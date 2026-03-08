import { useState, useEffect, useCallback, useMemo } from "react"
import { Box, Flex, Text, Spinner, Image, SimpleGrid } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { CHAINS, customChainToChainDef, type ChainDef } from "../../shared/chains"
import { formatBalance } from "../lib/formatting"
import { AnimatedUsd } from "./AnimatedUsd"
import { getAssetIcon, registerCustomAsset } from "../../shared/assetLookup"
import { AssetPage } from "./AssetPage"
import { DonutChart, ChartLegend, type DonutChartItem } from "./DonutChart"
import { AddChainDialog } from "./AddChainDialog"
import { ReportDialog } from "./ReportDialog"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { categorizeTokens } from "../../shared/spamFilter"
import type { ChainBalance, CustomChain, TokenVisibilityStatus } from "../../shared/types"

const DASHBOARD_ANIMATIONS = `
	@keyframes pulseGold {
		0%, 100% { box-shadow: 0 0 12px rgba(192,168,96,0.4); }
		50% { box-shadow: 0 0 24px rgba(192,168,96,0.7); }
	}
`

interface PioneerError {
	message: string
	url: string
}

interface DashboardProps {
	onLoaded?: () => void
	watchOnly?: boolean
	onOpenSettings?: () => void
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

export function Dashboard({ onLoaded, watchOnly, onOpenSettings }: DashboardProps) {
	const { t } = useTranslation("dashboard")
	const [selectedChain, setSelectedChain] = useState<ChainDef | null>(null)
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(new Map())
	const [loadingBalances, setLoadingBalances] = useState(false)
	const [initialLoaded, setInitialLoaded] = useState(false)
	const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(0)
	const [customChainDefs, setCustomChainDefs] = useState<ChainDef[]>([])
	const [showAddChain, setShowAddChain] = useState(false)
	const [showReports, setShowReports] = useState(false)
	const [pioneerError, setPioneerError] = useState<PioneerError | null>(null)
	const [cacheUpdatedAt, setCacheUpdatedAt] = useState<number | null>(null)
	const [tokenWarning, setTokenWarning] = useState(false)
	const [hasEverRefreshed, setHasEverRefreshed] = useState(false)
	const [visibilityMap, setVisibilityMap] = useState<Record<string, TokenVisibilityStatus>>({})

	// Load token visibility overrides (for spam filtering)
	useEffect(() => {
		rpcRequest<Record<string, TokenVisibilityStatus>>('getTokenVisibilityMap', undefined, 5000)
			.then(setVisibilityMap)
			.catch(() => {})
	}, [])

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
	useEffect(() => {
		let cancelled = false

		async function loadCached() {
			if (watchOnly) {
				// Watch-only still auto-fetches from cache
				try {
					const result = await rpcRequest<ChainBalance[] | null>('getWatchOnlyBalances', undefined, 5000)
					if (!cancelled && result && result.length > 0) {
						const map = new Map<string, ChainBalance>()
						for (const b of result) map.set(b.chainId, b)
						setBalances(map)
					}
				} catch { /* watch-only cache unavailable */ }
				if (!cancelled) {
					setInitialLoaded(true)
					onLoaded?.()
				}
				return
			}

			try {
				const cached = await rpcRequest<{ balances: ChainBalance[]; updatedAt: number } | null>('getCachedBalances', undefined, 3000)
				if (!cancelled && cached && cached.balances.length > 0) {
					const map = new Map<string, ChainBalance>()
					for (const b of cached.balances) map.set(b.chainId, b)
					setBalances(map)
					setCacheUpdatedAt(cached.updatedAt)
					console.log(`[Dashboard] Cache hit: ${cached.balances.length} chains, $${cached.balances.reduce((s, b) => s + (b.balanceUsd || 0), 0).toFixed(2)}, age: ${formatTimeAgo(cached.updatedAt, t)}`)
				}
			} catch { /* cache unavailable */ }

			if (!cancelled) {
				setInitialLoaded(true)
				onLoaded?.()
			}
		}

		loadCached()
		return () => { cancelled = true }
	}, [watchOnly])

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

	// Compute spam-filtered USD per chain: subtract spam token values from chain totals
	const cleanBalanceUsd = useMemo(() => {
		const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v]))
		const result = new Map<string, { usd: number; cleanTokenCount: number }>()
		for (const [chainId, bal] of balances) {
			if (!bal.tokens || bal.tokens.length === 0) {
				result.set(chainId, { usd: bal.balanceUsd || 0, cleanTokenCount: 0 })
				continue
			}
			const { spam } = categorizeTokens(bal.tokens, overrides)
			const spamUsd = spam.reduce((s, t) => s + (t.balanceUsd || 0), 0)
			const cleanTokens = (bal.tokens?.length || 0) - spam.length
			result.set(chainId, { usd: (bal.balanceUsd || 0) - spamUsd, cleanTokenCount: cleanTokens })
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

	const sortedChains = useMemo(() => [...allChains].sort((a, b) => {
		const aUsd = cleanBalanceUsd.get(a.id)?.usd || 0
		const bUsd = cleanBalanceUsd.get(b.id)?.usd || 0
		const aHas = aUsd > 0 || parseFloat(balances.get(a.id)?.balance || '0') > 0
		const bHas = bUsd > 0 || parseFloat(balances.get(b.id)?.balance || '0') > 0
		if (aHas && !bHas) return -1
		if (!aHas && bHas) return 1
		if (aHas && bHas) return bUsd - aUsd
		return 0
	}), [allChains, balances, cleanBalanceUsd])

	// Is data stale? (loaded from cache but haven't refreshed yet this session)
	const isStale = !hasEverRefreshed && !loadingBalances

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return <AssetPage chain={selectedChain} balance={bal} onBack={() => setSelectedChain(null)} />
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

			{/* Pioneer connection error banner */}
			{pioneerError && (
				<Box
					mb="3"
					px="4"
					py="3"
					bg="rgba(220,53,69,0.08)"
					border="1px solid"
					borderColor="rgba(220,53,69,0.3)"
					borderRadius="lg"
				>
					<Flex direction="column" gap="2">
						<Flex align="center" gap="2">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#DC3545" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<circle cx="12" cy="12" r="10" />
								<line x1="12" y1="8" x2="12" y2="12" />
								<line x1="12" y1="16" x2="12.01" y2="16" />
							</svg>
							<Text fontSize="sm" fontWeight="600" color="#DC3545">
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
									bg="rgba(192,168,96,0.2)"
									border="1px solid"
									borderColor="kk.gold"
									borderRadius="md"
									cursor="pointer"
									_hover={{ bg: "rgba(192,168,96,0.35)" }}
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
								onClick={() => window.open("https://support.keepkey.com", "_blank")}
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
					bg="rgba(255,165,0,0.08)"
					border="1px solid"
					borderColor="rgba(255,165,0,0.3)"
					borderRadius="lg"
				>
					<Flex align="center" gap="2" mb="1">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFA500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
							<line x1="12" y1="9" x2="12" y2="13" />
							<line x1="12" y1="17" x2="12.01" y2="17" />
						</svg>
						<Text fontSize="xs" fontWeight="600" color="#FFA500">
							{t("tokenWarningTitle")}
						</Text>
					</Flex>
					<Text fontSize="xs" color="kk.textSecondary" lineHeight="1.4">
						{t("tokenWarningDesc")}
					</Text>
				</Box>
			)}

			{/* Portfolio Chart — or Welcome placeholder for empty wallets */}
			{hasAnyBalance ? (
				<Box
					w="100%"
					p="4"
					mb="2"
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
							<Flex align="flex-start" gap="2.5" textAlign="left">
								<Text fontSize="sm" mt="0.5">3.</Text>
								<Text fontSize="sm" color="kk.textSecondary" lineHeight="1.4">
									{t("welcomeTip3")}
								</Text>
							</Flex>
						</Flex>
					</Flex>
				</Box>
			)}

			{/* Refresh + Reports buttons — below chart */}
			{!watchOnly && (
				<Flex justify="center" gap="3" mb="4">
					<Box
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
						_hover={{ color: "white", bg: "rgba(192,168,96,0.12)" }}
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
					</Box>
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
							bg: "rgba(192,168,96,0.12)",
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
											if (age < 3_600_000) return "#4ADE80"
											if (age < 86_400_000) return "#FBBF24"
											return "#F87171"
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

			<SimpleGrid columns={{ base: 2, sm: 3 }} gap="2.5">
				{sortedChains.map((chain) => {
					const bal = balances.get(chain.id)
					const clean = cleanBalanceUsd.get(chain.id)
					const balNum = parseFloat(bal?.balance || '0')
					const usdNum = clean?.usd || 0
					const hasBalance = balNum > 0 || usdNum > 0
					const tokenCount = clean?.cleanTokenCount || 0

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
										<Text fontSize="xs" fontFamily="mono" fontWeight="500" color={isStale ? "kk.textMuted" : "white"} lineHeight="1.3" truncate>
											{formatBalance(bal.balance)} {chain.symbol}
										</Text>
										{usdNum > 0 && (
											<AnimatedUsd value={usdNum} fontSize="11px" color={isStale ? "kk.textMuted" : "white"} fontWeight="500" lineHeight="1.3" />
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

			{showReports && (
				<ReportDialog onClose={() => setShowReports(false)} />
			)}
		</Box>
	)
}
