import { Box, Flex, Text } from "@chakra-ui/react"
import { AnimatedUsd } from "./AnimatedUsd"

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
	if (total === 0) return null

	const cx = size / 2
	const cy = size / 2
	const outerR = size * 0.45
	const innerR = size * 0.29
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

interface ChartLegendProps {
	data: DonutChartItem[]
	total: number
	activeIndex: number | null
	onHoverItem: (index: number | null) => void
	onClickItem?: (index: number) => void
}

export function ChartLegend({ data, total, activeIndex, onHoverItem: _onHoverItem, onClickItem }: ChartLegendProps) {
	if (activeIndex === null || !data[activeIndex]) {
		return <Box h="40px" />
	}

	const item = data[activeIndex]
	const percent = total > 0 ? ((item.value / total) * 100).toFixed(1) : "0"

	return (
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
			cursor={onClickItem ? "pointer" : undefined}
			onClick={onClickItem ? () => onClickItem(activeIndex) : undefined}
			_hover={onClickItem ? { borderColor: "var(--line-2)" } : undefined}
		>
			<Flex align="center" gap="3" minW="0" flex="1">
				<Box w="12px" h="12px" borderRadius="full" bg={item.color} flexShrink={0} boxShadow={`0 0 14px -2px ${item.color}`} />
				<Text fontSize="15px" fontWeight="600" color="var(--text-0)" truncate>{item.name}</Text>
				<Text fontSize="12px" color="var(--text-2)" letterSpacing="0.04em" flexShrink={0}>{percent}%</Text>
			</Flex>
			<AnimatedUsd
				value={item.value}
				fontSize={{ base: "20px", md: "26px" }}
				color="var(--text-0)"
				fontWeight="500"
				letterSpacing="-0.01em"
			/>
		</Flex>
	)
}
