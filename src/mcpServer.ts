import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
  CONNECT_TOOL,
  WAIT_TOOL,
  createPairingToolHandlers,
  isPairingToolName,
  type PairingToolsContext,
} from "./pairingTools.js"
import { BUNDLED_FUNCTIONAL_TOOLS } from "./bundledTools.js"
import { MCP_BRIDGE_VERSION } from "./protocolVersion.js"
import type { BridgeSession } from "./bridgeSession.js"
import type { ToolResultPayload } from "./types.js"

const SERVER_NAME = "questdb-mcp-bridge"
const SERVER_VERSION = MCP_BRIDGE_VERSION

const SERVER_INSTRUCTIONS = [
  "QuestDB Web Console MCP — author interactive SQL notebooks and dashboards in the user's running QuestDB Web Console.",
  "",
  "Use this MCP whenever the user asks to:",
  "  - draw a chart, build a dashboard, or visualize a query (line, area, bar, stacked bar, scatter, pie, candlestick)",
  "  - create / edit / arrange notebook cells against their QuestDB instance",
  "  - inspect tables / schemas, validate SQL, look up QuestDB function docs",
  "  - run SQL and inspect results in a live UI the user can interact with",
  "",
  "════════════════════ PAIRING FLOW — READ FIRST ════════════════════",
  "",
  "Before ANY functional tool works, the user must pair their browser",
  "to this bridge. Do these THREE steps in a SINGLE assistant turn,",
  "in order. The #1 reason this fails is skipping step 2.",
  "",
  "  STEP 1 — Call `get_pairing_credentials`.",
  "    Response includes: deepLink, wsUrl, token, userMessage,",
  "    assistantNextActions.",
  "",
  "  STEP 2 — Write a message to the user (MANDATORY — DO NOT SKIP).",
  "    Copy the `userMessage` field from STEP 1's response verbatim",
  "    into your message to the user. It already contains BOTH the",
  "    one-click deep link AND the manual ws_url + token in a",
  "    ready-to-paste format.",
  "    If you skip STEP 2: the user sees nothing actionable, has no",
  "    credentials to enter, and STEP 3 will just time out forever.",
  "    No exceptions. No \"I'll wait for status first.\" Show the",
  "    message, THEN call STEP 3.",
  "",
  "  STEP 3 — Call `wait_for_pairing` in the defined order.",
  "    Do not end your turn between STEP 2 and STEP 3. Do not say",
  "    \"I'll poll later\" and stop — actually call the tool now.",
  "    It blocks up to 50 s. On {paired:false, reason:'timeout'},",
  "    call wait_for_pairing again (up to ~10 retries / ~8 min).",
  "    On {paired:true}, retry whatever functional tool you were",
  "    originally trying to use.",
  "",
  "Common mistakes (DO NOT do these):",
  "  ✗ Calling wait_for_pairing immediately after get_pairing_credentials",
  "    without writing a message to the user. The user never sees the",
  "    credentials and cannot pair. wait_for_pairing will time out and",
  "    you will be stuck in a retry loop.",
  "  ✗ Ending your turn after get_pairing_credentials. The user is left",
  "    hanging with credentials they may not even see because you",
  "    haven't displayed them.",
  "  ✗ Telling the user \"QuestDB has no chart tool\" or similar — the",
  "    chart tools are in the catalog; they just need pairing first.",
  "  ✗ Skipping the `userMessage` and improvising your own that omits",
  "    either the deep link OR the ws_url+token. Always show BOTH so",
  "    the user can pick whichever works for them.",
  "",
  "═══════════════════════════════════════════════════════════════════",
  "",
  "Tool surface: 30 tools visible from `tools/list` from the very first",
  "request — 2 pairing tools (get_pairing_credentials, wait_for_pairing)",
  "plus 28 functional tools (3 schema + 3 reference + 19 notebook + 3",
  "meta). Functional tools require a paired Web Console; calling them",
  "while unpaired returns a `BRIDGE_NOT_PAIRED` error pointing back at",
  "the pairing flow above.",
  "",
  "Verifying current state before answering:",
  "  The user can change notebook state at any time (switching tabs,",
  "  editing cells, dragging layout). Before answering questions about",
  "  \"current cell\", \"this notebook\", \"the active chart\", or anything",
  "  that depends on what the user is looking at right now, ALWAYS",
  "  call `get_workspace_state` first. Do not rely on prior tool",
  "  results — the user may have changed things since. Tool results",
  "  carry a `<since_last_check>` block with the latest active buffer +",
  "  recent user events; consult it before answering.",
].join("\n")

type StartMcpServerArgs = {
  session: BridgeSession
}

export const startMcpServer = async ({ session }: StartMcpServerArgs) => {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  )

  const pairingCtx: PairingToolsContext = {
    buildDeepLink: () => session.buildDeepLink(),
    getCredentials: () => session.getCredentials(),
    getPairingState: () => session.getPairingSnapshot(),
    waitForPair: (timeoutMs) => {
      return session.waitForPair(timeoutMs).then((snap) => {
        if (snap.paired) {
          return {
            paired: true,
            sessionId: snap.sessionId,
            consoleOrigin: snap.consoleOrigin,
            permissions: snap.permissions,
            versionMismatch: snap.versionMismatch,
          }
        }
        if ("rateLimited" in snap && snap.rateLimited) {
          return { paired: false, reason: "rate_limited" as const }
        }
        return { paired: false, reason: "timeout" as const }
      })
    },
  }
  const { handleConnectWebConsole, handleWaitForPairing } =
    createPairingToolHandlers(pairingCtx)

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [],
  }))
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [],
  }))
  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [],
  }))

  const STATIC_TOOL_LIST = [CONNECT_TOOL, WAIT_TOOL, ...BUNDLED_FUNCTIONAL_TOOLS]
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: STATIC_TOOL_LIST,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name
    const args = req.params.arguments ?? {}

    try {
      if (isPairingToolName(name)) {
        let result: ToolResultPayload
        if (name === "get_pairing_credentials") {
          result = handleConnectWebConsole()
        } else {
          result = await handleWaitForPairing(args)
        }
        return {
          content: result.content,
          isError: result.isError === true,
        }
      }

      const result = await session.callBrowserTool(name, args, extra.signal)
      return {
        content: result.content,
        isError: result.isError === true,
      }
    } catch {
      return {
        content: [
          {
            type: "text",
            text:
              "INTERNAL_ERROR: the bridge failed to forward this call. " +
              "Retry; if the failure persists, refresh the browser tab.",
          },
        ],
        isError: true,
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  return {
    stop: async () => {
      await server.close()
    },
  }
}
