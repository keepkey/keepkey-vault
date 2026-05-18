import { useState } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"

/** Horizontal stacked-bar portfolio view. Big total on top, single
 *  bar segmented by share, in-line labels for segments above an area
 *  threshold, smaller items collapsed into a chip legend below. */

export interface StackedBarItem {
	id: string
	label: string
	color: string
	value: number
	onSelect?: () => void
}

interface StackedBarViewProps {
	items: StackedBarItem[]
	/** Big number on top — e.g. "$8,617.19". */
	totalLabel?: string
	/** Total value to use for percentages. Defaults to the sum of items. */
	total?: number
	/** Optional 24h delta to display in green/red under the total
	 *  (number is fine — we render the sign + percentage from it). */
	deltaUsd?: number
	deltaPct?: number
	/** Max bar width in px. */
	maxWidth?: number
}

const INLINE_LABEL_THRESHOLD = 0.05 // 5% — segments at or above get an inline label

export function StackedBarView({
	items,
	totalLabel,
	total: totalProp,
	deltaUsd,
	deltaPct,
	maxWidth = 720,
}: StackedBarViewProps) {
	const total = totalProp ?? items.reduce((s, it) => s + it.value, 0)
	const [hoverId, setHoverId] = useState<string | null>(null)
	if (total <= 0) return null

	const sorted = items
		.slice()
		.filter(it => it.value > 0)
		.sort((a, b) => b.value - a.value)

	let runningOffset = 0
	const segments = sorted.map((it) => {
		const pct = it.value / total
		const seg = { ...it, pct, offsetPct: runningOffset }
		runningOffset += pct
		return seg
	})

	const labeled = segments.filter(s => s.pct >= INLINE_LABEL_THRESHOLD)
	const chips   = segments.filter(s => s.pct <  INLINE_LABEL_THRESHOLD)

	const dollars = Math.floor(total)
	const cents   = (total % 1).toFixed(2).slice(2) || "00"

	const deltaPositive = (deltaUsd ?? 0) >= 0
	const deltaColor    = deltaPositive ? "var(--teal)" : "var(--rose)"

	return (
		<Flex direction="column" align="center" w="100%" maxW={`${maxWidth}px`} gap="5" px="3">
			{/* Total */}
			<Flex direction="column" align="center" gap="1">
				<Text
					fontSize="10px"
					color="var(--text-3)"
					letterSpacing="0.20em"
					textTransform="uppercase"
					fontWeight={500}
					lineHeight="1"
				>
					{totalLabel || "Total"}
				</Text>
				<Flex align="baseline" justify="center" gap="0">
					<Text
						fontSize={{ base: "44px", md: "56px" }}
						fontWeight={500}
						color="var(--text-0)"
						letterSpacing="-0.04em"
						lineHeight="1"
					>
						${dollars.toLocaleString()}
					</Text>
					<Text
						fontSize={{ base: "22px", md: "28px" }}
						fontWeight={400}
						color="var(--text-2)"
						letterSpacing="-0.02em"
						lineHeight="1"
						ml="1"
					>
						.{cents}
					</Text>
				</Flex>
				{(deltaUsd !== undefined || deltaPct !== undefined) && (
					<Flex align="center" gap="2" mt="1">
						{deltaUsd !== undefined && (
							<Text fontSize="13px" color={deltaColor} fontWeight={500}>
								{deltaPositive ? "+" : ""}${Math.abs(deltaUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
							</Text>
						)}
						{deltaPct !== undefined && (
							<Text fontSize="13px" color={deltaColor} fontWeight={500}>
								·  {deltaPositive ? "+" : ""}{deltaPct.toFixed(2)}% 24h
							</Text>
						)}
					</Flex>
				)}
			</Flex>

			{/* Bar */}
			<Box position="relative" w="100%" h="32px" borderRadius="md" overflow="hidden" bg="var(--ink-2)">
				<Flex w="100%" h="100%">
					{segments.map((s) => {
						const isHover = hoverId === s.id
						return (
							<Box
								key={s.id}
								as={s.onSelect ? "button" : "div"}
								flexGrow={s.pct}
								flexShrink={0}
								flexBasis={0}
								minW="2px"
								h="100%"
								bg={s.color}
								opacity={hoverId && !isHover ? 0.55 : 1}
								transition="opacity 0.15s"
								cursor={s.onSelect ? "pointer" : "default"}
								onMouseEnter={() => setHoverId(s.id)}
								onMouseLeave={() => setHoverId(null)}
								onClick={s.onSelect}
								border="0"
								p={0}
								title={`${s.label} · ${(s.pct * 100).toFixed(1)}% · $${s.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
							/>
						)
					})}
				</Flex>
			</Box>

			{/* Inline labels under segments above the threshold */}
			{labeled.length > 0 && (
				<Box position="relative" w="100%" minH="44px">
					{labeled.map((s) => {
						const isHover = hoverId === s.id
						return (
							<Box
								key={s.id}
								position="absolute"
								left={`${s.offsetPct * 100}%`}
								top="0"
								pr="2"
								maxW={`${s.pct * 100}%`}
								onMouseEnter={() => setHoverId(s.id)}
								onMouseLeave={() => setHoverId(null)}
								onClick={s.onSelect}
								cursor={s.onSelect ? "pointer" : "default"}
								opacity={hoverId && !isHover ? 0.55 : 1}
								transition="opacity 0.15s"
							>
								<Text
									fontSize="13px"
									fontWeight={600}
									color="var(--text-0)"
									lineHeight="1.2"
									truncate
								>
									{s.label}
								</Text>
								<Text fontSize="11px" color="var(--text-2)" lineHeight="1.4" truncate>
									{(s.pct * 100).toFixed(1)}% · ${s.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}
								</Text>
							</Box>
						)
					})}
				</Box>
			)}

			{/* Chip legend for small segments */}
			{chips.length > 0 && (
				<Flex wrap="wrap" justify="center" gap="3" rowGap="2" mt="1">
					{chips.map((s) => (
						<Flex
							key={s.id}
							as={s.onSelect ? "button" : "div"}
							align="center"
							gap="1.5"
							onClick={s.onSelect}
							cursor={s.onSelect ? "pointer" : "default"}
							bg="transparent"
							border="0"
							p={0}
							_hover={s.onSelect ? { color: "var(--text-0)" } : undefined}
							color="var(--text-2)"
							transition="color 0.15s"
						>
							<Box w="8px" h="8px" borderRadius="full" bg={s.color} flexShrink={0} />
							<Text fontSize="11px" lineHeight="1.2">
								{s.label} · ${s.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}
							</Text>
						</Flex>
					))}
				</Flex>
			)}
		</Flex>
	)
}
