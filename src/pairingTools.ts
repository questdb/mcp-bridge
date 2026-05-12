import type {
  MCPPermissions,
  ToolResultPayload,
  ToolSchema,
} from "./types.js"

export const CONNECT_TOOL: ToolSchema = {
  name: "connect_web_console",
  description:
    "Begin a QuestDB Web Console pairing session. Returns a one-click " +
    "deep link AND a separate WebSocket URL + token (for manual entry). " +
    "Idempotent — repeated calls during an in-flight pairing return the " +
    "same credentials; if already paired, returns a success message. " +
    "Show the credentials to the user, then call `wait_for_pairing` in " +
    "the same turn (see the server-level pairing flow instructions for " +
    "the full sequence).",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
}

export const WAIT_TOOL: ToolSchema = {
  name: "wait_for_pairing",
  description:
    "Poll for completion of a QuestDB Web Console pairing started by " +
    "`connect_web_console`. Blocks for `timeout_ms` (default 50 s, max " +
    "50 s — sized to fit under typical MCP client tool-call timeouts). " +
    "Returns `{paired:true, consoleOrigin, permissions:{read,write}}` " +
    "on success, or `{paired:false, reason:'timeout', retryCount, " +
    "maxRetriesHint:10}` on timeout — call again to keep waiting (up " +
    "to ~10 retries / ~8 min) until the user pairs. " +
    "If the bridge version doesn't match what the web console expects, " +
    "the success payload includes a `warning` field naming both " +
    "versions; surface it verbatim to the user before proceeding. " +
    "`permissions` describes the user-granted MCP scopes: `read=true` " +
    "allows schema introspection and DQL (SELECT/SHOW); `write=true` " +
    "additionally allows DDL/DML (CREATE/INSERT/UPDATE/DELETE/DROP/…). " +
    "Operations outside the granted scope return PERMISSION_DENIED " +
    "with a message naming the missing scope — adjust your plan " +
    "accordingly rather than retrying.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: 50000,
        description:
          "Override the default 50,000 ms poll length. Useful for tests.",
      },
    },
    additionalProperties: false,
  },
}

const PAIRING_TOOL_NAMES = ["connect_web_console", "wait_for_pairing"] as const
type PairingToolName = (typeof PAIRING_TOOL_NAMES)[number]

export const isPairingToolName = (name: string): name is PairingToolName =>
  (PAIRING_TOOL_NAMES as readonly string[]).includes(name)

export type VersionMismatch = {
  bridgeVersion: string
  expectedBridgeVersion: string
}

export type PairingSnapshot =
  | { paired: false }
  | {
      paired: true
      sessionId: string
      consoleOrigin: string
      permissions: MCPPermissions
      versionMismatch: VersionMismatch | null
    }

export type WaitForPairResult =
  | {
      paired: true
      sessionId: string
      consoleOrigin: string
      permissions: MCPPermissions
      versionMismatch: VersionMismatch | null
    }
  | { paired: false; reason: "timeout" | "rate_limited" }

export type PairingToolsContext = {
  buildDeepLink: () => string
  getCredentials: () => { wsUrl: string; token: string }
  getPairingState: () => PairingSnapshot
  waitForPair: (timeoutMs: number) => Promise<WaitForPairResult>
}

const DEFAULT_PAIRING_POLL_TIMEOUT_MS = 50_000
const MAX_PAIRING_POLL_TIMEOUT_MS = 50_000
const MIN_PAIRING_POLL_TIMEOUT_MS = 1_000
const RECOMMENDED_MAX_RETRIES = 10

const buildVersionWarning = (m: VersionMismatch): string =>
  `version_mismatch: This bridge is @questdb/mcp-bridge v${m.bridgeVersion}, ` +
  `but the QuestDB Web Console expects bridge version ${m.expectedBridgeVersion}. ` +
  `Some tools may not work as expected. Inform the user about this version mismatch ` +
  `before proceeding.`

type Counters = { waitRetries: number }

export const createPairingToolHandlers = (
  ctx: PairingToolsContext,
  counters: Counters = { waitRetries: 0 },
) => {
  const handleConnectWebConsole = (): ToolResultPayload => {
    const state = ctx.getPairingState()
    if (state.paired) {
      const payload: Record<string, unknown> = {
        paired: true,
        consoleOrigin: state.consoleOrigin,
        permissions: state.permissions,
        message:
          "Already paired with the QuestDB Web Console; notebook tools are available.",
      }
      if (state.versionMismatch) {
        payload.warning = buildVersionWarning(state.versionMismatch)
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(payload) },
        ],
      }
    }
    const url = ctx.buildDeepLink()
    const { wsUrl, token } = ctx.getCredentials()
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            paired: false,
            deepLink: url,
            wsUrl,
            token,
            nextStep: "wait_for_pairing",
          }),
        },
      ],
    }
  }

  const clampTimeout = (raw: unknown): number => {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return Math.min(
        MAX_PAIRING_POLL_TIMEOUT_MS,
        Math.max(MIN_PAIRING_POLL_TIMEOUT_MS, Math.floor(raw)),
      )
    }
    return DEFAULT_PAIRING_POLL_TIMEOUT_MS
  }

  const handleWaitForPairing = async (
    args: { timeout_ms?: number } | undefined,
  ): Promise<ToolResultPayload> => {
    const initial = ctx.getPairingState()
    if (initial.paired) {
      counters.waitRetries = 0
      const payload: Record<string, unknown> = {
        paired: true,
        consoleOrigin: initial.consoleOrigin,
        permissions: initial.permissions,
      }
      if (initial.versionMismatch) {
        payload.warning = buildVersionWarning(initial.versionMismatch)
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }
    }

    const timeoutMs = clampTimeout(args?.timeout_ms)
    const result = await ctx.waitForPair(timeoutMs)
    if (result.paired) {
      counters.waitRetries = 0
      const payload: Record<string, unknown> = {
        paired: true,
        consoleOrigin: result.consoleOrigin,
        permissions: result.permissions,
      }
      if (result.versionMismatch) {
        payload.warning = buildVersionWarning(result.versionMismatch)
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }
    }
    if (result.reason === "rate_limited") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              paired: false,
              reason: "rate_limited",
              message:
                "Too many concurrent wait_for_pairing calls; wait for the outstanding calls to resolve before issuing more.",
            }),
          },
        ],
        isError: true,
      }
    }
    counters.waitRetries += 1
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            paired: false,
            reason: "timeout",
            retryCount: counters.waitRetries,
            maxRetriesHint: RECOMMENDED_MAX_RETRIES,
            hint:
              "Call wait_for_pairing again to keep waiting. The user may " +
              "still be authenticating. Recommend giving up after ~10 retries " +
              "(~8 minutes) and asking the user to ping back when ready.",
          }),
        },
      ],
    }
  }

  return { handleConnectWebConsole, handleWaitForPairing, counters }
}
