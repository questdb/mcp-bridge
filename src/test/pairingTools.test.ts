import { describe, expect, it } from "vitest"
import {
  CONNECT_TOOL,
  WAIT_TOOL,
  createPairingToolHandlers,
  isPairingToolName,
  type PairingToolsContext,
} from "../pairingTools.js"

const PAIRING_TOOLS = [CONNECT_TOOL, WAIT_TOOL] as const

const makeCtx = (overrides: Partial<PairingToolsContext> = {}): PairingToolsContext => ({
  buildDeepLink: () =>
    "http://127.0.0.1:9000/?mcp-pair=1&mcp-ws=ws://127.0.0.1:57123&mcp-token=abcdefghijklmnopqrst1234",
  getCredentials: () => ({
    wsUrl: "ws://127.0.0.1:57123",
    token: "abcdefghijklmnopqrst1234",
  }),
  getPairingState: () => ({ paired: false }),
  waitForPair: () => Promise.resolve({ paired: false, reason: "timeout" }),
  ...overrides,
})

describe("PAIRING_TOOLS schema", () => {
  it("declares the two pairing tools", () => {
    expect(PAIRING_TOOLS).toHaveLength(2)
    expect(PAIRING_TOOLS.map((t) => t.name).sort()).toEqual([
      "connect_web_console",
      "wait_for_pairing",
    ])
  })

  it("inputSchema is a closed object with no/optional props", () => {
    for (const t of PAIRING_TOOLS) {
      expect(t.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      })
    }
  })

  it("isPairingToolName narrows correctly", () => {
    expect(isPairingToolName("connect_web_console")).toBe(true)
    expect(isPairingToolName("wait_for_pairing")).toBe(true)
    expect(isPairingToolName("add_cell")).toBe(false)
  })

  it("isPairingToolName covers every name in the schema array", () => {
    for (const t of PAIRING_TOOLS) {
      expect(isPairingToolName(t.name)).toBe(true)
    }
  })
})

describe("connect_web_console handler", () => {
  it("returns paired:false JSON when unpaired (deepLink + wsUrl + token + nextStep, camelCase)", () => {
    const { handleConnectWebConsole } = createPairingToolHandlers(makeCtx())
    const out = handleConnectWebConsole()
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(false)
    expect(parsed.deepLink).toContain("mcp-pair=1")
    expect(parsed.wsUrl).toBe("ws://127.0.0.1:57123")
    expect(parsed.token).toBe("abcdefghijklmnopqrst1234")
    expect(parsed.nextStep).toBe("wait_for_pairing")
  })

  it("returns paired:true JSON with consoleOrigin + permissions (camelCase) when already paired", () => {
    const { handleConnectWebConsole } = createPairingToolHandlers(
      makeCtx({
        getPairingState: () => ({
          paired: true,
          sessionId: "s1",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { read: true, write: false },
          versionMismatch: null,
        }),
      }),
    )
    const out = handleConnectWebConsole()
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(true)
    expect(parsed.consoleOrigin).toBe("http://127.0.0.1:9000")
    expect(parsed.permissions).toEqual({ read: true, write: false })
    expect(typeof parsed.message).toBe("string")
    expect(parsed.warning).toBeUndefined()
  })

  it("surfaces a version-mismatch warning in the already-paired branch", () => {
    const { handleConnectWebConsole } = createPairingToolHandlers(
      makeCtx({
        getPairingState: () => ({
          paired: true,
          sessionId: "s1",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { read: true, write: true },
          versionMismatch: {
            bridgeVersion: "0.1.0",
            expectedBridgeVersion: "0.2.0",
          },
        }),
      }),
    )
    const out = handleConnectWebConsole()
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(true)
    expect(typeof parsed.warning).toBe("string")
    expect(parsed.warning as string).toContain("0.1.0")
    expect(parsed.warning as string).toContain("0.2.0")
  })

  it("is idempotent — repeated calls produce the same payload", () => {
    let calls = 0
    const { handleConnectWebConsole } = createPairingToolHandlers(
      makeCtx({
        buildDeepLink: () => {
          calls += 1
          return "http://stable-url"
        },
      }),
    )
    const a = handleConnectWebConsole().content[0].text
    const b = handleConnectWebConsole().content[0].text
    expect(a).toBe(b)
    expect(calls).toBe(2) // still calls the builder; just produces a stable answer
  })
})

describe("wait_for_pairing handler", () => {
  it("fast-paths when already paired", async () => {
    const { handleWaitForPairing } = createPairingToolHandlers(
      makeCtx({
        getPairingState: () => ({
          paired: true,
          sessionId: "s1",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { read: true, write: true },
          versionMismatch: null,
        }),
      }),
    )
    const out = await handleWaitForPairing({})
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(true)
    expect(parsed.consoleOrigin).toBe("http://127.0.0.1:9000")
    expect(parsed.permissions).toEqual({ read: true, write: true })
    expect(parsed.warning).toBeUndefined()
  })

  it("attaches a warning string when wait_for_pairing resolves with a version mismatch", async () => {
    const ctx = makeCtx({
      waitForPair: () =>
        Promise.resolve({
          paired: true,
          sessionId: "s",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { read: true, write: true },
          versionMismatch: {
            bridgeVersion: "0.1.0",
            expectedBridgeVersion: "0.2.0",
          },
        }),
    })
    const { handleWaitForPairing } = createPairingToolHandlers(ctx)
    const out = await handleWaitForPairing({})
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(true)
    expect(typeof parsed.warning).toBe("string")
    expect(parsed.warning as string).toContain("0.1.0")
    expect(parsed.warning as string).toContain("0.2.0")
  })

  it("returns timeout payload on timeout, with retry guidance (camelCase)", async () => {
    const { handleWaitForPairing } = createPairingToolHandlers(makeCtx())
    const out = await handleWaitForPairing({ timeout_ms: 1000 })
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(false)
    expect(parsed.reason).toBe("timeout")
    expect(parsed.retryCount).toBe(1)
    expect(parsed.maxRetriesHint).toBe(10)
    expect(typeof parsed.hint).toBe("string")
    expect(parsed.retry_count).toBeUndefined()
    expect(parsed.max_retries_hint).toBeUndefined()
  })

  it("increments retryCount across timeouts and resets on success", async () => {
    let pairAfter = 3
    const ctx = makeCtx({
      waitForPair: () => {
        pairAfter -= 1
        if (pairAfter > 0) {
          return Promise.resolve({ paired: false, reason: "timeout" })
        }
        return Promise.resolve({
          paired: true,
          sessionId: "s",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { read: true, write: true },
          versionMismatch: null,
        })
      },
    })
    const { handleWaitForPairing } = createPairingToolHandlers(ctx)
    const r1 = JSON.parse(
      (await handleWaitForPairing({})).content[0].text,
    ) as Record<string, unknown>
    expect(r1.retryCount).toBe(1)
    const r2 = JSON.parse(
      (await handleWaitForPairing({})).content[0].text,
    ) as Record<string, unknown>
    expect(r2.retryCount).toBe(2)
    const r3 = JSON.parse(
      (await handleWaitForPairing({})).content[0].text,
    ) as Record<string, unknown>
    expect(r3.paired).toBe(true)
  })

  it("clamps timeout_ms to [1000, 50000]", async () => {
    let observed = 0
    const ctx = makeCtx({
      waitForPair: (ms) => {
        observed = ms
        return Promise.resolve({ paired: false, reason: "timeout" })
      },
    })
    const { handleWaitForPairing } = createPairingToolHandlers(ctx)
    await handleWaitForPairing({ timeout_ms: 500 })
    expect(observed).toBe(1000)
    await handleWaitForPairing({ timeout_ms: 999_999 })
    expect(observed).toBe(50_000)
    await handleWaitForPairing(undefined)
    expect(observed).toBe(50_000)
  })

  it("returns rate_limited reason with isError=true when bridge is at the cap", async () => {
    const ctx = makeCtx({
      waitForPair: () =>
        Promise.resolve({ paired: false, reason: "rate_limited" }),
    })
    const { handleWaitForPairing, counters } = createPairingToolHandlers(ctx)
    const out = await handleWaitForPairing({})
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(false)
    expect(parsed.reason).toBe("rate_limited")
    expect(typeof parsed.message).toBe("string")
    expect(parsed.retryCount).toBeUndefined()
    expect(parsed.maxRetriesHint).toBeUndefined()
    expect(out.isError).toBe(true)
    expect(counters.waitRetries).toBe(0)
  })

  it("does NOT increment retryCount on rate_limited (only on real timeouts)", async () => {
    let nextResult: "rate_limited" | "timeout" = "rate_limited"
    const ctx = makeCtx({
      waitForPair: () =>
        Promise.resolve({ paired: false, reason: nextResult }),
    })
    const { handleWaitForPairing, counters } = createPairingToolHandlers(ctx)
    await handleWaitForPairing({})
    await handleWaitForPairing({})
    await handleWaitForPairing({})
    expect(counters.waitRetries).toBe(0)
    nextResult = "timeout"
    const r = JSON.parse(
      (await handleWaitForPairing({})).content[0].text,
    ) as Record<string, unknown>
    expect(r.retryCount).toBe(1)
  })
})
