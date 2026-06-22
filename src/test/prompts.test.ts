import { render } from "@inquirer/testing"
import { describe, expect, it } from "vitest"
import { BACK, confirmBack, text } from "../setup/prompts.js"

const textConfig = {
  default: "",
  description: "",
  validate: () => true as const,
  theme: {},
}

const confirmConfig = {
  default: true,
  theme: {},
}

describe("text prompt", () => {
  it("returns the typed value on Enter", async () => {
    // Given a prompt the user types into
    const { answer, events } = await render(text, { message: "Name", ...textConfig })
    events.type("hello")

    // When the user presses Enter
    events.keypress("enter")

    // Then the typed value is returned
    expect(await answer).toBe("hello")
  })

  it("falls back to the default when Enter is pressed on an empty field", async () => {
    // Given a prompt with a default and no typed value
    const { answer, events } = await render(text, {
      message: "Origin",
      ...textConfig,
      default: "http://127.0.0.1:9000",
    })

    // When the user presses Enter
    events.keypress("enter")

    // Then the default is returned
    expect(await answer).toBe("http://127.0.0.1:9000")
  })

  it("clears the field on Esc when it has text, without going back", async () => {
    // Given a field with typed text over a default
    const { answer, events, getScreen } = await render(text, {
      message: "Origin",
      ...textConfig,
      default: "http://127.0.0.1:9000",
    })
    events.type("typed-junk")

    // When the user presses Esc once
    events.keypress("escape")

    // Then the field clears and the default hint returns
    expect(getScreen()).toContain("http://127.0.0.1:9000")

    // And Enter then accepts the default
    events.keypress("enter")
    expect(await answer).toBe("http://127.0.0.1:9000")
  })

  it("returns BACK on Esc when the field is already empty", async () => {
    // Given an empty field
    const { answer, events } = await render(text, { message: "Origin", ...textConfig })

    // When the user presses Esc
    events.keypress("escape")

    // Then it steps back
    expect(await answer).toBe(BACK)
  })

  it("clears on the first Esc, then steps back on the second", async () => {
    // Given a field with typed text
    const { answer, events } = await render(text, { message: "Origin", ...textConfig })
    events.type("abc")

    // When the user presses Esc twice
    events.keypress("escape")
    events.keypress("escape")

    // Then the first clears and the second steps back
    expect(await answer).toBe(BACK)
  })

  it("rejects an invalid value and keeps the prompt open", async () => {
    // Given a prompt that rejects "bad"
    const { answer, events, getScreen } = await render(text, {
      message: "Port",
      ...textConfig,
      validate: (v: string) => (v === "bad" ? "nope" : true),
    })

    // When the user submits an invalid value
    events.type("bad")
    events.keypress("enter")

    // Then the error shows and the prompt stays open for a valid retry
    expect(getScreen()).toContain("nope")
    events.keypress("escape")
    events.type("9000")
    events.keypress("enter")
    expect(await answer).toBe("9000")
  })
})

describe("confirmBack prompt", () => {
  it("returns the default when Enter is pressed on an empty answer", async () => {
    // Given a confirm defaulting to true
    const { answer, events } = await render(confirmBack, {
      message: "Apply?",
      ...confirmConfig,
      default: true,
    })

    // When the user presses Enter without typing
    events.keypress("enter")

    // Then the default is returned
    expect(await answer).toBe(true)
  })

  it("returns false when the user types no", async () => {
    // Given a confirm prompt
    const { answer, events } = await render(confirmBack, { message: "Apply?", ...confirmConfig })

    // When the user types "n" and submits
    events.type("n")
    events.keypress("enter")

    // Then it returns false
    expect(await answer).toBe(false)
  })

  it("returns BACK on Esc", async () => {
    // Given a confirm prompt
    const { answer, events } = await render(confirmBack, { message: "Apply?", ...confirmConfig })

    // When the user presses Esc
    events.keypress("escape")

    // Then it steps back
    expect(await answer).toBe(BACK)
  })
})
