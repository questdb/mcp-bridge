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
  "Tool surface: 30 tools are visible from `tools/list` from the very first",
  "request — 2 pairing tools (connect_web_console, wait_for_pairing) plus 28",
  "functional tools (3 schema + 3 reference + 19 notebook + 3 meta).",
  "Functional tools require a paired Web Console; calling them while unpaired",
  "returns a `BRIDGE_NOT_PAIRED` error pointing back at the pairing flow.",
  "",
  "Pairing flow (REQUIRED before any functional tool succeeds). All four",
  "steps happen in the SAME assistant turn — do not end your turn between",
  "step 2 and step 3:",
  "  1. Call `connect_web_console` — returns BOTH a one-click deep link AND",
  "     a separate WebSocket URL + token (for users who prefer manual entry).",
  "  2. Write a short message to the user that presents BOTH options:",
  "       \"You can pair with this link: <deep_link>\n",
  "       Or enter these manually in the MCP pill at the bottom of the console:\n",
  "         WebSocket URL: <ws_url>\n",
  "         Token: <token>\"",
  "     This is mandatory — the user cannot proceed without seeing both.",
  "  3. IMMEDIATELY call `wait_for_pairing`. DO NOT end your turn after",
  "     showing the URL; DO NOT say \"I'll poll for status\" and stop.",
  "     Actually call the tool. The wait blocks ~50 s, giving the user",
  "     time to click or paste. On timeout, call wait_for_pairing again",
  "     (up to ~10 retries / ~8 minutes) until {paired:true}.",
  "  4. Once paired, retry whatever functional tool you were trying to use.",
  "",
  "Do NOT tell the user 'QuestDB has no chart tool' — the chart tools are",
  "right there in the catalog; they just need pairing first.",
  "",
  "Verifying current state before answering:",
  "  The user can change notebook state at any time (switching tabs, editing",
  "  cells, dragging layout). Before answering questions about \"current cell\",",
  "  \"this notebook\", \"the active chart\", or anything that depends on what",
  "  the user is looking at right now, ALWAYS call `get_workspace_state` first.",
  "  Do not rely on prior tool results — the user may have changed things since.",
  "  Tool results carry a `<since_last_check>` block with the latest active",
  "  buffer + recent user events; consult it before answering.",
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
        if (name === "connect_web_console") {
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
