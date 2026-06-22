import { access } from "node:fs/promises"
import type { AgentConfig, AgentId, BridgeEnv } from "./agents.js"
import { SERVER_NAME } from "./agents.js"
import {
  readRawFile,
  upsertJsonServer,
  upsertTomlServer,
  writeRawFile,
} from "./configWriter.js"

export type ApplyResult = {
  agent: string
  path: string
  status: "configured" | "reconfigured" | "failed"
  error?: string
}

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export const detectInstalledAgents = async (
  agents: Record<AgentId, AgentConfig>,
): Promise<Set<AgentId>> => {
  const detected = new Set<AgentId>()
  for (const agent of Object.values(agents)) {
    for (const p of agent.detectPaths) {
      if (await pathExists(p)) {
        detected.add(agent.id)
        break
      }
    }
  }
  return detected
}

// First candidate that already exists, else the first (canonical) one.
export const resolveConfigPath = async (candidates: string[]): Promise<string> => {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  return candidates[0]
}

export const applyAgentConfig = async (
  agent: AgentConfig,
  env: BridgeEnv,
): Promise<ApplyResult> => {
  const entry = agent.buildEntry(env)
  const path = await resolveConfigPath(agent.configPaths)
  try {
    const raw = await readRawFile(path)
    const { content, alreadyExists } =
      agent.format === "toml"
        ? upsertTomlServer(raw, agent.configKey, SERVER_NAME, entry)
        : upsertJsonServer(raw, agent.configKey, SERVER_NAME, entry)
    await writeRawFile(path, content)
    return {
      agent: agent.displayName,
      path,
      status: alreadyExists ? "reconfigured" : "configured",
    }
  } catch (err) {
    return {
      agent: agent.displayName,
      path,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
