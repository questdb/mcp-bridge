---
name: review-pr
description: Review a code change against the QuestDB MCP Bridge coding standards
argument-hint: [PR number, PR URL, commit hash, unstaged changes, staged changes] [--level=0..3]
allowed-tools: Bash(gh *), Bash(git diff*), Bash(yarn test), Bash(yarn lint), Bash(yarn typecheck), Bash(yarn build), Read, Grep, Glob, Agent
---

Review `$ARGUMENTS`

## Review mindset

You are a senior backend engineer performing a blocking code review on the QuestDB MCP Bridge — a long-lived Node.js process that brokers tool calls between an untrusted MCP client (a coding agent) over stdio and a paired QuestDB Web Console over a local WebSocket. A bug here does not just render wrong; it can fire a data-modifying SQL statement twice, hand the agent a false error for work that committed, leak a pairing token, leave a timer or socket dangling for the life of the process, or wedge the bridge so no tool ever completes. Be critical, thorough, and opinionated. Your job is to catch problems before they ship, not to be nice.

- **Assume nothing is correct until you've verified it.** Read surrounding code to understand context — don't just look at the diff in isolation.
- **The diff is a hint, not the boundary of the review.** The highest-value bugs almost always live at the *protocol seams* and *lifecycle edges* the diff quietly shifts — a message whose shape or validation changed, a promise that can now resolve twice or never, a timer cleared on one path but not another, a state transition (`S0`↔`S1`) that a new branch can reach in an unexpected order, a tool-result `isError`/`content` contract a caller depends on. Treat the diff as the entry point, not the scope.
- **Flag every issue you find**, no matter how small. Do not soften language or hedge. Say "this is wrong" not "this might be an issue".
- **Do not praise the code.** Skip "looks good", "nice work", "clever approach". Focus entirely on problems and risks.
- **Think adversarially.** For each change, ask: what if the browser disconnects mid-call? What if it reconnects during the reconnect-grace window and the result lands late? What if `tool_result` arrives after the deadline already fired (or after cancel, or for an unknown `requestId`)? What if a second browser connects (supersede)? What if `hello` arrives twice, with a bad token, with a mismatched major version, or with malformed `tools`? What if the MCP client aborts the call via `extra.signal`? What if a pong never comes, or comes for a stale nonce? What if the socket's outbound buffer overflows? What if the port is taken, or file descriptors are exhausted? What if `SIGTERM` arrives mid-shutdown, or stdin closes? What if the same promise's `resolve`/`reject` is reachable from two timers at once?
- **Check what's missing**, not just what's there. Missing timer cleanup, missing `inflight.delete` before resolve, missing abort-listener removal, missing close-code handling, missing schema validation at the trust boundary, missing tests for the race/disconnect paths, missing handling of an empty/partial/error result.
- **Verify every claim.** If the PR title says "fix", verify the bug actually existed and the fix is correct. If it says "improve", reason about whether it actually does — or could it regress a timing/ordering guarantee? Treat the PR description as an unverified hypothesis, not a statement of fact.
- **Read the full context of changed files** when the diff alone is ambiguous. Use Read/Grep/Glob to inspect callers, the message types in `types.ts`, the timer it pairs with, and the related tests in `src/test`.
- **Assess reachability before reporting.** For every potential bug, trace the actual code path: which message, which timer, which signal, which CLI/env input triggers it. If a problem requires a message the protocol can't produce or a state the machine can't reach, it is not a real finding — drop it. Focus on bugs reachable from a real MCP client, a real paired console, or a real OS/network event.

## Repo surface area (where the bugs actually are)

This is a small codebase (~2k lines of source) but risk is sharply concentrated in the session lifecycle and the two trust boundaries. Weight the review toward them; do not spend equal effort everywhere.

- **Session state machine & protocol** (`src/bridgeSession.ts`, `src/wsServer.ts`, `src/types.ts`) — the core. The `S0`/`S1` machine, the `hello`/`hello_ack` handshake, supersede on a second browser, duplicate-`hello` rejection, token/major-version checks, malformed-JSON/message close codes (`WS_CLOSE_CODES`), and the `connClosing` guard. Bugs here corrupt every subsequent call. Highest stakes.
- **In-flight calls, timers & cancellation** (`src/bridgeSession.ts`) — five timers, each of which must be cleared on every exit path: `deadlineTimer`, `graceTimer`, `helloTimer`, `pongTimer`, and the `heartbeatTimer` interval. The `inflight` Map keys calls by `requestId`. The recurring hazard is **a promise resolving twice, or a stale timer firing against a deleted entry** — every resolve path must `inflight.delete(requestId)` *and* run `clearInflight(call)` first. Note the established invariant: the guard is `if (!this.inflight.has(requestId)) return` at the top of every deferred callback. Treat a new deferred path that omits this guard, or resolves without deleting, as a default finding.
- **Disconnect / reconnect / race semantics** (`src/bridgeSession.ts` `transitionToS0` / `scheduleDisconnectGrace`) — in-flight calls deliberately survive a browser drop for `RECONNECT_GRACE_MS` (30s) because the console finishes the work and flushes `tool_result` after the reconnect `hello_ack`; failing the call early would invite a **duplicate-DML retry**. This is the single most subtle contract in the repo. Any change to disconnect handling, grace scheduling, or the `DISCONNECT_UNVERIFIED_TEXT` wording must preserve "do not retry data-modifying calls without verifying state". The timeout-vs-result race, the pong-vs-`terminate` race, and the supersede-vs-inflight interaction all live here.
- **Trust boundary: WebSocket upgrade** (`src/wsServer.ts`) — origin allowlist (`deriveAllowedOrigins`/`isOriginAllowed`), token extraction + `tokensMatch` (constant-time via `timingSafeEqual`), `maxPayload`, the outbound-buffer-overflow `terminate`, and the EMFILE/ENFILE fatal path. Every inbound frame is attacker-influenced until validated.
- **Trust boundary: tool arguments** (`src/bridgeSession.ts` `rebuildToolValidators` / Ajv) — args arrive verbatim from an untrusted MCP client and the console persists/renders them. They are validated against the **live** schema the browser advertised in `hello`. Validators are cached per tool and rebuilt each pairing; an unvalidatable schema fails open *for that tool only*. Changes to validation are security-sensitive.
- **MCP server contract** (`src/mcpServer.ts`, `src/bundledTools.ts`, `src/consts/shared-definitions.json`) — the static `tools/list` surface, the `CallToolRequestSchema` handler, the `ToolResultPayload` shape (`content: {type:'text',text}[]`, `isError`), the structured error-text conventions (`BRIDGE_NOT_PAIRED:`, `VALIDATION_ERROR:`, `BROWSER_PROTOCOL_ERROR:`, `INTERNAL_ERROR:`), pairing-credential log redaction (`safePairingCredentialsSummary`), and `SERVER_INSTRUCTIONS`. `shared-definitions.json` is **vendored from `questdb/ui` and CI fails on drift** — flag any local edit to it.
- **Pairing flow** (`src/pairingTools.ts`) — `get_pairing_credentials` / `wait_for_pairing`, the deep link, the waiter queue (`MAX_PAIR_WAITERS`), and the rate-limited / incompatible / timeout outcomes. The token and `wsUrl` are secrets that must reach the user but not the logs.
- **Process lifecycle & resources** (`src/index.ts`, `src/bindWithRetry.ts`, `src/sessionStore.ts`) — argv parsing (`--version`/`--help` must stay side-effect-free), env parsing (`MCP_BRIDGE_PORT`, `CONSOLE_ORIGIN`), port bind + retry (`EADDRINUSE`, pinned vs auto), per-tool deadline table, graceful shutdown budgets (`SHUTDOWN_STEP_BUDGET_MS` / `SHUTDOWN_HARD_BUDGET_MS`, the `.unref()` safety timer), signal/stdin handlers, and exit codes.
- `src/logger.ts` and `src/protocolVersion.ts` exist but are a small slice — review them when touched (log level/redaction; `parseMajor` semantics), but they are not where most risk lives.

## Review level

Parse `$ARGUMENTS` for a level token: `--level=N` or `-lN`, with `N` in `0`-`3`. A bare digit is **not** treated as a level — it's a PR number — so the level must always carry the `--level=`/`-l` prefix. **If no level is given, default to 2.** Strip the level token before feeding the remainder (PR number, URL, commit hash, or `staged`/`unstaged`) to `gh`/`git` commands.

The level controls how much of the review below actually runs. Lower levels keep the same review *spirit* — adversarial, blocking, no praise — but cut the breadth of the analysis. Higher levels have higher token cost; reserve level 3 for high-stakes changes (the session state machine, timer/in-flight lifecycle, disconnect/grace semantics, either trust boundary, anything touching how a tool result or a data-modifying call is delivered).

| Level           | What runs                                                                                                                                                                                                                                                            |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **0**           | Steps 1, 2, 4. Skip Step 2.5. Skip Step 3a — no agent spawn; review the diff inline in the main loop, using Read/Grep on demand to resolve ambiguities. Step 3b runs `yarn typecheck` and `yarn lint` only. Verify each finding inline as you write it. Single-pass.   |
| **1**           | Adds Step 2.5a (semantic delta only — skip 2.5b/2.5c/2.5d). In Step 3a, launch only Agent 1 (Session state machine & protocol), Agent 2 (Timers, in-flight & cancellation), Agent 3 (Disconnect, reconnect & races), and Agent 6 (Tests). Step 3b runs the full quality gate. Verify findings inline. |
| **2 (default)** | Full Step 2.5. In Step 3a, launch Agents 1-6 (all structured domain agents). Skip Agent 7 (fresh-context adversarial). Step 3b runs the full quality gate. Step 3c uses a single batched verification agent for all findings.                                          |
| **3**           | Every step below as written, all 7 agents including Agent 7, per-finding verification. The full mission-critical pass.                                                                                                                                                |

State the chosen level in one line at the start of the review so the user knows what they're getting (e.g., "Reviewing PR #42 at level 2"). If the level was defaulted, mention that level 3 exists for high-stakes changes.

## Step 1: Gather PR/Diff context

Strip the level token (`--level=N` / `-lN`) from `$ARGUMENTS` first; the remainder is the review target. Never pass the level token to `gh`/`git` — it is not a valid flag for them. Fetch the diff according to what the target is:

- **PR number or URL** — fetch metadata, diff, and comments in a single bash call so the variable stays in scope:

```bash
TARGET='<$ARGUMENTS with the level token removed>'
gh pr view "$TARGET" --json number,title,body,labels,state
gh pr diff "$TARGET"
gh pr view "$TARGET" --comments
```

- **Commit hash** — `git diff <hash>~1..<hash>` (no PR metadata; skip Step 2).
- **Staged changes** (`staged`) — `git diff --staged` (no PR metadata; skip Step 2).
- **Unstaged changes** (`unstaged`) — `git diff` (no PR metadata; skip Step 2).

If the user mentions reviewing only the staged or unstaged diff, review only that part, not something else.

## Step 2: PR title and description

This step applies only when the target is a PR. For commit/staged/unstaged targets there is no PR description — skip it.

Check against conventions (the repo's history uses Conventional Commits, e.g. `fix:`, `chore:`):
- Title follows Conventional Commits: `type: description`
- Description speaks to behavior/impact, not just "refactored X"
- If it claims a fix, the description names the failure mode being fixed

## Step 2.5: Map the change surface

Before launching review agents, produce a structured change surface map. This step is mandatory at levels 2 and 3 (level 1 runs 2.5a only) and must use Grep/Glob — do not reason about consumers from memory. The output of this step is required input for every agent in Step 3a.

### 2.5a Semantic delta per changed symbol

For every modified or added function, method, class field, message type, timer, state transition, exported constant, error string, or env/CLI input, write:

- **Symbol:** name and file
- **Before:** signature/args (required vs optional, defaults); return/resolve shape (including the `ToolResultPayload` `content`/`isError` contract); which `SessionState` it reads or writes; which timers it sets, clears, or depends on; which `inflight` entries it creates, mutates, resolves, rejects, or deletes; side effects (`browser.send`, socket close/`terminate`, `process.exit`, log writes); promise-settlement guarantees (can it settle 0, 1, or >1 times?); which messages it sends or accepts and their validation; close codes emitted
- **After:** same fields
- **Delta:** one line stating what semantically changed

"Refactored", "cleaned up", "improved", "simplified" are not acceptable deltas. State the actual behavioral difference. If nothing semantically changed, write "no behavioral change" — but only after checking, not as a default.

### 2.5b Callsite inventory

For every changed symbol that is exported or called across files (a `BridgeSession` method, a `wsServer`/`mcpServer`/`pairingTools` export, a message type, a `WS_CLOSE_CODES` member, a timer constant), run Grep across the entire repository to find every consumer outside the diff.

Produce a list grouped by file. Also search for:
- callers of a changed `BridgeSession` method (`session.callBrowserTool`, `attachBrowser`, `handleMessage`, `waitForPair`, `getPairingSnapshot`, …) — both in `wsServer.ts`/`mcpServer.ts`/`index.ts` and in `src/test/**`
- producers/consumers of a changed message `type` (search `types.ts` and every `case "<type>"` / `{ type: "<type>" }`)
- readers of a changed `WS_CLOSE_CODES` member or close-reason string
- callers wiring a changed config field (`getDeadlineMs`, `getPort`, `onFatalError`, `allowedOrigins`)
- test files that exercise the changed symbol (`src/test/*.test.ts`)

A changed cross-file symbol with zero recorded Grep calls in the trace is a skill violation. You are not allowed to assert "this is only used here" without showing the search.

### 2.5c Implicit contract list

For each changed symbol, walk this checklist and write one line per item, stating before vs after:

- Args required vs optional, and their defaults
- Resolve/return shape — can a method now return/resolve a different `ToolResultPayload` shape, `null`, or throw where it didn't before?
- **Promise settlement — can the returned promise now settle twice (e.g. deadline fires *and* a late `tool_result` arrives), or never (a path that neither resolves nor rejects)?** This is the dominant defect class in this repo.
- **Timer lifecycle — every timer set must have a clear on every exit path (success, timeout, abort, disconnect, supersede, send-failure). Which timers does the change add, clear, or leave dangling?**
- **`inflight` Map invariant — is every settle preceded by `inflight.delete(requestId)` and `clearInflight(call)`? Does every deferred callback still guard with `if (!this.inflight.has(requestId)) return`?**
- **State machine — which `S0`/`S1` transitions does the change add or reorder? Can `handleHello` now run in `S1`, or a tool dispatch in `S0`? Is `connClosing` still honored?**
- Side effects: `browser.send` calls, socket `close`/`terminate`, `process.exit`/exit code, log lines (and whether any now log a token/credential)
- Message validation: is an inbound field newly trusted without a shape check? Is an outbound message still well-formed (`v`, `type`)?
- Cancellation/abort: is the `extra.signal` listener still added once and removed via `abortCleanup`? Re-entrancy under rapid or duplicate calls.
- Disconnect/grace: does existing in-flight survival for `RECONNECT_GRACE_MS` still hold, and does the unverified-disconnect guidance still warn against duplicate DML?
- Security: token comparison still constant-time; origin allowlist unchanged in spirit; payload/buffer caps intact; secrets kept out of logs.
- Resource lifecycle: sockets/servers/intervals closed on shutdown; `.unref()` where a timer must not keep the process alive; exit codes preserved.

### 2.5d Cross-context exposure list

End this step with an explicit list of "places this change is visible from but the diff does not touch". This is the highest-priority input for the bug-hunting agents in Step 3a.

Group the 2.5b callsites by context: the `wsServer` message/close/upgrade handlers that drive the session, the `mcpServer` tool dispatch and error mapping, `index.ts` wiring (deadline table, fatal handler, shutdown), the pairing-tool handlers, and every test that pins the changed behavior. Every entry on this list must be reviewed in Step 3a.

## Step 3a: Parallel review

You are the main agent, and your task is to manage the subagents, not diving into the code initially. Every agent receives:
1. The PR diff
2. The full change surface map from Step 2.5 (semantic deltas, callsite inventory, implicit contracts, cross-context exposure list)

Each subagent should read surrounding source files as needed for context.

### Anti-anchoring directive (applies to all agents)

- **Bugs at callsites outside the diff outrank bugs inside the diff.** A confirmed bug in a file the PR did not touch but that calls a changed method, sends/consumes a changed message, or depends on a changed timer/state contract is a P0 finding.
- **"Looks correct in isolation" is not a valid conclusion.** Before clearing a changed symbol, the agent must walk the callsite inventory from 2.5b and state, per callsite, whether the new behavior is still correct there.
- **The diff is the entry point, not the scope.** If the change surface map shows the symbol is consumed by N other files, the review covers N+1 files.
- A single finding of the form "in `wsServer.ts` a `tool_result` for an already-deadlined call now resolves the promise a second time" is worth more than five nits inside the diff.

### Agents

Launch the following agents in parallel. (Level 1 launches only Agents 1, 2, 3, 6; level 2 launches Agents 1-6; level 3 launches all 7.)

**Agent 1: Session state machine & protocol — the highest-stakes agent.** For any change touching `src/bridgeSession.ts`, `src/wsServer.ts`, or `src/types.ts`: correctness of the `S0`/`S1` transitions and that no path reaches a tool dispatch in `S0` or re-runs `handleHello` in `S1`; the `hello`/`hello_ack` handshake (token check via `tokensMatch`, major-version negotiation via `parseMajor`, `isValidToolList`, `incompatibleConsole` handling and waiter resolution); duplicate-`hello` and the `connClosing` guard; supersede when a second browser attaches; malformed-JSON / malformed-message close paths and correct `WS_CLOSE_CODES`; every outbound message is well-formed (`v: MCP_BRIDGE_VERSION`, correct `type`); inbound messages are validated before use (`isValidToolContent`, `isValidToolList`). Treat any path where the bridge could accept an unauthenticated/mis-versioned peer, send a malformed frame, or transition state out of order as critical.

**Agent 2: Timers, in-flight calls & cancellation.** The recurring defect surface. For every timer (`deadlineTimer`, `graceTimer`, `helloTimer`, `pongTimer`, `heartbeatTimer`): is it cleared on *every* exit path (success, timeout, abort, disconnect, supersede, send-failure, shutdown)? For every `inflight` entry: is each settle preceded by `inflight.delete(requestId)` + `clearInflight(call)`, and does each deferred callback guard with `if (!this.inflight.has(requestId)) return`? **Flag any promise that can settle twice (deadline + late result, abort + result, grace + result) or never (a branch that returns without resolving/rejecting).** The `extra.signal` abort path: listener added `{ once: true }`, removed via `abortCleanup`, no leak if the call settles first. `browser.send` throwing must reject and clean up. Verify the per-tool deadline (`getDeadlineMs`) is actually applied and the `cancel` message is sent to the browser on timeout/abort.

**Agent 3: Disconnect, reconnect & race semantics.** The subtlest contract in the repo. Verify in-flight calls still survive a browser drop for `RECONNECT_GRACE_MS` and that `handleToolResult` can still match them by `requestId` after a reconnect `hello_ack`; that `transitionToS0` schedules grace exactly once per call and `scheduleDisconnectGrace` is idempotent (`if (call.graceTimer) return`); that the `DISCONNECT_UNVERIFIED_TEXT` guidance still steers the agent away from blindly retrying a data-modifying call. Trace the interleavings: timeout-fires-then-result-arrives, result-arrives-then-timeout, pong-times-out-then-pong-arrives, supersede-while-a-call-is-in-flight, disconnect-then-reconnect-then-grace-expiry, two rapid tool calls. For each, confirm exactly one settlement with the correct payload and no leaked timer. A claimed race is only real if a real sequence of messages/timers/disconnects produces it.

**Agent 4: Trust boundaries & security.** WebSocket upgrade in `src/wsServer.ts`: origin allowlist (`deriveAllowedOrigins` correctness, including the loopback `127.0.0.1`/`localhost` equivalence and the http/https-only guard) and `isOriginAllowed`; token extraction and constant-time compare (`tokensMatch`/`timingSafeEqual` — flag any reintroduction of `===` on the token); `maxPayload` and the outbound-buffer-overflow `terminate`. Tool-argument validation in `bridgeSession.ts`: untrusted args validated against the live advertised schema before reaching the browser, validators rebuilt per pairing, fail-open scoped to a single unvalidatable tool. Secrets: the pairing token and `wsUrl` must never hit the log file — confirm `safePairingCredentialsSummary` still redacts and that no new log line prints raw args/credentials at INFO. SQL/string-built injection is not in scope here (the console builds SQL), but unintended forwarding of unvalidated args is.

**Agent 5: MCP server contract & tool surface.** `src/mcpServer.ts` / `src/bundledTools.ts`: the `CallToolRequestSchema` handler maps results to the MCP `{content, isError}` shape correctly and never throws out to the SDK (the catch must return `INTERNAL_ERROR`); pairing-tool routing (`isPairingToolName`) vs functional dispatch; the static `tools/list` surface stays consistent with what `SERVER_INSTRUCTIONS` advertises; the structured error-text conventions (`BRIDGE_NOT_PAIRED:`, `VALIDATION_ERROR:`, `BROWSER_PROTOCOL_ERROR:`, `INTERNAL_ERROR:`) remain machine-recognizable and actionable. `src/consts/shared-definitions.json` is vendored from `questdb/ui` and CI fails on any drift — flag any local edit to it as a release-blocker, not a nit.

**Agent 6: Tests & coverage.** Unit coverage (vitest, `src/test/*.test.ts`) for new/changed behavior, with emphasis on the paths that are hard to reason about and easy to break: timer expiry and cleanup (assert no double-settle, no leaked timer — these typically need `vi.useFakeTimers`), disconnect/reconnect/grace, supersede, duplicate/bad-token/bad-version `hello`, malformed messages, abort/cancel, and the pairing waiter outcomes (paired / timeout / rate-limited / incompatible). Cross-reference 2.5d: every cross-context exposure should have a test that exercises the changed symbol from that context. Missing tests for the disconnect/race/timer paths are a high-priority finding, not a nit.

**Agent 7: Fresh-context adversarial (level 3 only).** Dispatched separately from Agents 1-6 to escape checklist anchoring. Different rules:

- It receives ONLY the PR diff and the names of the changed files. It does NOT receive the change surface map from Step 2.5, the implicit contract list, the cross-context exposure list, or any of the agent checklists above.
- Its sole instruction: "find ways this code is wrong". No category list, no failure-mode taxonomy.
- It is free to use Read, Grep, and Glob to explore the repository however it wants.
- Each finding states: what's wrong, why it's wrong, and the concrete sequence of messages/timers/signals that demonstrates it.

A finding here that none of Agents 1-6 produced is high signal — the structured review missed it. A finding that overlaps is corroboration. Run it in parallel with the rest.

## Step 3b: Fixed quality checks
While the subagents are scanning the code for their tasks, you will perform predefined quality checks on the code.
- Type errors: `yarn typecheck`
- Build failure: `yarn build`
- Lint errors: `yarn lint`
- Test failures: `yarn test`

At level 0, run only `yarn typecheck` and `yarn lint`. At levels 1-3, run all four.

If the diff touches `src/consts/shared-definitions.json`, also note the CI drift check: the file must byte-match `questdb/ui@main:src/consts/shared-definitions.json`, so any local edit fails CI — surface it as a release-blocker.

After performing these checks, if there are errors/failures, add them to the output table at the end, one row per check. Build, type, and test failures are critical; lint errors are moderate.
After completing this step, you will wait for subagent results.

## Step 3c: Verify every finding against source code

Combine all agent findings into a single deduplicated **draft** report. Do NOT present this draft to the user yet — it goes straight into verification. The parallel review agents work from the diff plus the change surface map and frequently produce false positives — especially around double-settle, missing timer cleanup, and race claims. Every finding MUST be verified before it is reported. (At levels 0-1, verify each finding inline as you write it instead of spawning verification agents.)

For each finding in the draft report:

1. **Read the actual source code** at the exact lines cited. Do not rely on the agent's description alone.
2. **Trace the full code path**: confirm the claimed message/timer/signal sequence is producible by a real MCP client, a real paired console, or a real OS event.
3. **For double-settle / never-settle claims:** find every `resolve`/`reject` for the promise and every path that returns without settling. Confirm two settlements are actually reachable (not blocked by an earlier `inflight.delete` + the `has()` guard), or that a real path truly leaves it unsettled. This is the highest-value but most over-claimed class — verify the guard isn't already covering it.
4. **For missing-timer-cleanup claims:** confirm the timer is actually set on the path in question and that a `clearTimeout`/`clearInterval` is genuinely absent on a reachable exit (not handled by `clearInflight` or `stopHeartbeat`).
5. **For state-machine claims:** confirm the transition is reachable in the claimed order given `connClosing`, the `state !== "S1"` guards, and the supersede/duplicate-hello short-circuits.
6. **For race-condition claims:** trace the actual async ordering and confirm two operations can realistically interleave (disconnect mid-call, reconnect during grace, timeout vs late result, pong timeout vs late pong, supersede vs inflight). If the ordering is structurally impossible, drop it.
7. **For security claims:** confirm the boundary is actually reachable pre-validation (origin/token checked at upgrade before any session handling; args validated before reaching the browser) and that a real input bypasses it. For a secret-leak claim, confirm the value really reaches a persisted log line at the configured level.
8. **For MCP-contract claims:** confirm the returned shape against `ToolResultPayload` and that the SDK handler never throws past the catch.
9. **Think about the use case:** does the issue create a real regression for the agent or the user, considering how the bridge is actually driven? If it cannot occur under a realistic client/console/OS sequence, it cannot be critical.
10. **Classify each finding** as:
    - **CONFIRMED in-diff** — the bug is real and inside the diff
    - **CONFIRMED at out-of-diff callsite** — the bug is in an unchanged file because the changed symbol is consumed there in a way that's now broken (cite the file and the contract from 2.5c that was violated)
    - **FALSE POSITIVE** — the code is actually correct (explain why)
    - **CONFIRMED with nuance** — the issue exists but is less severe than stated (explain)

**Move false positives to a separate "False-positives" section** at the end of the report. For each, give a one-line explanation of why it was dismissed. This lets the PR author verify the reasoning and catch verification mistakes.

Launch verification agents in parallel where findings are independent, except where the level dictates otherwise: level 2 batches all findings into a single verification agent, level 3 verifies per-finding, and levels 0-1 verify inline as findings are written. Each verification agent should read surrounding source files, not just the diff.

## Step 4: Output
You will provide all the information in three sections: `## Issues`, `## False-positives`, `## Summary`:

### Issues section
Present the validated findings in a table with the following columns:
- Issue ID (#1, #2 etc.)
- Issue name (3-5 words)
- Category: "Quality check" | title of the subagent (the task name)
- Severity: "Critical" | "Moderate" | "Minor"
- Location: "in-diff" | "out-of-diff" — for out-of-diff findings, name the file and the contract from 2.5c that was violated
- Description: Full impact in a plain, small paragraph (what breaks for the agent, the user, or the process)
- Steps to reproduce: a concrete sequence of tool calls / messages / timers / signals that triggers it
- Suggested fix

### False-positives section
Provide the list of false-positive findings from subagents that you verified do not exist, with the following fields:
- Category: title of the subagent (the task name)
- Description: the description from the subagent
- Explanation: your explanation of why it's a false positive

### Summary section
- One-line verdict: approve, request changes, or needs discussion
- Highlight any regressions or tradeoffs (especially to the disconnect-grace / no-duplicate-DML contract)
- State how many draft findings were verified vs dropped as false positives (e.g., "8 findings verified, 4 false positives removed")
- State the in-diff vs out-of-diff split (e.g., "5 findings in-diff, 3 findings out-of-diff").
