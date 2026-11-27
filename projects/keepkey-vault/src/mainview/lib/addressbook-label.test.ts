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

test("translates the seeded Zcash transparent-address default", () => {
	expect(addressBookLabel({ kind: "own", label: "My ZEC transparent address" }, t)).toBe("addressbook:ownTransparent:ZEC")
	expect(addressBookLabel({ kind: "external", label: "My ZEC transparent address" }, t)).toBe("My ZEC transparent address")
})

test("translates the seeded Zcash unified-address default (KEEPKEY-180)", () => {
	expect(addressBookLabel({ kind: "own", label: "My ZEC unified address" }, t)).toBe("addressbook:ownUnified:ZEC")
	expect(addressBookLabel({ kind: "external", label: "My ZEC unified address" }, t)).toBe("My ZEC unified address")
	expect(addressBookLabel({ kind: "own", label: "Shielded savings" }, t)).toBe("Shielded savings")
})
