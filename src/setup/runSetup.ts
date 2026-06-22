// Two-screen wizard: pick agents, then review env vars and confirm. Esc clears
// the current field and, when already empty, steps back to the previous prompt.
import { checkbox } from "@inquirer/prompts"
import { MCP_BRIDGE_VERSION } from "../protocolVersion.js"
import { brand, gray, green, red, renderBanner } from "./banner.js"
import { armFastEscape, BACK, confirmBack, text } from "./prompts.js"
import { ALL_AGENT_IDS, buildAgents, type AgentConfig, type AgentId } from "./agents.js"
import { applyAgentConfig, detectInstalledAgents } from "./applyConfig.js"
import {
  buildBridgeEnv,
  DEFAULT_CONSOLE_ORIGIN,
  DEFAULT_PORT_LABEL,
  type SetupAnswers,
  validateConsoleOrigin,
  validatePort,
} from "./env.js"

const out = (s: string): void => void process.stdout.write(s)

const brandTheme = { style: { highlight: (t: string) => brand(t) } }

type EnvOutcome = "back" | "cancel" | "apply"

// Returns "back" only when Esc is pressed on the first field; `values` is
// mutated so a revisited field shows the last answer.
const runEnvAndConfirm = async (
  agents: Record<AgentId, AgentConfig>,
  selectedIds: AgentId[],
  values: SetupAnswers,
): Promise<EnvOutcome> => {
  const fields = ["consoleOrigin", "port", "confirm"] as const
  let i = 0
  while (i < fields.length) {
    const field = fields[i]
    let goBack = false

    if (field === "consoleOrigin") {
      const r = await text({
        message: "CONSOLE_ORIGIN",
        default: values.consoleOrigin,
        description: "Origin of your running QuestDB Web Console",
        validate: validateConsoleOrigin,
        theme: brandTheme,
      })
      if (r === BACK) goBack = true
      else values.consoleOrigin = r
    } else if (field === "port") {
      const r = await text({
        message: "MCP_BRIDGE_PORT",
        default: values.port,
        description:
          "Port for the bridge to bind. Auto-allocates a free port by default",
        validate: validatePort,
        theme: brandTheme,
      })
      if (r === BACK) goBack = true
      else values.port = r
    } else {
      printReview(agents, selectedIds, values)
      const r = await confirmBack({
        message: `Apply this to ${selectedIds.length} agent${selectedIds.length === 1 ? "" : "s"}?`,
        default: true,
        theme: brandTheme,
      })
      if (r === BACK) goBack = true
      else return r ? "apply" : "cancel"
    }

    if (goBack) {
      if (i === 0) return "back"
      i--
    } else {
      i++
    }
  }
  return "cancel"
}

const printReview = (
  agents: Record<AgentId, AgentConfig>,
  selectedIds: AgentId[],
  values: SetupAnswers,
): void => {
  out("\n  Review\n")
  out(`    Agents: ${selectedIds.map((id) => agents[id].displayName).join(", ")}\n`)
  const envEntries = Object.entries(buildBridgeEnv(values))
  if (envEntries.length === 0) {
    out("    Env:    all defaults — no env block will be written\n")
  } else {
    out("    Env:\n")
    for (const [k, v] of envEntries) out(`      ${k} = ${v}\n`)
  }
  out("\n")
}

export const runSetup = async (): Promise<number> => {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      "setup is interactive and needs a TTY. Run `npx @questdb/mcp-bridge setup` " +
        "directly in a terminal.\n",
    )
    return 1
  }

  armFastEscape()

  const agents = buildAgents()
  out("\n" + renderBanner() + "\n\n")
  out(
    "  Configure @questdb/mcp-bridge as an MCP server for your coding agents " +
      "to interact with QuestDB\n",
  )
  out(
    gray(
      `  Pinning bridge v${MCP_BRIDGE_VERSION} — must match the version your QuestDB Web Console expects.`,
    ) + "\n\n",
  )

  const values: SetupAnswers = {
    consoleOrigin: DEFAULT_CONSOLE_ORIGIN,
    port: DEFAULT_PORT_LABEL,
  }

  let detected: Set<AgentId>
  try {
    detected = await detectInstalledAgents(agents)
  } catch {
    detected = new Set()
  }
  const preselected = new Set<AgentId>(detected)

  try {
    // Outer loop lets the first env field's Esc return to the agent picker.
    for (;;) {
      const selectedIds = await checkbox<AgentId>({
        message: "Step 1 — Select coding agents to configure (Space toggles, Enter confirms)",
        choices: ALL_AGENT_IDS.map((id) => ({
          name: detected.has(id)
            ? `${agents[id].displayName}  (detected)`
            : agents[id].displayName,
          value: id,
          checked: preselected.has(id),
        })),
        loop: false,
        theme: {
          icon: { checked: brand(" ◉"), unchecked: " ◯", cursor: "❯" },
          style: {
            highlight: (text: string) => brand(text),
            // Recap lists clean names, one per line; the "(detected)" hint
            // only matters while choosing.
            renderSelectedChoices: (selected: readonly { value: AgentId }[]) =>
              selected.map((c) => `\n    ${agents[c.value].displayName}`).join(""),
          },
        },
      })

      if (selectedIds.length === 0) {
        out("\n  No agents selected — nothing to do.\n\n")
        return 0
      }
      preselected.clear()
      for (const id of selectedIds) preselected.add(id)

      out(
        "\n  Step 2 — Environment variables " +
          "(Enter keeps the default · Esc clears the field / goes back)\n\n",
      )
      const outcome = await runEnvAndConfirm(agents, selectedIds, values)
      if (outcome === "back") {
        out("\n")
        continue
      }
      if (outcome === "cancel") {
        out("\n  Cancelled — no files changed.\n\n")
        return 0
      }

      const env = buildBridgeEnv(values)
      out("\n")
      let anyFail = false
      for (const id of selectedIds) {
        const res = await applyAgentConfig(agents[id], env)
        if (res.status === "failed") {
          anyFail = true
          out(`  ${red("✖")} ${res.agent}: ${res.error}\n    ${gray(res.path)}\n\n`)
        } else {
          out(`  ${green("✔")} ${res.agent} ${res.status}\n    ${gray(res.path)}\n\n`)
        }
      }
      out(
        "  Done. Restart your coding agent if it was running, then ask it to pair with your QuestDB Web Console. The agent will walk you through pairing.\n\n",
      )
      return anyFail ? 1 : 0
    }
  } catch (err) {
    // Ctrl-C surfaces as ExitPromptError; treat as a clean cancel.
    if (err instanceof Error && err.name === "ExitPromptError") {
      out("\n  Cancelled.\n\n")
      return 0
    }
    throw err
  }
}
