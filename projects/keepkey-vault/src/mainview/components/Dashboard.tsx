import { useState, useEffect } from "react"
import { Box, Flex, Text, VStack, HStack, Spinner } from "@chakra-ui/react"
import { CHAINS, type ChainDef } from "../lib/chains"
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

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return <AssetPage chain={selectedChain} balance={bal} onBack={() => setSelectedChain(null)} />
	}

	return (
		<Box maxW="600px" mx="auto" pt="4" px="4">
			<VStack gap="6" align="center">
				{/* Portfolio Donut Card */}
				<Box
					w="100%"
					maxW="420px"
					p="6"
					borderRadius="2xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor={hasAnyBalance ? `${chartData[0]?.color}40` : "kk.border"}
					boxShadow={hasAnyBalance ? `0 4px 20px ${chartData[0]?.color}20` : "lg"}
					transition="all 0.2s"
				>
					{loadingBalances && !hasAnyBalance ? (
						<Flex direction="column" align="center" justify="center" py="10" gap="4">
							<Spinner size="lg" color="kk.gold" />
							<Text fontSize="sm" color="kk.gold">Loading portfolio...</Text>
						</Flex>
					) : hasAnyBalance ? (
						<Flex direction="column" align="center" gap="4">
							<DonutChart
								data={chartData}
								size={210}
								activeIndex={activeSliceIndex}
								onHoverSlice={(i) => setActiveSliceIndex(i === null ? 0 : i)}
							/>
							<Box w="100%" maxW="360px" borderTop="1px solid" borderColor="whiteAlpha.100" pt="2">
								<ChartLegend
									data={chartData}
									total={totalUsd}
									activeIndex={activeSliceIndex}
									onHoverItem={(i) => setActiveSliceIndex(i === null ? 0 : i)}
								/>
							</Box>
						</Flex>
					) : (
						<Flex direction="column" align="center" py="8" gap="3">
							<Text fontSize="3xl">📊</Text>
							<Text fontSize="md" color="gray.400" fontWeight="500">No Portfolio Balance</Text>
							<Text fontSize="xs" color="gray.500" textAlign="center" maxW="280px">
								Your portfolio is empty. Add funds to see your portfolio breakdown.
							</Text>
							<Text fontSize="xl" color="kk.gold" fontWeight="bold">$0.00</Text>
						</Flex>
					)}
				</Box>

				{/* Asset List */}
				<Box w="100%">
					<HStack justify="space-between" mb="3">
						<HStack gap="2">
							<Text fontSize="sm" color="gray.400">Your Assets</Text>
							<Text fontSize="xs" color="gray.600">({CHAINS.length})</Text>
						</HStack>
						{loadingBalances && hasAnyBalance && <Spinner size="xs" color="kk.gold" />}
					</HStack>

					<VStack gap="3">
						{sortedChains.map((chain) => {
							const bal = balances.get(chain.id)
							const balNum = parseFloat(bal?.balance || '0')
							const usdNum = bal?.balanceUsd || 0
							const hasBalance = balNum > 0 || usdNum > 0

							return (
								<Box
									key={chain.id}
									w="100%"
									p="4"
									borderRadius="xl"
									border="1px solid"
									borderColor={hasBalance ? `${chain.color}50` : "kk.border"}
									borderLeft="4px solid"
									borderLeftColor={chain.color}
									bg={hasBalance ? `${chain.color}10` : "kk.cardBg"}
									boxShadow={hasBalance ? `0 2px 12px ${chain.color}15` : "none"}
									cursor="pointer"
									transition="all 0.2s"
									_hover={{
										transform: "translateY(-2px)",
										boxShadow: `0 6px 20px ${chain.color}30`,
										borderColor: chain.color,
										bg: `${chain.color}18`,
									}}
									_active={{ transform: "scale(0.98)" }}
									onClick={() => setSelectedChain(chain)}
								>
									<Flex align="center" justify="space-between">
										<HStack gap="3">
											{/* Color dot icon */}
											<Box
												w="36px"
												h="36px"
												borderRadius="full"
												bg={chain.color}
												display="flex"
												alignItems="center"
												justifyContent="center"
												boxShadow={`0 0 8px ${chain.color}40`}
											>
												<Text fontSize="xs" fontWeight="bold" color="white">
													{chain.symbol.slice(0, 3)}
												</Text>
											</Box>
											<Box>
												<Text fontSize="sm" fontWeight="600" color="white">
													{chain.coin}
												</Text>
												<Text fontSize="xs" color="gray.500">{chain.symbol}</Text>
											</Box>
										</HStack>

										<Box textAlign="right">
											{bal ? (
												<>
													<Text fontSize="sm" fontFamily="mono" fontWeight="500" color="white">
														{formatBalance(bal.balance)} {chain.symbol}
													</Text>
													{usdNum > 0 && (
														<Text fontSize="xs" color="gray.400">
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

function formatBalance(val: string): string {
	const num = parseFloat(val)
	if (isNaN(num) || num === 0) return "0"
	if (num < 0.000001) return num.toExponential(2)
	if (num < 1) return num.toFixed(6)
	if (num < 1000) return num.toFixed(4)
	return num.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
