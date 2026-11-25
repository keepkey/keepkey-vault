import { describe, expect, test } from "bun:test"
import { chainCrownLayout, CROWN_SPAN_MAX } from "./chain-crown-layout"

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe("chainCrownLayout", () => {
	test("no tokens: only the chain icon", () => {
		const g = chainCrownLayout(0)
		expect(g.points).toHaveLength(0)
		expect(g.height).toBeCloseTo(g.core + 20)
	})

	test("one token sits at 12 o'clock", () => {
		const [p] = chainCrownLayout(1).points
		expect(p!.angle).toBeCloseTo(-Math.PI / 2)
	})

	test("two tokens are symmetric around the top and the arc stays tight", () => {
		const g = chainCrownLayout(2)
		const [a, b] = g.points
		expect(a!.x + b!.x).toBeCloseTo(2 * g.cx)
		expect(a!.y).toBeCloseTo(b!.y)
		expect(g.span).toBeLessThan(Math.PI / 2)
	})

	test("more than 9 tokens: 8 satellites + overflow chip", () => {
		const g = chainCrownLayout(15)
		expect(g.visible).toBe(8)
		expect(g.extra).toBe(7)
		expect(g.points).toHaveLength(9)
		expect(chainCrownLayout(9).extra).toBe(0)
	})

	for (const n of [1, 2, 3, 5, 8, 9, 10, 40]) for (const s of [0.7, 1]) {
		test(`n=${n} s=${s}: satellites never overlap, stay in the box, never dip into the text below`, () => {
			const g = chainCrownLayout(n, s)
			expect(g.span).toBeLessThanOrEqual(CROWN_SPAN_MAX + 1e-9)
			for (let i = 1; i < g.points.length; i++) expect(dist(g.points[i - 1]!, g.points[i]!)).toBeGreaterThanOrEqual(g.sat - 1e-6)
			for (const p of g.points) {
				expect(dist(p, { x: g.cx, y: g.cy })).toBeGreaterThanOrEqual(g.core / 2 + g.sat / 2)
				expect(p.x - g.sat / 2).toBeGreaterThanOrEqual(0)
				expect(p.x + g.sat / 2).toBeLessThanOrEqual(g.width)
				expect(p.y - g.sat / 2).toBeGreaterThanOrEqual(0)
				// Text block starts at the bottom of this box (normal flow).
				expect(p.y + g.sat / 2).toBeLessThanOrEqual(g.height)
			}
		})
	}
})
