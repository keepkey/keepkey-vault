/** DOM id of the drilled-chain token list; the crown's "+N" chip scrolls to it. */
export const CHAIN_TOKEN_LIST_ID = 'kk-chain-token-list'

export const CROWN_SPAN_MAX = (200 * Math.PI) / 180
export const CROWN_MAX_SATS = 9 // up to 9 tokens shown directly; beyond that 8 + "+N"

/** Geometry for the chain-detail crown: token satellites on an arc centred
 *  above the chain icon. Everything is derived from the icon and satellite
 *  sizes — never from the balance text, which lives in normal flow below the
 *  box this returns, so the two can't overlap at any balance length, token
 *  count or width. `s` scales every dimension for narrow columns. */
export function chainCrownLayout(tokenCount: number, s = 1) {
	const core = 96 * s
	const sat = 46 * s
	const gap = 12 * s
	const pad = 10 * s // room for glow + hover scale
	const visible = tokenCount > CROWN_MAX_SATS ? CROWN_MAX_SATS - 1 : tokenCount
	const extra = tokenCount - visible
	const count = visible + (extra > 0 ? 1 : 0)
	const rMin = core / 2 + sat / 2 + 20 * s
	// Few tokens: keep neighbours one (sat+gap) apart at rMin so the arc
	// shrinks around 12 o'clock instead of spreading 2 logos across 200°.
	const step = (sat + gap) / rMin
	const span = count > 1 ? Math.min(CROWN_SPAN_MAX, (count - 1) * step) : 0
	const r = count > 1 ? Math.max(rMin, ((count - 1) * (sat + gap)) / span) : rMin
	const angles = Array.from({ length: count }, (_, i) =>
		count === 1 ? -Math.PI / 2 : -Math.PI / 2 - span / 2 + (i * span) / (count - 1))
	const rel = angles.map(a => ({ a, dx: Math.cos(a) * r, dy: Math.sin(a) * r }))
	const halfW = Math.max(core / 2, ...rel.map(p => Math.abs(p.dx) + sat / 2))
	const above = Math.max(core / 2, ...rel.map(p => -p.dy + sat / 2))
	const below = Math.max(core / 2, ...rel.map(p => p.dy + sat / 2))
	const width = 2 * (halfW + pad)
	const height = above + below + 2 * pad
	const cx = width / 2
	const cy = above + pad
	return {
		core, sat, r, cx, cy, width, height, visible, extra, span,
		points: rel.map(p => ({ angle: p.a, x: cx + p.dx, y: cy + p.dy })),
	}
}
