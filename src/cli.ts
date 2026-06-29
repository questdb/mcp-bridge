// CLI argument and environment parsing, factored out of index.ts so the
// branching (exit codes, --version/--help, port validation) is unit-testable
// without importing index.ts — whose module load starts the whole bridge.

export type CliOutcome =
  | { kind: "start" }
  | { kind: "setup" }
  | { kind: "upgrade" }
  | { kind: "exit"; code: number; stdout?: string; stderr?: string }

// Pure mapping from argv to an outcome. The caller performs the actual writes
// and process.exit so this stays side-effect-free (and testable). --version and
// --help must not allocate a port or open a log file, hence parsed up front.
export const parseCli = (
  argv: string[],
  version: string,
  helpText: () => string,
): CliOutcome => {
  const command = argv[0]

  if (command === undefined || command === "start") return { kind: "start" }

  if (command === "setup") return { kind: "setup" }

  if (command === "upgrade") return { kind: "upgrade" }

  if (command === "-v" || command === "--version") {
    return { kind: "exit", code: 0, stdout: `${version}\n` }
  }

  if (command === "-h" || command === "--help") {
    return { kind: "exit", code: 0, stdout: helpText() }
  }

  return {
    kind: "exit",
    code: 2,
    stderr:
      `@questdb/mcp-bridge: unknown command '${command}'.\n` +
      `Run 'npx @questdb/mcp-bridge --help' for usage.\n`,
  }
}

export type PortChoice = { auto: true } | { pinned: number } | { error: string }

// Validate MCP_BRIDGE_PORT. Unset/empty → auto-allocate; a valid 1-65535 integer
// → pinned; anything else → an error the caller turns into a fatal exit(2).
export const parsePort = (raw: string | undefined): PortChoice => {
  if (raw === undefined || raw === "") return { auto: true }
  if (!/^\d+$/.test(raw)) {
    return { error: `MCP_BRIDGE_PORT=${raw} must be an integer` }
  }
  const n = Number(raw)
  if (n < 1 || n > 65535) {
    return { error: `MCP_BRIDGE_PORT=${raw} is out of range` }
  }
  return { pinned: n }
}
