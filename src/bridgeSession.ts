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
const MAX_PAIR_WAITERS = 32

type SessionState = "S0" | "S1"

// Validates a tool call's arguments against the input schema the browser
// advertised for that tool. Args arrive verbatim from an untrusted MCP client,
// and the Web Console renders/persists them without an error boundary, so a
// wrong-typed field (e.g. a non-string cell value) could crash the editor. We
// reject off-schema args here, at the trust boundary, against the LIVE schema
// (no drift vs. the connected console). One Ajv instance is reused; compiled
// validators are cached per tool and rebuilt on each pairing.
type ArgValidator = (input: unknown) => { valid: boolean; errorMessage?: string }
const schemaValidator = new AjvJsonSchemaValidator()

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
  private browserPermissions: MCPPermissions = { read: true, write: true }
  private inflight = new Map<string, InflightCall>()
  private pairWaiters: PairWaiter[] = []
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private outstandingPing: { nonce: string; sentAtNs: bigint } | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private helloTimer: ReturnType<typeof setTimeout> | null = null
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
    if (this.state !== "S1" || !this.sessionId) return { paired: false }
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
      conn.close(WS_CLOSE_CODES.protocol_violation, "hello_timeout")
    }, HELLO_TIMEOUT_MS)
    return "accepted"
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
            content: [
              { type: "text", text: `timeout: tool call exceeded ${deadlineMs}ms` },
            ],
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
      this.browser?.close(
        WS_CLOSE_CODES.protocol_violation,
        "duplicate_hello",
      )
      this.connClosing = true
      return
    }
    if (msg.token !== this.config.token) {
      this.browser?.close(WS_CLOSE_CODES.token_invalid, "token_mismatch")
      this.connClosing = true
      return
    }

    if (!isValidToolList(msg.tools)) {
      this.browser?.close(
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
      this.browser?.close(
        WS_CLOSE_CODES.major_version_mismatch,
        "major_version_mismatch",
      )
      this.connClosing = true
      return
    }
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
    if (this.outstandingPing) {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
      this.outstandingPing = null
      this.browser.terminate()
      return
    }
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
    this.stopHeartbeat()
    this.browser = null
    this.connClosing = false
    this.transitionToS0()
  }

  private rebuildToolValidators(): void {
    this.toolValidators.clear()
    for (const tool of this.browserTools) {
      try {
        this.toolValidators.set(
          tool.name,
          schemaValidator.getValidator(tool.inputSchema),
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
    for (const call of Array.from(this.inflight.values())) {
      clearInflight(call)
      call.resolve({
        content: [
          {
            type: "text",
            text:
              "browser_disconnected: paired browser went away during the call.",
          },
        ],
        isError: true,
      })
    }
    this.inflight.clear()
  }
}

const clearInflight = (call: InflightCall): void => {
  if (call.deadlineTimer) {
    clearTimeout(call.deadlineTimer)
    call.deadlineTimer = null
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
