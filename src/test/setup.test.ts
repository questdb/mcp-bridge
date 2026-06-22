import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseCli } from "../cli.js"
import { buildAgents, BRIDGE_PACKAGE_SPEC } from "../setup/agents.js"
import { resolveConfigPath } from "../setup/applyConfig.js"
import {
  buildBridgeEnv,
  validateConsoleOrigin,
  validatePort,
} from "../setup/env.js"
import {
  buildTomlServerBlock,
  upsertJsonServer,
  upsertTomlServer,
} from "../setup/configWriter.js"

describe("parseCli", () => {
  it("routes the setup command to the setup outcome", () => {
    // Given the `setup` argument
    const argv = ["setup"]

    // When parsing the CLI
    const outcome = parseCli(argv, "1.2.3", () => "")

    // Then it resolves to the setup outcome
    expect(outcome).toEqual({ kind: "setup" })
  })
})

describe("agents — buildEntry", () => {
  it("emits a bare {command,args} entry when no env is set", () => {
    // Given the JSON agents and an empty env
    const agents = buildAgents()

    // When building each entry
    // Then no env block is attached and the bridge spec is version-pinned
    for (const id of ["claude", "cursor", "gemini"] as const) {
      expect(agents[id].buildEntry({})).toEqual({
        command: "npx",
        args: ["-y", BRIDGE_PACKAGE_SPEC],
      })
    }
  })

  it("attaches an env block when env has keys", () => {
    // Given an env override
    const agents = buildAgents()
    const env = { CONSOLE_ORIGIN: "https://q.example.com" }

    // When building Claude's entry
    const entry = agents.claude.buildEntry(env)

    // Then the env is included
    expect(entry).toEqual({
      command: "npx",
      args: ["-y", BRIDGE_PACKAGE_SPEC],
      env,
    })
  })

  it("gives OpenCode its array command, `environment`, and enabled flag", () => {
    // Given OpenCode with and without env
    const agents = buildAgents()

    // When building its entries
    // Then it uses OpenCode's distinct shape
    expect(agents.opencode.buildEntry({})).toEqual({
      type: "local",
      command: ["npx", "-y", BRIDGE_PACKAGE_SPEC],
      enabled: true,
    })
    expect(agents.opencode.buildEntry({ MCP_BRIDGE_PORT: "9009" })).toEqual({
      type: "local",
      command: ["npx", "-y", BRIDGE_PACKAGE_SPEC],
      environment: { MCP_BRIDGE_PORT: "9009" },
      enabled: true,
    })
  })

  it("uses TOML only for Codex and JSON for the rest", () => {
    // Given all agents
    const agents = buildAgents()

    // When inspecting their formats
    // Then only Codex is TOML
    expect(agents.codex.format).toBe("toml")
    expect(agents.codex.configKey).toBe("mcp_servers")
    for (const id of ["claude", "cursor", "gemini", "opencode"] as const) {
      expect(agents[id].format).toBe("json")
    }
  })
})

describe("resolveConfigPath", () => {
  it("targets the first candidate that already exists", async () => {
    // Given two candidates where only the second exists on disk
    const dir = mkdtempSync(join(tmpdir(), "qdb-setup-"))
    const canonical = join(dir, "opencode.json")
    const existing = join(dir, "opencode.jsonc")
    writeFileSync(existing, "{}")

    // When resolving the path
    const resolved = await resolveConfigPath([canonical, existing])

    // Then the existing file wins
    expect(resolved).toBe(existing)
  })

  it("falls back to the canonical candidate when none exist", async () => {
    // Given two candidates, neither on disk
    const dir = mkdtempSync(join(tmpdir(), "qdb-setup-"))
    const canonical = join(dir, "opencode.json")
    const variant = join(dir, "opencode.jsonc")

    // When resolving the path
    const resolved = await resolveConfigPath([canonical, variant])

    // Then it falls back to the first (canonical) candidate
    expect(resolved).toBe(canonical)
  })

  it("gives every agent a candidate, and OpenCode several", () => {
    // Given all agents
    const agents = buildAgents()

    // When inspecting their candidate paths
    // Then each has at least one, and OpenCode has variants
    for (const id of ["claude", "codex", "cursor", "opencode", "gemini"] as const) {
      expect(agents[id].configPaths.length).toBeGreaterThan(0)
    }
    expect(agents.opencode.configPaths.length).toBeGreaterThan(1)
  })
})

describe("validateConsoleOrigin", () => {
  it("accepts blank and http/https origins", () => {
    // Given blank and well-formed origins
    // When validating each
    // Then all pass
    expect(validateConsoleOrigin("")).toBe(true)
    expect(validateConsoleOrigin("http://127.0.0.1:9000")).toBe(true)
    expect(validateConsoleOrigin("https://q.example.com")).toBe(true)
  })

  it("rejects junk and non-http schemes with a reason", () => {
    // Given an unparseable string and an ftp origin
    // When validating each
    // Then each returns a human-readable reason
    expect(typeof validateConsoleOrigin("not a url")).toBe("string")
    expect(typeof validateConsoleOrigin("ftp://x")).toBe("string")
  })
})

describe("validatePort", () => {
  it("accepts auto, blank, and a valid port", () => {
    // Given the sentinel, blank, and an in-range port
    // When validating each
    // Then all pass
    expect(validatePort("auto")).toBe(true)
    expect(validatePort("")).toBe(true)
    expect(validatePort("9000")).toBe(true)
  })

  it("rejects a non-numeric and an out-of-range port with a reason", () => {
    // Given bad port strings
    // When validating each
    // Then each returns a reason
    expect(typeof validatePort("abc")).toBe("string")
    expect(typeof validatePort("70000")).toBe("string")
  })
})

describe("buildBridgeEnv", () => {
  const defaults = {
    consoleOrigin: "http://127.0.0.1:9000",
    port: "auto",
  }

  it("emits nothing when every answer is left at its default", () => {
    // Given the default answers
    // When building the env
    const env = buildBridgeEnv(defaults)

    // Then it is empty
    expect(env).toEqual({})
  })

  it("treats a trailing-slash default origin as unchanged", () => {
    // Given the default origin with a trailing slash
    const answers = { ...defaults, consoleOrigin: "http://127.0.0.1:9000/" }

    // When building the env
    const env = buildBridgeEnv(answers)

    // Then the normalized origin still matches the default and is omitted
    expect(env).toEqual({})
  })

  it("emits each changed var, normalizing the origin and port", () => {
    // Given overridden answers
    const answers = { consoleOrigin: "https://q.example.com:9000", port: "9009" }

    // When building the env
    const env = buildBridgeEnv(answers)

    // Then both are emitted in normalized form
    expect(env).toEqual({
      CONSOLE_ORIGIN: "https://q.example.com:9000",
      MCP_BRIDGE_PORT: "9009",
    })
  })
})

describe("upsertJsonServer", () => {
  it("creates the section on an empty file", () => {
    // Given an empty file
    // When upserting our server
    const { content, alreadyExists } = upsertJsonServer("", "mcpServers", "questdb", {
      command: "npx",
    })

    // Then a fresh section is written
    expect(alreadyExists).toBe(false)
    expect(JSON.parse(content)).toEqual({ mcpServers: { questdb: { command: "npx" } } })
  })

  it("preserves sibling servers and other top-level keys", () => {
    // Given a config with another server and an unrelated key
    const existing = '{ "$schema": "x", "mcpServers": { "other": { "command": "other" } } }'

    // When upserting our server
    const { content, alreadyExists } = upsertJsonServer(existing, "mcpServers", "questdb", {
      command: "npx",
    })

    // Then the sibling and the key survive alongside ours
    expect(alreadyExists).toBe(false)
    expect(JSON.parse(content)).toEqual({
      $schema: "x",
      mcpServers: { other: { command: "other" }, questdb: { command: "npx" } },
    })
  })

  it("preserves comments and formatting in a JSONC file", () => {
    // Given a JSONC file with a comment and a sibling server
    const existing = [
      "{",
      "  // keep my server",
      '  "mcpServers": {',
      '    "other": { "command": "other" }',
      "  }",
      "}",
      "",
    ].join("\n")

    // When upserting our server
    const { content } = upsertJsonServer(existing, "mcpServers", "questdb", {
      command: "npx",
    })

    // Then the comment survives and our server is added alongside the sibling
    expect(content).toContain("// keep my server")
    expect(content).toContain('"questdb"')
    expect(content).toContain('"other"')
  })

  it("is idempotent and reports alreadyExists on a re-upsert", () => {
    // Given a config that already has our server
    const entry = { command: "npx", args: ["-y", "@questdb/mcp-bridge"] }
    const first = upsertJsonServer("", "mcpServers", "questdb", entry)

    // When upserting the same entry again
    const second = upsertJsonServer(first.content, "mcpServers", "questdb", entry)

    // Then it reports a reconfigure and the config is unchanged
    expect(second.alreadyExists).toBe(true)
    expect(JSON.parse(second.content)).toEqual(JSON.parse(first.content))
  })

  it("refuses to touch a structurally invalid file", () => {
    // Given a file with a genuine syntax error (a dropped closing brace)
    const broken = '{ "mcpServers": { "other": { "command": "x" }'

    // When upserting our server
    // Then it throws rather than writing still-broken output
    expect(() =>
      upsertJsonServer(broken, "mcpServers", "questdb", { command: "npx" }),
    ).toThrow()
  })

  it("accepts valid JSONC with comments and trailing commas", () => {
    // Given a valid JSONC file (comment + trailing comma)
    const jsonc = '{\n  // c\n  "mcpServers": {\n    "other": { "command": "x" },\n  }\n}'

    // When upserting our server
    // Then it does not abort, and adds our server
    let content = ""
    expect(() => {
      content = upsertJsonServer(jsonc, "mcpServers", "questdb", { command: "npx" }).content
    }).not.toThrow()
    expect(content).toContain('"questdb"')
  })
})

describe("upsertTomlServer", () => {
  const entry = {
    command: "npx",
    args: ["-y", "@questdb/mcp-bridge"],
    env: { LOG_LEVEL: "DEBUG" },
  }

  it("appends a new block with an env subtable", () => {
    // Given an empty config
    // When upserting our server
    const { content, alreadyExists } = upsertTomlServer("", "mcp_servers", "questdb", entry)

    // Then a fresh block with its env subtable is written
    expect(alreadyExists).toBe(false)
    expect(content).toContain("[mcp_servers.questdb]")
    expect(content).toContain('command = "npx"')
    expect(content).toContain("[mcp_servers.questdb.env]")
    expect(content).toContain('LOG_LEVEL = "DEBUG"')
  })

  it("preserves a pre-existing unrelated section", () => {
    // Given a config with another section
    const existing = "[other]\nx = 1\n"

    // When upserting our server
    const { content } = upsertTomlServer(existing, "mcp_servers", "questdb", entry)

    // Then the other section survives alongside ours
    expect(content).toContain("[other]")
    expect(content).toContain("x = 1")
    expect(content).toContain("[mcp_servers.questdb]")
  })

  it("is idempotent: re-upserting the same entry is a no-op", () => {
    // Given a config already containing our server
    const first = upsertTomlServer("[other]\nx = 1\n", "mcp_servers", "questdb", entry)

    // When upserting the same entry again
    const second = upsertTomlServer(first.content, "mcp_servers", "questdb", entry)

    // Then the content is unchanged and reports a reconfigure
    expect(second.alreadyExists).toBe(true)
    expect(second.content).toBe(first.content)
  })

  it("matches a header carrying an inline comment instead of duplicating it", () => {
    // Given an existing block whose header carries a trailing comment
    const existing = '[mcp_servers.questdb] # my notes\ncommand = "old"\n'

    // When upserting our server
    const { content, alreadyExists } = upsertTomlServer(
      existing,
      "mcp_servers",
      "questdb",
      entry,
    )

    // Then it replaces the block in place — exactly one header, no duplicate table
    expect(alreadyExists).toBe(true)
    expect(content.match(/\[mcp_servers\.questdb\]/g)?.length).toBe(1)
    expect(content).not.toContain('command = "old"')
  })

  it("replaces an existing block instead of duplicating it", () => {
    // Given a config with our server at LOG_LEVEL=DEBUG
    const first = upsertTomlServer("", "mcp_servers", "questdb", entry)

    // When upserting with a different env value
    const changed = upsertTomlServer(first.content, "mcp_servers", "questdb", {
      ...entry,
      env: { LOG_LEVEL: "WARN" },
    })

    // Then the block is replaced in place, leaving exactly one header
    expect(changed.alreadyExists).toBe(true)
    expect(changed.content).toContain('LOG_LEVEL = "WARN"')
    expect(changed.content).not.toContain('LOG_LEVEL = "DEBUG"')
    expect(changed.content.match(/\[mcp_servers\.questdb\]/g)?.length).toBe(1)
  })

  it("omits the env subtable when env is empty", () => {
    // Given an entry without env
    const envless = { command: "npx", args: ["-y", "@questdb/mcp-bridge"] }

    // When building its TOML block
    const block = buildTomlServerBlock("mcp_servers", "questdb", envless)

    // Then no env subtable is emitted
    expect(block).toContain("[mcp_servers.questdb]")
    expect(block).not.toContain(".env]")
  })
})
