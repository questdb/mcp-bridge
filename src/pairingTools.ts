import type {
  MCPPermissions,
  ToolResultPayload,
  ToolSchema,
} from "./types.js"

export const CONNECT_TOOL: ToolSchema = {
  name: "get_pairing_credentials",
  description:
    "Get the credentials the user needs to pair their browser with this " +
    "MCP bridge — calling this tool does NOT itself pair anything. It " +
    "returns a deep_link, ws_url, token, AND a pre-rendered `userMessage` " +
    "with the exact text to show the user. " +
    "REQUIRED FLOW — do all three in the defined: " +
    "(1) call this tool, " +
    "(2) write a message to the user containing the `userMessage` text " +
    "(or your own equivalent showing deep_link + ws_url + token), " +
    "(3) call `wait_for_pairing`. " +
    "DO NOT skip step (2). Calling `wait_for_pairing` without first " +
    "showing the credentials guarantees a timeout — the user has no " +
    "credentials to enter, so they cannot pair. " +
    "Idempotent during pairing; returns paired:true if already paired.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
}

export const WAIT_TOOL: ToolSchema = {
  name: "wait_for_pairing",
  description:
    "Poll for completion of pairing started by `get_pairing_credentials`. " +
    "PREREQUISITE: you have already written a message to the user " +
    "containing the deep_link + ws_url + token from " +
    "`get_pairing_credentials`'s last response. If you have NOT yet shown " +
    "those credentials, do that first — calling this tool without " +
    "showing credentials only burns 50 s of polling while the user " +
    "sees nothing actionable. " +
    "Blocks for `timeout_ms` (default 50 s, max 50 s — sized to fit " +
    "under typical MCP client tool-call timeouts). " +
    "Returns `{paired:true, consoleOrigin, permissions:{grantSchemaAccess,read,write}}` " +
    "on success, or `{paired:false, reason:'timeout', retryCount, " +
    "maxRetriesHint:10}` on timeout — call again to keep waiting (up " +
    "to ~10 retries / ~8 min) until the user pairs. " +
    "If the bridge version doesn't match what the web console expects, " +
    "the success payload includes a `warning` plus a pre-rendered " +
    "`userMessage`; show the `userMessage` to the user verbatim before " +
    "proceeding. " +
    "If pairing is refused outright for an incompatible bridge, the result " +
    "is `{paired:false, reason:'incompatible_bridge', userMessage, " +
    "assistantNextActions}` — show the `userMessage` verbatim and STOP " +
    "polling; pairing cannot succeed until the user reinstalls the bridge " +
    "version named in the message. " +
    "`permissions` describes the user-granted MCP scopes: " +
    "`grantSchemaAccess=true` allows schema introspection (tables/columns); " +
    "`read=true` allows DQL (SELECT/SHOW); `write=true` additionally allows " +
    "DDL/DML (CREATE/INSERT/UPDATE/DELETE/DROP/…). " +
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

const PAIRING_TOOL_NAMES = [
  "get_pairing_credentials",
  "wait_for_pairing",
] as const
type PairingToolName = (typeof PAIRING_TOOL_NAMES)[number]

export const isPairingToolName = (name: string): name is PairingToolName =>
  (PAIRING_TOOL_NAMES as readonly string[]).includes(name)

export type VersionMismatch = {
  bridgeVersion: string
  expectedBridgeVersion: string
}

export type PairingSnapshot =
  | { paired: false; incompatible?: VersionMismatch }
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
  | { paired: false; reason: "incompatible"; incompatible: VersionMismatch }

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

// Pre-rendered text the assistant SHOULD show the user verbatim — same forcing
// pattern as get_pairing_credentials' `userMessage`. `expectedBridgeVersion` is
// the exact npm version the console was verified against, so it doubles as the
// pin to install.
const buildVersionUserMessage = (m: VersionMismatch): string =>
  `Version mismatch: this MCP bridge is @questdb/mcp-bridge v${m.bridgeVersion}, ` +
  `but the QuestDB Web Console expects v${m.expectedBridgeVersion}. ` +
  `Update your MCP server command to \`npx @questdb/mcp-bridge@${m.expectedBridgeVersion} start\`, ` +
  `restart your coding agent, then pair again.`

const buildVersionWarning = (m: VersionMismatch): string =>
  `version_mismatch (bridge v${m.bridgeVersion} vs console-expected ` +
  `v${m.expectedBridgeVersion}): show the \`userMessage\` field to the user ` +
  `verbatim before proceeding. Some tools may not work properly until the correct bridge version is used.`

// Returned when the console tried to pair but its expected bridge major differs
// — pairing was refused, so this is a terminal error for the agent: surface the
// upgrade instruction and stop polling rather than burning retries.
const buildIncompatiblePayload = (inc: VersionMismatch): ToolResultPayload => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        paired: false,
        reason: "incompatible_bridge",
        warning: buildVersionWarning(inc),
        userMessage: buildVersionUserMessage(inc),
        assistantNextActions: [
          "Show the `userMessage` text to the user verbatim.",
          `Tell them to set their MCP server command to \`npx @questdb/mcp-bridge@${inc.expectedBridgeVersion} start\` and restart this coding agent.`,
          "Stop calling wait_for_pairing — pairing cannot succeed until the bridge version is updated.",
        ],
      }),
    },
  ],
  isError: true,
})

type Counters = { waitRetries: number }

export const createPairingToolHandlers = (
  ctx: PairingToolsContext,
  counters: Counters = { waitRetries: 0 },
) => {
  const handleConnectWebConsole = (): ToolResultPayload => {
    const state = ctx.getPairingState()
    if (!state.paired && state.incompatible) {
      return buildIncompatiblePayload(state.incompatible)
    }
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
        payload.userMessage = buildVersionUserMessage(state.versionMismatch)
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(payload) },
        ],
      }
    }
    const url = ctx.buildDeepLink()
    const { wsUrl, token } = ctx.getCredentials()
    const userMessage =
      `To pair with the QuestDB Web Console:\n\n` +
      `  Option 1 — click this link and follow the instructions: ${url}\n\n` +
      `  Option 2 — open the QuestDB Web Console, click the MCP connection status at\n` +
      `  the bottom of the screen, and enter these values manually:\n` +
      `    WebSocket URL: ${wsUrl}\n` +
      `    Token:         ${token}\n`
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
            // Pre-rendered text the assistant SHOULD show the user. Smaller
            // models often skim past prose instructions about "show these
            // to the user" — having the rendered message inline makes the
            // next step trivially copy-pasteable.
            userMessage,
            // Explicit ordered steps in case the model still skips ahead.
            // Phrased as imperatives because that's what weaker models
            // follow most reliably.
            assistantNextActions: [
              "Write a message to the user containing the `userMessage` text above (or your own equivalent — the user must see deepLink AND wsUrl+token).",
              "Then, in the SAME turn, call wait_for_pairing.",
              "Do NOT skip step 1. Calling wait_for_pairing before showing the user the credentials only burns 50s — the user cannot pair without seeing them.",
            ],
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
    if (!initial.paired && initial.incompatible) {
      counters.waitRetries = 0
      return buildIncompatiblePayload(initial.incompatible)
    }
    if (initial.paired) {
      counters.waitRetries = 0
      const payload: Record<string, unknown> = {
        paired: true,
        consoleOrigin: initial.consoleOrigin,
        permissions: initial.permissions,
      }
      if (initial.versionMismatch) {
        payload.warning = buildVersionWarning(initial.versionMismatch)
        payload.userMessage = buildVersionUserMessage(initial.versionMismatch)
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
        payload.userMessage = buildVersionUserMessage(result.versionMismatch)
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }
    }
    if (result.reason === "incompatible") {
      counters.waitRetries = 0
      return buildIncompatiblePayload(result.incompatible)
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
              "still be authenticating. " +
              "CHECK FIRST: did you write a message to the user containing " +
              "the deepLink + wsUrl + token from your last get_pairing_credentials " +
              "response? If not, do that NOW — the user cannot pair without " +
              "seeing those credentials, and continuing to poll will just " +
              "keep timing out. " +
              "Recommend giving up after ~10 retries (~8 minutes) and asking " +
              "the user to ping back when ready.",
          }),
        },
      ],
    }
  }

  return { handleConnectWebConsole, handleWaitForPairing, counters }
}
