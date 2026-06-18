import { describe, expect, it } from "vitest"
import { parseCli, parsePort } from "../cli.js"

const HELP = () => "HELP TEXT BODY"

describe("parseCli", () => {
  it("starts on no command and on the explicit `start`", () => {
    expect(parseCli([], "1.2.3", HELP)).toEqual({ kind: "start" })
    expect(parseCli(["start"], "1.2.3", HELP)).toEqual({ kind: "start" })
  })

  it("prints the version and exits 0 for --version and -v", () => {
    expect(parseCli(["--version"], "1.2.3", HELP)).toEqual({
      kind: "exit",
      code: 0,
      stdout: "1.2.3\n",
    })
    expect(parseCli(["-v"], "9.9.9", HELP)).toEqual({
      kind: "exit",
      code: 0,
      stdout: "9.9.9\n",
    })
  })

  it("prints help and exits 0 for --help and -h", () => {
    expect(parseCli(["--help"], "1.2.3", HELP)).toEqual({
      kind: "exit",
      code: 0,
      stdout: "HELP TEXT BODY",
    })
    expect(parseCli(["-h"], "1.2.3", HELP).kind).toBe("exit")
  })

  it("exits 2 with a stderr message on an unknown command", () => {
    const out = parseCli(["frobnicate"], "1.2.3", HELP)
    if (out.kind !== "exit") throw new Error("expected exit")
    expect(out.code).toBe(2)
    expect(out.stderr).toContain("unknown command 'frobnicate'")
    expect(out.stdout).toBeUndefined()
  })
})

describe("parsePort", () => {
  it("auto-allocates when unset or empty", () => {
    expect(parsePort(undefined)).toEqual({ auto: true })
    expect(parsePort("")).toEqual({ auto: true })
  })

  it("pins a valid 1-65535 integer", () => {
    expect(parsePort("9000")).toEqual({ pinned: 9000 })
    expect(parsePort("1")).toEqual({ pinned: 1 })
    expect(parsePort("65535")).toEqual({ pinned: 65535 })
  })

  it("errors on a non-integer", () => {
    expect("error" in parsePort("12ab")).toBe(true)
    expect("error" in parsePort("9000.5")).toBe(true)
    expect("error" in parsePort("-1")).toBe(true)
  })

  it("errors on out-of-range ports", () => {
    expect("error" in parsePort("0")).toBe(true)
    expect("error" in parsePort("70000")).toBe(true)
  })
})
