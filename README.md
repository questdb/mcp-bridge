# `@questdb/mcp-bridge`

An MCP server that connects coding agents (Claude Code, Codex, …) to a
running QuestDB Web Console. The agent gets tools to create notebook
cells, run queries, and build charts; every action executes in the
browser against your already-authenticated QuestDB.

## Setup

Add to your MCP client's config (e.g. `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "questdb": {
      "command": "npx",
      "args": ["-y", "@questdb/mcp-bridge"],
      "env": { "CONSOLE_ORIGIN": "http://127.0.0.1:9000" }
    }
  }
}
```

Point `CONSOLE_ORIGIN` at your QuestDB Web Console. Defaults to
`http://127.0.0.1:9000`. The bridge auto-accepts both `127.0.0.1` and
`localhost` for loopback origins; any other host must match exactly.

## Pairing

The first time the agent reaches for a notebook tool, it presents a
one-click URL. Open it in the browser tab already showing your QuestDB
Web Console, accept the consent prompt, and the agent's next call goes
through.

Each bridge run generates a fresh port and pairing token, held only in
memory. If the bridge restarts (Claude Code respawn, manual restart),
the old URL stops working — ask the agent for a new one.

To pin a stable port (rare; useful only for a fixed deep link), set
`MCP_BRIDGE_PORT`. If that port is already in use, the bridge fails to
start.

## License

Apache-2.0.
