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
import { Logger } from "./logger.js"
import { readFileSync } from "node:fs"
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
  npx @questdb/mcp-bridge --version  Print the version and exit
  npx @questdb/mcp-bridge --help     Print this help and exit
`

const printHelp = (): void => {
  try {
    const readmePath = fileURLToPath(new URL("../README.md", import.meta.url))
    process.stdout.write(readFileSync(readmePath, "utf8"))
  } catch {
    process.stdout.write(USAGE)
  }
}

// Parse argv before any logger/server side effects so --version and --help
// stay pure (no log file, no port allocation) and exit immediately.
const runCli = (argv: string[]): void => {
  const command = argv[0]

  if (command === undefined || command === "start") return

  if (command === "-v" || command === "--version") {
    process.stdout.write(`${MCP_BRIDGE_VERSION}\n`)
    process.exit(0)
  }

  if (command === "-h" || command === "--help") {
    printHelp()
    process.exit(0)
  }

  process.stderr.write(
    `@questdb/mcp-bridge: unknown command '${command}'.\n` +
      `Run 'npx @questdb/mcp-bridge --help' for usage.\n`,
  )
  process.exit(2)
}

runCli(process.argv.slice(2))

const logger = new Logger()
const { log, fatal } = logger

const main = async () => {
  const portRaw = process.env.MCP_BRIDGE_PORT
  let port: number
  if (portRaw !== undefined && portRaw !== "") {
    if (!/^\d+$/.test(portRaw)) {
      fatal(`MCP_BRIDGE_PORT=${portRaw} must be an integer`, 2)
    }
    const n = Number(portRaw)
    if (n < 1 || n > 65535) {
      fatal(`MCP_BRIDGE_PORT=${portRaw} is out of range`, 2)
    }
    port = n
  } else {
    port = await findFreePort()
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
      isPinned: !!portRaw,
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

  let shuttingDown = false
  let exitCode = 0
  const SHUTDOWN_STEP_BUDGET_MS = 2_000
  const SHUTDOWN_HARD_BUDGET_MS = 5_000
  const withTimeout = (
    p: Promise<unknown>,
    ms: number,
  ): Promise<unknown> =>
    Promise.race([
      p.catch(() => undefined),
      new Promise<void>((res) => setTimeout(res, ms).unref()),
    ])
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    const safety = setTimeout(
      () => process.exit(1),
      SHUTDOWN_HARD_BUDGET_MS,
    ).unref()
    try {
      await withTimeout(mcp.stop(), SHUTDOWN_STEP_BUDGET_MS)
    } catch (err) {
      void err
    }
    if (stopWs) {
      try {
        await withTimeout(stopWs(), SHUTDOWN_STEP_BUDGET_MS)
      } catch (err) {
        void err
      }
    }
    clearTimeout(safety)
    process.exit(exitCode)
  }

  fatalShutdown = (kind, err) => {
    log("ERROR", `fatal (${kind}):`, err.message)
    if (kind === "fd-exhaustion") {
      exitCode = 3
    }
    void shutdown()
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  process.stdin.on("end", () => void shutdown())
  process.stdin.on("close", () => void shutdown())
}

main().catch((err: unknown) => {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
  fatal(`startup error: ${text}`, 1)
})
