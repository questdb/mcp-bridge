import { parsePort } from "../cli.js"
import type { BridgeEnv } from "./agents.js"

export const DEFAULT_CONSOLE_ORIGIN = "http://127.0.0.1:9000"
export const DEFAULT_PORT_LABEL = "auto"

export type SetupAnswers = {
  consoleOrigin: string
  port: string
}

export const validateConsoleOrigin = (raw: string): true | string => {
  const value = raw.trim()
  if (value === "") return true // blank → keep the default
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `Not a valid URL: ${value}`
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Origin must use http:// or https://"
  }
  return true
}

export const validatePort = (raw: string): true | string => {
  const value = raw.trim()
  if (value === "" || value.toLowerCase() === DEFAULT_PORT_LABEL) return true
  const choice = parsePort(value)
  if ("error" in choice) return choice.error
  return true
}

// Emit only values the user changed from their default; origin is normalized so
// a trailing slash doesn't read as a change.
export const buildBridgeEnv = (answers: SetupAnswers): BridgeEnv => {
  const env: BridgeEnv = {}

  const origin = answers.consoleOrigin.trim()
  if (origin !== "" && normalizeOrigin(origin) !== DEFAULT_CONSOLE_ORIGIN) {
    env.CONSOLE_ORIGIN = normalizeOrigin(origin)
  }

  const port = answers.port.trim()
  if (port !== "" && port.toLowerCase() !== DEFAULT_PORT_LABEL) {
    env.MCP_BRIDGE_PORT = String(Number(port))
  }

  return env
}

const normalizeOrigin = (value: string): string => {
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}
