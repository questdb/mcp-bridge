import readline from "node:readline"
import {
  createPrompt,
  isBackspaceKey,
  isEnterKey,
  makeTheme,
  useKeypress,
  usePrefix,
  useState,
} from "@inquirer/core"

export const BACK = Symbol("setup:back")
export type Back = typeof BACK

// Esc is the prefix of arrow-key escape sequences, so readline waits
// `escapeCodeTimeout` ms (default 500) after a lone Esc before reporting it.
// The value is captured once when keypress decoding is first armed for a stream,
// so we pre-arm stdin with a small timeout before @inquirer creates its readline
// — its later setup becomes a no-op and our value governs.
const ESCAPE_TIMEOUT_MS = 25

export const armFastEscape = (): void => {
  if (!process.stdin.isTTY) return
  readline.emitKeypressEvents(
    process.stdin,
    { escapeCodeTimeout: ESCAPE_TIMEOUT_MS } as unknown as readline.Interface,
  )
}

const isEscape = (key: { name?: string }): boolean => key.name === "escape"

type ThemeArg = { style?: { highlight?: (text: string) => string } }

type TextConfig = {
  message: string
  default: string
  description: string
  validate: (value: string) => boolean | string
  theme: ThemeArg
}

// Enter accepts (falling back to `default` when empty); Esc clears a non-empty
// field, or returns BACK when the field is already empty.
export const text = createPrompt<string | Back, TextConfig>((config, done) => {
  const theme = makeTheme(config.theme)
  const [status, setStatus] = useState<string>("idle")
  const [defaultValue, setDefaultValue] = useState(config.default)
  const [errorMsg, setError] = useState<string | undefined>(undefined)
  const [value, setValue] = useState("")
  const prefix = usePrefix({ status, theme })

  useKeypress((key, rl) => {
    if (status !== "idle") return

    if (isEscape(key)) {
      if (value.length > 0) {
        rl.clearLine(0)
        setValue("")
        setError(undefined)
      } else {
        setStatus("done")
        done(BACK)
      }
      return
    }

    if (isEnterKey(key)) {
      const answer = value || defaultValue
      const valid = config.validate(answer)
      if (valid === true) {
        setValue(answer)
        setStatus("done")
        done(answer)
      } else {
        rl.write(value)
        setError(typeof valid === "string" ? valid : "Invalid input")
      }
    } else if (isBackspaceKey(key) && !value) {
      setDefaultValue("")
    } else {
      setValue(rl.line)
      setError(undefined)
    }
  })

  const message = theme.style.message(config.message, status)
  const formatted = status === "done" ? theme.style.answer(value) : value
  const defaultStr =
    defaultValue && status !== "done" && !value
      ? theme.style.defaultAnswer(defaultValue)
      : undefined
  let bottom = ""
  if (errorMsg) bottom = theme.style.error(errorMsg)
  else if (status !== "done") bottom = theme.style.help(`  ${config.description}`)
  return [
    [prefix, message, defaultStr, formatted].filter((v) => v !== undefined).join(" "),
    bottom,
  ]
})

type ConfirmConfig = {
  message: string
  default: boolean
  theme: ThemeArg
}

// Enter accepts (the default when empty), y/n typed, Esc returns BACK.
export const confirmBack = createPrompt<boolean | Back, ConfirmConfig>(
  (config, done) => {
    const theme = makeTheme(config.theme)
    const [status, setStatus] = useState<string>("idle")
    const [value, setValue] = useState("")
    const prefix = usePrefix({ status, theme })

    useKeypress((key, rl) => {
      if (status !== "idle") return
      if (isEscape(key)) {
        setStatus("done")
        done(BACK)
        return
      }
      if (isEnterKey(key)) {
        const lower = value.trim().toLowerCase()
        const answer = lower === "" ? config.default : lower.startsWith("y")
        setValue(answer ? "yes" : "no")
        setStatus("done")
        done(answer)
        return
      }
      setValue(rl.line)
    })

    const message = theme.style.message(config.message, status)
    if (status === "done") {
      return `${prefix} ${message} ${theme.style.answer(value)}`
    }
    const hint = config.default ? "Y/n" : "y/N"
    return `${prefix} ${message} ${theme.style.defaultAnswer(hint)} ${value}`
  },
)
