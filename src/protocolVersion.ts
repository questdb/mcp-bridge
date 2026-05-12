import { createRequire } from "node:module"

const readPackageVersion = (): string => {
  const require = createRequire(import.meta.url)
  const pkg = require("../package.json") as Record<string, unknown>
  const v = pkg.version
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      "FATAL: package.json version field is missing or invalid. " +
        "This is a packaging bug — fail loudly so we never wire an empty version.",
    )
  }
  return v
}

export const MCP_BRIDGE_VERSION: string = readPackageVersion()

export const parseMajor = (version: string): number | null => {
  const m = /^(\d+)\./.exec(version)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}
