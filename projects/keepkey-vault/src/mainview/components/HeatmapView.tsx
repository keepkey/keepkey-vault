import { useEffect, useMemo, useRef, useState } from "react"
import { Box, Flex, Image, Text } from "@chakra-ui/react"
import type { ChainDef } from "../../shared/chains"
import type { ChainBalance, TokenBalance } from "../../shared/types"
import { getAssetIcon } from "../../shared/assetLookup"

/** A portfolio heatmap (squarified treemap). Each tile is a chain (or a
 *  drilled chain's clean tokens), with area proportional to USD value.
 *  Bigger holdings = bigger tile. Tile color = chain.color (chains) or a
 *  rotating palette (tokens). Click a tile to drill in or open detail. */

interface HeatmapTile {
	id: string
	label: string
	subLabel: string
	icon: string
	color: string
	value: number
	onSelect: () => void
}

interface HeatmapViewProps {
	tiles: HeatmapTile[]
	/** Optional explicit size — if omitted the view fills its parent container
	 *  and re-lays out on resize via ResizeObserver. */
	width?: number
	height?: number
}

/** Squarified treemap algorithm — Bruls et al, 2000.
 *  Lays out rectangles in rows, picking the row that keeps aspect ratios
 *  closest to 1:1. Good enough for ~30 tiles. */
function layoutSquarified(
	items: HeatmapTile[],
	x: number,
	y: number,
	w: number,
	h: number,
): Array<{ tile: HeatmapTile; x: number; y: number; w: number; h: number }> {
	if (items.length === 0) return []
	const total = items.reduce((s, t) => s + t.value, 0)
	if (total <= 0) return []

	// Scale values to area of the bounding rect
	const area = w * h
	const scaled = items.map(t => ({ tile: t, area: (t.value / total) * area }))
	scaled.sort((a, b) => b.area - a.area)

	const result: Array<{ tile: HeatmapTile; x: number; y: number; w: number; h: number }> = []
	let curX = x, curY = y, curW = w, curH = h

	const worstRatio = (row: { area: number }[], width: number) => {
		const rowSum = row.reduce((s, r) => s + r.area, 0)
		const max = Math.max(...row.map(r => r.area))
		const min = Math.min(...row.map(r => r.area))
		const widthSq = width * width
		const sumSq = rowSum * rowSum
		return Math.max((widthSq * max) / sumSq, sumSq / (widthSq * min))
	}

	const layoutRow = (row: typeof scaled, width: number, horizontal: boolean) => {
		const rowSum = row.reduce((s, r) => s + r.area, 0)
		const rowDepth = rowSum / width
		let pos = horizontal ? curX : curY
		for (const r of row) {
			const len = r.area / rowDepth
			if (horizontal) {
				result.push({ tile: r.tile, x: pos, y: curY, w: len, h: rowDepth })
				pos += len
			} else {
				result.push({ tile: r.tile, x: curX, y: pos, w: rowDepth, h: len })
				pos += len
			}
		}
		// Advance into the remaining rect
		if (horizontal) {
			curY += rowDepth
			curH -= rowDepth
		} else {
			curX += rowDepth
			curW -= rowDepth
		}
	}

	let pending = [...scaled]
	while (pending.length > 0) {
		const horizontal = curW >= curH
		const shortSide = horizontal ? curW : curH
		const row: typeof scaled = []
		while (pending.length > 0) {
			const candidate = [...row, pending[0]!]
			const newRatio = worstRatio(candidate, shortSide)
			const currentRatio = row.length === 0 ? Infinity : worstRatio(row, shortSide)
			if (newRatio <= currentRatio) {
				row.push(pending.shift()!)
			} else {
				break
			}
		}
		if (row.length === 0) break
		layoutRow(row, shortSide, horizontal)
	}

	return result
}

function HeatmapTileBox({
	rect,
}: {
	rect: { tile: HeatmapTile; x: number; y: number; w: number; h: number }
}) {
	const { tile, x, y, w, h } = rect
	const area = w * h
	// Decide what fits inside the tile based on its area
	const showIcon = area > 2200
	const showSubLabel = area > 4500
	const showLabel = area > 1300
	const iconSize = Math.min(48, Math.max(18, Math.floor(Math.sqrt(area) / 4)))
	const labelSize = Math.min(15, Math.max(10, Math.floor(Math.sqrt(area) / 9)))
	return (
		<Box
			as="button"
			onClick={tile.onSelect}
			position="absolute"
			left={`${x}px`}
			top={`${y}px`}
			w={`${w - 4}px`}
			h={`${h - 4}px`}
			borderRadius="md"
			overflow="hidden"
			cursor="pointer"
			border="1px solid"
			borderColor={`${tile.color}55`}
			bg={`linear-gradient(135deg, ${tile.color}3a 0%, ${tile.color}14 100%)`}
			transition="transform 0.18s cubic-bezier(0.2,0.8,0.2,1), border-color 0.18s, box-shadow 0.18s"
			_hover={{
				transform: "translate(-1px, -1px)",
				borderColor: tile.color,
				boxShadow: `0 0 0 1px ${tile.color}, 0 8px 22px -10px ${tile.color}`,
				zIndex: 2,
			}}
			textAlign="left"
			title={`${tile.label} · $${tile.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
		>
			<Flex direction="column" justify="space-between" w="100%" h="100%" p={area > 4500 ? "3" : "2"} gap="1">
				<Flex align="center" gap="2" minW="0">
					{showIcon && (
						<Image
							src={tile.icon}
							alt=""
							w={`${iconSize}px`}
							h={`${iconSize}px`}
							borderRadius="full"
							flexShrink={0}
							bg="var(--ink-2)"
						/>
					)}
					{showLabel && (
						<Box minW="0">
							<Text
								fontSize={`${labelSize}px`}
								fontWeight="600"
								color="var(--text-0)"
								lineHeight="1.1"
								truncate
							>
								{tile.label}
							</Text>
							{showSubLabel && (
								<Text fontSize="10px" color="var(--text-3)" lineHeight="1.2" truncate letterSpacing="0.04em">
									{tile.subLabel}
								</Text>
							)}
						</Box>
					)}
				</Flex>
				{area > 1800 && (
					<Text
						fontSize={`${Math.max(10, Math.min(18, Math.floor(Math.sqrt(area) / 8)))}px`}
						fontWeight="500"
						color="var(--text-0)"
						letterSpacing="-0.01em"
						lineHeight="1"
						truncate
					>
						${tile.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}
					</Text>
				)}
			</Flex>
		</Box>
	)
}

export function HeatmapView({ tiles, width, height }: HeatmapViewProps) {
	const wrapRef = useRef<HTMLDivElement>(null)
	const [measured, setMeasured] = useState<{ w: number; h: number }>({ w: width ?? 0, h: height ?? 0 })

	useEffect(() => {
		// Explicit dimensions short-circuit measurement.
		if (width !== undefined && height !== undefined) {
			setMeasured({ w: width, h: height })
			return
		}
		const el = wrapRef.current
		if (!el) return
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const { width: w, height: h } = entry.contentRect
				setMeasured({ w: Math.floor(w), h: Math.floor(h) })
			}
		})
		ro.observe(el)
		const r = el.getBoundingClientRect()
		setMeasured({ w: Math.floor(r.width), h: Math.floor(r.height) })
		return () => ro.disconnect()
	}, [width, height])

	const laid = useMemo(() => {
		if (measured.w <= 0 || measured.h <= 0) return []
		return layoutSquarified(tiles.filter(t => t.value > 0), 0, 0, measured.w, measured.h)
	}, [tiles, measured.w, measured.h])

	return (
		<Box ref={wrapRef} position="relative" w="100%" h="100%" minH="0" minW="0">
			{laid.map((rect) => (
				<HeatmapTileBox key={rect.tile.id} rect={rect} />
			))}
		</Box>
	)
}

/** Helpers to build the tile lists from Dashboard's existing state. */
export function buildAllChainsTiles(
	chains: ChainDef[],
	cleanBalanceUsd: Map<string, { usd: number }>,
	onSelectChain: (chainId: string) => void,
): HeatmapTile[] {
	const tiles: HeatmapTile[] = []
	for (const chain of chains) {
		const usd = cleanBalanceUsd.get(chain.id)?.usd ?? 0
		if (usd <= 0) continue
		tiles.push({
			id: chain.id,
			label: chain.coin,
			subLabel: chain.symbol,
			icon: getAssetIcon(chain.caip),
			color: chain.color,
			value: usd,
			onSelect: () => onSelectChain(chain.id),
		})
	}
	return tiles
}

const TOKEN_PALETTE = ["#e9c46a", "#8be3c4", "#6c7be8", "#e08c7b", "#9f8ce0", "#f0a85c", "#4eb591", "#4f7fc8"]

export function buildChainDetailTiles(
	chain: ChainDef,
	balance: ChainBalance | undefined,
	cleanTokens: TokenBalance[],
	nativeUsd: number,
	onSelectToken: (tok?: TokenBalance) => void,
): HeatmapTile[] {
	const tiles: HeatmapTile[] = []
	const nativeBalance = balance?.balance || "0"
	if (nativeUsd > 0) {
		tiles.push({
			id: `${chain.id}:native`,
			label: chain.symbol,
			subLabel: `${parseFloat(nativeBalance).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${chain.symbol}`,
			icon: getAssetIcon(chain.caip),
			color: chain.color,
			value: nativeUsd,
			onSelect: () => onSelectToken(undefined),
		})
	}
	const sorted = cleanTokens.slice().sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0))
	sorted.forEach((tok, i) => {
		const usd = tok.balanceUsd ?? 0
		if (usd <= 0) return
		tiles.push({
			id: tok.caip,
			label: tok.symbol,
			subLabel: tok.name || chain.coin,
			icon: tok.icon || getAssetIcon(tok.caip),
			color: TOKEN_PALETTE[i % TOKEN_PALETTE.length]!,
			value: usd,
			onSelect: () => onSelectToken(tok),
		})
	})
	return tiles
}
