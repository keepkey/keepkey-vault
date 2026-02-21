import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, HStack, Spinner, Image, SimpleGrid, IconButton } from "@chakra-ui/react"
import { CHAINS, type ChainDef } from "../../shared/chains"
import { formatBalance } from "../lib/formatting"
import { AnimatedUsd } from "./AnimatedUsd"
import { getAssetIcon } from "../../shared/assetLookup"
import { AssetPage } from "./AssetPage"
import { DonutChart, ChartLegend, type DonutChartItem } from "./DonutChart"
import { rpcRequest } from "../lib/rpc"
import type { ChainBalance } from "../../shared/types"
import kkLogo from "../assets/icon.png"

export function Dashboard() {
	const [selectedChain, setSelectedChain] = useState<ChainDef | null>(null)
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(new Map())
	const [loadingBalances, setLoadingBalances] = useState(false)
	const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(0)
	const [fetchKey, setFetchKey] = useState(0)

	useEffect(() => {
		let cancelled = false
		async function fetchBalances() {
			setLoadingBalances(true)
			try {
				const result = await rpcRequest<ChainBalance[]>('getBalances', undefined, 120000)
				if (!cancelled && result) {
					const map = new Map<string, ChainBalance>()
					for (const b of result) map.set(b.chainId, b)
					setBalances(map)
				}
			} catch (e: any) {
				console.warn('[Dashboard] getBalances failed:', e.message)
			}
			if (!cancelled) setLoadingBalances(false)
		}
		fetchBalances()
		return () => { cancelled = true }
	}, [fetchKey])

	const refreshBalances = useCallback(() => {
		if (!loadingBalances) setFetchKey((k) => k + 1)
	}, [loadingBalances])

	const totalUsd = Array.from(balances.values()).reduce((sum, b) => sum + (b.balanceUsd || 0), 0)

	const chartData: DonutChartItem[] = CHAINS
		.map((chain) => {
			const bal = balances.get(chain.id)
			return { name: chain.symbol, value: bal?.balanceUsd || 0, color: chain.color, chainId: chain.id }
		})
		.filter((d) => d.value > 0)
		.sort((a, b) => b.value - a.value)

	const hasAnyBalance = chartData.length > 0

	const sortedChains = [...CHAINS].sort((a, b) => {
		const aUsd = balances.get(a.id)?.balanceUsd || 0
		const bUsd = balances.get(b.id)?.balanceUsd || 0
		const aHas = aUsd > 0 || parseFloat(balances.get(a.id)?.balance || '0') > 0
		const bHas = bUsd > 0 || parseFloat(balances.get(b.id)?.balance || '0') > 0
		if (aHas && !bHas) return -1
		if (!aHas && bHas) return 1
		if (aHas && bHas) return bUsd - aUsd
		return 0
	})

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return <AssetPage chain={selectedChain} balance={bal} onBack={() => setSelectedChain(null)} />
	}

	const isInitialLoad = loadingBalances && !hasAnyBalance

	return (
		<Box w="100%" maxW="600px" mx="auto" pt="2"
			{...(isInitialLoad ? { minH: "calc(100vh - 70px)", display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center" } : {})}
		>
			{/* KeepKey Branding + Portfolio Value */}
			<Flex direction="column" align="center" mb="5" w="100%">
				<Image
					src={kkLogo}
					alt="KeepKey"
					w="48px"
					h="48px"
					borderRadius="12px"
					mb="2"
				/>
				{totalUsd > 0 ? (
					<AnimatedUsd value={totalUsd} fontSize="2xl" fontWeight="700" color="white" letterSpacing="-0.5px" />
				) : loadingBalances ? (
					<HStack gap="2">
						<Spinner size="sm" color="kk.gold" />
						<Text fontSize="sm" color="kk.textSecondary">Loading portfolio...</Text>
					</HStack>
				) : (
					<Text fontSize="lg" fontWeight="600" color="kk.textSecondary">Portfolio</Text>
				)}
			</Flex>

			{/* Portfolio Chart — only when there are balances */}
			{hasAnyBalance && (
				<Box
					w="100%"
					p="4"
					mb="5"
					borderRadius="xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor="kk.border"
				>
					<Flex direction="column" align="center" gap="3">
						<DonutChart
							data={chartData}
							size={160}
							activeIndex={activeSliceIndex}
							onHoverSlice={(i) => setActiveSliceIndex(i === null ? 0 : i)}
						/>
						<Box w="100%" borderTop="1px solid" borderColor="whiteAlpha.100" pt="2">
							<ChartLegend
								data={chartData}
								total={totalUsd}
								activeIndex={activeSliceIndex}
								onHoverItem={(i) => setActiveSliceIndex(i === null ? 0 : i)}
							/>
						</Box>
					</Flex>
				</Box>
			)}

			{/* Section Header + Chain Grid — hidden during initial load */}
			{!isInitialLoad && (
				<>
					<Flex align="center" justify="space-between" mb="3" px="1">
						<Text fontSize="xs" fontWeight="600" color="kk.textSecondary" textTransform="uppercase" letterSpacing="0.05em">
							Supported Chains
						</Text>
						<HStack gap="2">
							{loadingBalances && hasAnyBalance && <Spinner size="xs" color="kk.gold" />}
							<Text fontSize="xs" color="kk.textMuted">{CHAINS.length} networks</Text>
							<IconButton
								aria-label="Refresh balances"
								size="xs"
								variant="ghost"
								color="kk.textMuted"
								_hover={{ color: "kk.gold", bg: "rgba(255,255,255,0.06)" }}
								onClick={refreshBalances}
								disabled={loadingBalances}
							>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
									<path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
									<path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
								</svg>
							</IconButton>
						</HStack>
					</Flex>

					<SimpleGrid columns={{ base: 2, sm: 3 }} gap="2.5">
						{sortedChains.map((chain) => {
							const bal = balances.get(chain.id)
							const balNum = parseFloat(bal?.balance || '0')
							const usdNum = bal?.balanceUsd || 0
							const hasBalance = balNum > 0 || usdNum > 0

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
											<Box overflow="hidden">
												<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2" truncate>
													{chain.coin}
												</Text>
												<Text fontSize="10px" color="kk.textMuted" lineHeight="1.2">
													{chain.symbol}
												</Text>
											</Box>
										</Flex>

										{bal ? (
											<Box>
												<Text fontSize="xs" fontFamily="mono" fontWeight="500" color="white" lineHeight="1.3" truncate>
													{formatBalance(bal.balance)} {chain.symbol}
												</Text>
												{usdNum > 0 && (
													<AnimatedUsd value={usdNum} fontSize="10px" color="kk.textMuted" lineHeight="1.3" />
												)}
											</Box>
										) : loadingBalances ? (
											<Text fontSize="10px" color="kk.textMuted">Loading...</Text>
										) : (
											<Text fontSize="10px" color="kk.textMuted">No balance</Text>
										)}
									</Flex>
								</Box>
							)
						})}
					</SimpleGrid>
				</>
			)}
		</Box>
	)
}
