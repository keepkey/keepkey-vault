import { useState, useEffect, useCallback, useMemo } from "react"
import { Box, Flex, Text, HStack, Spinner, Image, SimpleGrid, IconButton } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { CHAINS, customChainToChainDef, type ChainDef } from "../../shared/chains"
import { formatBalance } from "../lib/formatting"
import { AnimatedUsd } from "./AnimatedUsd"
import { getAssetIcon, registerCustomAsset } from "../../shared/assetLookup"
import { AssetPage } from "./AssetPage"
import { DonutChart, ChartLegend, type DonutChartItem } from "./DonutChart"
import { AddChainDialog } from "./AddChainDialog"
import { rpcRequest } from "../lib/rpc"
import type { ChainBalance, CustomChain } from "../../shared/types"

interface DashboardProps {
	onLoaded?: () => void
	watchOnly?: boolean
}

export function Dashboard({ onLoaded, watchOnly }: DashboardProps) {
	const { t } = useTranslation("dashboard")
	const [selectedChain, setSelectedChain] = useState<ChainDef | null>(null)
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(new Map())
	const [loadingBalances, setLoadingBalances] = useState(true)
	const [initialLoaded, setInitialLoaded] = useState(false)
	const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(0)
	const [fetchKey, setFetchKey] = useState(0)
	const [customChainDefs, setCustomChainDefs] = useState<ChainDef[]>([])
	const [showAddChain, setShowAddChain] = useState(false)

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

	// Cache-first: show cached balances instantly, then refresh with live data
	useEffect(() => {
		let cancelled = false
		let retryTimer: ReturnType<typeof setTimeout> | undefined

		// Phase 1: Load cached balances immediately (< 1ms from SQLite)
		async function loadCached() {
			if (watchOnly || cancelled) return
			try {
				const cached = await rpcRequest<ChainBalance[] | null>('getCachedBalances', undefined, 3000)
				if (!cancelled && cached && cached.length > 0) {
					const map = new Map<string, ChainBalance>()
					for (const b of cached) map.set(b.chainId, b)
					setBalances(map)
					console.log(`[Dashboard] Cache hit: ${cached.length} chains, $${cached.reduce((s, b) => s + (b.balanceUsd || 0), 0).toFixed(2)}`)
					// Dismiss splash immediately with cached data
					if (!initialLoaded) {
						setInitialLoaded(true)
						onLoaded?.()
					}
				}
			} catch { /* cache unavailable, will wait for live data */ }
		}

		// Phase 2: Fetch live data (background refresh or primary if no cache)
		async function fetchLive(attempt = 1) {
			setLoadingBalances(true)
			let hasTokenData = false
			try {
				const result = watchOnly
					? await rpcRequest<ChainBalance[] | null>('getWatchOnlyBalances', undefined, 5000).then(r => r || [])
					: await rpcRequest<ChainBalance[]>('getBalances', undefined, 120000)
				if (!cancelled && result) {
					const tokenTotal = result.reduce((n, b) => n + (b.tokens?.length || 0), 0)
					const balTotal = result.reduce((n, b) => n + (b.balanceUsd || 0), 0)
					hasTokenData = tokenTotal > 0 || balTotal > 0 || result.length > 0
					console.log(`[Dashboard] Live: ${result.length} chains, ${tokenTotal} tokens, $${balTotal.toFixed(2)} (attempt=${attempt})`)
					const map = new Map<string, ChainBalance>()
					for (const b of result) map.set(b.chainId, b)
					setBalances(map)
				}
			} catch (e: any) {
				console.warn(`[Dashboard] ${watchOnly ? 'watchOnly' : 'getBalances'} failed (attempt=${attempt}):`, e.message)
			}
			if (!cancelled) {
				setLoadingBalances(false)
				if (!initialLoaded) {
					setInitialLoaded(true)
					onLoaded?.()
				}
				// Auto-retry once if first attempt returned no meaningful data
				if (!watchOnly && !hasTokenData && attempt < 2 && !cancelled) {
					console.log('[Dashboard] No balance data — auto-retrying in 3s')
					retryTimer = setTimeout(() => { if (!cancelled) fetchLive(attempt + 1) }, 3000)
				}
			}
		}

		// Execute: cache first, then live
		loadCached().then(() => { if (!cancelled) fetchLive() })

		return () => { cancelled = true; clearTimeout(retryTimer) }
	}, [fetchKey, watchOnly])

	const refreshBalances = useCallback(() => {
		if (!loadingBalances) setFetchKey((k) => k + 1)
	}, [loadingBalances])

	const totalUsd = useMemo(() => Array.from(balances.values()).reduce((sum, b) => sum + (b.balanceUsd || 0), 0), [balances])

	const allChains = useMemo(() => [...CHAINS, ...customChainDefs], [customChainDefs])

	const existingChainIds = useMemo(() => [
		...CHAINS.filter(c => c.chainFamily === 'evm' && c.chainId).map(c => Number(c.chainId)),
		...customChainDefs.filter(c => c.chainId).map(c => Number(c.chainId)),
	], [customChainDefs])

	const chartData = useMemo<DonutChartItem[]>(() => allChains
		.map((chain) => {
			const bal = balances.get(chain.id)
			return { name: chain.coin, value: bal?.balanceUsd || 0, color: chain.color, chainId: chain.id }
		})
		.filter((d) => d.value > 0)
		.sort((a, b) => b.value - a.value), [allChains, balances])

	const hasAnyBalance = chartData.length > 0

	const sortedChains = useMemo(() => [...allChains].sort((a, b) => {
		const aUsd = balances.get(a.id)?.balanceUsd || 0
		const bUsd = balances.get(b.id)?.balanceUsd || 0
		const aHas = aUsd > 0 || parseFloat(balances.get(a.id)?.balance || '0') > 0
		const bHas = bUsd > 0 || parseFloat(balances.get(b.id)?.balance || '0') > 0
		if (aHas && !bHas) return -1
		if (!aHas && bHas) return 1
		if (aHas && bHas) return bUsd - aUsd
		return 0
	}), [allChains, balances])

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return <AssetPage chain={selectedChain} balance={bal} onBack={() => setSelectedChain(null)} />
	}

	return (
		<Box w="100%" maxW="600px" mx="auto" pt="2">
			{/* Watch-only banner */}
			{watchOnly && (
				<Flex
					align="center"
					justify="center"
					gap="2"
					mb="3"
					px="3"
					py="2"
					bg="rgba(255,215,0,0.08)"
					border="1px solid"
					borderColor="rgba(255,215,0,0.2)"
					borderRadius="lg"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
						<circle cx="12" cy="12" r="3" />
					</svg>
					<Text fontSize="xs" color="kk.gold" fontWeight="500">
						{t("watchOnlyBanner")}
					</Text>
				</Flex>
			)}

			{/* Portfolio Chart — or Welcome placeholder for empty wallets */}
			{hasAnyBalance ? (
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
			) : !loadingBalances && initialLoaded && (
				<Box
					w="100%"
					p="5"
					mb="5"
					borderRadius="xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor="rgba(192,168,96,0.2)"
				>
					<Flex direction="column" align="center" gap="3" textAlign="center">
						{/* Shield / vault icon */}
						<Box
							w="56px"
							h="56px"
							borderRadius="full"
							bg="rgba(192,168,96,0.1)"
							display="flex"
							alignItems="center"
							justifyContent="center"
						>
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
								<path d="M9 12l2 2 4-4" />
							</svg>
						</Box>

						<Box>
							<Text fontSize="md" fontWeight="600" color="white" mb="1">
								{t("welcomeTitle", { defaultValue: "Welcome to KeepKey Vault" })}
							</Text>
							<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.5">
								{t("welcomeSubtitle", { defaultValue: "Your wallet is ready. Here's how to get started:" })}
							</Text>
						</Box>

						<Flex direction="column" gap="2" w="100%" maxW="340px" mt="1">
							<Flex align="flex-start" gap="2.5" textAlign="left">
								<Text fontSize="sm" mt="0.5">1.</Text>
								<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.4">
									{t("welcomeTip1", { defaultValue: "Tap any chain below, then hit Receive to get your deposit address" })}
								</Text>
							</Flex>
							<Flex align="flex-start" gap="2.5" textAlign="left">
								<Text fontSize="sm" mt="0.5">2.</Text>
								<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.4">
									{t("welcomeTip2", { defaultValue: "Send crypto to your address — your balance will appear here automatically" })}
								</Text>
							</Flex>
							<Flex align="flex-start" gap="2.5" textAlign="left">
								<Text fontSize="sm" mt="0.5">3.</Text>
								<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.4">
									{t("welcomeTip3", { defaultValue: "Add custom EVM chains with the + card to track any network" })}
								</Text>
							</Flex>
						</Flex>
					</Flex>
				</Box>
			)}

			{/* Section Header + Chain Grid */}
			<Flex align="center" justify="space-between" mb="3" px="1">
				<Text fontSize="xs" fontWeight="600" color="kk.textSecondary" textTransform="uppercase" letterSpacing="0.05em">
					{t("supportedChains")}
				</Text>
				<HStack gap="2">
					{loadingBalances && hasAnyBalance && <Spinner size="xs" color="kk.gold" />}
					<Text fontSize="xs" color="kk.textMuted">{t("networksCount", { count: allChains.length })}</Text>
					<IconButton
						aria-label={watchOnly ? t("connectDeviceToRefresh") : t("refreshBalances")}
						size="xs"
						variant="ghost"
						color="kk.gold"
						_hover={watchOnly ? {} : { color: "white", bg: "rgba(255,215,0,0.15)" }}
						onClick={watchOnly ? undefined : refreshBalances}
						disabled={loadingBalances || watchOnly}
						opacity={watchOnly ? 0.4 : 1}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
					const tokenCount = bal?.tokens?.length || 0

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
											<AnimatedUsd value={usdNum} fontSize="11px" color="white" fontWeight="500" lineHeight="1.3" />
										)}
										{tokenCount > 0 && (
											<Text fontSize="10px" color={chain.color} fontWeight="600" lineHeight="1.3" mt="0.5">
												{t("tokensCount", { count: tokenCount })}
											</Text>
										)}
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
							bg: "rgba(255,215,0,0.05)",
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
		</Box>
	)
}
