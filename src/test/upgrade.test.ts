import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parseCli } from "../cli.js"
import type { AgentConfig } from "../setup/agents.js"
import { rewriteBridgePin, upgradeAgent } from "../setup/runUpgrade.js"

const fakeAgent = (configPaths: string[]): AgentConfig => ({
  id: "claude",
  displayName: "Test Agent",
  format: "json",
  configPaths,
  configKey: "mcpServers",
  buildEntry: () => ({}),
  detectPaths: [],
})

describe("parseCli — upgrade", () => {
  it("routes the upgrade command to the upgrade outcome", () => {
    expect(parseCli(["upgrade"], "1.2.3", () => "")).toEqual({
      kind: "upgrade",
    })
  })
})

describe("rewriteBridgePin", () => {
  it("re-pins a JSON entry to the target, preserving env and other args", () => {
    const raw = JSON.stringify(
      {
        mcpServers: {
          questdb: {
            command: "npx",
            args: ["-y", "@questdb/mcp-bridge@0.1.0"],
            env: { CONSOLE_ORIGIN: "http://x" },
          },
        },
      },
      null,
      2,
    )
    const { content, from } = rewriteBridgePin(raw, "0.2.0")
    expect(from).toBe("0.1.0")
    const parsed = JSON.parse(content) as {
      mcpServers: { questdb: { args: string[]; env: Record<string, string> } }
    }
    expect(parsed.mcpServers.questdb.args).toEqual([
      "-y",
      "@questdb/mcp-bridge@0.2.0",
    ])
    expect(parsed.mcpServers.questdb.env).toEqual({
      CONSOLE_ORIGIN: "http://x",
    })
  })

  it("pins a previously unpinned spec", () => {
    const { content, from } = rewriteBridgePin(
      'args = ["-y", "@questdb/mcp-bridge"]',
      "0.2.0",
    )
    expect(from).toBe("unpinned")
    expect(content).toContain("@questdb/mcp-bridge@0.2.0")
  })

  it("is a no-op when already at the target (idempotent)", () => {
    const raw = 'args = ["-y", "@questdb/mcp-bridge@0.2.0"]'
    expect(rewriteBridgePin(raw, "0.2.0").content).toBe(raw)
  })

  it("rewrites a TOML (codex) entry without touching the rest", () => {
    const raw =
      '[mcp_servers.questdb]\ncommand = "npx"\n' +
      'args = ["-y", "@questdb/mcp-bridge@0.1.0"]\n'
    const { content } = rewriteBridgePin(raw, "0.2.0")
    expect(content).toContain("@questdb/mcp-bridge@0.2.0")
    expect(content).toContain('command = "npx"')
  })
})

describe("upgradeAgent", () => {
  it("re-pins a config that references the bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qdb-upgrade-"))
    const path = join(dir, "config.json")
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          questdb: { command: "npx", args: ["-y", "@questdb/mcp-bridge@0.1.0"] },
        },
      }),
    )
    const r = await upgradeAgent(fakeAgent([path]), "0.2.0")
    expect(r.kind).toBe("updated")
    if (r.kind === "updated") expect(r.from).toBe("0.1.0")
  })

  it("reports absent for a missing config (ENOENT)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qdb-upgrade-"))
    const r = await upgradeAgent(fakeAgent([join(dir, "nope.json")]), "0.2.0")
    expect(r.kind).toBe("absent")
  })

  it("reports failed (not absent) for a present-but-unreadable config", async () => {
    // A directory where a file is expected: it exists, so it's not ENOENT —
    // reading it fails (EISDIR). It must surface as a failure, never be
    // silently skipped as if the bridge spec weren't there.
    const dir = mkdtempSync(join(tmpdir(), "qdb-upgrade-"))
    const r = await upgradeAgent(fakeAgent([dir]), "0.2.0")
    expect(r.kind).toBe("failed")
  })
})
