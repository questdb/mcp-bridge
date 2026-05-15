# `@questdb/mcp-bridge`

An MCP server that connects coding agents (Claude Code, Codex, Cursor, OpenCode …) to a
running QuestDB Web Console. The agent gets tools to create notebook
cells, run queries, and build charts. Every action executes in the
browser against your already-established QuestDB session.

## Setup

Add to your MCP client's config (e.g. `~/.claude/.mcp.json`):

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

| Label             | Value                                | Default Value                                          | Description                                                                              |
| ----------------- | ------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `CONSOLE_ORIGIN`  | origin URL                           | `http://127.0.0.1:9000`                          | QuestDB Web Console origin. `127.0.0.1` and `localhost` are interchangeable.       |
| `MCP_BRIDGE_PORT` | `1`–`65535`                          | auto-allocated                                   | When specified, the bridge uses a fixed port. Bridge fails to start if specified port is taken.                                  |
| `LOG_PATH`        | file path                            | `/tmp/questdb-mcp-bridge/<ISO-ts>-<pid>.log`     | Override the log file location.                                                    |
| `LOG_LEVEL`       | `ERROR` / `WARN` / `INFO` / `DEBUG`  | `INFO`                                           | `DEBUG` adds heartbeats and full tool payloads.                                    |


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
