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
      "get_pairing_credentials",
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
    expect(isPairingToolName("get_pairing_credentials")).toBe(true)
    expect(isPairingToolName("wait_for_pairing")).toBe(true)
    expect(isPairingToolName("add_cell")).toBe(false)
  })

  it("isPairingToolName covers every name in the schema array", () => {
    for (const t of PAIRING_TOOLS) {
      expect(isPairingToolName(t.name)).toBe(true)
    }
  })
})

describe("get_pairing_credentials handler", () => {
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

  it("includes a pre-rendered userMessage that shows BOTH the deep link and ws_url+token", () => {
    const { handleConnectWebConsole } = createPairingToolHandlers(makeCtx())
    const out = handleConnectWebConsole()
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(typeof parsed.userMessage).toBe("string")
    const msg = parsed.userMessage as string
    expect(msg).toContain("mcp-pair=1")
    expect(msg).toContain("ws://127.0.0.1:57123")
    expect(msg).toContain("abcdefghijklmnopqrst1234")
  })

  it("includes assistantNextActions ordered: show user first, then call wait_for_pairing", () => {
    const { handleConnectWebConsole } = createPairingToolHandlers(makeCtx())
    const out = handleConnectWebConsole()
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(Array.isArray(parsed.assistantNextActions)).toBe(true)
    const actions = parsed.assistantNextActions as string[]
    expect(actions.length).toBeGreaterThanOrEqual(2)
    // The "show user" instruction must come before the "call wait_for_pairing" instruction.
    const showIdx = actions.findIndex((a) => /write a message to the user/i.test(a))
    const waitIdx = actions.findIndex((a) => /wait_for_pairing/i.test(a))
    expect(showIdx).toBeGreaterThanOrEqual(0)
    expect(waitIdx).toBeGreaterThan(showIdx)
  })

  it("returns paired:true JSON with consoleOrigin + permissions (camelCase) when already paired", () => {
    const { handleConnectWebConsole } = createPairingToolHandlers(
      makeCtx({
        getPairingState: () => ({
          paired: true,
          sessionId: "s1",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { grantSchemaAccess: true, read: true, write: false },
          versionMismatch: null,
        }),
      }),
    )
    const out = handleConnectWebConsole()
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(true)
    expect(parsed.consoleOrigin).toBe("http://127.0.0.1:9000")
    expect(parsed.permissions).toEqual({ grantSchemaAccess: true, read: true, write: false })
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
          permissions: { grantSchemaAccess: true, read: true, write: true },
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
    expect(parsed.userMessage as string).toContain(
      "npx @questdb/mcp-bridge@0.2.0 start",
    )
  })

  it("returns an actionable incompatible_bridge error when the console was refused", () => {
    const { handleConnectWebConsole } = createPairingToolHandlers(
      makeCtx({
        getPairingState: () => ({
          paired: false,
          incompatible: {
            bridgeVersion: "1.4.0",
            expectedBridgeVersion: "2.0.0",
          },
        }),
      }),
    )
    const out = handleConnectWebConsole()
    expect(out.isError).toBe(true)
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(false)
    expect(parsed.reason).toBe("incompatible_bridge")
    expect(parsed.userMessage as string).toContain("v1.4.0")
    expect(parsed.userMessage as string).toContain(
      "npx @questdb/mcp-bridge@2.0.0 start",
    )
    expect(Array.isArray(parsed.assistantNextActions)).toBe(true)
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
          permissions: { grantSchemaAccess: true, read: true, write: true },
          versionMismatch: null,
        }),
      }),
    )
    const out = await handleWaitForPairing({})
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(true)
    expect(parsed.consoleOrigin).toBe("http://127.0.0.1:9000")
    expect(parsed.permissions).toEqual({ grantSchemaAccess: true, read: true, write: true })
    expect(parsed.warning).toBeUndefined()
  })

  it("resolves with paired:true when the user approves AFTER wait_for_pairing has been called (wait-then-approve)", async () => {
    // Simulates: agent calls wait_for_pairing while state is S0; user
    // approves the consent modal mid-wait → bridge hello → pairWaiters
    // drain → waitForPair Promise resolves with the snapshot.
    const ctx = makeCtx({
      // getPairingState is called at the top of handleWaitForPairing
      // BEFORE waitForPair — state is still S0 there, no fast-path.
      getPairingState: () => ({ paired: false }),
      waitForPair: () =>
        Promise.resolve({
          paired: true,
          sessionId: "s1",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { grantSchemaAccess: true, read: true, write: true },
          versionMismatch: null,
        }),
    })
    const { handleWaitForPairing } = createPairingToolHandlers(ctx)
    const out = await handleWaitForPairing({})
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(true)
    expect(parsed.consoleOrigin).toBe("http://127.0.0.1:9000")
    expect(parsed.permissions).toEqual({ grantSchemaAccess: true, read: true, write: true })
    expect(parsed.warning).toBeUndefined()
  })

  it("attaches a warning string when wait_for_pairing resolves with a version mismatch", async () => {
    const ctx = makeCtx({
      waitForPair: () =>
        Promise.resolve({
          paired: true,
          sessionId: "s",
          consoleOrigin: "http://127.0.0.1:9000",
          permissions: { grantSchemaAccess: true, read: true, write: true },
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
    expect(parsed.userMessage as string).toContain(
      "npx @questdb/mcp-bridge@0.2.0 start",
    )
  })

  it("returns an actionable incompatible_bridge error when waitForPair reports incompatible", async () => {
    const ctx = makeCtx({
      getPairingState: () => ({ paired: false }),
      waitForPair: () =>
        Promise.resolve({
          paired: false,
          reason: "incompatible",
          incompatible: {
            bridgeVersion: "1.4.0",
            expectedBridgeVersion: "2.0.0",
          },
        }),
    })
    const { handleWaitForPairing } = createPairingToolHandlers(ctx)
    const out = await handleWaitForPairing({})
    expect(out.isError).toBe(true)
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.paired).toBe(false)
    expect(parsed.reason).toBe("incompatible_bridge")
    expect(parsed.userMessage as string).toContain(
      "npx @questdb/mcp-bridge@2.0.0 start",
    )
  })

  it("fast-paths an incompatible bridge from the initial snapshot without waiting", async () => {
    let waited = false
    const ctx = makeCtx({
      getPairingState: () => ({
        paired: false,
        incompatible: {
          bridgeVersion: "1.4.0",
          expectedBridgeVersion: "2.0.0",
        },
      }),
      waitForPair: () => {
        waited = true
        return Promise.resolve({ paired: false, reason: "timeout" })
      },
    })
    const { handleWaitForPairing } = createPairingToolHandlers(ctx)
    const out = await handleWaitForPairing({})
    expect(waited).toBe(false)
    expect(out.isError).toBe(true)
    const parsed = JSON.parse(out.content[0].text) as Record<string, unknown>
    expect(parsed.reason).toBe("incompatible_bridge")
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
    // Hint should remind the assistant to verify it has shown the user
    // the credentials — the most common cause of repeated timeouts.
    expect(parsed.hint as string).toMatch(/credentials|deepLink|wsUrl|token/i)
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
          permissions: { grantSchemaAccess: true, read: true, write: true },
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
