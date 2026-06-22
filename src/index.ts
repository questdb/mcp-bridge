#!/usr/bin/env node
import { findFreePort, generateToken } from "./sessionStore.js"
import { BridgeSession } from "./bridgeSession.js"
import { MCP_BRIDGE_VERSION } from "./protocolVersion.js"
import {
  startWsServer,
  deriveAllowedOrigins,
  InvalidConsoleOriginError,
} from "./wsServer.js"
import { startMcpServer } from "./mcpServer.js"
import { bindWithRetry, type AttemptListenFn } from "./bindWithRetry.js"
import { createShutdownController } from "./shutdown.js"
import { parseCli, parsePort } from "./cli.js"
import { Logger } from "./logger.js"
import { readFileSync, writeSync } from "node:fs"
import { fileURLToPath } from "node:url"

const DEFAULT_CONSOLE_ORIGIN = "http://127.0.0.1:9000"

const PER_TOOL_TIMEOUT_MS: Record<string, number> = {
  run_cell: 300_000,
  run_query: 300_000,
  apply_notebook_state: 300_000,
  create_notebook: 15_000,
  add_cell: 15_000,
  update_cell: 15_000,
  delete_cell: 15_000,
  duplicate_cell: 15_000,
  move_cell_up: 15_000,
  move_cell_down: 15_000,
  set_layout_mode: 15_000,
  set_cell_layout: 15_000,
  set_cell_mode: 15_000,
  set_cell_chart_config: 15_000,
  set_cell_autorefresh: 15_000,
  set_cell_chart_maximized: 15_000,
  set_cell_maximized: 15_000,
  list_cells: 15_000,
  get_cell: 15_000,
  get_notebook_state: 15_000,
  get_workspace_state: 15_000,
  get_recent_user_actions: 15_000,
}

const USAGE = `@questdb/mcp-bridge — bridge coding agents to a running QuestDB Web Console.

Usage:
  npx @questdb/mcp-bridge [start]    Start the bridge (default when no command is given)
  npx @questdb/mcp-bridge setup      Configure the bridge for your coding agents (interactive)
  npx @questdb/mcp-bridge --version  Print the version and exit
  npx @questdb/mcp-bridge --help     Print this help and exit
`

// Synchronous, best-effort writes to a standard fd.
const writeFd = (fd: number, text: string): void => {
  try {
    writeSync(fd, text)
  } catch {
    /* nothing actionable if the output target rejects the write */
  }
}

const helpText = (): string => {
  try {
    const readmePath = fileURLToPath(new URL("../README.md", import.meta.url))
    return readFileSync(readmePath, "utf8")
  } catch {
    // README not readable (missing in the install, permissions, sandbox).
    return USAGE
  }
}

// Parse argv before any logger/server side effects so --version and --help
// stay pure (no log file, no port allocation) and exit immediately.
const cli = parseCli(process.argv.slice(2), MCP_BRIDGE_VERSION, helpText)
if (cli.kind === "exit") {
  if (cli.stdout !== undefined) writeFd(process.stdout.fd, cli.stdout)
  if (cli.stderr !== undefined) writeFd(process.stderr.fd, cli.stderr)
  process.exit(cli.code)
}

if (cli.kind === "setup") {
  const { runSetup } = await import("./setup/runSetup.js")
  const code = await runSetup()
  process.exit(code)
}

const logger = new Logger()
const { log, fatal } = logger

const main = async () => {
  const portChoice = parsePort(process.env.MCP_BRIDGE_PORT)
  if ("error" in portChoice) {
    fatal(portChoice.error, 2)
  }
  let port: number
  let isPinned: boolean
  if ("pinned" in portChoice) {
    port = portChoice.pinned
    isPinned = true
  } else {
    port = await findFreePort()
    isPinned = false
  }

  const consoleOrigin = process.env.CONSOLE_ORIGIN ?? DEFAULT_CONSOLE_ORIGIN
  let allowedOrigins: string[]
  try {
    allowedOrigins = deriveAllowedOrigins(consoleOrigin)
  } catch (err) {
    if (err instanceof InvalidConsoleOriginError) {
      fatal(err.message, 2)
    }
    throw err
  }

  const token = generateToken()

  const session = new BridgeSession({
    token,
    getPort: () => port,
    consoleOrigin,
    getDeadlineMs: (toolName) => PER_TOOL_TIMEOUT_MS[toolName] ?? 15_000,
    log,
  })

  let stopWs: (() => Promise<void>) | null = null

  let fatalShutdown: (kind: string, err: Error) => void = (kind, err) => {
    log("ERROR", `fatal (${kind}) before shutdown wired:`, err)
    process.exit(3)
  }
  const attemptListen: AttemptListenFn = (p) =>
    startWsServer({
      port: p,
      token,
      allowedOrigins,
      session,
      log,
      onFatalError: (kind, err) => fatalShutdown(kind, err),
    })
  try {
    const bound = await bindWithRetry({
      port,
      isPinned,
      attemptListen,
      findFreePort,
      log,
    })
    stopWs = bound.stop
    port = bound.port
  } catch (err) {
    const code = (err as Error & { code?: string }).code
    if (code === "port-pinned-in-use" || code === "port-exhausted") {
      fatal(err instanceof Error ? err.message : String(err), 2)
    }
    fatal(err instanceof Error ? err.message : String(err), 1)
  }

  const mcp = await startMcpServer({ session, log })

  log("INFO", `@questdb/mcp-bridge v${MCP_BRIDGE_VERSION}`)
  log("INFO", `listening on ws://127.0.0.1:${port}`)
  log("INFO", `console origin: ${consoleOrigin}`)
  log(
    "INFO",
    `log file: ${logger.getFilePath() ?? "(disabled — stderr only)"}`,
  )
  log("INFO", `log level: ${logger.getLevelName()}`)

  const SHUTDOWN_STEP_BUDGET_MS = 2_000
  const SHUTDOWN_HARD_BUDGET_MS = 5_000
  const { shutdown, requestFatal } = createShutdownController({
    stopMcp: () => mcp.stop(),
    getStopWs: () => stopWs,
    exit: (code: number) => process.exit(code),
    log,
    stepBudgetMs: SHUTDOWN_STEP_BUDGET_MS,
    hardBudgetMs: SHUTDOWN_HARD_BUDGET_MS,
  })
  fatalShutdown = (kind, err) => void requestFatal(kind, err)

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  process.stdin.on("end", () => void shutdown())
  process.stdin.on("close", () => void shutdown())
}

main().catch((err: unknown) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  fatal(`startup error: ${text}`, 1)
})
