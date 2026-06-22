import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

// Insert/replace our server while preserving the user's comments and formatting
// (handles both .json and .jsonc). `alreadyExists` distinguishes a fresh write
// from a reconfigure. Throws if the existing file is structurally invalid — a
// tolerant edit would emit still-broken JSON, so we leave it untouched and let
// the caller report a failure rather than a false success.
export const upsertJsonServer = (
  raw: string,
  configKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): { content: string; alreadyExists: boolean } => {
  const source = raw.trim() === "" ? "{}" : raw
  const errors: ParseError[] = []
  const parsed = parse(source, errors, { allowTrailingComma: true }) as
    | Record<string, unknown>
    | undefined
  if (errors.length > 0) {
    throw new Error("existing config is not valid JSON; left it untouched")
  }
  const section = parsed?.[configKey]
  const alreadyExists =
    typeof section === "object" && section !== null && serverName in section
  const edits = modify(source, [configKey, serverName], entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const content = applyEdits(source, edits)
  return { content: content.endsWith("\n") ? content : content + "\n", alreadyExists }
}

const tomlString = (value: string): string => `"${value.replace(/(["\\])/g, "\\$1")}"`

// Minimal TOML serializer for our entry shape ({ command, args, env? }).
export const buildTomlServerBlock = (
  configKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): string => {
  const lines: string[] = [`[${configKey}.${serverName}]`]
  const command = entry.command
  if (typeof command === "string") lines.push(`command = ${tomlString(command)}`)
  const args = entry.args
  if (Array.isArray(args)) {
    const items = args.map((a) => tomlString(String(a))).join(", ")
    lines.push(`args = [${items}]`)
  }
  const env = entry.env
  if (env && typeof env === "object" && Object.keys(env).length > 0) {
    lines.push("")
    lines.push(`[${configKey}.${serverName}.env]`)
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      lines.push(`${k} = ${tomlString(String(v))}`)
    }
  }
  return lines.join("\n") + "\n"
}

// The bracketed table header on a line, ignoring trailing whitespace/comments
// and quoted contents; null when the line isn't a table header. Used so a header
// carrying an inline comment (`[t] # note`) still matches our existing block
// instead of appending a duplicate table.
const tomlTableHeader = (line: string): string | null => {
  const trimmed = line.trim()
  if (!trimmed.startsWith("[")) return null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === "]") {
      return trimmed.slice(0, i + 1)
    }
  }
  return null
}

// Replace an existing [configKey.serverName] block (including its .env subtable)
// in place, or append a fresh one. Block boundaries: from the header line up to
// the next top-level `[` that is NOT a subtable of our server, or EOF.
export const upsertTomlServer = (
  raw: string,
  configKey: string,
  serverName: string,
  entry: Record<string, unknown>,
): { content: string; alreadyExists: boolean } => {
  const block = buildTomlServerBlock(configKey, serverName, entry)
  const header = `[${configKey}.${serverName}]`
  const subPrefix = `[${configKey}.${serverName}.`

  const lines = raw.split("\n")
  const startIdx = lines.findIndex((l) => tomlTableHeader(l) === header)
  if (startIdx === -1) {
    const trimmed = raw.replace(/\s*$/, "")
    const sep = trimmed === "" ? "" : "\n\n"
    return { content: trimmed + sep + block, alreadyExists: false }
  }

  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const hdr = tomlTableHeader(lines[i])
    if (hdr === null) continue
    if (hdr === header || hdr.startsWith(subPrefix)) continue
    endIdx = i
    break
  }
  let spliceEnd = endIdx
  while (spliceEnd > startIdx + 1 && lines[spliceEnd - 1].trim() === "") {
    spliceEnd--
  }
  const before = lines.slice(0, startIdx).join("\n").replace(/\s*$/, "")
  const after = lines.slice(spliceEnd).join("\n").replace(/^\s*/, "")
  const beforeSep = before === "" ? "" : "\n\n"
  const afterSep = after === "" ? "" : "\n\n"
  const content =
    before + beforeSep + block.replace(/\n$/, "") + (after === "" ? "\n" : afterSep + after)
  return { content, alreadyExists: true }
}

export const readRawFile = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf-8")
  } catch {
    return ""
  }
}

export const writeRawFile = async (
  filePath: string,
  content: string,
): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf-8")
}
