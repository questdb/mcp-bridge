import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { BRIDGE_PACKAGE, buildAgents, type AgentConfig } from "./agents.js"
import { resolveConfigPath } from "./applyConfig.js"
import { readRawFileOrNull, writeRawFile } from "./configWriter.js"

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Rewrites every `@questdb/mcp-bridge[@<ver>]` spec in the raw config text to the
// target version, leaving everything else (env, extra args, comments,
// formatting) untouched — format-agnostic across JSON and TOML. Returns the new
// text and the first version it found ("unpinned" if the spec had none).
export const rewriteBridgePin = (
  raw: string,
  target: string,
): { content: string; from: string | null } => {
  const re = new RegExp(`${escapeRe(BRIDGE_PACKAGE)}(@[\\w.\\-]+)?`, "g")
  let from: string | null = null
  const content = raw.replace(re, (_m, ver: string | undefined) => {
    if (from === null) from = ver ? ver.slice(1) : "unpinned"
    return `${BRIDGE_PACKAGE}@${target}`
  })
  return { content, from }
}

type AgentOutcome =
  | { agent: string; kind: "updated"; from: string; path: string }
  | { agent: string; kind: "current"; path: string }
  | { agent: string; kind: "absent" }
  | { agent: string; kind: "failed"; path: string; error: string }

export const upgradeAgent = async (
  agent: AgentConfig,
  target: string,
): Promise<AgentOutcome> => {
  const path = await resolveConfigPath(agent.configPaths)
  let raw: string | null
  try {
    raw = await readRawFileOrNull(path)
  } catch (err) {
    // The file exists but couldn't be read (permissions, a directory in the
    // path). It may still pin the bridge, so surface a failure rather than
    // silently skipping it and exiting 0.
    return {
      agent: agent.displayName,
      kind: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (raw === null || !raw.includes(BRIDGE_PACKAGE)) {
    return { agent: agent.displayName, kind: "absent" }
  }
  const { content, from } = rewriteBridgePin(raw, target)
  if (content === raw)
    return { agent: agent.displayName, kind: "current", path }
  try {
    await writeRawFile(path, content)
  } catch (err) {
    return {
      agent: agent.displayName,
      kind: "failed",
      path,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  return {
    agent: agent.displayName,
    kind: "updated",
    from: from ?? "unpinned",
    path,
  }
}

export const runUpgrade = async (): Promise<number> => {
  const target = MCP_BRIDGE_VERSION
  const agents = buildAgents()
  console.log(
    `@questdb/mcp-bridge upgrade — pinning coding-agent configs to v${target}\n`,
  )

  const reported: string[] = []
  let changed = 0
  let failed = 0
  for (const agent of Object.values(agents)) {
    const r = await upgradeAgent(agent, target)
    if (r.kind === "updated") {
      reported.push(`  ✓ ${r.agent}: ${r.from} → ${target}  (${r.path})`)
      changed++
    } else if (r.kind === "current") {
      reported.push(`  • ${r.agent}: already v${target}`)
    } else if (r.kind === "failed") {
      reported.push(`  ✗ ${r.agent}: ${r.error}  (${r.path})`)
      failed++
    }
    // "absent" agents (no questdb spec configured) stay silent.
  }

  if (reported.length === 0) {
    console.log(
      `  No coding-agent config references @questdb/mcp-bridge.\n` +
        `  Run \`npx @questdb/mcp-bridge@${target} setup\` to configure one.`,
    )
  } else {
    console.log(reported.join("\n"))
  }
  if (changed > 0) {
    console.log(
      `\nRestart your coding agent (or reload its MCP servers) so v${target} launches.`,
    )
  }
  return failed > 0 ? 1 : 0
}
