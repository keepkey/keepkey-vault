import { useEffect, useRef, useState, type ReactNode } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import { useDashboardView, type DashboardView } from "../lib/dashboardViewContext"
import { Z } from "../lib/z-index"

/** Drop-down view picker, triggered by an eye icon in the TopNav. Replaces
 *  the inline orbital/donut/heatmap pill. Each menu row carries a small
 *  preview thumbnail so the user can recognize the view visually. */

const VIEWS: Array<{ id: DashboardView; label: string; description: string; preview: ReactNode }> = [
	{
		id: "orbital",
		label: "Orbital",
		description: "Chains orbiting the portfolio total",
		preview: (
			<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
				<circle cx="12" cy="12" r="9" strokeDasharray="2 3" opacity="0.5" />
				<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
				<circle cx="21" cy="12" r="2" fill="currentColor" stroke="none" />
				<circle cx="3" cy="12" r="1.7" fill="currentColor" stroke="none" />
				<circle cx="12" cy="3" r="1.7" fill="currentColor" stroke="none" />
				<circle cx="12" cy="21" r="1.7" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		id: "donut",
		label: "Donut",
		description: "Slice breakdown with percentages",
		preview: (
			<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
				<circle cx="12" cy="12" r="9" />
				<path d="M12 3 a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3.2" opacity="0.65" />
				<path d="M21 12 a9 9 0 0 1 -4.5 7.8" stroke="currentColor" strokeWidth="3.2" opacity="0.85" />
				<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
			</svg>
		),
	},
	{
		id: "heatmap",
		label: "Heatmap",
		description: "Treemap sized by value",
		preview: (
			<svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor">
				<rect x="3" y="3" width="11" height="13" rx="1.2" opacity="0.95" />
				<rect x="16" y="3" width="5" height="8" rx="1.2" opacity="0.7" />
				<rect x="16" y="13" width="5" height="8" rx="1.2" opacity="0.5" />
				<rect x="3" y="18" width="11" height="3" rx="1.2" opacity="0.35" />
			</svg>
		),
	},
	{
		id: "stack",
		label: "Stack",
		description: "Horizontal stacked bar by share",
		preview: (
			<svg width="40" height="40" viewBox="0 0 24 24">
				<g transform="translate(0,8)">
					<rect x="2"  y="0" width="11" height="8" rx="1.5" fill="currentColor" opacity="0.95" />
					<rect x="13" y="0" width="6"  height="8" fill="currentColor" opacity="0.7" />
					<rect x="19" y="0" width="2"  height="8" fill="currentColor" opacity="0.5" />
					<rect x="21" y="0" width="1"  height="8" rx="0.5" fill="currentColor" opacity="0.35" />
				</g>
				<g transform="translate(0,18)" fill="currentColor" opacity="0.55">
					<rect x="2"  y="0" width="5"  height="1.6" rx="0.6" />
					<rect x="9"  y="0" width="3"  height="1.6" rx="0.6" />
					<rect x="14" y="0" width="2"  height="1.6" rx="0.6" />
				</g>
			</svg>
		),
	},
]

/** assetCount is the number of items the current view would render (chains in
 *  All Chains view, or native + clean tokens in a drilled chain). When < 2,
 *  comparison views (heatmap, stack) are hidden because they can't compare
 *  one thing. */
export function ViewPickerButton({ assetCount }: { assetCount?: number } = {}) {
	const { viewMode, setViewMode } = useDashboardView()
	const [open, setOpen] = useState(false)
	const wrapRef = useRef<HTMLDivElement>(null)
	const visibleViews = assetCount !== undefined && assetCount < 2
		? VIEWS.filter(v => v.id === 'orbital' || v.id === 'donut')
		: VIEWS
	const activeView = visibleViews.find(v => v.id === viewMode) ?? visibleViews[0]

	// Close on outside click / Esc
	useEffect(() => {
		if (!open) return
		const onClick = (e: MouseEvent) => {
			if (!wrapRef.current) return
			if (!wrapRef.current.contains(e.target as Node)) setOpen(false)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false)
		}
		window.addEventListener("mousedown", onClick)
		window.addEventListener("keydown", onKey)
		return () => {
			window.removeEventListener("mousedown", onClick)
			window.removeEventListener("keydown", onKey)
		}
	}, [open])

	return (
		<Box ref={wrapRef} position="relative" className="electrobun-webkit-app-region-no-drag">
			<Box
				as="button"
				onClick={() => setOpen(o => !o)}
				position="relative"
				w="36px"
				h="36px"
				borderRadius="999px"
				bg={open ? "var(--ink-4)" : "var(--ink-2)"}
				color={open ? "var(--gold)" : "var(--text-2)"}
				border="1px solid var(--line)"
				_hover={{ color: "var(--text-0)", bg: "var(--ink-3)" }}
				transition="all 0.18s"
				cursor="pointer"
				title="Switch view"
				aria-haspopup="menu"
				aria-expanded={open}
				overflow="hidden"
			>
				<Box
					position="absolute"
					style={{ transform: "translate(-50%, -50%) scale(0.55)", top: "50%", left: "50%" }}
					display="flex"
				>
					{activeView.preview}
				</Box>
			</Box>

			{open && (
				<Box
					position="absolute"
					top="calc(100% + 8px)"
					left="50%"
					style={{ transform: "translateX(-50%)" }}
					w="260px"
					bg="var(--ink-1)"
					border="1px solid var(--line)"
					borderRadius="lg"
					boxShadow="0 24px 64px rgba(0,0,0,0.55)"
					p="1"
					zIndex={Z.nav + 1}
					role="menu"
				>
					{visibleViews.map((v) => {
						const isActive = viewMode === v.id
						return (
							<Box
								key={v.id}
								as="button"
								onClick={() => { setViewMode(v.id); setOpen(false) }}
								role="menuitem"
								w="100%"
								textAlign="left"
								px="2.5"
								py="2"
								my="0.5"
								borderRadius="md"
								bg={isActive ? "var(--ink-3)" : "transparent"}
								_hover={{ bg: "var(--ink-3)" }}
								cursor="pointer"
								transition="background 0.15s"
								display="flex"
								alignItems="center"
								gap="3"
							>
								<Box
									w="44px"
									h="44px"
									flexShrink={0}
									borderRadius="md"
									bg="var(--ink-0)"
									border="1px solid var(--line)"
									display="flex"
									alignItems="center"
									justifyContent="center"
									color={isActive ? "var(--gold)" : "var(--text-2)"}
								>
									{v.preview}
								</Box>
								<Box flex="1" minW="0">
									<Flex align="center" gap="2">
										<Text fontSize="13px" fontWeight="600" color="var(--text-0)" lineHeight="1.2">
											{v.label}
										</Text>
										{isActive && (
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
												<polyline points="20 6 9 17 4 12" />
											</svg>
										)}
									</Flex>
									<Text fontSize="11px" color="var(--text-3)" lineHeight="1.3" mt="0.5">
										{v.description}
									</Text>
								</Box>
							</Box>
						)
					})}
				</Box>
			)}
		</Box>
	)
}
