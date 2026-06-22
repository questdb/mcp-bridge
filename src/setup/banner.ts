// Colours and gradient stops are taken from questdb-logotype.svg. Truecolor SGR
// codes, emitted only on an interactive stdout with NO_COLOR unset.
const FG_RESET = "\x1b[39m"
const fg = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`

const GRADIENT_START: [number, number, number] = [0x89, 0x2c, 0x6c]
const GRADIENT_END: [number, number, number] = [0xd1, 0x46, 0x71]
const FG_BRAND = fg(0xbe, 0x2f, 0x5b)

export const colorEnabled = (): boolean =>
  !process.env.NO_COLOR && process.stdout.isTTY === true

export const brand = (s: string): string =>
  colorEnabled() ? `${FG_BRAND}${s}${FG_RESET}` : s

export const green = (s: string): string =>
  colorEnabled() ? `\x1b[32m${s}${FG_RESET}` : s

export const red = (s: string): string =>
  colorEnabled() ? `\x1b[31m${s}${FG_RESET}` : s

export const gray = (s: string): string =>
  colorEnabled() ? `\x1b[90m${s}${FG_RESET}` : s

// String.raw so the backslashes in the art are taken literally.
const MARK_ART = String.raw`
       ++++++++++++
    ++++++++++++++++
  ++++++++++++++++   ***
 ++++++++          ******
+++++++             ******
++++++               ******
++=++     +++++**    *****
+++===     +*******
+++++=+      *********
 ++++++++      *********
  +++++++*****   *********
    ++++******     *********
       *******       *********
`

const MARK_ROWS = MARK_ART.replace(/^\n/, "").replace(/\n$/, "").split("\n")

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t)

const MAX_ROW = Math.max(1, MARK_ROWS.length - 1)
const MAX_COL = Math.max(1, ...MARK_ROWS.map((r) => r.length - 1))

const colorRow = (row: string, y: number): string => {
  if (!colorEnabled()) return row
  let line = ""
  for (let x = 0; x < row.length; x++) {
    const ch = row[x]
    if (ch === " ") {
      line += " "
      continue
    }
    const t = (y / MAX_ROW + x / MAX_COL) / 2
    line += fg(
      lerp(GRADIENT_START[0], GRADIENT_END[0], t),
      lerp(GRADIENT_START[1], GRADIENT_END[1], t),
      lerp(GRADIENT_START[2], GRADIENT_END[2], t),
    )
    line += ch
  }
  return line + FG_RESET
}

export const renderBanner = (): string =>
  MARK_ROWS.map((row, y) => colorRow(row, y)).join("\n")
