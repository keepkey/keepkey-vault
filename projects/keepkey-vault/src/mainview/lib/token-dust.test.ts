import { describe, expect, test } from "bun:test"
import { splitDustTokens } from "./token-dust"
import { formatCompactBalance } from "./formatting"

describe("splitDustTokens", () => {
	test("priced tokens under $0.01 are dust, unpriced ones stay in the main list", () => {
		const { main, dust } = splitDustTokens([
			{ id: "steth", balanceUsd: 1418.18, priceUsd: 1679 },
			{ id: "hex", balanceUsd: 0.002, priceUsd: 0.002 },
			{ id: "weth", balanceUsd: 0, priceUsd: 3000 },
			{ id: "nofeed", balanceUsd: 0, priceUsd: 0 },
			{ id: "cent", balanceUsd: 0.01, priceUsd: 1 },
		])
		expect(main.map(t => t.id)).toEqual(["steth", "nofeed", "cent"])
		expect(dust.map(t => t.id)).toEqual(["hex", "weth"])
	})
})

describe("formatCompactBalance", () => {
	test("abbreviates millions and above", () => {
		expect(formatCompactBalance("20953883.97", "en-US")).toBe("20.95M")
		expect(formatCompactBalance("1500000000", "en-US")).toBe("1.5B")
	})
	test("leaves smaller quantities to formatBalance", () => {
		expect(formatCompactBalance("16.8042", "en-US")).toBe("16.8042")
		expect(formatCompactBalance("999999", "en-US")).toBe("999,999")
		expect(formatCompactBalance("0", "en-US")).toBe("0")
	})
})
