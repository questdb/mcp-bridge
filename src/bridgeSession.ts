import { randomBytes } from "node:crypto"
import { MCP_BRIDGE_VERSION, parseMajor } from "./protocolVersion.js"
import type {
  AnyMessage,
  CancelMessage,
  HelloAckMessage,
  HelloMessage,
  Log,
  MCPPermissions,
  PingMessage,
  PongMessage,
  ToolCallMessage,
  ToolContent,
  ToolResultMessage,
  ToolResultPayload,
  ToolSchema,
} from "./types.js"
import { WS_CLOSE_CODES } from "./types.js"
import type {
  PairingSnapshot,
  VersionMismatch,
} from "./pairingTools.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"

const HEARTBEAT_INTERVAL_MS = 5_000
const PONG_TIMEOUT_MS = 10_000
const HELLO_TIMEOUT_MS = 10_000
// If a peer ignores our graceful close() (a stuck or misbehaving console), force
// the socket down shortly after. Otherwise `this.browser` stays set — and on the
// protocol-violation paths `connClosing` stays true — until ws's own
// close-handshake timeout (~30s), wedging a fresh pairing for that whole window.
const FORCE_CLOSE_MS = 1_000
const MAX_PAIR_WAITERS = 32
// How long an in-flight call survives a browser disconnect. The console keeps
// executing through transient drops (sleep/wake, heartbeat misses), queues the
// tool_result, and flushes it right after the reconnect hello_ack — failing
// the call immediately would hand the agent a false error for work that
// commits anyway, inviting a duplicate-DML retry.
const RECONNECT_GRACE_MS = 30_000

const DISCONNECT_UNVERIFIED_TEXT =
  "browser_disconnected: the paired browser dropped during the call and did " +
  "not reconnect in time. IMPORTANT: the call may have completed in the " +
  "console before the drop — only its result was lost. Verify current state " +
  "first (e.g. get_notebook_state or a read query); do NOT retry a " +
  "data-modifying call unless verification shows it did not apply."

// A deadline timeout means the result was lost, not that the work was rolled
// back — the console may have committed it (e.g. a long INSERT that finished
// just as the deadline fired). Carry the same do-not-blindly-retry guidance as
// the disconnect path so the agent doesn't duplicate a data-modifying call.
const buildTimeoutText = (deadlineMs: number): string =>
  `timeout: the tool call exceeded ${deadlineMs}ms before the paired console ` +
  `returned a result. IMPORTANT: the call may have completed in the console — ` +
  `only its result was not received in time. Verify current state first (e.g. ` +
  `get_notebook_state or a read query); do NOT retry a data-modifying call ` +
  `unless verification shows it did not apply.`

type SessionState = "S0" | "S1"

// Validates a tool call's arguments against the input schema the browser
// advertised for that tool. Args arrive verbatim from an untrusted MCP client,
// and the Web Console renders/persists them without an error boundary, so a
// wrong-typed field (e.g. a non-string cell value) could crash the editor. We
// reject off-schema args here, at the trust boundary, against the LIVE schema
// (no drift vs. the connected console). A FRESH validator is built per pairing
// (see rebuildToolValidators) so a prior console's schema cache can never leak
// into a later one, and advertised schemas are sanitized first (see
// sanitizeAdvertisedSchema).
type ArgValidator = (input: unknown) => { valid: boolean; errorMessage?: string }

// Schema keywords stripped from every advertised schema before compilation:
//  - `$id`: the SDK validator caches compiled schemas by `$id` for the life of
//    the Ajv instance, so two tools (or two pairings) advertising a colliding
//    `$id` would silently reuse the first one's validator — downgrading the
//    trust boundary for the second tool.
//  - `pattern` / `patternProperties` / `format`: console-supplied regexes run
//    synchronously on the single event loop during validation, so a
//    catastrophic-backtracking pattern (e.g. `^(a+)+$`) plus a crafted arg
//    would freeze the whole bridge (ReDoS). The bundled QuestDB schemas use
//    none of these, so stripping them costs no real validation fidelity.
const SCHEMA_KEYS_TO_STRIP = new Set([
  "$id",
  "pattern",
  "patternProperties",
  "format",
])

const sanitizeAdvertisedSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeAdvertisedSchema)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SCHEMA_KEYS_TO_STRIP.has(key)) continue
      out[key] = sanitizeAdvertisedSchema(v)
    }
    return out
  }
  return value
}

const MAX_TOOL_ARG_BYTES = 4 * 1024 * 1024

export type BrowserConn = {
  send: (msg: AnyMessage) => void
  close: (code: number, reason: string) => void
  terminate: () => void
}

export type BridgeSessionConfig = {
  token: string
  getPort: () => number
  consoleOrigin: string
  getDeadlineMs: (toolName: string) => number | null
  log?: Log
}

type InflightCall = {
  requestId: string
  toolName: string
  resolve: (result: ToolResultPayload) => void
  reject: (err: Error) => void
  deadlineTimer: ReturnType<typeof setTimeout> | null
  graceTimer: ReturnType<typeof setTimeout> | null
  abortCleanup: (() => void) | null
}

type PairWaiter = {
  resolve: (snap: PairingSnapshot) => void
  timer: ReturnType<typeof setTimeout>
}

const monotonicNs = (): bigint => process.hrtime.bigint()

const generateRequestId = (): string => {
  const t = Date.now().toString(36)
  const r = randomBytes(8).toString("hex")
  return `${t}-${r}`
}

const generateNonce = (): string => randomBytes(8).toString("hex")

const generateSessionId = (): string => {
  const t = Date.now().toString(36)
  const r = randomBytes(8).toString("hex")
  return `s-${t}-${r}`
}

export class BridgeSession {
  private state: SessionState = "S0"
  private browser: BrowserConn | null = null
  private sessionId: string | null = null
  private browserConsoleOrigin = ""
  private browserTools: ToolSchema[] = []
  private toolValidators = new Map<string, ArgValidator>()
  private versionMismatch: VersionMismatch | null = null
  // Set when a console's hello is refused for a major-version mismatch. The
  // socket is closed, but we keep the rejected version so the pairing tools can
  // hand the agent an actionable upgrade message instead of a silent timeout.
  private incompatibleConsole: VersionMismatch | null = null
  private browserPermissions: MCPPermissions = { read: true, write: true }
  private inflight = new Map<string, InflightCall>()
  private pairWaiters: PairWaiter[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private outstandingPing: { nonce: string; sentAtNs: bigint } | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private helloTimer: ReturnType<typeof setTimeout> | null = null
  private closeFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private connClosing = false

  constructor(private config: BridgeSessionConfig) {}

  getState(): SessionState {
    return this.state
  }

  buildDeepLink(): string {
    const url = `ws://127.0.0.1:${this.config.getPort()}`
    const params = new URLSearchParams({
      "mcp-pair": "1",
      "mcp-ws": url,
      "mcp-token": this.config.token,
    })
    return `${this.config.consoleOrigin}/?${params.toString()}`
  }

  getCredentials(): { wsUrl: string; token: string } {
    return {
      wsUrl: `ws://127.0.0.1:${this.config.getPort()}`,
      token: this.config.token,
    }
  }

  getPairingSnapshot(): PairingSnapshot {
    if (this.state !== "S1" || !this.sessionId) {
      return this.incompatibleConsole
        ? { paired: false, incompatible: this.incompatibleConsole }
        : { paired: false }
    }
    return {
      paired: true,
      sessionId: this.sessionId,
      consoleOrigin: this.browserConsoleOrigin,
      permissions: this.browserPermissions,
      versionMismatch: this.versionMismatch,
    }
  }

  waitForPair(
    timeoutMs: number,
  ): Promise<PairingSnapshot | { paired: false; rateLimited: true }> {
    if (this.state === "S1") {
      return Promise.resolve(this.getPairingSnapshot())
    }

    if (this.incompatibleConsole) {
      return Promise.resolve({
        paired: false,
        incompatible: this.incompatibleConsole,
      })
    }

    if (this.pairWaiters.length >= MAX_PAIR_WAITERS) {
      return Promise.resolve({ paired: false, rateLimited: true })
    }
    return new Promise<PairingSnapshot>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.pairWaiters.findIndex((w) => w.timer === timer)
        if (idx !== -1) this.pairWaiters.splice(idx, 1)
        resolve({ paired: false })
      }, timeoutMs)
      this.pairWaiters.push({ resolve, timer })
    })
  }

  attachBrowser(conn: BrowserConn): "accepted" | "superseded" {
    if (this.browser) {
      return "superseded"
    }
    this.browser = conn
    this.helloTimer = setTimeout(() => {
      this.closeBrowser(WS_CLOSE_CODES.protocol_violation, "hello_timeout")
    }, HELLO_TIMEOUT_MS)
    return "accepted"
  }

  private closeBrowser(code: number, reason: string): void {
    const conn = this.browser
    if (!conn) return
    conn.close(code, reason)
    if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer)
    const timer = setTimeout(() => {
      this.closeFallbackTimer = null
      conn.terminate()
    }, FORCE_CLOSE_MS)
    timer.unref()
    this.closeFallbackTimer = timer
  }

  handleMessage(msg: AnyMessage): void {
    if (this.connClosing) return
    switch (msg.type) {
      case "hello":
        this.handleHello(msg)
        return
      case "tool_result":
        this.handleToolResult(msg)
        return
      case "ping":
        this.browser?.send({
          v: MCP_BRIDGE_VERSION,
          type: "pong",
          nonce: msg.nonce,
        } satisfies PongMessage)
        return
      case "pong":
        this.handlePong(msg)
        return
      default:
        return
    }
  }

  handleSocketClose(conn: BrowserConn): void {
    if (this.browser !== conn) return
    this.detachBrowser()
  }

  callBrowserTool(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResultPayload> {
    if (this.state !== "S1" || !this.browser) {
      return Promise.resolve({
        content: [
          {
            type: "text",
            text:
              `BRIDGE_NOT_PAIRED: This tool requires a paired QuestDB Web ` +
              `Console.\n` +
              `Recovery: call \`get_pairing_credentials\` to get a pairing URL ` +
              `(present BOTH the deep link AND the manual ws_url + token to ` +
              `the user), then call \`wait_for_pairing\` until ` +
              `{paired:true}, then retry this tool.`,
          },
        ],
        isError: true,
      })
    }
    if (signal?.aborted) {
      return Promise.resolve({
        content: [
          { type: "text", text: "cancelled: tool call cancelled before dispatch" },
        ],
        isError: true,
      })
    }
    let argsByteLength: number
    try {
      argsByteLength = Buffer.byteLength(JSON.stringify(args), "utf8")
    } catch {
      argsByteLength = Number.POSITIVE_INFINITY
    }
    if (argsByteLength > MAX_TOOL_ARG_BYTES) {
      return Promise.resolve({
        content: [
          {
            type: "text",
            text:
              `VALIDATION_ERROR: arguments for \`${toolName}\` exceed the ` +
              `${MAX_TOOL_ARG_BYTES}-byte limit.`,
          },
        ],
        isError: true,
      })
    }
    const validate = this.toolValidators.get(toolName)
    if (validate) {
      const { valid, errorMessage } = validate(args)
      if (!valid) {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text:
                `VALIDATION_ERROR: arguments for \`${toolName}\` do not match ` +
                `its input schema: ${errorMessage ?? "invalid arguments"}`,
            },
          ],
          isError: true,
        })
      }
    }
    const requestId = generateRequestId()
    const deadlineMs = this.config.getDeadlineMs(toolName)
    return new Promise<ToolResultPayload>((resolve, reject) => {
      const inflight: InflightCall = {
        requestId,
        toolName,
        resolve,
        reject,
        deadlineTimer: null,
        graceTimer: null,
        abortCleanup: null,
      }
      if (typeof deadlineMs === "number") {
        inflight.deadlineTimer = setTimeout(() => {
          if (!this.inflight.has(requestId)) return
          this.inflight.delete(requestId)
          clearInflight(inflight)
          this.browser?.send({
            v: MCP_BRIDGE_VERSION,
            type: "cancel",
            requestId,
          } satisfies CancelMessage)
          resolve({
            content: [{ type: "text", text: buildTimeoutText(deadlineMs) }],
            isError: true,
          })
        }, deadlineMs)
      }
      if (signal) {
        const onAbort = () => {
          if (!this.inflight.has(requestId)) return
          this.inflight.delete(requestId)
          clearInflight(inflight)
          this.browser?.send({
            v: MCP_BRIDGE_VERSION,
            type: "cancel",
            requestId,
          } satisfies CancelMessage)
          resolve({
            content: [
              { type: "text", text: "cancelled: caller cancelled tool call" },
            ],
            isError: true,
          })
        }
        signal.addEventListener("abort", onAbort, { once: true })
        inflight.abortCleanup = () =>
          signal.removeEventListener("abort", onAbort)
      }
      this.inflight.set(requestId, inflight)
      const call: ToolCallMessage = {
        v: MCP_BRIDGE_VERSION,
        type: "tool_call",
        requestId,
        name: toolName,
        arguments: args,
        deadlineMs: deadlineMs,
      }
      try {
        this.browser?.send(call)
      } catch (err) {
        clearInflight(inflight)
        this.inflight.delete(requestId)
        reject(err instanceof Error ? err : new Error("send failed"))
      }
    })
  }

  private handleHello(msg: HelloMessage): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer)
      this.helloTimer = null
    }

    if (this.state === "S1") {
      this.closeBrowser(
        WS_CLOSE_CODES.protocol_violation,
        "duplicate_hello",
      )
      this.connClosing = true
      return
    }
    if (msg.token !== this.config.token) {
      this.closeBrowser(WS_CLOSE_CODES.token_invalid, "token_mismatch")
      this.connClosing = true
      return
    }

    if (!isValidToolList(msg.tools)) {
      this.closeBrowser(
        WS_CLOSE_CODES.protocol_violation,
        "malformed_hello_tools",
      )
      this.connClosing = true
      return
    }

    const expectedMajor = parseMajor(msg.expectedBridgeVersion)
    const actualMajor = parseMajor(MCP_BRIDGE_VERSION)
    if (
      expectedMajor === null ||
      actualMajor === null ||
      expectedMajor !== actualMajor
    ) {
      this.incompatibleConsole = {
        bridgeVersion: MCP_BRIDGE_VERSION,
        expectedBridgeVersion: msg.expectedBridgeVersion,
      }
      // Resolve any parked waiters now instead of letting them run out the full
      // poll timeout — the agent should get the actionable upgrade message on
      // the current wait_for_pairing call, not a wasted timeout-then-retry.
      const waiters = this.pairWaiters
      this.pairWaiters = []
      for (const w of waiters) {
        clearTimeout(w.timer)
        w.resolve({ paired: false, incompatible: this.incompatibleConsole })
      }
      this.closeBrowser(
        WS_CLOSE_CODES.major_version_mismatch,
        "major_version_mismatch",
      )
      this.connClosing = true
      return
    }
    this.incompatibleConsole = null
    this.versionMismatch =
      msg.expectedBridgeVersion === MCP_BRIDGE_VERSION
        ? null
        : {
            bridgeVersion: MCP_BRIDGE_VERSION,
            expectedBridgeVersion: msg.expectedBridgeVersion,
          }

    this.sessionId = generateSessionId()
    this.browserConsoleOrigin = msg.consoleOrigin
    this.browserTools = msg.tools
    this.rebuildToolValidators()
    this.browserPermissions = msg.permissions
    this.config.log?.(
      "INFO",
      `browser paired: console=${msg.consoleOrigin} expectedBridge=${msg.expectedBridgeVersion} actualBridge=${MCP_BRIDGE_VERSION} ua=${msg.userAgent}`,
    )

    this.state = "S1"
    for (const call of this.inflight.values()) {
      if (call.graceTimer) {
        clearTimeout(call.graceTimer)
        call.graceTimer = null
      }
    }
    const ack: HelloAckMessage = {
      v: MCP_BRIDGE_VERSION,
      type: "hello_ack",
      sessionId: this.sessionId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      seenToolCount: this.browserTools.length,
    }
    this.browser?.send(ack)

    const snap = this.getPairingSnapshot()
    const waiters = this.pairWaiters
    this.pairWaiters = []
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.resolve(snap)
    }

    this.startHeartbeat()
  }

  private handleToolResult(msg: ToolResultMessage): void {
    const call = this.inflight.get(msg.requestId)
    if (!call) {
      return
    }
    clearInflight(call)
    this.inflight.delete(msg.requestId)

    if (!isValidToolContent(msg.content)) {
      call.resolve({
        content: [
          {
            type: "text",
            text:
              "BROWSER_PROTOCOL_ERROR: paired browser returned a malformed " +
              "tool_result.content (expected an array of {type:'text', text:string}). " +
              "Retry the tool call; if the failure persists, the browser may need " +
              "a refresh.",
          },
        ],
        isError: true,
      })
      return
    }
    call.resolve({
      content: msg.content,
      isError: msg.isError === true,
    })
  }

  private handlePong(msg: PongMessage): void {
    if (!this.outstandingPing || this.outstandingPing.nonce !== msg.nonce) {
      return
    }
    const elapsedMs = Number(
      (monotonicNs() - this.outstandingPing.sentAtNs) / 1_000_000n,
    )
    this.config.log?.("DEBUG", `heartbeat: pong in ${elapsedMs}ms`)
    this.outstandingPing = null
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(
      () => this.sendPing(),
      HEARTBEAT_INTERVAL_MS,
    )
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    this.outstandingPing = null
  }

  private sendPing(): void {
    if (!this.browser || this.state !== "S1") return
    if (this.outstandingPing) return
    const nonce = generateNonce()
    const sentAtNs = monotonicNs()
    this.outstandingPing = { nonce, sentAtNs }
    this.browser.send({
      v: MCP_BRIDGE_VERSION,
      type: "ping",
      nonce,
    } satisfies PingMessage)
    this.pongTimer = setTimeout(() => {
      this.browser?.terminate()
    }, PONG_TIMEOUT_MS)
  }

  private detachBrowser(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer)
      this.helloTimer = null
    }
    if (this.closeFallbackTimer) {
      clearTimeout(this.closeFallbackTimer)
      this.closeFallbackTimer = null
    }
    this.stopHeartbeat()
    this.browser = null
    this.connClosing = false
    this.transitionToS0()
  }

  private rebuildToolValidators(): void {
    this.toolValidators.clear()
    const validator = new AjvJsonSchemaValidator()
    for (const tool of this.browserTools) {
      try {
        this.toolValidators.set(
          tool.name,
          validator.getValidator(
            sanitizeAdvertisedSchema(tool.inputSchema) as Record<
              string,
              unknown
            >,
          ),
        )
      } catch {
        // unvalidatable schema → skip (fail-open for that tool only)
      }
    }
  }

  private transitionToS0(): void {
    this.state = "S0"
    this.browserTools = []
    this.toolValidators.clear()
    this.sessionId = null
    this.incompatibleConsole = null
    // In-flight calls survive the disconnect: the console flushes their
    // results after a reconnect hello_ack, and handleToolResult still finds
    // them by requestId. Only grace expiry fails them.
    for (const call of this.inflight.values()) {
      this.scheduleDisconnectGrace(call)
    }
  }

  private scheduleDisconnectGrace(call: InflightCall): void {
    if (call.graceTimer) return
    call.graceTimer = setTimeout(() => {
      if (!this.inflight.has(call.requestId)) return
      this.inflight.delete(call.requestId)
      clearInflight(call)
      call.resolve({
        content: [{ type: "text", text: DISCONNECT_UNVERIFIED_TEXT }],
        isError: true,
      })
    }, RECONNECT_GRACE_MS)
  }
}

const clearInflight = (call: InflightCall): void => {
  if (call.deadlineTimer) {
    clearTimeout(call.deadlineTimer)
    call.deadlineTimer = null
  }
  if (call.graceTimer) {
    clearTimeout(call.graceTimer)
    call.graceTimer = null
  }
  if (call.abortCleanup) {
    call.abortCleanup()
    call.abortCleanup = null
  }
}

const isValidToolList = (
  tools: unknown,
): tools is { name: string; description?: unknown; inputSchema?: unknown }[] => {
  if (!Array.isArray(tools)) return false
  for (const t of tools) {
    if (
      typeof t !== "object" ||
      t === null ||
      typeof (t as { name?: unknown }).name !== "string"
    ) {
      return false
    }
  }
  return true
}

const isValidToolContent = (content: unknown): content is ToolContent[] => {
  if (!Array.isArray(content)) return false
  for (const item of content) {
    if (
      typeof item !== "object" ||
      item === null ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return false
    }
  }
  return true
}
