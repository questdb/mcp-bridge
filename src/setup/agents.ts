import { homedir } from "node:os"
import { join } from "node:path"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"

export type AgentId = "claude" | "codex" | "cursor" | "opencode" | "gemini"

// LOG_PATH / LOG_LEVEL are deliberately omitted; users add them by hand to debug.
export type BridgeEnv = {
  CONSOLE_ORIGIN?: string
  MCP_BRIDGE_PORT?: string
}

export type AgentConfig = {
  id: AgentId
  displayName: string
  format: "json" | "toml"
  configPaths: string[]
  configKey: string
  buildEntry: (env: BridgeEnv) => Record<string, unknown>
  detectPaths: string[]
}

export const BRIDGE_PACKAGE = "@questdb/mcp-bridge"
export const SERVER_NAME = "questdb"
// Pin the spawned bridge to the version that ran setup: a console expects a
// specific bridge version, so `npx @questdb/mcp-bridge@X setup` must write a
// config that launches @X (not whatever "latest" later resolves to).
export const BRIDGE_PACKAGE_SPEC = `${BRIDGE_PACKAGE}@${MCP_BRIDGE_VERSION}`
const NPX_ARGS = ["-y", BRIDGE_PACKAGE_SPEC]

const hasEnv = (env: BridgeEnv): boolean => Object.keys(env).length > 0

// Claude Code honors CLAUDE_CONFIG_DIR; otherwise the user-scope MCP servers
// live in ~/.claude.json (same file `claude mcp add --scope user` writes).
const claudeConfigDir = (): string =>
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
const claudeGlobalConfigPath = (): string =>
  process.env.CLAUDE_CONFIG_DIR
    ? join(claudeConfigDir(), ".claude.json")
    : join(homedir(), ".claude.json")

const jsonStdioEntry = (env: BridgeEnv): Record<string, unknown> => ({
  command: "npx",
  args: [...NPX_ARGS],
  ...(hasEnv(env) ? { env } : {}),
})

export const buildAgents = (): Record<AgentId, AgentConfig> => ({
  claude: {
    id: "claude",
    displayName: "Claude Code",
    format: "json",
    configPaths: [claudeGlobalConfigPath()],
    configKey: "mcpServers",
    buildEntry: jsonStdioEntry,
    detectPaths: [claudeGlobalConfigPath(), claudeConfigDir()],
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    format: "toml",
    configPaths: [join(homedir(), ".codex", "config.toml")],
    configKey: "mcp_servers",
    buildEntry: (env) => ({
      command: "npx",
      args: [...NPX_ARGS],
      ...(hasEnv(env) ? { env } : {}),
    }),
    detectPaths: [join(homedir(), ".codex")],
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    format: "json",
    configPaths: [join(homedir(), ".cursor", "mcp.json")],
    configKey: "mcpServers",
    buildEntry: jsonStdioEntry,
    detectPaths: [join(homedir(), ".cursor")],
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    format: "json",
    // OpenCode accepts several config filenames; write to whichever exists.
    configPaths: [
      join(homedir(), ".config", "opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
      join(homedir(), ".config", "opencode", ".opencode.json"),
      join(homedir(), ".config", "opencode", ".opencode.jsonc"),
    ],
    configKey: "mcp",
    buildEntry: (env) => ({
      type: "local",
      command: ["npx", ...NPX_ARGS],
      ...(hasEnv(env) ? { environment: env } : {}),
      enabled: true,
    }),
    detectPaths: [join(homedir(), ".config", "opencode")],
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini CLI",
    format: "json",
    configPaths: [join(homedir(), ".gemini", "settings.json")],
    configKey: "mcpServers",
    buildEntry: jsonStdioEntry,
    detectPaths: [join(homedir(), ".gemini")],
  },
})

export const ALL_AGENT_IDS: AgentId[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "gemini",
]
