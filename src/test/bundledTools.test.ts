import { describe, expect, it } from "vitest"
import {
  BUNDLED_FUNCTIONAL_TOOLS,
  BUNDLED_TOOL_NAMES,
} from "../bundledTools.js"

describe("bundledTools", () => {
  it("ships 30 functional tools (3 schema + 3 reference + 21 notebook + 1 query + 2 meta)", () => {
    expect(BUNDLED_FUNCTIONAL_TOOLS).toHaveLength(30)
  })

  it("includes the schema tools", () => {
    for (const name of [
      "get_tables",
      "get_table_schema",
      "get_table_details",
    ]) {
      expect(BUNDLED_TOOL_NAMES.has(name)).toBe(true)
    }
  })

  it("includes the reference tools", () => {
    for (const name of [
      "validate_query",
      "get_questdb_toc",
      "get_questdb_documentation",
    ]) {
      expect(BUNDLED_TOOL_NAMES.has(name)).toBe(true)
    }
  })

  it("includes the meta tools (resolved bridge-side, not in tools.ts)", () => {
    for (const name of [
      "get_workspace_state",
      "get_recent_user_actions",
      "run_query",
    ]) {
      expect(BUNDLED_TOOL_NAMES.has(name)).toBe(true)
    }
  })

  it("includes apply_notebook_state (the bulk-write tool)", () => {
    expect(BUNDLED_TOOL_NAMES.has("apply_notebook_state")).toBe(true)
  })

  it("apply_notebook_state mirrors the UI's required-field shape", () => {
    const tool = BUNDLED_FUNCTIONAL_TOOLS.find(
      (t) => t.name === "apply_notebook_state",
    )
    if (!tool) throw new Error("apply_notebook_state missing")
    const props = tool.inputSchema.properties as Record<string, unknown>
    const cells = props.cells as { items: { required: string[] } }
    expect(cells.items.required).toEqual([
      "id",
      "value",
      "mode",
      "auto_refresh",
      "is_chart_maximized",
      "chart_config",
      "grid",
    ])
    expect(tool.inputSchema.required).toEqual([
      "buffer_id",
      "layout_mode",
      "maximized_cell_id",
      "variables",
      "cells",
    ])
  })

  it("does not reference the hallucinated `get_pairing_status` tool", () => {
    for (const tool of BUNDLED_FUNCTIONAL_TOOLS) {
      expect(tool.description).not.toMatch(/get_pairing_status/)
    }
  })

  it("set_cell_chart_config required matches the UI's full field list", () => {
    const tool = BUNDLED_FUNCTIONAL_TOOLS.find(
      (t) => t.name === "set_cell_chart_config",
    )
    if (!tool) throw new Error("set_cell_chart_config missing")
    // "Explicit-everything" patch convention (same as apply_notebook_state):
    // every field is required but nullable — the agent passes null to preserve.
    expect(tool.inputSchema.required).toEqual([
      "buffer_id",
      "cell_id",
      "x_column",
      "name",
      "queries",
      "right_axis",
    ])
    const props = tool.inputSchema.properties as Record<string, unknown>
    const queries = props.queries as { items: { required: string[] } }
    expect(queries.items.required).toEqual([
      "type",
      "y_columns",
      "ohlc",
      "partition_by_column",
      "axis",
      "enabled",
      "name",
    ])
  })

  it("meta-tool descriptions carry the BRIDGE_NOT_PAIRED recovery prefix", () => {
    for (const name of ["get_workspace_state", "get_recent_user_actions"]) {
      const tool = BUNDLED_FUNCTIONAL_TOOLS.find((t) => t.name === name)
      if (!tool) throw new Error(`${name} missing`)
      expect(tool.description).toMatch(/BRIDGE_NOT_PAIRED/)
      expect(tool.description).toMatch(/get_pairing_credentials/)
    }
  })

  it("does NOT include the pairing tools (those are mcpServer's job)", () => {
    expect(BUNDLED_TOOL_NAMES.has("get_pairing_credentials")).toBe(false)
    expect(BUNDLED_TOOL_NAMES.has("wait_for_pairing")).toBe(false)
  })

  it("every tool has the MCP wire shape (name + description + inputSchema)", () => {
    for (const tool of BUNDLED_FUNCTIONAL_TOOLS) {
      expect(typeof tool.name).toBe("string")
      expect(typeof tool.description).toBe("string")
      expect(typeof tool.inputSchema).toBe("object")
      expect(tool.inputSchema).not.toBeNull()
    }
  })

  it("tool names are unique", () => {
    const names = BUNDLED_FUNCTIONAL_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
