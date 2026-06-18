import { describe, expect, it } from "vitest"
import { safePairingCredentialsSummary } from "../mcpServer.js"

describe("safePairingCredentialsSummary — token/credential redaction", () => {
  it("keeps paired/consoleOrigin/permissions but drops token, wsUrl and deepLink", () => {
    const token = "SUPER_SECRET_TOKEN_abc123"
    const wsUrl = "ws://127.0.0.1:57123"
    const content = [
      {
        type: "text" as const,
        text: JSON.stringify({
          paired: false,
          deepLink: `http://127.0.0.1:9000/?mcp-token=${token}`,
          wsUrl,
          token,
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { read: true, write: true },
          nextStep: "wait_for_pairing",
        }),
      },
    ]

    const summary = safePairingCredentialsSummary(content)

    expect(summary).not.toBeNull()
    // The whole point: secrets must never appear in the loggable summary.
    expect(summary).not.toContain(token)
    expect(summary).not.toContain(wsUrl)
    expect(summary).not.toContain("deepLink")
    const parsed = JSON.parse(summary as string) as Record<string, unknown>
    expect(parsed).toHaveProperty("paired", false)
    expect(parsed).toHaveProperty("consoleOrigin", "http://127.0.0.1:9000")
    expect(parsed).toHaveProperty("permissions")
  })

  it("returns null for non-JSON or empty content so the caller logs nothing", () => {
    expect(
      safePairingCredentialsSummary([{ type: "text", text: "not json" }]),
    ).toBeNull()
    expect(safePairingCredentialsSummary([])).toBeNull()
  })
})
