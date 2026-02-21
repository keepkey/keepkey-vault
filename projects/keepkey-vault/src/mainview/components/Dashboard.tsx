import { useState, useEffect } from "react"
import { Box, Flex, Text, VStack, HStack, Spinner, Image } from "@chakra-ui/react"
import { CHAINS, type ChainDef } from "../../shared/chains"
import { formatBalance } from "../lib/formatting"
import { supportsTokens } from "../lib/asset-utils"
import { getAssetIcon } from "../../shared/assetLookup"
import { AssetPage } from "./AssetPage"
import { DonutChart, ChartLegend, type DonutChartItem } from "./DonutChart"
import { rpcRequest } from "../lib/rpc"
import type { ChainBalance } from "../../shared/types"

export function Dashboard() {
	const [selectedChain, setSelectedChain] = useState<ChainDef | null>(null)
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(new Map())
	const [loadingBalances, setLoadingBalances] = useState(false)
	const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(0)

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
	}, [])

	const totalUsd = Array.from(balances.values()).reduce((sum, b) => sum + (b.balanceUsd || 0), 0)

	// Build chart data — only chains with USD value
	const chartData: DonutChartItem[] = CHAINS
		.map((chain) => {
			const bal = balances.get(chain.id)
			return {
				name: chain.symbol,
				value: bal?.balanceUsd || 0,
				color: chain.color,
				chainId: chain.id,
			}
		})
		.filter((d) => d.value > 0)
		.sort((a, b) => b.value - a.value)

	const hasAnyBalance = chartData.length > 0

	// Sort chains: ones with balance first (by USD desc), then rest by original order
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

	// Aggregate token stats across all chains
	const totalTokenCount = Array.from(balances.values()).reduce((sum, b) => sum + (b.tokens?.length || 0), 0)
	const totalTokenUsd = Array.from(balances.values()).reduce(
		(sum, b) => sum + (b.tokens?.reduce((ts, t) => ts + (t.balanceUsd || 0), 0) || 0), 0
	)

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return <AssetPage chain={selectedChain} balance={bal} onBack={() => setSelectedChain(null)} />
	}

	return (
		<Box w="100%" maxW={{ base: "100%", sm: "480px", md: "560px" }} mx="auto" pt="2" px={{ base: "3", md: "4" }}>
			<VStack gap={{ base: "4", md: "5" }} align="center">
				{/* Portfolio Donut Card */}
				<Box
					w="100%"
					p={{ base: "4", md: "5" }}
					borderRadius="xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor={hasAnyBalance ? `${chartData[0]?.color}40` : "kk.border"}
					boxShadow={hasAnyBalance ? `0 4px 20px ${chartData[0]?.color}20` : "lg"}
					transition="all 0.2s"
				>
					{loadingBalances && !hasAnyBalance ? (
						<Flex direction="column" align="center" justify="center" py="8" gap="3">
							<Spinner size="lg" color="kk.gold" />
							<Text fontSize="sm" color="kk.gold">Loading portfolio...</Text>
						</Flex>
					) : hasAnyBalance ? (
						<Flex direction="column" align="center" gap="3">
							<DonutChart
								data={chartData}
								size={180}
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
					) : (
						<Flex direction="column" align="center" py="6" gap="2">
							<Text fontSize="2xl">📊</Text>
							<Text fontSize="sm" color="gray.400" fontWeight="500">No Portfolio Balance</Text>
							<Text fontSize="xs" color="gray.500" textAlign="center" maxW="280px">
								Your portfolio is empty. Add funds to see your portfolio breakdown.
							</Text>
							<Text fontSize="lg" color="kk.gold" fontWeight="bold">$0.00</Text>
						</Flex>
					)}
				</Box>

				{/* Asset List */}
				<Box w="100%">
					<HStack justify="space-between" mb="2">
						<HStack gap="2">
							<Text fontSize="sm" color="gray.400">Your Assets</Text>
							<Text fontSize="xs" color="gray.600">({CHAINS.length})</Text>
						</HStack>
						{loadingBalances && hasAnyBalance && <Spinner size="xs" color="kk.gold" />}
					</HStack>

					<VStack gap="1.5">
						{sortedChains.map((chain) => {
							const bal = balances.get(chain.id)
							const balNum = parseFloat(bal?.balance || '0')
							const usdNum = bal?.balanceUsd || 0
							const hasBalance = balNum > 0 || usdNum > 0
							const tokenCount = bal?.tokens?.length || 0

							return (
								<Box
									key={chain.id}
									w="100%"
									py="2"
									px={{ base: "2.5", md: "3" }}
									borderRadius="lg"
									border="1px solid"
									borderColor={hasBalance ? `${chain.color}40` : "kk.border"}
									bg={hasBalance ? `${chain.color}08` : "kk.cardBg"}
									cursor="pointer"
									transition="all 0.15s"
									_hover={{
										borderColor: chain.color,
										bg: `${chain.color}14`,
									}}
									_active={{ transform: "scale(0.99)" }}
									onClick={() => setSelectedChain(chain)}
								>
									<Flex align="center" justify="space-between">
										<HStack gap="2">
											<Image
												src={getAssetIcon(chain.caip)}
												alt={chain.symbol}
												w="26px"
												h="26px"
												borderRadius="full"
												flexShrink={0}
												bg={chain.color}
											/>
											<Box>
												<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2">
													{chain.coin}
												</Text>
												<Text fontSize="xs" color="gray.500" lineHeight="1.2">{chain.symbol}</Text>
											</Box>
										</HStack>

										<Box textAlign="right">
											{bal ? (
												<>
													<Text fontSize={{ base: "xs", md: "sm" }} fontFamily="mono" fontWeight="500" color="white" lineHeight="1.2">
														{formatBalance(bal.balance)} {chain.symbol}
													</Text>
													{usdNum > 0 && (
														<Text fontSize="xs" color="gray.400" lineHeight="1.2">
															${usdNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
														</Text>
													)}
												</>
											) : loadingBalances ? (
												<Text fontSize="xs" color="gray.600">...</Text>
											) : (
												<Text fontSize="xs" color="gray.600">—</Text>
											)}
										</Box>
									</Flex>
								</Box>
							)
						})}
					</VStack>
				</Box>
			</VStack>
		</Box>
	)
}
