import { createRequire } from "node:module"
import type { ToolSchema } from "./types.js"

type SharedDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  category?: string
  mutatesNotebook?: boolean
  surfaces?: ("ai" | "mcp")[]
}

const require = createRequire(import.meta.url)
const sharedDefinitions = require("./consts/shared-definitions.json") as SharedDefinition[]

const isMcpSurfaced = (def: SharedDefinition): boolean =>
  !def.surfaces || def.surfaces.includes("mcp")

export const BUNDLED_FUNCTIONAL_TOOLS: ToolSchema[] = sharedDefinitions
  .filter(isMcpSurfaced)
  .map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }))

export const BUNDLED_TOOL_NAMES = new Set(
  BUNDLED_FUNCTIONAL_TOOLS.map((t) => t.name),
)
