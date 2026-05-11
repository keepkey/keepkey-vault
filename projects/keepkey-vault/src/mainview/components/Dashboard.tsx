import { Component, useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type ErrorInfo } from "react"
import { Box, Flex, Text, Spinner, Image, SimpleGrid, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { CHAINS, customChainToChainDef, isChainSupported, type ChainDef } from "../../shared/chains"
import { versionCompare } from "../../shared/firmware-versions"
import { formatBalance } from "../lib/formatting"
import { AnimatedUsd } from "./AnimatedUsd"
import { getAssetIcon, registerCustomAsset } from "../../shared/assetLookup"
import { AssetPage } from "./AssetPage"
import { DonutChart, ChartLegend, type DonutChartItem } from "./DonutChart"
import { AddChainDialog } from "./AddChainDialog"
import { ReportDialog } from "./ReportDialog"
import { Bip85VaultDialog } from "./Bip85VaultDialog"

import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { categorizeTokens } from "../../shared/spamFilter"
import type { ChainBalance, CustomChain, TokenVisibilityStatus, AppSettings, TokenBalance } from "../../shared/types"
import { playChaChing } from "../lib/sounds"
import { useImagePreload } from "../lib/use-image-preload"

/** Error boundary wrapping AssetPage — ensures user can always go back to Dashboard */
class AssetPageErrorBoundary extends Component<
	{ children: ReactNode; onBack: () => void; chainName: string },
	{ hasError: boolean; error: Error | null }
> {
	state: { hasError: boolean; error: Error | null } = { hasError: false, error: null }
	static getDerivedStateFromError(error: Error) { return { hasError: true, error } }
	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('[AssetPageErrorBoundary]', error, info)
	}
	render() {
		if (this.state.hasError) {
			return (
				<Flex direction="column" align="center" justify="center" gap="4" py="12" px="6" minH="300px">
					<Text fontSize="lg" fontWeight="600" color="red.400">
						Failed to load {this.props.chainName}
					</Text>
					<Text fontSize="sm" color="kk.textMuted" textAlign="center" maxW="440px">
						{this.state.error?.message || 'An unexpected error occurred while loading this asset page.'}
					</Text>
					<Flex gap="3">
						<Button
							size="sm"
							variant="ghost"
							color="kk.gold"
							onClick={() => this.setState({ hasError: false, error: null })}
						>
							Try Again
						</Button>
						<Button
							size="sm"
							variant="ghost"
							color="kk.textSecondary"
							_hover={{ color: "white" }}
							onClick={this.props.onBack}
						>
							&larr; Back to Dashboard
						</Button>
					</Flex>
				</Flex>
			)
		}
		return this.props.children
	}
}

const DASHBOARD_ANIMATIONS = `
	@keyframes pulseGold {
		0%, 100% { box-shadow: 0 0 12px rgba(233,196,106,0.4); }
		50% { box-shadow: 0 0 24px rgba(233,196,106,0.7); }
	}
	@keyframes glowCta {
		0% { box-shadow: 0 0 8px rgba(233,196,106,0.3), 0 0 20px rgba(233,196,106,0.1); }
		50% { box-shadow: 0 0 16px rgba(233,196,106,0.5), 0 0 40px rgba(233,196,106,0.2); }
		100% { box-shadow: 0 0 8px rgba(233,196,106,0.3), 0 0 20px rgba(233,196,106,0.1); }
	}
	@keyframes v3-spin {
		from { transform: rotate(0deg); }
		to   { transform: rotate(360deg); }
	}
	@keyframes kkBounceUp {
		0%   { opacity: 0; transform: translateY(8px) scale(0.96); }
		60%  { opacity: 1; transform: translateY(-3px) scale(1.02); }
		100% { opacity: 1; transform: translateY(0) scale(1); }
	}
	@keyframes kkBubbleIn {
		0%   { opacity: 0; transform: scale(0.3); }
		70%  { opacity: 1; transform: scale(1.08); }
		100% { opacity: 1; transform: scale(1); }
	}
	@keyframes kkBubbleLine {
		0%   { stroke-dashoffset: 24; opacity: 0; }
		100% { stroke-dashoffset: 0;  opacity: 0.28; }
	}
`

/* localStorage key for user's preferred portfolio view. */
const DASHBOARD_VIEW_KEY = 'keepkey.dashboard.view'
type DashboardView = 'orbit' | 'grid'
function readSavedView(): DashboardView {
	try {
		const v = localStorage.getItem(DASHBOARD_VIEW_KEY)
		// Legacy 'orbital' / 'donut' values from the previous toggle map to 'orbit'.
		return v === 'grid' ? 'grid' : 'orbit'
	} catch { return 'orbit' }
}

/** Orbital portfolio view — chain logos placed in a constellation around
 *  the center total. Departs from the original perfect-circle layout in
 *  three ways:
 *    1. Logo size scales with USD share — biggest chain reads visually as
 *       "biggest holding" without needing to lean on the numeric label.
 *       Range 56→128px (vs old 40→72) so the diff actually communicates.
 *    2. Logos alternate between two concentric radii (inner / outer) so
 *       the layout reads as a constellation rather than a perfect ring.
 *       The largest chain anchors top-inner; smaller chains zigzag outward.
 *    3. Up to 10 chains visible (was 8) — extra slots cost little when
 *       sizes vary, and the per-chain "+N tokens" badge becomes useful
 *       on more rows. */
function OrbitalView({
	chains,
	balances,
	cleanBalanceUsd,
	totalUsd,
	totalDollars,
	totalCents,
	cleanTokenTotal,
	onSelect,
	mode,
	onShowReports,
	onRefresh,
	loadingBalances,
	cacheUpdatedAt,
	canShowReports,
	t,
}: {
	chains: ChainDef[]
	balances: Map<string, ChainBalance>
	cleanBalanceUsd: Map<string, { usd: number; cleanTokenCount: number }>
	totalUsd: number
	totalDollars: number
	totalCents: string
	cleanTokenTotal: number
	onSelect: (c: ChainDef) => void
	mode: DashboardView
	onShowReports: () => void
	onRefresh: () => void
	loadingBalances: boolean
	cacheUpdatedAt: number | null
	canShowReports: boolean
	t: (key: string, opts?: any) => string
}) {
	const [hover, setHover] = useState<string | null>(null)
	// Which chain (if any) has its +N tokens badge expanded into child bubbles.
	// One-at-a-time so the layout stays legible. Click the badge again, the
	// chain icon, or anywhere on the canvas backdrop to collapse.
	const [expandedChainId, setExpandedChainId] = useState<string | null>(null)
	useEffect(() => {
		if (!expandedChainId) return
		const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedChainId(null) }
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [expandedChainId])
	// Rectangular canvas — width and height are independent so the orbital
	// can actually fill widescreen layouts instead of being clamped to a
	// square that leaves big empty bands on either side. The icon hierarchy
	// scales against the *smaller* dimension (so portrait windows still
	// produce sensible sizing); slot positions use whichever dimension
	// applies (corners at (half, half), edge mids at (cx, half), etc.).
	const [dims, setDims] = useState({ w: 440, h: 440 })

	useEffect(() => {
		const compute = () => {
			const wAvail = window.innerWidth - 64
			const hAvail = window.innerHeight - 260
			// Width: up to 1280px on a wide monitor (icons + spacing still
			// look balanced beyond that, but the page starts feeling empty).
			// Height: capped tighter so the chain list below stays on-screen.
			const w = Math.min(1280, Math.max(280, wAvail))
			const h = Math.min(820,  Math.max(280, hAvail))
			setDims({ w, h })
		}
		compute()
		window.addEventListener('resize', compute)
		return () => window.removeEventListener('resize', compute)
	}, [])

	const { w: width, h: height } = dims
	const cx = width / 2
	const cy = height / 2
	// Decorative dashed ring stays an inscribed circle so it's always
	// fully visible regardless of aspect ratio.
	const ringR = Math.min(width, height) * 0.46
	// Icon scale tracks the smaller dimension — at very wide aspect ratios
	// we don't want icons ballooning past what looks balanced.
	const sizeRef = Math.min(width, height)

	// Build the chain set once per data change. Up to 10 visible, sorted by
	// USD desc so the biggest gets index 0 (anchored top).
	const orbitChains = useMemo(
		() => chains
			.map(c => ({ chain: c, usd: cleanBalanceUsd.get(c.id)?.usd || 0, bal: balances.get(c.id) }))
			.filter(x => x.usd > 0)
			.sort((a, b) => b.usd - a.usd)
			.slice(0, 10),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[chains.map(c => c.id).join('|'), Array.from(cleanBalanceUsd.entries()).map(([k, v]) => `${k}:${v.usd}`).join('|')]
	)

	// Max USD across the visible set — drives the size scale. Falls back to
	// 1 so a single-chain wallet still produces a sensible size, not a NaN.
	const maxOrbitUsd = orbitChains.reduce((m, x) => Math.max(m, x.usd), 0) || 1

	// ── Layout: square-aware radial, big-outside / small-inside ─────────
	// Each chain gets a size proportional to its USD share (56→144px) and
	// a position computed in two phases:
	//   Phase A — radial seed. Spread chains around the full 360° using a
	//   golden-angle spiral. At each chain's angle, find the SQUARE
	//   boundary radius (Chebyshev distance, not Euclidean — so chains at
	//   45° angles get pushed all the way to the corners of the container,
	//   not just to the inscribed circle). Place the chain at a fraction
	//   of that boundary radius scaled by its USD share: biggest chain
	//   sits at the edge, smallest sits well inside.
	//   Phase B — force relaxation. Iteratively repulse overlapping
	//   neighbours and push any chain whose box intersects the center
	//   totals out along the smaller-overlap axis. 60 iterations is
	//   enough for 10 nodes to settle stably.
	// Net effect: corners of the square fill with the biggest holdings;
	// smaller chains pull inward toward the center text but never overlap
	// it or each other. Looks like a portfolio bento, not a clock face.
	const layout = useMemo(() => {
		if (orbitChains.length === 0) return [] as Array<{
			chain: ChainDef; usd: number; bal: ChainBalance | undefined;
			x: number; y: number; sat: number
		}>
		const N = orbitChains.length
		// Scale icon sizes against the smaller container dimension — 440 was
		// the old fixed cap so its constants encoded an unstated "1.0 at 440".
		// Tracking the smaller dim keeps icons sane on portrait windows.
		const k = sizeRef / 440
		// Orbit mode runs ~20% smaller per the redesign — icons that big felt
		// shouty against the new card frame; grid mode keeps the full size
		// since each tile gets a visible background that has to read at scale.
		const modeScale = mode === 'orbit' ? 0.8 : 1.0
		const items = orbitChains.map((c, i) => {
			const share = c.usd / maxOrbitUsd
			// Two-axis sizing — bigger USD share AND a higher slot rank both
			// inflate the icon. Slot rank pushes corner chains (i<4) toward
			// the top end so the four corners always feel anchored; share
			// carries the rest of the hierarchy.
			const rankBoost = i < 4 ? 1.0 : i < 8 ? 0.5 : 0.25
			const sat = Math.round((56 + share * 96 * rankBoost + rankBoost * 24) * k * modeScale)
			return { ...c, sat }
		})
		// Center totals rectangle — chains must clear this region.
		const textHalfW = Math.max(96, width * 0.18)
		const textHalfH = Math.max(60, height * 0.14)
		const gap = 8
		// Phase A — deterministic corner-first slots. Forces the four biggest
		// chains into the four corners of the container, the next four into
		// the four edge midpoints, and the remaining two inward on the
		// diagonal. Layout reads as a filled rectangle (corners visible)
		// rather than a circle.
		const slot = (rank: number, sat: number): { x: number; y: number } => {
			const half = sat / 2 + 6
			const innerOffX = width * 0.22
			const innerOffY = height * 0.22
			switch (rank) {
				case 0: return { x: half, y: half }                            // TL corner
				case 1: return { x: width - half, y: half }                    // TR corner
				case 2: return { x: width - half, y: height - half }           // BR corner
				case 3: return { x: half, y: height - half }                   // BL corner
				case 4: return { x: cx, y: half }                              // Top edge mid
				case 5: return { x: width - half, y: cy }                      // Right edge mid
				case 6: return { x: cx, y: height - half }                     // Bottom edge mid
				case 7: return { x: half, y: cy }                              // Left edge mid
				case 8: return { x: cx - innerOffX, y: cy - innerOffY }        // TL inner
				case 9: return { x: cx + innerOffX, y: cy + innerOffY }        // BR inner
				default: return { x: cx, y: cy }
			}
		}
		const pos = items.map((it, i) => slot(i, it.sat))
		// Phase B — relax for non-overlap + text clearance.
		// Grid mode skips relaxation: slots are deterministic, the visual
		// language is "fixed tiles on a wall mosaic", not a constellation.
		// Overlaps in grid mode get resolved by the slot function itself
		// (corner-first / edge-mid layout) since icons there are smaller.
		const ITER = mode === 'orbit' ? 80 : 0
		for (let k = 0; k < ITER; k++) {
			for (let i = 0; i < N; i++) {
				// Pairwise repulsion — hard non-overlap guarantee.
				for (let j = 0; j < N; j++) {
					if (i === j) continue
					let dx = pos[i].x - pos[j].x
					let dy = pos[i].y - pos[j].y
					let d = Math.sqrt(dx * dx + dy * dy)
					if (d < 0.001) { d = 0.001; dx = 0.001; dy = 0 }
					const minD = items[i].sat / 2 + items[j].sat / 2 + gap
					if (d < minD) {
						const push = (minD - d) / 2
						const ux = dx / d
						const uy = dy / d
						pos[i].x += ux * push
						pos[i].y += uy * push
						pos[j].x -= ux * push
						pos[j].y -= uy * push
					}
				}
				// Clear center totals box — push along the smaller-overlap
				// axis so chains slide laterally rather than jumping.
				const dxC = pos[i].x - cx
				const dyC = pos[i].y - cy
				const clearX = textHalfW + items[i].sat / 2 + gap
				const clearY = textHalfH + items[i].sat / 2 + gap
				if (Math.abs(dxC) < clearX && Math.abs(dyC) < clearY) {
					const overlapX = clearX - Math.abs(dxC)
					const overlapY = clearY - Math.abs(dyC)
					if (overlapX < overlapY) {
						pos[i].x += Math.sign(dxC || 1) * overlapX
					} else {
						pos[i].y += Math.sign(dyC || 1) * overlapY
					}
				}
				// Clamp to container, accounting for the USD label band.
				const halfX = items[i].sat / 2 + 2
				const halfY = items[i].sat / 2 + 18 // ~18px label below
				pos[i].x = Math.max(halfX, Math.min(width - halfX, pos[i].x))
				pos[i].y = Math.max(halfY, Math.min(height - halfY, pos[i].y))
			}
		}
		return items.map((it, i) => ({ ...it, x: pos[i].x, y: pos[i].y }))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [orbitChains.map(c => `${c.chain.id}:${c.usd}`).join('|'), width, height, cx, cy, maxOrbitUsd, sizeRef, mode])

	/* Token-bubble layout — computed when a chain has its +N badge expanded.
	 *
	 * Each token gets a bubble sized by its USD share of the parent chain's
	 * token total. Bubbles seed in a ring around the chain icon at golden-angle
	 * offsets, then 50 iterations of relaxation push them away from every
	 * existing body (chains, center text region, other tokens) and clamp
	 * inside the canvas. Net effect: bubbles "tree" out from their chain icon
	 * without overlapping anything else on the canvas. */
	const tokenLayout = useMemo(() => {
		if (!expandedChainId) return [] as Array<{
			tok: TokenBalance; x: number; y: number; sat: number; pct: number
		}>
		const parent = layout.find(c => c.chain.id === expandedChainId)
		if (!parent) return []
		const tokens = parent.bal?.tokens ?? []
		if (tokens.length === 0) return []

		// Sort by USD desc — biggest tokens lay out first so they get the best
		// slots; tiny dust tokens fill in afterward.
		const sorted = [...tokens].sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0))
		const tokenTotal = sorted.reduce((s, t) => s + (t.balanceUsd || 0), 0) || 1
		const maxTok = Math.max(...sorted.map(t => t.balanceUsd || 0)) || 1

		// Size: 28→64 across USD share. Tracks sizeRef too so on tiny
		// containers the bubbles don't dominate.
		const tokenScale = Math.min(1, sizeRef / 440)
		const items = sorted.map(tok => {
			const share = (tok.balanceUsd || 0) / maxTok
			const sat = Math.max(28, Math.round((28 + share * 36) * tokenScale))
			return { tok, sat, pct: ((tok.balanceUsd || 0) / tokenTotal) * 100 }
		})

		// Seed positions on a ring around the parent chain icon.
		const N = items.length
		const seedR = parent.sat / 2 + 28
		const GOLDEN = Math.PI * (3 - Math.sqrt(5))
		const pos = items.map((_, i) => {
			const a = i * GOLDEN
			return {
				x: parent.x + Math.cos(a) * seedR,
				y: parent.y + Math.sin(a) * seedR,
			}
		})

		// Build the obstacle list — chains + center text region.
		const textHalfW = Math.max(96, width * 0.18)
		const textHalfH = Math.max(60, height * 0.14)
		const gap = 6
		const ITER = 50
		for (let k = 0; k < ITER; k++) {
			for (let i = 0; i < N; i++) {
				// Repel from every chain icon (always non-overlap).
				for (const c of layout) {
					let dx = pos[i].x - c.x
					let dy = pos[i].y - c.y
					let d = Math.sqrt(dx * dx + dy * dy)
					if (d < 0.001) { d = 0.001; dx = 0.001; dy = 0 }
					const minD = items[i].sat / 2 + c.sat / 2 + gap
					if (d < minD) {
						const push = (minD - d)
						pos[i].x += (dx / d) * push
						pos[i].y += (dy / d) * push
					}
				}
				// Repel from sibling tokens.
				for (let j = 0; j < N; j++) {
					if (i === j) continue
					let dx = pos[i].x - pos[j].x
					let dy = pos[i].y - pos[j].y
					let d = Math.sqrt(dx * dx + dy * dy)
					if (d < 0.001) { d = 0.001; dx = 0.001; dy = 0 }
					const minD = items[i].sat / 2 + items[j].sat / 2 + gap
					if (d < minD) {
						const push = (minD - d) / 2
						const ux = dx / d, uy = dy / d
						pos[i].x += ux * push
						pos[i].y += uy * push
						pos[j].x -= ux * push
						pos[j].y -= uy * push
					}
				}
				// Clear center totals rectangle.
				const dxC = pos[i].x - cx
				const dyC = pos[i].y - cy
				const clearX = textHalfW + items[i].sat / 2 + gap
				const clearY = textHalfH + items[i].sat / 2 + gap
				if (Math.abs(dxC) < clearX && Math.abs(dyC) < clearY) {
					const overlapX = clearX - Math.abs(dxC)
					const overlapY = clearY - Math.abs(dyC)
					if (overlapX < overlapY) pos[i].x += Math.sign(dxC || 1) * overlapX
					else                     pos[i].y += Math.sign(dyC || 1) * overlapY
				}
				// Clamp to container.
				const halfX = items[i].sat / 2 + 2
				const halfY = items[i].sat / 2 + 16
				pos[i].x = Math.max(halfX, Math.min(width - halfX, pos[i].x))
				pos[i].y = Math.max(halfY, Math.min(height - halfY, pos[i].y))
			}
		}
		return items.map((it, i) => ({ ...it, x: pos[i].x, y: pos[i].y }))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		expandedChainId,
		layout.map(c => `${c.chain.id}:${c.x.toFixed(0)}:${c.y.toFixed(0)}:${c.sat}`).join('|'),
		width, height, cx, cy, sizeRef,
	])

	/* Matter.js physics — orbit mode only.
	 *
	 *  Each chain icon is a circle body. Bodies are bound softly to their
	 *  deterministic slot via spring constraints (stiffness 0.01, damping
	 *  0.1) — they wander on disturbance but always come home. Built-in
	 *  Matter collisions handle non-overlap with realistic bounce.
	 *
	 *  Mouse drag uses Matter's MouseConstraint so dragging a body has
	 *  proper feel — it follows the cursor, and on release retains the
	 *  swipe velocity for momentum throws.
	 *
	 *  Loading entrance: bodies spawn well above the canvas with a small
	 *  random downward velocity. Their slot springs yank them into
	 *  formation, where they bounce off each other before settling — the
	 *  "coins dropping into a tray" sequence the user wanted.
	 *
	 *  Rendering: we DO NOT use React state per frame. A RAF loop reads
	 *  body.position and writes directly to each chain's DOM transform.
	 *  That keeps the engine running at 60fps independently of the React
	 *  tree (which only updates on hover, expansion, etc.).
	 */
	const physicsEnabled = mode === 'orbit'
	const chainElRefs = useRef<Map<string, HTMLDivElement | null>>(new Map())
	const physicsRef = useRef<{
		engine: any | null
		bodies: Map<string, any>     // chainId → Matter.Body
		halfSizes: Map<string, number>
		raf: number | null
		dragMoved: boolean
	}>({ engine: null, bodies: new Map(), halfSizes: new Map(), raf: null, dragMoved: false })
	const suppressClickRef = useRef(false)

	useEffect(() => {
		if (!physicsEnabled || layout.length === 0 || width < 100 || height < 100) return
		// Matter is moderately large; import on demand so users who never
		// touch Orbit mode don't pay for it.
		let cancelled = false
		let cleanup: (() => void) | null = null
		;(async () => {
			const Matter = await import('matter-js')
			if (cancelled) return
			const { Engine, World, Bodies, Body, Constraint, Composite } = Matter
			const engine = Engine.create({
				gravity: { x: 0, y: 0, scale: 0 },        // no falling — springs do the work
				enableSleeping: false,
				positionIterations: 8,
				velocityIterations: 8,
			})
			const world = engine.world

			// Canvas-edge walls. Static, slightly elastic so bodies bounce
			// instead of sticking. Wall thickness 100 keeps them off-screen.
			const wallOpts = { isStatic: true, restitution: 0.6, friction: 0.05 }
			Composite.add(world, [
				Bodies.rectangle(width / 2, -50,         width + 200, 100, wallOpts),
				Bodies.rectangle(width / 2, height + 50, width + 200, 100, wallOpts),
				Bodies.rectangle(-50,         height / 2, 100, height + 200, wallOpts),
				Bodies.rectangle(width + 50,  height / 2, 100, height + 200, wallOpts),
			])
			// Center text region — an invisible static rectangle so bodies
			// physically can't land on the price label.
			const textHalfW = Math.max(96, width * 0.18)
			const textHalfH = Math.max(60, height * 0.14)
			Composite.add(world, Bodies.rectangle(
				width / 2, height / 2,
				textHalfW * 2, textHalfH * 2,
				{ isStatic: true, restitution: 0.7, friction: 0.04, render: { visible: false } },
			))

			const bodies = new Map<string, any>()
			const halfSizes = new Map<string, number>()
			// Tracks which bodies have actually been added to the world (the
			// spawn loop stages them on a stagger). The RAF loop only paints
			// — and reveals — bodies in this set, so the entrance reads as
			// staggered drops rather than 10 icons appearing at once.
			const spawned = new Set<string>()

			// Brief gravity pulse for the entrance — bodies feel real weight
			// as they fall in. The pulse turns off after 1.4s so the cluster
			// then floats on its springs alone.
			engine.gravity.x = 0
			engine.gravity.y = 1.0
			engine.gravity.scale = 0.0007
			const gravityTimer = setTimeout(() => {
				if (cancelled) return
				engine.gravity.scale = 0  // springs take over
			}, 1400)

			// Sort by USD desc so the heaviest chain falls first — the eye
			// lands on the biggest holding before the smaller ones rain in.
			const orderedLayout = [...layout].sort((a, b) => b.usd - a.usd)

			const spawnTimers: ReturnType<typeof setTimeout>[] = []
			orderedLayout.forEach((c, i) => {
				const radius = c.sat / 2
				// Above the canvas with horizontal spread. The further away
				// from the slot's x, the more dramatic the trajectory.
				const startX = c.x + (Math.random() - 0.5) * width * 0.25
				const startY = -140 - Math.random() * 220
				const body = Bodies.circle(startX, startY, radius, {
					restitution: 0.6,
					friction: 0.015,
					frictionAir: 0.035,            // global drag — eventually settles
					density: 0.0012 + (radius / 200) * 0.0015, // bigger = heavier
					slop: 0.5,
					label: c.chain.id,
				})

				// Soft spring constraint to the slot. Stiffness ~0.014
				// produces a noticeably bouncy "snap into place" without
				// turning the cluster into oscillating spaghetti. Damping
				// kills residual oscillation in 1–2 seconds.
				const constraint = Constraint.create({
					bodyA: body,
					pointB: { x: c.x, y: c.y },
					stiffness: 0.014,
					damping: 0.08,
					length: 0,
					render: { visible: false },
				})

				bodies.set(c.chain.id, body)
				halfSizes.set(c.chain.id, radius)

				// Stagger: heaviest in immediately, each next ~90ms later.
				// 10 chains × 90ms = 900ms before the last body enters,
				// which dovetails nicely with the 1.4s gravity pulse.
				const delay = i * 90
				const enter = () => {
					if (cancelled || !physicsRef.current.engine) return
					Composite.add(world, [body, constraint])
					Body.setVelocity(body, { x: (Math.random() - 0.5) * 3, y: 4 + Math.random() * 3 })
					// Slight angular kick — coins tumble. The SVG icon
					// itself doesn't rotate (we'd distort the wordmark)
					// but body momentum reads as motion under collision.
					Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.2)
					spawned.add(c.chain.id)
				}
				if (delay === 0) enter()
				else spawnTimers.push(setTimeout(enter, delay))
			})

			physicsRef.current.engine = engine
			physicsRef.current.bodies = bodies
			physicsRef.current.halfSizes = halfSizes

			// Render loop — read body positions and write DOM transforms
			// directly. setTransform on a Map of pre-cached HTMLElements
			// keeps every frame O(N) with no React reconciliation.
			let last = performance.now()
			const tick = (now: number) => {
				if (cancelled) return
				const dt = Math.min(32, now - last)
				last = now
				// Step the physics engine. We don't pass time accuracy because
				// the slot springs are forgiving — a couple of dropped frames
				// won't cause weird simulation drift.
				Engine.update(engine, dt)
				for (const [id, body] of bodies) {
					if (!spawned.has(id)) continue
					const el = chainElRefs.current.get(id)
					if (!el) continue
					const half = halfSizes.get(id)!
					// Math.round avoids subpixel antialiasing fuzz on icons.
					const tx = Math.round(body.position.x - half)
					const ty = Math.round(body.position.y - half)
					el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
					if (el.style.opacity !== '1') el.style.opacity = '1'
				}
				physicsRef.current.raf = requestAnimationFrame(tick)
			}
			physicsRef.current.raf = requestAnimationFrame(tick)

			cleanup = () => {
				clearTimeout(gravityTimer)
				for (const t of spawnTimers) clearTimeout(t)
				if (physicsRef.current.raf != null) cancelAnimationFrame(physicsRef.current.raf)
				physicsRef.current.raf = null
				World.clear(world, false)
				Engine.clear(engine)
				physicsRef.current.engine = null
				physicsRef.current.bodies = new Map()
				physicsRef.current.halfSizes = new Map()
			}
		})()
		return () => {
			cancelled = true
			cleanup?.()
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		physicsEnabled,
		width,
		height,
		layout.map(c => `${c.chain.id}:${c.x.toFixed(0)}:${c.y.toFixed(0)}:${c.sat}`).join('|'),
	])

	// While a chain is expanded, freeze the engine and snap the expanded
	// body back to its layout slot so token bubbles tree from a stable,
	// known anchor. On collapse, restore time scale and let physics
	// resettle the cluster.
	useEffect(() => {
		const engine = physicsRef.current.engine
		if (!engine) return
		if (expandedChainId) {
			engine.timing.timeScale = 0
			const body = physicsRef.current.bodies.get(expandedChainId)
			const slot = layout.find(c => c.chain.id === expandedChainId)
			if (body && slot) {
				import('matter-js').then(Matter => {
					Matter.Body.setPosition(body, { x: slot.x, y: slot.y })
					Matter.Body.setVelocity(body, { x: 0, y: 0 })
					Matter.Body.setAngularVelocity(body, 0)
					// Also paint the DOM at the snapped position immediately —
					// otherwise the icon stays mid-flight visually until RAF
					// next runs, which it won't while timeScale=0.
					const el = chainElRefs.current.get(expandedChainId)
					const half = physicsRef.current.halfSizes.get(expandedChainId)
					if (el && half != null) {
						el.style.transform = `translate3d(${Math.round(slot.x - half)}px, ${Math.round(slot.y - half)}px, 0)`
					}
				})
			}
		} else {
			engine.timing.timeScale = 1
		}
	}, [expandedChainId, layout])

	// Mouse-drag — pointer-down on an icon hands the body to a transient
	// pointer-follow handler. Built-in Matter MouseConstraint would also
	// work, but we want to suppress the trailing click ONLY when the user
	// actually moved (so a quick tap still opens AssetPage).
	const onBodyPointerDown = useCallback((chainId: string, ev: React.PointerEvent) => {
		if (!physicsEnabled) return
		const body = physicsRef.current.bodies.get(chainId)
		if (!body) return
		const rect = (ev.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
		const toLocal = (cx: number, cy: number) => ({
			x: cx - rect.left,
			y: cy - rect.top,
		})
		const start = toLocal(ev.clientX, ev.clientY)
		const grabOffX = body.position.x - start.x
		const grabOffY = body.position.y - start.y
		let lastX = start.x, lastY = start.y, lastT = performance.now()
		let velX = 0, velY = 0
		let moved = false
		physicsRef.current.dragMoved = false

		// Park the body — zero velocity, no gravity contribution. We'll
		// set its position by hand each pointermove.
		;(async () => {
			const Matter = await import('matter-js')
			Matter.Body.setStatic(body, true)
			const onMove = (mv: PointerEvent) => {
				const p = toLocal(mv.clientX, mv.clientY)
				const now = performance.now()
				const dt = Math.max(8, now - lastT)
				velX = (p.x - lastX) / dt * 16  // px / frame
				velY = (p.y - lastY) / dt * 16
				lastX = p.x; lastY = p.y; lastT = now
				if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > 4) {
					moved = true
					physicsRef.current.dragMoved = true
				}
				Matter.Body.setPosition(body, { x: p.x + grabOffX, y: p.y + grabOffY })
			}
			const onUp = () => {
				Matter.Body.setStatic(body, false)
				// Hand the swipe velocity back to physics so the body keeps
				// going after release — momentum throw.
				Matter.Body.setVelocity(body, { x: velX, y: velY })
				if (moved) suppressClickRef.current = true
				window.removeEventListener('pointermove', onMove)
				window.removeEventListener('pointerup', onUp)
			}
			window.addEventListener('pointermove', onMove)
			window.addEventListener('pointerup', onUp)
		})()
	}, [physicsEnabled])

	// Preload all visible chain icons before we paint the cluster.
	const iconUrls = useMemo(
		() => layout.map((c) => getAssetIcon(c.chain.caip)),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[layout.map(c => c.chain.id).join('|')]
	)
	const iconsReady = useImagePreload(iconUrls)

	return (
		<Box position="relative" w={`${width}px`} h={`${height}px`} mx="auto" my="2">
			<svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
				<defs>
					<radialGradient id="dashboardCoreGlow" cx="50%" cy="50%">
						<stop offset="0%" stopColor="rgba(233,196,106,0.18)" />
						<stop offset="55%" stopColor="rgba(139,227,196,0.05)" />
						<stop offset="100%" stopColor="transparent" />
					</radialGradient>
				</defs>
				<circle cx={cx} cy={cy} r={sizeRef * 0.5} fill="url(#dashboardCoreGlow)" />
				<circle
					cx={cx}
					cy={cy}
					r={ringR}
					fill="none"
					stroke="rgba(255,255,255,0.10)"
					strokeWidth="1"
					strokeDasharray="2 6"
					style={{
						transformOrigin: `${cx}px ${cy}px`,
						animation: 'v3-spin 90s linear infinite',
					}}
				/>
			</svg>

			{/* Center total */}
			<Box
				position="absolute"
				top="50%"
				left="50%"
				transform="translate(-50%, -50%)"
				textAlign="center"
				w="60%"
				pointerEvents="none"
			>
				<Text
					fontSize="10px"
					color="var(--text-3)"
					letterSpacing="0.20em"
					textTransform="uppercase"
					mb="2"
					fontWeight="500"
				>
					Total
				</Text>
				{/* AnimatedUsd handles the smooth green count-up between
				    values — the "money counting up" cue that lived on
				    master. The kkBounceUp keyframe re-fires whenever the
				    rounded dollar total changes (via the `key` prop) so
				    each refresh gets a short scale-bump beat. Color is
				    AnimatedUsd's default teal (#23DCC8) — green text is
				    half the perceived bounce; users equate "green ticking
				    up" with "money just landed." */}
				<Box
					key={`bounce-${Math.round(totalUsd * 100)}`}
					style={{ animation: 'kkBounceUp 0.7s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
				>
					<AnimatedUsd
						value={totalUsd}
						fontSize={sizeRef > 720 ? "72px" : sizeRef > 540 ? "56px" : sizeRef > 380 ? "44px" : "36px"}
						fontWeight="500"
						letterSpacing="-0.04em"
						lineHeight="1"
						decimals={2}
					/>
				</Box>
				<Text
					fontSize="10px"
					color="var(--text-3)"
					letterSpacing="0.14em"
					textTransform="uppercase"
					mt="3"
					fontFamily="mono"
				>
					{chains.length} CHAINS
					{cleanTokenTotal > 0 && ` · ${cleanTokenTotal} ASSETS`}
				</Text>

				{/* Reports + Refresh inline under the center price.
				    Previously these sat below the orbital card as their own
				    Flex row; folding them into the center pulls all the
				    primary controls into one focal point so the constellation
				    really IS the whole dashboard. */}
				<Flex justify="center" gap="2" mt="4" pointerEvents="auto">
					{canShowReports && (
						<Box
							as="button"
							px="2.5"
							py="1.5"
							fontSize="11px"
							fontWeight="600"
							color="kk.gold"
							bg="rgba(233,196,106,0.06)"
							border="1px solid"
							borderColor="rgba(233,196,106,0.25)"
							borderRadius="full"
							cursor="pointer"
							transition="all 0.15s"
							_hover={{ color: "white", bg: "rgba(233,196,106,0.18)" }}
							onClick={onShowReports}
						>
							<Flex align="center" gap="1.5">
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
									<polyline points="14 2 14 8 20 8" />
									<line x1="16" y1="13" x2="8" y2="13" />
									<line x1="16" y1="17" x2="8" y2="17" />
								</svg>
								{t("reports")}
							</Flex>
						</Box>
					)}
					<Box
						as="button"
						px="2.5"
						py="1.5"
						fontSize="11px"
						fontWeight="600"
						color={loadingBalances ? "kk.textMuted" : "kk.gold"}
						bg="rgba(233,196,106,0.06)"
						border="1px solid"
						borderColor="rgba(233,196,106,0.25)"
						borderRadius="full"
						cursor={loadingBalances ? "default" : "pointer"}
						transition="all 0.15s"
						_hover={loadingBalances ? {} : { color: "white", bg: "rgba(233,196,106,0.18)" }}
						onClick={loadingBalances ? undefined : onRefresh}
					>
						<Flex align="center" gap="1.5">
							{loadingBalances ? (
								<Spinner size="xs" color="kk.gold" />
							) : (
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
									<path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
									<path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
								</svg>
							)}
							{loadingBalances
								? t("refreshing")
								: cacheUpdatedAt
									? <>
										<Text as="span" color={(() => {
											const age = Date.now() - cacheUpdatedAt
											if (age < 3_600_000) return "var(--teal)"
											if (age < 86_400_000) return "var(--gold)"
											return "var(--rose)"
										})()}>
											{formatTimeAgo(cacheUpdatedAt, t)}
										</Text>
										{" · "}{t("refreshBalances")}
									</>
									: t("refreshPrompt")}
						</Flex>
					</Box>
				</Flex>
			</Box>

			{/* Satellite chains — variable size by USD share, two-ring zigzag.
			    Wrapped in a fade gate so the constellation appears in one beat
			    once all icons are cached, instead of stippling in. */}
			<Box
				position="absolute"
				inset="0"
				style={{
					opacity: iconsReady ? 1 : 0,
					transition: 'opacity 220ms ease-out',
				}}
				onClick={(e: React.MouseEvent) => {
					// Click on empty constellation canvas (not on a chain icon
					// or token bubble) collapses any expanded chain. Children
					// don't need stopPropagation because we only act when the
					// click landed directly on this Box.
					if (expandedChainId && e.target === e.currentTarget) {
						setExpandedChainId(null)
					}
				}}
			>
			{layout.map(({ chain, usd, bal, x: slotX, y: slotY, sat }) => {
				const isHover = hover === chain.id
				const pct = totalUsd > 0 ? (usd / totalUsd) * 100 : 0
				// Grid mode wraps the icon in a square tile bg so the layout
				// reads as a wall mosaic. Tile is slightly larger than the icon
				// so the round logo nests inside a rounded square — Apple
				// app-icon-on-springboard feel.
				const tilePad = mode === 'grid' ? Math.round(sat * 0.15) : 0
				const cellSize = sat + tilePad * 2
				// In orbit mode the RAF loop writes element.style.transform
				// directly per frame; the initial slot position seeds the
				// transform so before physics initializes the body is in the
				// right place. Grid mode uses static transform — no physics.
				const initialTx = Math.round(slotX - cellSize / 2)
				const initialTy = Math.round(slotY - cellSize / 2)
				return (
					<Box
						key={chain.id}
						ref={(el: HTMLDivElement | null) => {
							if (mode === 'orbit') chainElRefs.current.set(chain.id, el)
							else chainElRefs.current.delete(chain.id)
						}}
						as="button"
						onMouseEnter={() => setHover(chain.id)}
						onMouseLeave={() => setHover(null)}
						onClick={() => {
							if (suppressClickRef.current) {
								suppressClickRef.current = false
								return
							}
							onSelect(chain)
						}}
						onPointerDown={(e: React.PointerEvent) => onBodyPointerDown(chain.id, e)}
						position="absolute"
						left="0"
						top="0"
						style={{
							transform: `translate3d(${initialTx}px, ${initialTy}px, 0)`,
							willChange: physicsEnabled ? 'transform' : undefined,
							// Hidden until the RAF loop flips opacity after the
							// body lands in the world. The staggered spawn means
							// each chain reveals as it rains in.
							opacity: physicsEnabled ? 0 : 1,
							transition: physicsEnabled ? 'opacity 220ms ease-out' : undefined,
						}}
						w={`${cellSize}px`}
						h={`${cellSize}px`}
						borderRadius={mode === 'grid' ? '20%' : 'full'}
						bg={mode === 'grid' ? `linear-gradient(155deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))` : 'transparent'}
						border={mode === 'grid' ? '1px solid var(--line)' : '0'}
						p={`${tilePad}px`}
						display="grid"
						placeItems="center"
						// Limit transition to filter/box-shadow — animating
						// transform would fight the per-frame physics writes.
						transition={physicsEnabled ? "filter 0.3s, box-shadow 0.3s" : "all 0.3s cubic-bezier(0.2,0.8,0.2,1)"}
						filter={isHover
							? `drop-shadow(0 0 24px ${chain.color})`
							: 'drop-shadow(0 4px 14px rgba(0,0,0,0.55))'}
						zIndex={isHover ? 10 : 1}
						cursor="pointer"
						aria-label={chain.coin}
					>
						<Image
							src={getAssetIcon(chain.caip)}
							alt={chain.symbol}
							w="100%"
							h="100%"
							borderRadius="full"
							bg="var(--ink-2)"
							boxShadow={`0 0 0 1px var(--line), 0 6px 18px -8px ${chain.color}`}
							style={{
								transform: isHover ? 'scale(1.12)' : 'scale(1)',
								transition: 'transform 0.25s cubic-bezier(0.2,0.8,0.2,1)',
							}}
						/>
						{(bal?.tokens?.length ?? 0) > 0 && (() => {
							const isExpanded = expandedChainId === chain.id
							// Badge size grows with chain icon size — keeps the
							// "this is clearly a button" feel on big and small
							// icons alike. Floor 26 / ceiling 40.
							const badgeSize = Math.max(26, Math.min(40, Math.round(sat * 0.32)))
							return (
								<Box
									as="div"
									role="button"
									aria-label={`Expand ${bal!.tokens!.length} tokens on ${chain.coin}`}
									aria-pressed={isExpanded}
									tabIndex={0}
									position="absolute"
									bottom={`-${Math.round(badgeSize * 0.2)}px`}
									right={`-${Math.round(badgeSize * 0.2)}px`}
									w={`${badgeSize}px`}
									h={`${badgeSize}px`}
									borderRadius="full"
									bg={isExpanded ? 'var(--gold)' : 'var(--ink-3)'}
									color={isExpanded ? '#1a1408' : 'var(--text-1)'}
									border="2px solid"
									borderColor={isExpanded ? 'var(--gold-hi, #e0bb7e)' : 'rgba(233,196,106,0.55)'}
									fontSize={`${Math.round(badgeSize * 0.38)}px`}
									fontFamily="var(--font-display, inherit)"
									fontWeight="700"
									display="grid"
									placeItems="center"
									cursor="pointer"
									transition="transform 0.15s, background 0.15s, box-shadow 0.15s"
									boxShadow={isExpanded
										? '0 0 0 4px rgba(233,196,106,0.18), 0 6px 18px -4px rgba(233,196,106,0.55)'
										: '0 0 0 0 rgba(233,196,106,0), 0 4px 12px -4px rgba(0,0,0,0.6)'}
									_hover={{
										transform: 'scale(1.1)',
										boxShadow: '0 0 0 4px rgba(233,196,106,0.16), 0 4px 14px -4px rgba(233,196,106,0.5)',
									}}
									onClick={(e: React.MouseEvent) => {
										e.stopPropagation()
										setExpandedChainId(prev => prev === chain.id ? null : chain.id)
									}}
									onKeyDown={(e: React.KeyboardEvent) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault()
											e.stopPropagation()
											setExpandedChainId(prev => prev === chain.id ? null : chain.id)
										}
									}}
								>
									{isExpanded ? '×' : `+${bal!.tokens!.length}`}
								</Box>
							)
						})()}
						{/* Persistent USD label under the icon. AnimatedUsd
						    handles smooth count-up between updates; the
						    kkBounceUp key re-fires whenever the value
						    materially changes so a refresh has a visible
						    beat. */}
						<Box
							position="absolute"
							top="100%"
							left="50%"
							transform="translateX(-50%)"
							mt="1"
							pointerEvents="none"
						>
							<Box
								key={`chain-bounce-${chain.id}-${Math.round(usd * 100)}`}
								style={{ animation: 'kkBounceUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
							>
								<AnimatedUsd
									value={usd}
									fontSize="11px"
									fontWeight="600"
									fontFamily="mono"
									style={{
										textShadow: '0 1px 4px rgba(0,0,0,0.7)',
										whiteSpace: 'nowrap',
									}}
									decimals={usd >= 100 ? 0 : 2}
								/>
							</Box>
						</Box>
						{isHover && (
							<Box
								position="absolute"
								top="-58px"
								left="50%"
								transform="translateX(-50%)"
								bg="var(--ink-3)"
								border="1px solid rgba(255,255,255,0.10)"
								px="3"
								py="1.5"
								borderRadius="10px"
								whiteSpace="nowrap"
								boxShadow="0 8px 24px -8px rgba(0,0,0,0.6)"
								pointerEvents="none"
							>
								<Text fontSize="12px" fontWeight="600" color="var(--text-0)" textAlign="center">
									{chain.coin}
								</Text>
								<Text fontSize="11px" fontFamily="mono" color="var(--text-2)" textAlign="center">
									${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
									{totalUsd > 0 && ` · ${pct.toFixed(1)}%`}
								</Text>
							</Box>
						)}
					</Box>
				)
			})}

			{/* Token bubbles — rendered after chain icons so they sit on top of
			    chain shadows but below the +N badge (which has higher z-index
			    when expanded). Staggered scale-in animation per index gives
			    the "tree expanding" cue. */}
			{tokenLayout.length > 0 && expandedChainId && (() => {
				const parent = layout.find(c => c.chain.id === expandedChainId)
				if (!parent) return null
				return (
					<>
						{/* SVG connector lines from chain icon → each bubble. Drawn
						    in a single SVG layered behind the bubble buttons. */}
						<Box position="absolute" inset="0" pointerEvents="none">
							<svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
								{tokenLayout.map((t, i) => (
									<line
										key={`line-${t.tok.caip}-${i}`}
										x1={parent.x} y1={parent.y}
										x2={t.x} y2={t.y}
										stroke={parent.chain.color}
										strokeOpacity="0.28"
										strokeWidth="1"
										strokeDasharray="2 4"
										style={{
											animation: `kkBubbleLine 0.5s ${i * 25}ms ease-out both`,
										}}
									/>
								))}
							</svg>
						</Box>
						{tokenLayout.map((t, i) => {
							const symbol = t.tok.symbol || '?'
							const labelUsd = t.tok.balanceUsd > 0
								? `$${t.tok.balanceUsd < 1
									? t.tok.balanceUsd.toFixed(2)
									: t.tok.balanceUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
								: ''
							return (
								<Box
									key={`tok-${t.tok.caip}-${i}`}
									as="button"
									position="absolute"
									left={`${t.x - t.sat / 2}px`}
									top={`${t.y - t.sat / 2}px`}
									w={`${t.sat}px`}
									h={`${t.sat}px`}
									borderRadius="full"
									border="1px solid var(--line-2)"
									bg="var(--ink-2)"
									color="var(--text-1)"
									fontFamily="var(--font-mono, monospace)"
									fontWeight="600"
									fontSize={`${Math.max(9, Math.round(t.sat * 0.22))}px`}
									display="grid"
									placeItems="center"
									cursor="pointer"
									p={0}
									transition="transform 0.15s, box-shadow 0.15s"
									boxShadow={`0 4px 14px -4px ${parent.chain.color}, 0 0 0 1px rgba(255,255,255,0.04)`}
									_hover={{
										transform: 'scale(1.12)',
										boxShadow: `0 0 0 2px ${parent.chain.color}, 0 6px 18px -4px ${parent.chain.color}`,
										zIndex: 11,
									}}
									style={{
										animation: `kkBubbleIn 0.4s ${i * 28}ms cubic-bezier(0.34, 1.56, 0.64, 1) both`,
									}}
									title={`${t.tok.symbol} · ${t.tok.balance} · ${labelUsd}`}
									onClick={(e: React.MouseEvent) => {
										e.stopPropagation()
										onSelect(parent.chain)
									}}
								>
									<Box textAlign="center" lineHeight="1">
										<Box>{symbol.slice(0, 4).toUpperCase()}</Box>
										{labelUsd && t.sat >= 36 && (
											<Box
												fontSize={`${Math.max(8, Math.round(t.sat * 0.16))}px`}
												color="var(--text-3)"
												fontWeight="500"
												mt="2px"
											>{labelUsd}</Box>
										)}
									</Box>
								</Box>
							)
						})}
					</>
				)
			})()}
			</Box>

		</Box>
	)
}

interface PioneerError {
	message: string
	url: string
}

interface DashboardProps {
	onLoaded?: () => void
	watchOnly?: boolean
	/** When in watchOnly mode, load cached data for this specific device (defaults to latest) */
	watchOnlyDeviceId?: string
	onOpenSettings?: () => void
	firmwareVersion?: string
	/** When true (e.g. after OOB setup), skip stale cache and auto-refresh live balances */
	forceRefresh?: boolean
	/** Called after forceRefresh has been consumed (one-shot) — parent should clear the flag */
	onForceRefreshConsumed?: () => void
	/** True when using a hidden wallet — reports and some features are unavailable */
	isHiddenWallet?: boolean
}

/** Format a timestamp as a relative "time ago" string (i18n-aware) */
function formatTimeAgo(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
	const diff = Date.now() - ts
	const mins = Math.floor(diff / 60_000)
	if (mins < 1) return t('timeJustNow')
	if (mins < 60) return t('timeMinutesAgo', { count: mins })
	const hours = Math.floor(mins / 60)
	if (hours < 24) return t('timeHoursAgo', { count: hours })
	const days = Math.floor(hours / 24)
	return t('timeDaysAgo', { count: days })
}

export function Dashboard({ onLoaded, watchOnly, watchOnlyDeviceId, onOpenSettings, firmwareVersion, forceRefresh, onForceRefreshConsumed, isHiddenWallet }: DashboardProps) {
	const { t } = useTranslation("dashboard")
	const [selectedChain, setSelectedChain] = useState<ChainDef | null>(null)
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(new Map())
	const [loadingBalances, setLoadingBalances] = useState(false)
	const [initialLoaded, setInitialLoaded] = useState(false)
	const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(0)
	const [customChainDefs, setCustomChainDefs] = useState<ChainDef[]>([])
	const [showAddChain, setShowAddChain] = useState(false)
	const [showReports, setShowReports] = useState(false)
	const [showBip85, setShowBip85] = useState(false)
	const [bip85Enabled, setBip85Enabled] = useState(false)
	const [zcashEnabled, setZcashEnabled] = useState(false)
	const [pioneerError, setPioneerError] = useState<PioneerError | null>(null)
	const [cacheUpdatedAt, setCacheUpdatedAt] = useState<number | null>(null)
	const [tokenWarning, setTokenWarning] = useState(false)
	const [hasEverRefreshed, setHasEverRefreshed] = useState(false)
	const [visibilityMap, setVisibilityMap] = useState<Record<string, TokenVisibilityStatus>>({})

	// Load token visibility overrides (for spam filtering). Refetch on
	// `token-visibility-changed` push so a "mark as scam" action in
	// AssetPage immediately removes the spam USD from the dashboard total
	// (and a "mark as safe" puts it back). Without this subscription, the
	// initial on-mount snapshot would persist and the dashboard would keep
	// showing the spam balance until full reload.
	useEffect(() => {
		const refetch = () => {
			rpcRequest<Record<string, TokenVisibilityStatus>>('getTokenVisibilityMap', undefined, 5000)
				.then(setVisibilityMap)
				.catch(() => {})
		}
		refetch()
		return onRpcMessage('token-visibility-changed', refetch)
	}, [])

	// Load feature flags (re-check when settings change)
	const refreshFeatureFlags = useCallback(() => {
		rpcRequest<AppSettings>('getAppSettings', undefined, 5000)
			.then(s => {
				setBip85Enabled(s.bip85Enabled)
				setZcashEnabled(s.zcashPrivacyEnabled)
			})
			.catch(() => {})
	}, [])

	useEffect(() => { refreshFeatureFlags() }, [refreshFeatureFlags])

	useEffect(() => {
		window.addEventListener('keepkey-settings-changed', refreshFeatureFlags)
		return () => window.removeEventListener('keepkey-settings-changed', refreshFeatureFlags)
	}, [refreshFeatureFlags])

	// Listen for Pioneer connection errors from backend
	useEffect(() => {
		return onRpcMessage("pioneer-error", (payload) => {
			setPioneerError(payload as PioneerError)
		})
	}, [])

	// Load custom chains on mount and register their explorer links
	useEffect(() => {
		rpcRequest<CustomChain[]>('getCustomChains', undefined, 5000)
			.then(chains => {
				setCustomChainDefs(chains.map(customChainToChainDef))
				for (const c of chains) {
					if (c.explorerAddressLink || c.explorerTxLink) {
						registerCustomAsset(`eip155:${c.chainId}/slip44:60`, {
							symbol: c.symbol, name: c.name,
							explorer: c.explorerUrl,
							explorerAddressLink: c.explorerAddressLink,
							explorerTxLink: c.explorerTxLink,
						})
					}
				}
			})
			.catch(() => {})
	}, [])

	// On mount: load cached balances ONLY (no live fetch — saves API credits)
	// When forceRefresh (e.g. new seed after OOB setup), skip stale cache entirely.
	useEffect(() => {
		let cancelled = false

		async function loadCached() {
			let needsAutoRefresh = false

			if (watchOnly) {
				try {
					const result = await rpcRequest<ChainBalance[] | null>('getWatchOnlyBalances', watchOnlyDeviceId ? { deviceId: watchOnlyDeviceId } : undefined, 5000)
					if (!cancelled && result && result.length > 0) {
						const map = new Map<string, ChainBalance>()
						for (const b of result) map.set(b.chainId, b)
						setBalances(map)
					}
				} catch { /* watch-only cache unavailable */ }
				if (!cancelled) { setInitialLoaded(true); onLoaded?.() }
				return
			}

			// New seed: cache belongs to the old seed — skip it
			if (!forceRefresh) {
				try {
					const cached = await rpcRequest<{ balances: ChainBalance[]; updatedAt: number; staleReasons?: string[] } | null>('getCachedBalances', undefined, 3000)
					if (!cancelled && cached && cached.balances.length > 0) {
						const map = new Map<string, ChainBalance>()
						for (const b of cached.balances) map.set(b.chainId, b)
						setBalances(map)
						setCacheUpdatedAt(cached.updatedAt)
						console.log(`[Dashboard] Cache hit: ${cached.balances.length} chains, $${cached.balances.reduce((s, b) => s + (b.balanceUsd || 0), 0).toFixed(2)}, age: ${formatTimeAgo(cached.updatedAt, t)}`)
						if (cached.staleReasons && cached.staleReasons.length > 0) {
							console.log(`[Dashboard] Cache incomplete (${cached.staleReasons.join(', ')}) — will auto-refresh`)
							needsAutoRefresh = true
						}
					} else {
						// Empty cache — passphrase wallets intentionally skip DB writes,
						// and first-run devices also have no cache. Auto-refresh live.
						console.log('[Dashboard] Cache empty — will auto-refresh live balances')
						needsAutoRefresh = true
					}
				} catch {
					// Cache unavailable — still trigger a live fetch
					needsAutoRefresh = true
				}
			} else {
				console.log('[Dashboard] forceRefresh: skipping stale cache (new seed detected)')
			}

			if (!cancelled) {
				setInitialLoaded(true)
				onLoaded?.()
				// Auto-refresh in background when cache is empty or incomplete
				if (needsAutoRefresh) refreshBalances()
			}
		}

		loadCached()
		return () => { cancelled = true }
	}, [watchOnly, watchOnlyDeviceId, forceRefresh])

	// One-shot price refresh: update cached USD values with fresh market prices on load/navigate.
	// Does NOT re-fetch balances from Pioneer — only reprices existing cached amounts.
	const priceRefreshedRef = useRef(false)
	useEffect(() => {
		if (!initialLoaded || balances.size === 0 || watchOnly || loadingBalances) return
		if (priceRefreshedRef.current) return
		priceRefreshedRef.current = true

		const allChains = [...CHAINS, ...customChainDefs].filter(c => !c.hidden)
		const chainsWithBalance = allChains.filter(c => {
			const bal = balances.get(c.id)
			return bal && parseFloat(bal.balance || '0') > 0
		})
		if (chainsWithBalance.length === 0) return
		const caips = chainsWithBalance.map(c => c.caip).filter(Boolean)
		if (caips.length === 0) return

		let cancelled = false
		rpcRequest<any>('getMarketData', { caips }, 15000)
			.then(resp => {
				if (cancelled) return
				// resp.data is an array of USD prices in the same order as caips
				const prices: number[] = resp?.data || (Array.isArray(resp) ? resp : [])
				if (prices.length !== caips.length) return

				setBalances(prev => {
					const next = new Map(prev)
					let changed = false
					for (let i = 0; i < chainsWithBalance.length; i++) {
						const chain = chainsWithBalance[i]
						const freshPrice = prices[i]
						if (!freshPrice || freshPrice <= 0) continue
						const bal = next.get(chain.id)
						if (!bal) continue
						const amount = parseFloat(bal.balance || '0')
						if (amount <= 0) continue
						const newNativeUsd = amount * freshPrice
						const tokenUsd = bal.tokens?.reduce((s, t) => s + (t.balanceUsd || 0), 0) || 0
						const updated = { ...bal, nativeBalanceUsd: newNativeUsd, balanceUsd: newNativeUsd + tokenUsd }
						next.set(chain.id, updated)
						changed = true
					}
					return changed ? next : prev
				})
				console.log(`[Dashboard] Price refresh: ${prices.length} prices updated`)
			})
			.catch(() => { /* price refresh is best-effort */ })

		return () => { cancelled = true }
	}) // runs on every render but ref-gated to fire once

	// Manual refresh: fetch live data from Pioneer API
	const refreshBalances = useCallback(async () => {
		if (loadingBalances || watchOnly) return
		setLoadingBalances(true)
		setPioneerError(null)
		setTokenWarning(false)

		try {
			const result = await rpcRequest<ChainBalance[]>('getBalances', undefined, 120000)
			if (result) {
				const tokenTotal = result.reduce((n, b) => n + (b.tokens?.length || 0), 0)
				const balTotal = result.reduce((n, b) => n + (b.balanceUsd || 0), 0)
				console.log(`[Dashboard] Live: ${result.length} chains, ${tokenTotal} tokens, $${balTotal.toFixed(2)}`)
				// DEBUG: dump token data that arrived via RPC
				for (const b of result) {
					if (b.tokens && b.tokens.length > 0) {
						console.log(`[Dashboard:rpc-tokens] ${b.chainId}: ${b.tokens.length} tokens`)
						for (const t of b.tokens.slice(0, 3)) {
							console.log(`  ${t.symbol}: balanceUsd=${t.balanceUsd}, priceUsd=${t.priceUsd}, balance=${t.balance}, caip=${t.caip?.substring(0, 40)}`)
						}
					}
				}
				const map = new Map<string, ChainBalance>()
				for (const b of result) map.set(b.chainId, b)
				setBalances(map)
				setCacheUpdatedAt(Date.now())
				setHasEverRefreshed(true)

				// Warn if no token data came back (possible API issue)
				if (tokenTotal === 0 && balTotal > 0) {
					setTokenWarning(true)
				}
			}
		} catch (e: any) {
			console.warn('[Dashboard] getBalances failed:', e.message)
		}

		setLoadingBalances(false)
	}, [loadingBalances, watchOnly])

	// Auto-refresh after new seed (OOB setup) — one-shot, then clear the flag
	useEffect(() => {
		if (forceRefresh && initialLoaded && !hasEverRefreshed && !loadingBalances) {
			console.log('[Dashboard] New seed detected — auto-refreshing balances (one-shot)')
			refreshBalances()
			onForceRefreshConsumed?.()
		}
	}, [forceRefresh, initialLoaded, hasEverRefreshed, loadingBalances, refreshBalances, onForceRefreshConsumed])

	// Auto-refresh balances when a swap completes (both chains affected)
	useEffect(() => {
		const handler = () => {
			console.log('[Dashboard] Swap completed — refreshing balances')
			refreshBalances()
		}
		window.addEventListener('keepkey-swap-completed', handler)
		return () => window.removeEventListener('keepkey-swap-completed', handler)
	}, [refreshBalances])

	// Live balance sync: merge single-chain updates from backend (e.g. AssetPage refresh)
	useEffect(() => {
		return onRpcMessage("balance-updated", (updated: ChainBalance) => {
			setBalances(prev => {
				const old = prev.get(updated.chainId)
				const oldUsd = old?.balanceUsd ?? 0
				const newUsd = updated.balanceUsd ?? 0
				// Cha-ching when balance increased
				if (newUsd > oldUsd && oldUsd > 0) {
					playChaChing()
				}
				const next = new Map(prev)
				next.set(updated.chainId, updated)
				return next
			})
			setCacheUpdatedAt(Date.now())
		})
	}, [])

	const cleanBalanceUsd = useMemo(() => {
		const overrides = new Map(
			Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const),
		)
		const result = new Map<string, { usd: number; cleanTokenCount: number }>()
		for (const [chainId, bal] of balances) {
			if (bal.tokens && bal.tokens.length > 0) {
				const { clean } = categorizeTokens(bal.tokens, overrides)
				const spamUsd = (bal.tokens.length - clean.length) > 0
					? bal.tokens.reduce((s, t) => s + (t.balanceUsd || 0), 0) - clean.reduce((s, t) => s + (t.balanceUsd || 0), 0)
					: 0
				result.set(chainId, {
					usd: (bal.balanceUsd || 0) - spamUsd,
					cleanTokenCount: clean.length,
				})
			} else {
				result.set(chainId, { usd: bal.balanceUsd || 0, cleanTokenCount: 0 })
			}
		}
		return result
	}, [balances, visibilityMap])

	const totalUsd = useMemo(() => Array.from(cleanBalanceUsd.values()).reduce((sum, b) => sum + b.usd, 0), [cleanBalanceUsd])

	const allChains = useMemo(() => [...CHAINS, ...customChainDefs], [customChainDefs])

	const existingChainIds = useMemo(() => [
		...CHAINS.filter(c => c.chainFamily === 'evm' && c.chainId).map(c => Number(c.chainId)),
		...customChainDefs.filter(c => c.chainId).map(c => Number(c.chainId)),
	], [customChainDefs])

	const chartData = useMemo<DonutChartItem[]>(() => allChains
		.map((chain) => {
			const clean = cleanBalanceUsd.get(chain.id)
			return { name: chain.coin, value: clean?.usd || 0, color: chain.color, chainId: chain.id }
		})
		.filter((d) => d.value > 0)
		.sort((a, b) => b.value - a.value), [allChains, cleanBalanceUsd])

	const hasAnyBalance = chartData.length > 0

	/* Portfolio view mode — orbital is the new default per design handoff,
	 * donut is preserved as a toggle so power users can still get the
	 * percentage-bar legend. Persisted to localStorage. */
	const [viewMode, setViewMode] = useState<DashboardView>(readSavedView)
	useEffect(() => {
		try { localStorage.setItem(DASHBOARD_VIEW_KEY, viewMode) } catch { /* private mode etc. */ }
	}, [viewMode])

	/* Splits totalUsd into dollars + cents so the orbital can render the
	 * cents in a smaller weight (matches handoff layout). */
	const totalDollars = Math.floor(totalUsd)
	const totalCents = (totalUsd % 1).toFixed(2).slice(2) || '00'

	/* cleanTokenTotal — sum of non-spam tokens across all chains. Used for
	 * the "N CHAINS · M ASSETS" subtitle on the orbital. */
	const cleanTokenTotal = useMemo(() => {
		let n = 0
		for (const v of cleanBalanceUsd.values()) n += v.cleanTokenCount
		return n
	}, [cleanBalanceUsd])

	const visibleChains = useMemo(() => allChains.filter(c => {
		if (!isChainSupported(c, firmwareVersion)) return false
		// Zcash transparent is hidden by default — show when feature flag is on
		if (c.id === 'zcash') return zcashEnabled
		return !c.hidden
	}), [allChains, firmwareVersion, zcashEnabled])

	const sortedChains = useMemo(() => [...visibleChains].sort((a, b) => {
		const aUsd = cleanBalanceUsd.get(a.id)?.usd || 0
		const bUsd = cleanBalanceUsd.get(b.id)?.usd || 0
		const aHas = aUsd > 0 || parseFloat(balances.get(a.id)?.balance || '0') > 0
		const bHas = bUsd > 0 || parseFloat(balances.get(b.id)?.balance || '0') > 0
		if (aHas && !bHas) return -1
		if (!aHas && bHas) return 1
		if (aHas && bHas) return bUsd - aUsd
		return 0
	}), [visibleChains, balances, cleanBalanceUsd])

	// Is data stale? (loaded from cache but haven't refreshed yet this session)
	const isStale = !hasEverRefreshed && !loadingBalances

	// Show big CTA when last check is older than 24 hours
	const cacheOlderThanDay = !loadingBalances && !watchOnly && initialLoaded && (
		!cacheUpdatedAt || (Date.now() - cacheUpdatedAt > 86_400_000)
	)

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return (
			<AssetPageErrorBoundary onBack={() => setSelectedChain(null)} chainName={selectedChain.coin}>
				<AssetPage chain={selectedChain} balance={bal} onBack={() => setSelectedChain(null)} firmwareVersion={firmwareVersion} />
			</AssetPageErrorBoundary>
		)
	}

	return (
		<Box w="100%" maxW="600px" mx="auto" pt="2">
			<style>{DASHBOARD_ANIMATIONS}</style>

			{/* Watch-only banner */}
			{watchOnly && (
				<Flex
					align="center"
					justify="center"
					gap="2"
					mb="3"
					px="3"
					py="2"
					bg="rgba(233,196,106,0.08)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.2)"
					borderRadius="lg"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
						<circle cx="12" cy="12" r="3" />
					</svg>
					<Text fontSize="xs" color="kk.gold" fontWeight="500">
						{t("watchOnlyBanner")}
					</Text>
				</Flex>
			)}

			{/* Pioneer connection error banner */}
			{pioneerError && (
				<Box
					mb="3"
					px="4"
					py="3"
					bg="rgba(224,140,123,0.08)"
					border="1px solid"
					borderColor="rgba(224,140,123,0.3)"
					borderRadius="lg"
				>
					<Flex direction="column" gap="2">
						<Flex align="center" gap="2">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<circle cx="12" cy="12" r="10" />
								<line x1="12" y1="8" x2="12" y2="12" />
								<line x1="12" y1="16" x2="12.01" y2="16" />
							</svg>
							<Text fontSize="sm" fontWeight="600" color="var(--rose)">
								{t("pioneerOfflineTitle")}
							</Text>
						</Flex>
						<Text fontSize="xs" color="kk.textSecondary" lineHeight="1.4">
							{t("pioneerOfflineDesc", { url: pioneerError.url })}
						</Text>
						<Flex gap="2" mt="1">
							{onOpenSettings && (
								<Box
									as="button"
									px="3"
									py="1.5"
									fontSize="xs"
									fontWeight="600"
									color="white"
									bg="rgba(233,196,106,0.2)"
									border="1px solid"
									borderColor="kk.gold"
									borderRadius="md"
									cursor="pointer"
									_hover={{ bg: "rgba(233,196,106,0.35)" }}
									onClick={() => {
										setPioneerError(null)
										onOpenSettings()
									}}
								>
									{t("changeServer")}
								</Box>
							)}
							<Box
								as="button"
								px="3"
								py="1.5"
								fontSize="xs"
								fontWeight="600"
								color="kk.textSecondary"
								bg="transparent"
								border="1px solid"
								borderColor="kk.border"
								borderRadius="md"
								cursor="pointer"
								_hover={{ borderColor: "kk.textMuted", color: "white" }}
								onClick={() => rpcRequest('openUrl', { url: "https://support.keepkey.com" }).catch((e: any) => console.warn('[openUrl]', e?.message))}
							>
								{t("getSupport")}
							</Box>
							<Box
								as="button"
								px="3"
								py="1.5"
								fontSize="xs"
								fontWeight="600"
								color="kk.textMuted"
								bg="transparent"
								cursor="pointer"
								_hover={{ color: "white" }}
								onClick={() => {
									setPioneerError(null)
									refreshBalances()
								}}
							>
								{t("retry")}
							</Box>
						</Flex>
					</Flex>
				</Box>
			)}

			{/* Token warning banner — shown when refresh succeeded but no tokens returned */}
			{tokenWarning && !pioneerError && (
				<Box
					mb="3"
					px="4"
					py="3"
					bg="rgba(233,196,106,0.08)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.3)"
					borderRadius="lg"
				>
					<Flex align="center" gap="2" mb="1">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
							<line x1="12" y1="9" x2="12" y2="13" />
							<line x1="12" y1="17" x2="12.01" y2="17" />
						</svg>
						<Text fontSize="xs" fontWeight="600" color="var(--gold)">
							{t("tokenWarningTitle")}
						</Text>
					</Flex>
					<Text fontSize="xs" color="kk.textSecondary" lineHeight="1.4">
						{t("tokenWarningDesc")}
					</Text>
				</Box>
			)}

			{/* Portfolio view — Grid (square tiles) or Orbit (constellation).
			    The view is the hero of the dashboard — it breaks out of the
			    parent 600px maxW into a viewport-wide canvas. Reports +
			    Refresh fold into the center column inside the view, so this
			    card is essentially the whole dashboard. */}
			{hasAnyBalance ? (
				<Box
					w="min(98vw, 1360px)"
					p="4"
					mb="2"
					borderRadius="xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor="kk.border"
					position="relative"
					left="50%"
					transform="translateX(-50%)"
				>
					{/* Grid / Orbit segmented toggle — TOP LEFT, larger, with text labels.
					    Was a tiny icon-only pill in the top right; promoting it gives
					    users a clear way to flip the whole visual language. */}
					<Flex
						position="absolute"
						top="14px"
						left="14px"
						bg="rgba(255,255,255,0.04)"
						border="1px solid"
						borderColor="kk.border"
						borderRadius="999px"
						p="3px"
						gap="2px"
						zIndex={3}
					>
						<Box
							as="button"
							onClick={() => setViewMode('grid')}
							px="14px" h="32px"
							borderRadius="999px"
							display="flex" alignItems="center" gap="6px"
							bg={viewMode === 'grid' ? 'rgba(233,196,106,0.22)' : 'transparent'}
							color={viewMode === 'grid' ? 'var(--gold)' : 'var(--text-3)'}
							border={viewMode === 'grid' ? '1px solid rgba(233,196,106,0.45)' : '1px solid transparent'}
							fontSize="12px" fontWeight="600"
							_hover={{ color: 'var(--text-1)' }}
							transition="all 0.15s"
							cursor="pointer"
							title="Grid view"
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<rect x="3" y="3"  width="7" height="7" rx="1.5"/>
								<rect x="14" y="3" width="7" height="7" rx="1.5"/>
								<rect x="3" y="14" width="7" height="7" rx="1.5"/>
								<rect x="14" y="14" width="7" height="7" rx="1.5"/>
							</svg>
							GRID
						</Box>
						<Box
							as="button"
							onClick={() => setViewMode('orbit')}
							px="14px" h="32px"
							borderRadius="999px"
							display="flex" alignItems="center" gap="6px"
							bg={viewMode === 'orbit' ? 'rgba(233,196,106,0.22)' : 'transparent'}
							color={viewMode === 'orbit' ? 'var(--gold)' : 'var(--text-3)'}
							border={viewMode === 'orbit' ? '1px solid rgba(233,196,106,0.45)' : '1px solid transparent'}
							fontSize="12px" fontWeight="600"
							_hover={{ color: 'var(--text-1)' }}
							transition="all 0.15s"
							cursor="pointer"
							title="Orbit view"
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<circle cx="12" cy="12" r="9" strokeDasharray="2 3"/>
								<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>
								<circle cx="21" cy="12" r="2.2" fill="currentColor" stroke="none"/>
								<circle cx="3"  cy="12" r="1.6" fill="currentColor" stroke="none"/>
							</svg>
							ORBIT
						</Box>
					</Flex>

					<OrbitalView
						chains={visibleChains}
						balances={balances}
						cleanBalanceUsd={cleanBalanceUsd}
						totalUsd={totalUsd}
						totalDollars={totalDollars}
						totalCents={totalCents}
						cleanTokenTotal={cleanTokenTotal}
						onSelect={(c) => setSelectedChain(c)}
						mode={viewMode}
						onShowReports={() => setShowReports(true)}
						onRefresh={refreshBalances}
						loadingBalances={loadingBalances}
						cacheUpdatedAt={cacheUpdatedAt}
						canShowReports={!isHiddenWallet}
						t={t}
					/>
				</Box>
			) : !loadingBalances && initialLoaded && (
				<Box
					w="100%"
					p="5"
					mb="5"
					borderRadius="xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor="rgba(233,196,106,0.2)"
				>
					<Flex direction="column" align="center" gap="3" textAlign="center">
						{/* Shield / vault icon */}
						<Box
							w="56px"
							h="56px"
							borderRadius="full"
							bg="rgba(233,196,106,0.1)"
							display="flex"
							alignItems="center"
							justifyContent="center"
						>
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
								<path d="M9 12l2 2 4-4" />
							</svg>
						</Box>

						<Box>
							<Text fontSize="md" fontWeight="600" color="white" mb="1">
								{t("welcomeTitle")}
							</Text>
							<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.5">
								{t("welcomeSubtitle")}
							</Text>
						</Box>

						<Flex direction="column" gap="2" w="100%" maxW="340px" mt="1">
							<Flex align="flex-start" gap="2.5" textAlign="left">
								<Text fontSize="sm" mt="0.5">1.</Text>
								<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.4">
									{t("welcomeTip1")}
								</Text>
							</Flex>
							<Flex align="flex-start" gap="2.5" textAlign="left">
								<Text fontSize="sm" mt="0.5">2.</Text>
								<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.4">
									{t("welcomeTip2")}
								</Text>
							</Flex>
						</Flex>
					</Flex>
				</Box>
			)}

			{/* Refresh + Reports buttons — below chart.
			    HIDDEN when a portfolio view is active: those controls move
			    into the OrbitalView's center column. The original
			    out-of-view fallback (no balance loaded yet) still wants
			    them here. */}
			{!watchOnly && !hasAnyBalance && (
				<Flex justify="center" gap="3" mb="4">
					{!isHiddenWallet && <Box
						as="button"
						px="3"
						py="1"
						fontSize="11px"
						fontWeight="600"
						color="kk.gold"
						bg="transparent"
						borderRadius="full"
						cursor="pointer"
						transition="all 0.2s"
						_hover={{ color: "white", bg: "rgba(233,196,106,0.12)" }}
						onClick={() => setShowReports(true)}
					>
						<Flex align="center" gap="1.5">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
								<polyline points="14 2 14 8 20 8" />
								<line x1="16" y1="13" x2="8" y2="13" />
								<line x1="16" y1="17" x2="8" y2="17" />
								<polyline points="10 9 9 9 8 9" />
							</svg>
							{t("reports")}
						</Flex>
					</Box>}
					<Box
						as="button"
						px="3"
						py="1"
						fontSize="11px"
						fontWeight="600"
						color={loadingBalances ? "kk.textMuted" : "kk.gold"}
						bg="transparent"
						borderRadius="full"
						cursor={loadingBalances ? "default" : "pointer"}
						transition="all 0.2s"
						_hover={loadingBalances ? {} : {
							color: "white",
							bg: "rgba(233,196,106,0.12)",
						}}
						onClick={loadingBalances ? undefined : refreshBalances}
						css={isStale && !loadingBalances ? { animation: "pulseGold 2s ease-in-out infinite" } : undefined}
					>
						<Flex align="center" gap="1.5">
							{loadingBalances ? (
								<Spinner size="xs" color="kk.gold" />
							) : (
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
									<path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
									<path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
								</svg>
							)}
							{loadingBalances
								? t("refreshing")
								: cacheUpdatedAt
									? <>
										<Text as="span" color={(() => {
											const age = Date.now() - cacheUpdatedAt
											if (age < 3_600_000) return "var(--teal)"
											if (age < 86_400_000) return "var(--gold)"
											return "var(--rose)"
										})()}>
											{formatTimeAgo(cacheUpdatedAt, t)}
										</Text>
										{" · "}{t("refreshBalances")}
									</>
									: t("refreshPrompt")}
						</Flex>
					</Box>
				</Flex>
			)}

			{/* Big glowing CTA when balances haven't been checked in over a day.
			    Hidden under portfolio views — the Refresh button moves into
			    the center column where it already pulses gold when stale. */}
			{cacheOlderThanDay && !hasAnyBalance && (
				<Box
					as="button"
					w="100%"
					mb="4"
					px="5"
					py="4"
					bg="rgba(233,196,106,0.08)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.35)"
					borderRadius="xl"
					cursor="pointer"
					transition="all 0.3s ease-out"
					css={{ animation: "glowCta 3s ease-in-out infinite" }}
					_hover={{
						bg: "rgba(233,196,106,0.15)",
						borderColor: "kk.gold",
						transform: "scale(1.02)",
						boxShadow: "0 0 24px rgba(233,196,106,0.5), 0 0 48px rgba(233,196,106,0.2)",
					}}
					_active={{ transform: "scale(0.98)", transition: "transform 0.1s" }}
					onClick={refreshBalances}
				>
					<Flex align="center" justify="center" gap="3">
						<Box
							w="40px"
							h="40px"
							borderRadius="full"
							bg="rgba(233,196,106,0.15)"
							display="flex"
							alignItems="center"
							justifyContent="center"
							flexShrink={0}
						>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
								<path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
							</svg>
						</Box>
						<Flex direction="column" align="flex-start">
							<Text fontSize="md" fontWeight="700" color="kk.gold" lineHeight="1.3">
								{t("staleCtaTitle")}
							</Text>
							<Text fontSize="xs" color="kk.textMuted" lineHeight="1.3">
								{cacheUpdatedAt
									? t("staleCtaSubtitle", { time: formatTimeAgo(cacheUpdatedAt, t) })
									: t("lastUpdatedNever")}
							</Text>
						</Flex>
					</Flex>
				</Box>
			)}

		{/* Chain grid below the portfolio view. Hidden when the new
		    Grid/Orbit views are active — those views ARE the dashboard
		    and rendering this below was visual clutter. */}
		<SimpleGrid columns={{ base: 2, sm: 3 }} gap="2.5" display={hasAnyBalance ? "none" : "grid"}>
				{sortedChains.map((chain) => {
					const bal = balances.get(chain.id)
					const clean = cleanBalanceUsd.get(chain.id)
					const balNum = parseFloat(bal?.balance || '0')
					const usdNum = clean?.usd || 0
					const hasBalance = balNum > 0 || usdNum > 0
					const tokenCount = clean?.cleanTokenCount || 0

					// Low-gas warning: EVM chain with < $1 native but > $1 in tokens
					const nativeUsd = bal?.nativeBalanceUsd ?? 0
					const tokenUsd = usdNum - nativeUsd
					const lowGas = chain.chainFamily === 'evm' && nativeUsd < 1 && tokenUsd > 1

					return (
						<Box
							key={chain.id}
							bg="kk.cardBg"
							border="1px solid"
							borderColor={hasBalance ? `${chain.color}50` : "kk.border"}
							borderRadius="xl"
							p="3"
							cursor="pointer"
							transition="all 0.15s"
							_hover={{
								borderColor: chain.color,
								bg: `${chain.color}10`,
								transform: "translateY(-1px)",
								boxShadow: `0 4px 12px ${chain.color}15`,
							}}
							_active={{ transform: "scale(0.98)" }}
							onClick={() => setSelectedChain(chain)}
							position="relative"
							overflow="hidden"
						>
							{hasBalance && (
								<Box
									position="absolute"
									top="-20px"
									right="-20px"
									w="60px"
									h="60px"
									borderRadius="full"
									bg={chain.color}
									opacity={0.06}
									pointerEvents="none"
								/>
							)}

							<Flex direction="column" gap="2" position="relative">
								<Flex align="center" gap="2">
									<Image
										src={getAssetIcon(chain.caip)}
										alt={chain.symbol}
										w="28px"
										h="28px"
										borderRadius="full"
										flexShrink={0}
										bg={chain.color}
									/>
									<Box overflow="hidden" flex="1">
										<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2" truncate>
											{chain.coin}
										</Text>
										<Text fontSize="10px" color="kk.textMuted" lineHeight="1.2">
											{chain.symbol}
										</Text>
									</Box>
									{lowGas && (
										<Flex
											direction="column"
											align="center"
											title={`Low ${chain.symbol} for gas \u2014 you need ${chain.symbol} to send tokens on ${chain.coin}`}
											flexShrink={0}
											cursor="help"
											onClick={(e) => e.stopPropagation()}
										>
											<svg width="16" height="16" viewBox="0 0 24 24" fill="#E53E3E" xmlns="http://www.w3.org/2000/svg">
												<path d="M3 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v9h1a3 3 0 0 1 3 3v3a1 1 0 0 0 2 0v-7.5l-2.4-2.4a1 1 0 0 1 1.4-1.4l3.3 3.3c.2.2.3.4.3.7V19a3 3 0 0 1-6 0v-3a1 1 0 0 0-1-1h-1v7H3zM7 6h4v5H7V6z"/>
											</svg>
											<Text fontSize="8px" fontWeight="700" color="#E53E3E" lineHeight="1" mt="1">LOW GAS</Text>
										</Flex>
									)}
								</Flex>

								{bal ? (
									<Box>
										<Text fontSize="xs" fontFamily="mono" fontWeight="500" color={isStale ? "kk.textMuted" : "white"} lineHeight="1.3" truncate>
											{formatBalance(bal.balance)} {chain.symbol}
										</Text>
										{usdNum > 0 && (
											<AnimatedUsd value={usdNum} fontSize="11px" color={isStale ? "kk.textMuted" : undefined} fontWeight="500" lineHeight="1.3" />
										)}
										{(() => {
											// Zcash gets a special "+ shielded" sub-row instead of generic token count.
											// The shielded balance is appended as a synthetic token with type:'shielded'
											// in getBalances; surface it explicitly so users see the private balance.
											const shielded = bal.tokens?.find(tk => tk.type === 'shielded')
											const otherTokens = bal.tokens?.filter(tk => tk.type !== 'shielded') ?? []
											return (
												<>
													{shielded && parseFloat(shielded.balance || '0') > 0 && (
														<Flex align="center" gap="1" mt="0.5" title="Shielded (Orchard) balance — visible only to you">
															<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={chain.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
																<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
															</svg>
															<Text fontSize="10px" fontFamily="mono" color={chain.color} fontWeight="600" lineHeight="1.3" truncate>
																+ {formatBalance(shielded.balance)} private
															</Text>
														</Flex>
													)}
													{otherTokens.length > 0 && (
														<Text fontSize="10px" color={chain.color} fontWeight="600" lineHeight="1.3" mt="0.5">
															{t("tokensCount", { count: otherTokens.length })}
														</Text>
													)}
												</>
											)
										})()}
									</Box>
								) : loadingBalances ? (
									<Text fontSize="10px" color="kk.textMuted">{t("loading", { ns: "common" })}</Text>
								) : (
									<Text fontSize="10px" color="kk.textMuted">{t("noBalance")}</Text>
								)}
							</Flex>
						</Box>
					)
				})}

				{/* Add Chain card — hidden in watch-only mode */}
				{!watchOnly && (
					<Box
						bg="kk.cardBg"
						border="1px dashed"
						borderColor="kk.border"
						borderRadius="xl"
						p="3"
						cursor="pointer"
						transition="all 0.15s"
						_hover={{
							borderColor: "kk.gold",
							bg: "rgba(233,196,106,0.05)",
						}}
						onClick={() => setShowAddChain(true)}
						display="flex"
						alignItems="center"
						justifyContent="center"
						minH="80px"
					>
						<Flex direction="column" align="center" gap="1">
							<Text fontSize="lg" color="kk.textMuted">+</Text>
							<Text fontSize="10px" color="kk.textMuted">{t("addChain")}</Text>
						</Flex>
					</Box>
				)}
			</SimpleGrid>

			{showAddChain && (
				<AddChainDialog
					onClose={() => setShowAddChain(false)}
					onAdded={(chain) => {
						setCustomChainDefs(prev => [...prev, customChainToChainDef(chain)])
						if (chain.explorerAddressLink || chain.explorerTxLink) {
							registerCustomAsset(`eip155:${chain.chainId}/slip44:60`, {
								symbol: chain.symbol, name: chain.name,
								explorer: chain.explorerUrl,
								explorerAddressLink: chain.explorerAddressLink,
								explorerTxLink: chain.explorerTxLink,
							})
						}
					}}
					existingChainIds={existingChainIds}
				/>
			)}

			{showReports && (
				<ReportDialog onClose={() => setShowReports(false)} />
			)}

			{showBip85 && (
				<Bip85VaultDialog onClose={() => setShowBip85(false)} />
			)}

			{/* BIP-85 lock icon — bottom right (only when feature enabled AND firmware >= 7.15.0) */}
			{bip85Enabled && !watchOnly && firmwareVersion && versionCompare(firmwareVersion, '7.15.0') >= 0 && (
				<Box
					as="button"
					position="fixed"
					bottom="24px"
					right="24px"
					w="52px"
					h="52px"
					borderRadius="full"
					bg="rgba(233,196,106,0.15)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.3)"
					display="flex"
					alignItems="center"
					justifyContent="center"
					cursor="pointer"
					transition="all 0.2s"
					_hover={{
						bg: "rgba(233,196,106,0.25)",
						borderColor: "kk.gold",
						transform: "scale(1.08)",
						boxShadow: "0 0 20px rgba(233,196,106,0.3)",
					}}
					_active={{ transform: "scale(0.95)" }}
					onClick={() => setShowBip85(true)}
					zIndex={10}
					title="BIP-85 Seed Vault"
				>
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
						<path d="M7 11V7a5 5 0 0 1 10 0v4" />
					</svg>
				</Box>
			)}
		</Box>
	)
}
