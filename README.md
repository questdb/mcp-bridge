# `@questdb/mcp-bridge`

An MCP server that connects coding agents (Claude Code, Codex, Cursor, OpenCode …) to a
running QuestDB Web Console. The agent gets tools to create notebook
cells, run queries, and build charts. Every action executes in the
browser against your already-established QuestDB session.

## Setup

### Quick setup (recommended)

The interactive wizard detects your installed coding agents and
writes the bridge into each one's MCP config:

```bash
npx @questdb/mcp-bridge setup
```

It walks you through two steps:

1. **Pick agents**: multi-select from the ones it detects (Claude Code,
   Codex, Cursor, OpenCode, Gemini CLI).
2. **Review settings**: optionally override `CONSOLE_ORIGIN` and
   `MCP_BRIDGE_PORT`; press Enter to keep the defaults.

The wizard pins each agent's config to the bridge version that ran it. Your
QuestDB Web Console expects a specific bridge version. If you're on an older
console, run the matching version: `npx @questdb/mcp-bridge@<version> setup`. The config it writes will launch that same version. (When unsure, pair first; on a version mismatch the agent is told which version to switch to.)

### Manual setup

Or add it to your MCP client's config by hand (e.g. `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "questdb": {
      "command": "npx",
      "args": ["-y", "@questdb/mcp-bridge"]
    }
  }
}
```

### Environment variables

| Label             | Value                                | Default Value                                          | Description                                                                              |
| ----------------- | ------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `CONSOLE_ORIGIN`  | origin URL                           | `http://127.0.0.1:9000`                          | QuestDB Web Console origin. `127.0.0.1` and `localhost` are interchangeable.       |
| `MCP_BRIDGE_PORT` | `1`–`65535`                          | auto-allocated                                   | When specified, the bridge uses a fixed port. Bridge fails to start if specified port is taken.                                  |
| `LOG_PATH`        | file path                            | `/tmp/questdb-mcp-bridge/<ISO-ts>-<pid>.log`     | Override the log file location.                                                    |
| `LOG_LEVEL`       | `ERROR` / `WARN` / `INFO` / `DEBUG`  | `INFO`                                           | `DEBUG` adds heartbeats and full tool payloads.                                    |


## Commands

Your MCP client runs the bridge for you via the config above, so you
rarely invoke it by hand. When you do:

| Command                             | Description                              |
| ----------------------------------- | ---------------------------------------- |
| `npx @questdb/mcp-bridge` (no args) | Start the bridge — same as `start`.      |
| `npx @questdb/mcp-bridge start`     | Start the bridge.                        |
| `npx @questdb/mcp-bridge setup`     | Interactively configure the bridge for your coding agents. |
| `npx @questdb/mcp-bridge --version` | Print the version and exit. Alias: `-v`. |
| `npx @questdb/mcp-bridge --help`    | Print this help and exit. Alias: `-h`.   |

An unknown command exits non-zero with a short error. Pin a version with
`npx @questdb/mcp-bridge@0.1.0 start`. (Installed on your `PATH`, the
executable is named `questdb-mcp-bridge`.)


## Pairing

Before any notebook / chart / SQL tool works, your browser has to pair
with the bridge. The agent drives the flow.

When the agent needs to pair, it calls `get_pairing_credentials` and
shows you **both**:

- A one-click deep link — open it in the tab showing your Web Console.
- A WebSocket URL + token — paste into the **MCP pill** at the bottom
  of the Web Console if the deep link doesn't land in the right tab.

Either path lands you on a consent prompt. Accept it and the agent's
next tool call goes through.

Each bridge run generates a fresh port and pairing token, held only in
memory. On restart the old credentials stop working — the agent will
surface new ones the next time it needs to pair.


## Logs

The bridge writes to stderr and to a log file. Tail the newest:

```bash
tail -F "$(ls -t /tmp/questdb-mcp-bridge/*.log | head -1)"
```

At default `INFO`:

```
2026-05-15T12:29:27.142Z [INFO] tool_call: run_query
2026-05-15T12:29:27.318Z [INFO] tool_result: run_query ok
2026-05-15T12:29:28.011Z [ERROR] tool_result: update_cell internal_error timeout after 15000ms
```

At `DEBUG` (full payloads as continuation lines):

```
2026-05-15T12:29:27.142Z [INFO] tool_call: run_query
2026-05-15T12:29:27.142Z [DEBUG]   args: {"query":"SELECT count() FROM trades"}
2026-05-15T12:29:27.318Z [INFO] tool_result: run_query ok
2026-05-15T12:29:27.318Z [DEBUG]   content: [{"type":"text","text":"..."}]
```


## License

Apache-2.0.
