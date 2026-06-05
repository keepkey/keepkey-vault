import { Box, Flex, Text } from "@chakra-ui/react"
import { AnimatedUsd } from "./AnimatedUsd"
import type { StackedBarItem } from "./StackedBarView"

export interface DonutChartItem {
	name: string
	value: number
	color: string
}

interface DonutChartProps {
	data: DonutChartItem[]
	size?: number
	activeIndex: number | null
	onHoverSlice: (index: number | null) => void
	onClickSlice?: (index: number) => void
}

export function DonutChart({ data, size = 210, activeIndex, onHoverSlice, onClickSlice }: DonutChartProps) {
	const total = data.reduce((sum, d) => sum + d.value, 0)
	const cx = size / 2
	const cy = size / 2
	const outerR = size * 0.45
	const innerR = size * 0.29

	if (total === 0) {
		const ringR = (outerR + innerR) / 2
		const ringW = outerR - innerR
		return (
			<Box position="relative" w={`${size}px`} h={`${size}px`}>
				<svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
					<circle cx={cx} cy={cy} r={ringR} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={ringW} />
				</svg>
				<Flex position="absolute" top="0" left="0" right="0" bottom="0" align="center" justify="center" direction="column" pointerEvents="none" gap="1">
					<Text fontSize="10px" color="var(--text-3)" letterSpacing="0.20em" textTransform="uppercase" fontWeight="500" lineHeight="1">Total</Text>
					<AnimatedUsd value={0} fontSize={`${Math.round(size * 0.10)}px`} color="var(--text-0)" fontWeight="500" lineHeight="1.1" />
				</Flex>
			</Box>
		)
	}
	const hoverOuterR = outerR * 1.05
	const gap = 0.02 // radians gap between slices

	// Build arc paths
	let startAngle = -Math.PI / 2 // start at top
	const arcs = data.map((item, i) => {
		const sliceAngle = (item.value / total) * Math.PI * 2
		const padded = Math.max(sliceAngle - gap, 0.001)
		const s = startAngle + gap / 2
		const e = s + padded
		startAngle += sliceAngle
		return { item, index: i, startAngle: s, endAngle: e }
	})

	function arcPath(sa: number, ea: number, or_: number, ir: number): string {
		const x1 = cx + or_ * Math.cos(sa)
		const y1 = cy + or_ * Math.sin(sa)
		const x2 = cx + or_ * Math.cos(ea)
		const y2 = cy + or_ * Math.sin(ea)
		const x3 = cx + ir * Math.cos(ea)
		const y3 = cy + ir * Math.sin(ea)
		const x4 = cx + ir * Math.cos(sa)
		const y4 = cy + ir * Math.sin(sa)
		const large = ea - sa > Math.PI ? 1 : 0
		return [
			`M ${x1} ${y1}`,
			`A ${or_} ${or_} 0 ${large} 1 ${x2} ${y2}`,
			`L ${x3} ${y3}`,
			`A ${ir} ${ir} 0 ${large} 0 ${x4} ${y4}`,
			`Z`,
		].join(" ")
	}

	return (
		<Box position="relative" w={`${size}px`} h={`${size}px`}>
			<svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
				{arcs.map(({ item, index, startAngle: sa, endAngle: ea }) => {
					const isActive = activeIndex === index
					const r = isActive ? hoverOuterR : outerR
					return (
						<g key={index}>
							<path
								d={arcPath(sa, ea, r, innerR)}
								fill={item.color}
								stroke="rgba(255,255,255,0.13)"
								strokeWidth={1.5}
								opacity={activeIndex !== null && !isActive ? 0.6 : 1}
								style={{ transition: "all 0.15s ease-in-out", cursor: onClickSlice ? "pointer" : "default" }}
								onMouseEnter={() => onHoverSlice(index)}
								onMouseLeave={() => onHoverSlice(null)}
								onClick={() => onClickSlice?.(index)}
							/>
						</g>
					)
				})}

				{/* Inner cutout — no stroke, blends into the background. */}
				<circle
					cx={cx}
					cy={cy}
					r={innerR * 0.96}
					fill="transparent"
				/>
			</svg>

			{/* Center text overlay — matches the orbital "TOTAL" treatment. */}
			<Flex
				position="absolute"
				top="0"
				left="0"
				right="0"
				bottom="0"
				align="center"
				justify="center"
				direction="column"
				pointerEvents="none"
				gap="1"
			>
				<Text
					fontSize="10px"
					color="var(--text-3)"
					letterSpacing="0.20em"
					textTransform="uppercase"
					fontWeight="500"
					lineHeight="1"
				>
					Total
				</Text>
				<AnimatedUsd
					value={total}
					fontSize={`${Math.round(size * 0.10)}px`}
					color="var(--text-0)"
					fontWeight="500"
					lineHeight="1.1"
				/>
			</Flex>
		</Box>
	)
}

interface SelectedSliceProps {
	/** The currently active (hovered / selected) slice. */
	active: DonutChartItem | null
	/** Total used to compute the slice's percentage share. */
	total: number
	/** Token-level breakdown for the active slice. Pass only when the chain
	 *  holds more than one token — renders a stacked bar + chip labels below
	 *  the key. Omit for single-token chains and the drilled (per-token) view. */
	breakdown?: StackedBarItem[]
	/** Click on the selected key — drill into the chain / open the asset. */
	onClick?: () => void
}

/** Single "selected key" shown below the donut: the active slice plus, when
 *  the chain holds more than one token, a horizontal stacked bar breaking the
 *  chain's value down by token. */
export function SelectedSlice({ active, total, breakdown, onClick }: SelectedSliceProps) {
	if (!active) return <Box h="40px" />

	const percent = total > 0 ? ((active.value / total) * 100).toFixed(1) : "0"
	const segments = (breakdown ?? [])
		.filter((b) => b.value > 0)
		.sort((a, b) => b.value - a.value)
	const stackTotal = segments.reduce((s, it) => s + it.value, 0)
	const showStack = segments.length > 1 && stackTotal > 0

	return (
		<Flex direction="column" w="100%" gap="3">
			{/* Selected key */}
			<Flex
				justify="space-between"
				align="center"
				py="3"
				px="4"
				borderRadius="lg"
				bg="transparent"
				border="1px solid"
				borderColor="kk.border"
				w="100%"
				gap="4"
				transition="border-color 0.2s"
				cursor={onClick ? "pointer" : undefined}
				onClick={onClick}
				_hover={onClick ? { borderColor: "var(--line-2)" } : undefined}
			>
				<Flex align="center" gap="3" minW="0" flex="1">
					<Box w="12px" h="12px" borderRadius="full" bg={active.color} flexShrink={0} boxShadow={`0 0 14px -2px ${active.color}`} />
					<Text fontSize="15px" fontWeight="600" color="var(--text-0)" truncate>{active.name}</Text>
					<Text fontSize="12px" color="var(--text-2)" letterSpacing="0.04em" flexShrink={0}>{percent}%</Text>
				</Flex>
				<AnimatedUsd
					value={active.value}
					fontSize={{ base: "20px", md: "26px" }}
					color="var(--text-0)"
					fontWeight="500"
					letterSpacing="-0.01em"
				/>
			</Flex>

			{/* Token breakdown — stacked bar + chips, only for multi-token chains */}
			{showStack && (
				<Flex direction="column" gap="2.5" px="1">
					<Flex w="100%" h="10px" borderRadius="full" overflow="hidden" bg="var(--ink-2)">
						{segments.map((it) => (
							<Box
								key={it.id}
								flexGrow={it.value / stackTotal}
								flexShrink={0}
								flexBasis={0}
								minW="3px"
								h="100%"
								bg={it.color}
								cursor={it.onSelect ? "pointer" : "default"}
								onClick={it.onSelect}
								_hover={it.onSelect ? { opacity: 0.85 } : undefined}
								transition="opacity 0.15s"
								title={`${it.label} · $${it.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
							/>
						))}
					</Flex>
					<Flex wrap="wrap" justify="center" gap="3" rowGap="1.5">
						{segments.map((it) => (
							<Flex
								key={it.id}
								as={it.onSelect ? "button" : "div"}
								align="center"
								gap="1.5"
								bg="transparent"
								border="0"
								p={0}
								color="var(--text-2)"
								cursor={it.onSelect ? "pointer" : "default"}
								_hover={it.onSelect ? { color: "var(--text-0)" } : undefined}
								transition="color 0.15s"
								onClick={it.onSelect}
							>
								<Box w="8px" h="8px" borderRadius="full" bg={it.color} flexShrink={0} />
								<Text fontSize="11px" lineHeight="1.2" whiteSpace="nowrap">
									{it.label} · ${it.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}
								</Text>
							</Flex>
						))}
					</Flex>
				</Flex>
			)}
		</Flex>
	)
}
