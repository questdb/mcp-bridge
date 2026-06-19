import { describe, expect, it, vi } from "vitest"
import { dispatchToolCall, safePairingCredentialsSummary } from "../mcpServer.js"
import type { Log, ToolResultPayload } from "../types.js"

const okText = (text: string): ToolResultPayload => ({
  content: [{ type: "text", text }],
})

const pairingThatReturns = (
  credentials: ToolResultPayload,
  waitResult: ToolResultPayload = okText("{}"),
) => ({
  handleConnectWebConsole: () => credentials,
  handleWaitForPairing: () => Promise.resolve(waitResult),
})

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

describe("dispatchToolCall — request handler", () => {
  it("forwards a functional tool through the session and mirrors its result", async () => {
    // Given a session that returns a successful payload
    const session = { callBrowserTool: vi.fn(() => Promise.resolve(okText("rows"))) }

    // When a functional tool is dispatched
    const out = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("creds")) },
      "list_cells",
      { a: 1 },
    )

    // Then the session is called with the args and the result is mirrored
    expect(session.callBrowserTool).toHaveBeenCalledWith(
      "list_cells",
      { a: 1 },
      undefined,
    )
    expect(out).toEqual({ content: [{ type: "text", text: "rows" }], isError: false })
  })

  it("mirrors an error payload from the session as isError:true", async () => {
    // Given a session that returns an error payload
    const session = {
      callBrowserTool: (): Promise<ToolResultPayload> =>
        Promise.resolve({
          content: [{ type: "text", text: "BRIDGE_NOT_PAIRED: ..." }],
          isError: true,
        }),
    }

    // When dispatched
    const out = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("creds")) },
      "list_cells",
      {},
    )

    // Then the error flag is preserved
    expect(out.isError).toBe(true)
  })

  it("converts a thrown error into INTERNAL_ERROR instead of escaping the handler", async () => {
    // Given a session whose callBrowserTool rejects (e.g. send failure)
    const session = {
      callBrowserTool: (): Promise<ToolResultPayload> =>
        Promise.reject(new Error("socket dead")),
    }

    // When dispatched
    const out = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("creds")) },
      "list_cells",
      {},
    )

    // Then the caller gets a machine-recognizable INTERNAL_ERROR, not a crash
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toMatch(/^INTERNAL_ERROR:/)
  })

  it("routes pairing tools to the pairing handlers, not the session", async () => {
    // Given a session that must never be called for a pairing tool
    const session = { callBrowserTool: vi.fn(() => Promise.resolve(okText("nope"))) }

    // When get_pairing_credentials and wait_for_pairing are dispatched
    const creds = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("CREDS"), okText("WAIT")) },
      "get_pairing_credentials",
      {},
    )
    const wait = await dispatchToolCall(
      { session, pairing: pairingThatReturns(okText("CREDS"), okText("WAIT")) },
      "wait_for_pairing",
      {},
    )

    // Then the pairing handlers answer and the session is untouched
    expect(creds.content[0].text).toBe("CREDS")
    expect(wait.content[0].text).toBe("WAIT")
    expect(session.callBrowserTool).not.toHaveBeenCalled()
  })

  it("redacts pairing credentials from the DEBUG log but logs functional content verbatim", async () => {
    // Given a log spy and credentials whose payload carries a secret token
    const lines: string[] = []
    const log: Log = (_level, ...args) => {
      lines.push(args.join(" "))
    }
    const token = "SUPER_SECRET_TOKEN_xyz"
    const credentials = okText(
      JSON.stringify({ paired: false, token, consoleOrigin: "http://127.0.0.1:9000" }),
    )

    // When get_pairing_credentials is dispatched (with debug logging)
    await dispatchToolCall(
      { session: { callBrowserTool: () => Promise.resolve(okText("x")) }, pairing: pairingThatReturns(credentials), log },
      "get_pairing_credentials",
      {},
    )

    // Then the token never appears in any log line
    expect(lines.some((l) => l.includes(token))).toBe(false)

    // And a functional tool's content is logged verbatim
    lines.length = 0
    await dispatchToolCall(
      { session: { callBrowserTool: () => Promise.resolve(okText("VISIBLE_CONTENT")) }, pairing: pairingThatReturns(credentials), log },
      "list_cells",
      {},
    )
    expect(lines.some((l) => l.includes("VISIBLE_CONTENT"))).toBe(true)
  })
})
