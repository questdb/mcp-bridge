#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, "../consts/shared-definitions.json")

const repo = process.env.UPSTREAM_REPO ?? "questdb/ui"
const ref = process.env.UPSTREAM_REF ?? "main"
const path = process.env.UPSTREAM_PATH ?? "src/consts/shared-definitions.json"
const url =
  process.env.UPSTREAM_URL ??
  `https://raw.githubusercontent.com/${repo}/${ref}/${path}`

const sha256 = (s) => createHash("sha256").update(s).digest("hex")

const res = await fetch(url)
if (!res.ok) {
  console.error(`sync-tools: fetch failed: ${url} → HTTP ${res.status}`)
  process.exit(1)
}
const upstreamText = await res.text()

let priorText = ""
try {
  priorText = await readFile(target, "utf8")
} catch (err) {
  if (err.code !== "ENOENT") throw err
}

const before = priorText ? sha256(priorText) : "(absent)"
const after = sha256(upstreamText)

if (before === after) {
  console.log(
    `sync-tools: shared-definitions.json already matches ${url} ` +
      `(sha256 ${after.slice(0, 12)}…)`,
  )
  process.exit(0)
}

await writeFile(target, upstreamText)
console.log(`sync-tools: updated shared-definitions.json`)
console.log(`  source: ${url}`)
console.log(`  before: ${before}`)
console.log(`  after:  ${after}`)
console.log(`  bytes:  ${upstreamText.length}`)
