import { expect, test } from "bun:test"
import { addressBookLabel } from "./addressbook-label"

const t = (key: string, options?: Record<string, unknown>) => `${options?.ns}:${key}:${options?.symbol}`

test("translates the untouched own-address default at render time", () => {
	expect(addressBookLabel({ kind: "own", label: "My RUNE" }, t)).toBe("addressbook:ownSymbol:RUNE")
})

test("keeps labels the user typed and labels of other entries", () => {
	expect(addressBookLabel({ kind: "own", label: "My savings" }, t)).toBe("My savings")
	expect(addressBookLabel({ kind: "own", label: "Cold storage" }, t)).toBe("Cold storage")
	expect(addressBookLabel({ kind: "own", label: "ETH #0" }, t)).toBe("ETH #0")
	expect(addressBookLabel({ kind: "external", label: "My RUNE" }, t)).toBe("My RUNE")
	expect(addressBookLabel({ kind: "own", label: undefined }, t)).toBeUndefined()
})
