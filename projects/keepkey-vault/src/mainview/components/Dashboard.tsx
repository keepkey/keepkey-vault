import { Component, useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type ErrorInfo } from "react"
import { Box, Flex, Text, Spinner, Image, SimpleGrid, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { CHAINS, customChainToChainDef, isChainSupported, type ChainDef } from "../../shared/chains"
import { versionCompare } from "../../shared/firmware-versions"
import { formatBalance } from "../lib/formatting"
import { AnimatedUsd } from "./AnimatedUsd"
import { getAssetIcon, registerCustomAsset } from "../../shared/assetLookup"
import { AssetPage } from "./AssetPage"
import { DonutChart, ChartLegend, type DonutChartItem } from "./DonutChart"
import { AddChainDialog } from "./AddChainDialog"
import { ReportDialog } from "./ReportDialog"
import { Bip85VaultDialog } from "./Bip85VaultDialog"

import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { categorizeTokens } from "../../shared/spamFilter"
import type { ChainBalance, CustomChain, TokenVisibilityStatus, AppSettings } from "../../shared/types"
import { playChaChing } from "../lib/sounds"

/** Error boundary wrapping AssetPage — ensures user can always go back to Dashboard */
class AssetPageErrorBoundary extends Component<
	{ children: ReactNode; onBack: () => void; chainName: string },
	{ hasError: boolean; error: Error | null }
> {
	state: { hasError: boolean; error: Error | null } = { hasError: false, error: null }
	static getDerivedStateFromError(error: Error) { return { hasError: true, error } }
	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error('[AssetPageErrorBoundary]', error, info)
	}
	render() {
		if (this.state.hasError) {
			return (
				<Flex direction="column" align="center" justify="center" gap="4" py="12" px="6" minH="300px">
					<Text fontSize="lg" fontWeight="600" color="red.400">
						Failed to load {this.props.chainName}
					</Text>
					<Text fontSize="sm" color="kk.textMuted" textAlign="center" maxW="440px">
						{this.state.error?.message || 'An unexpected error occurred while loading this asset page.'}
					</Text>
					<Flex gap="3">
						<Button
							size="sm"
							variant="ghost"
							color="kk.gold"
							onClick={() => this.setState({ hasError: false, error: null })}
						>
							Try Again
						</Button>
						<Button
							size="sm"
							variant="ghost"
							color="kk.textSecondary"
							_hover={{ color: "white" }}
							onClick={this.props.onBack}
						>
							&larr; Back to Dashboard
						</Button>
					</Flex>
				</Flex>
			)
		}
		return this.props.children
	}
}

const DASHBOARD_ANIMATIONS = `
	@keyframes pulseGold {
		0%, 100% { box-shadow: 0 0 12px rgba(233,196,106,0.4); }
		50% { box-shadow: 0 0 24px rgba(233,196,106,0.7); }
	}
	@keyframes glowCta {
		0% { box-shadow: 0 0 8px rgba(233,196,106,0.3), 0 0 20px rgba(233,196,106,0.1); }
		50% { box-shadow: 0 0 16px rgba(233,196,106,0.5), 0 0 40px rgba(233,196,106,0.2); }
		100% { box-shadow: 0 0 8px rgba(233,196,106,0.3), 0 0 20px rgba(233,196,106,0.1); }
	}
	@keyframes v3-spin {
		from { transform: rotate(0deg); }
		to   { transform: rotate(360deg); }
	}
`

/* localStorage key for user's preferred portfolio view. */
const DASHBOARD_VIEW_KEY = 'keepkey.dashboard.view'
type DashboardView = 'orbital' | 'donut'
function readSavedView(): DashboardView {
	try {
		const v = localStorage.getItem(DASHBOARD_VIEW_KEY)
		return v === 'donut' ? 'donut' : 'orbital'
	} catch { return 'orbital' }
}

/** Orbital portfolio view — chain logos placed on a slowly rotating ring
 *  around a center total. Ported from the design handoff (balances.jsx
 *  OrbitalView) with vault tokens. Logos sized by sqrt(usd) so a
 *  $10k chain isn't 1000× the diameter of a $10 chain — the ring still
 *  reads even when one wallet dominates. */
function OrbitalView({
	chains,
	balances,
	cleanBalanceUsd,
	totalUsd,
	totalDollars,
	totalCents,
	cleanTokenTotal,
	onSelect,
}: {
	chains: ChainDef[]
	balances: Map<string, ChainBalance>
	cleanBalanceUsd: Map<string, { usd: number; cleanTokenCount: number }>
	totalUsd: number
	totalDollars: number
	totalCents: string
	cleanTokenTotal: number
	onSelect: (c: ChainDef) => void
}) {
	const [hover, setHover] = useState<string | null>(null)
	const [size, setSize] = useState(440)

	useEffect(() => {
		const compute = () => setSize(Math.min(440, Math.max(280, window.innerWidth - 80)))
		compute()
		window.addEventListener('resize', compute)
		return () => window.removeEventListener('resize', compute)
	}, [])

	const cx = size / 2
	const cy = size / 2
	const orbitR = size * 0.42
	const ringR  = size * 0.46

	const orbitChains = chains
		.map(c => ({ chain: c, usd: cleanBalanceUsd.get(c.id)?.usd || 0, bal: balances.get(c.id) }))
		.filter(x => x.usd > 0)
		.slice(0, 8)

	return (
		<Box position="relative" w={`${size}px`} h={`${size}px`} mx="auto" my="2">
			<svg width={size} height={size} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
				<defs>
					<radialGradient id="dashboardCoreGlow" cx="50%" cy="50%">
						<stop offset="0%" stopColor="rgba(233,196,106,0.18)" />
						<stop offset="55%" stopColor="rgba(139,227,196,0.05)" />
						<stop offset="100%" stopColor="transparent" />
					</radialGradient>
				</defs>
				<circle cx={cx} cy={cy} r={size * 0.5} fill="url(#dashboardCoreGlow)" />
				<circle
					cx={cx}
					cy={cy}
					r={ringR}
					fill="none"
					stroke="rgba(255,255,255,0.10)"
					strokeWidth="1"
					strokeDasharray="2 6"
					style={{
						transformOrigin: `${cx}px ${cy}px`,
						animation: 'v3-spin 90s linear infinite',
					}}
				/>
			</svg>

			{/* Center total */}
			<Box
				position="absolute"
				top="50%"
				left="50%"
				transform="translate(-50%, -50%)"
				textAlign="center"
				w="60%"
				pointerEvents="none"
			>
				<Text
					fontSize="10px"
					color="var(--text-3)"
					letterSpacing="0.20em"
					textTransform="uppercase"
					mb="2"
					fontWeight="500"
				>
					Total
				</Text>
				<Flex align="baseline" justify="center" gap="0">
					<Text
						fontSize={{ base: "38px", md: "48px" }}
						fontWeight="500"
						color="var(--text-0)"
						letterSpacing="-0.04em"
						lineHeight="1"
					>
						${totalDollars.toLocaleString()}
					</Text>
					<Text
						fontSize={{ base: "20px", md: "24px" }}
						fontWeight="400"
						color="var(--text-2)"
						letterSpacing="-0.02em"
						lineHeight="1"
						ml="1"
					>
						.{totalCents}
					</Text>
				</Flex>
				<Text
					fontSize="10px"
					color="var(--text-3)"
					letterSpacing="0.14em"
					textTransform="uppercase"
					mt="3"
					fontFamily="mono"
				>
					{chains.length} CHAINS
					{cleanTokenTotal > 0 && ` · ${cleanTokenTotal} ASSETS`}
				</Text>
			</Box>

			{/* Satellite chains */}
			{orbitChains.map(({ chain, usd, bal }, i) => {
				const angle = (Math.PI * 2 * i) / orbitChains.length - Math.PI / 2
				const x = cx + Math.cos(angle) * orbitR
				const y = cy + Math.sin(angle) * orbitR
				const sat = Math.max(40, Math.min(72, 30 + Math.sqrt(usd) * 1.4))
				const isHover = hover === chain.id
				const pct = totalUsd > 0 ? (usd / totalUsd) * 100 : 0
				return (
					<Box
						key={chain.id}
						as="button"
						onMouseEnter={() => setHover(chain.id)}
						onMouseLeave={() => setHover(null)}
						onClick={() => onSelect(chain)}
						position="absolute"
						left={`${x - sat / 2}px`}
						top={`${y - sat / 2}px`}
						w={`${sat}px`}
						h={`${sat}px`}
						borderRadius="full"
						bg="transparent"
						border="0"
						p={0}
						display="grid"
						placeItems="center"
						transition="all 0.3s cubic-bezier(0.2,0.8,0.2,1)"
						transform={isHover ? 'scale(1.12)' : 'scale(1)'}
						filter={isHover
							? `drop-shadow(0 0 24px ${chain.color})`
							: 'drop-shadow(0 4px 14px rgba(0,0,0,0.55))'}
						zIndex={isHover ? 10 : 1}
						cursor="pointer"
						aria-label={chain.coin}
					>
						<Image
							src={getAssetIcon(chain.caip)}
							alt={chain.symbol}
							w="100%"
							h="100%"
							borderRadius="full"
							bg="var(--ink-2)"
							boxShadow={`0 0 0 1px var(--line), 0 6px 18px -8px ${chain.color}`}
						/>
						{(bal?.tokens?.length ?? 0) > 0 && (
							<Box
								position="absolute"
								bottom="-4px"
								right="-4px"
								w="22px"
								h="22px"
								borderRadius="full"
								bg="var(--ink-3)"
								border="1px solid var(--line-2)"
								fontSize="10px"
								fontFamily="mono"
								color="var(--text-1)"
								display="grid"
								placeItems="center"
							>
								+{bal!.tokens!.length}
							</Box>
						)}
						{isHover && (
							<Box
								position="absolute"
								top="-58px"
								left="50%"
								transform="translateX(-50%)"
								bg="var(--ink-3)"
								border="1px solid rgba(255,255,255,0.10)"
								px="3"
								py="1.5"
								borderRadius="10px"
								whiteSpace="nowrap"
								boxShadow="0 8px 24px -8px rgba(0,0,0,0.6)"
								pointerEvents="none"
							>
								<Text fontSize="12px" fontWeight="600" color="var(--text-0)" textAlign="center">
									{chain.coin}
								</Text>
								<Text fontSize="11px" fontFamily="mono" color="var(--text-2)" textAlign="center">
									${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
									{totalUsd > 0 && ` · ${pct.toFixed(1)}%`}
								</Text>
							</Box>
						)}
					</Box>
				)
			})}
		</Box>
	)
}

interface PioneerError {
	message: string
	url: string
}

interface DashboardProps {
	onLoaded?: () => void
	watchOnly?: boolean
	/** When in watchOnly mode, load cached data for this specific device (defaults to latest) */
	watchOnlyDeviceId?: string
	onOpenSettings?: () => void
	firmwareVersion?: string
	/** When true (e.g. after OOB setup), skip stale cache and auto-refresh live balances */
	forceRefresh?: boolean
	/** Called after forceRefresh has been consumed (one-shot) — parent should clear the flag */
	onForceRefreshConsumed?: () => void
	/** True when using a hidden wallet — reports and some features are unavailable */
	isHiddenWallet?: boolean
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

export function Dashboard({ onLoaded, watchOnly, watchOnlyDeviceId, onOpenSettings, firmwareVersion, forceRefresh, onForceRefreshConsumed, isHiddenWallet }: DashboardProps) {
	const { t } = useTranslation("dashboard")
	const [selectedChain, setSelectedChain] = useState<ChainDef | null>(null)
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(new Map())
	const [loadingBalances, setLoadingBalances] = useState(false)
	const [initialLoaded, setInitialLoaded] = useState(false)
	const [activeSliceIndex, setActiveSliceIndex] = useState<number | null>(0)
	const [customChainDefs, setCustomChainDefs] = useState<ChainDef[]>([])
	const [showAddChain, setShowAddChain] = useState(false)
	const [showReports, setShowReports] = useState(false)
	const [showBip85, setShowBip85] = useState(false)
	const [bip85Enabled, setBip85Enabled] = useState(false)
	const [zcashEnabled, setZcashEnabled] = useState(false)
	const [pioneerError, setPioneerError] = useState<PioneerError | null>(null)
	const [cacheUpdatedAt, setCacheUpdatedAt] = useState<number | null>(null)
	const [tokenWarning, setTokenWarning] = useState(false)
	const [hasEverRefreshed, setHasEverRefreshed] = useState(false)
	const [visibilityMap, setVisibilityMap] = useState<Record<string, TokenVisibilityStatus>>({})

	// Load token visibility overrides (for spam filtering). Refetch on
	// `token-visibility-changed` push so a "mark as scam" action in
	// AssetPage immediately removes the spam USD from the dashboard total
	// (and a "mark as safe" puts it back). Without this subscription, the
	// initial on-mount snapshot would persist and the dashboard would keep
	// showing the spam balance until full reload.
	useEffect(() => {
		const refetch = () => {
			rpcRequest<Record<string, TokenVisibilityStatus>>('getTokenVisibilityMap', undefined, 5000)
				.then(setVisibilityMap)
				.catch(() => {})
		}
		refetch()
		return onRpcMessage('token-visibility-changed', refetch)
	}, [])

	// Load feature flags (re-check when settings change)
	const refreshFeatureFlags = useCallback(() => {
		rpcRequest<AppSettings>('getAppSettings', undefined, 5000)
			.then(s => {
				setBip85Enabled(s.bip85Enabled)
				setZcashEnabled(s.zcashPrivacyEnabled)
			})
			.catch(() => {})
	}, [])

	useEffect(() => { refreshFeatureFlags() }, [refreshFeatureFlags])

	useEffect(() => {
		window.addEventListener('keepkey-settings-changed', refreshFeatureFlags)
		return () => window.removeEventListener('keepkey-settings-changed', refreshFeatureFlags)
	}, [refreshFeatureFlags])

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
	// When forceRefresh (e.g. new seed after OOB setup), skip stale cache entirely.
	useEffect(() => {
		let cancelled = false

		async function loadCached() {
			let needsAutoRefresh = false

			if (watchOnly) {
				try {
					const result = await rpcRequest<ChainBalance[] | null>('getWatchOnlyBalances', watchOnlyDeviceId ? { deviceId: watchOnlyDeviceId } : undefined, 5000)
					if (!cancelled && result && result.length > 0) {
						const map = new Map<string, ChainBalance>()
						for (const b of result) map.set(b.chainId, b)
						setBalances(map)
					}
				} catch { /* watch-only cache unavailable */ }
				if (!cancelled) { setInitialLoaded(true); onLoaded?.() }
				return
			}

			// New seed: cache belongs to the old seed — skip it
			if (!forceRefresh) {
				try {
					const cached = await rpcRequest<{ balances: ChainBalance[]; updatedAt: number; staleReasons?: string[] } | null>('getCachedBalances', undefined, 3000)
					if (!cancelled && cached && cached.balances.length > 0) {
						const map = new Map<string, ChainBalance>()
						for (const b of cached.balances) map.set(b.chainId, b)
						setBalances(map)
						setCacheUpdatedAt(cached.updatedAt)
						console.log(`[Dashboard] Cache hit: ${cached.balances.length} chains, $${cached.balances.reduce((s, b) => s + (b.balanceUsd || 0), 0).toFixed(2)}, age: ${formatTimeAgo(cached.updatedAt, t)}`)
						if (cached.staleReasons && cached.staleReasons.length > 0) {
							console.log(`[Dashboard] Cache incomplete (${cached.staleReasons.join(', ')}) — will auto-refresh`)
							needsAutoRefresh = true
						}
					} else {
						// Empty cache — passphrase wallets intentionally skip DB writes,
						// and first-run devices also have no cache. Auto-refresh live.
						console.log('[Dashboard] Cache empty — will auto-refresh live balances')
						needsAutoRefresh = true
					}
				} catch {
					// Cache unavailable — still trigger a live fetch
					needsAutoRefresh = true
				}
			} else {
				console.log('[Dashboard] forceRefresh: skipping stale cache (new seed detected)')
			}

			if (!cancelled) {
				setInitialLoaded(true)
				onLoaded?.()
				// Auto-refresh in background when cache is empty or incomplete
				if (needsAutoRefresh) refreshBalances()
			}
		}

		loadCached()
		return () => { cancelled = true }
	}, [watchOnly, watchOnlyDeviceId, forceRefresh])

	// One-shot price refresh: update cached USD values with fresh market prices on load/navigate.
	// Does NOT re-fetch balances from Pioneer — only reprices existing cached amounts.
	const priceRefreshedRef = useRef(false)
	useEffect(() => {
		if (!initialLoaded || balances.size === 0 || watchOnly || loadingBalances) return
		if (priceRefreshedRef.current) return
		priceRefreshedRef.current = true

		const allChains = [...CHAINS, ...customChainDefs].filter(c => !c.hidden)
		const chainsWithBalance = allChains.filter(c => {
			const bal = balances.get(c.id)
			return bal && parseFloat(bal.balance || '0') > 0
		})
		if (chainsWithBalance.length === 0) return
		const caips = chainsWithBalance.map(c => c.caip).filter(Boolean)
		if (caips.length === 0) return

		let cancelled = false
		rpcRequest<any>('getMarketData', { caips }, 15000)
			.then(resp => {
				if (cancelled) return
				// resp.data is an array of USD prices in the same order as caips
				const prices: number[] = resp?.data || (Array.isArray(resp) ? resp : [])
				if (prices.length !== caips.length) return

				setBalances(prev => {
					const next = new Map(prev)
					let changed = false
					for (let i = 0; i < chainsWithBalance.length; i++) {
						const chain = chainsWithBalance[i]
						const freshPrice = prices[i]
						if (!freshPrice || freshPrice <= 0) continue
						const bal = next.get(chain.id)
						if (!bal) continue
						const amount = parseFloat(bal.balance || '0')
						if (amount <= 0) continue
						const newNativeUsd = amount * freshPrice
						const tokenUsd = bal.tokens?.reduce((s, t) => s + (t.balanceUsd || 0), 0) || 0
						const updated = { ...bal, nativeBalanceUsd: newNativeUsd, balanceUsd: newNativeUsd + tokenUsd }
						next.set(chain.id, updated)
						changed = true
					}
					return changed ? next : prev
				})
				console.log(`[Dashboard] Price refresh: ${prices.length} prices updated`)
			})
			.catch(() => { /* price refresh is best-effort */ })

		return () => { cancelled = true }
	}) // runs on every render but ref-gated to fire once

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
				// DEBUG: dump token data that arrived via RPC
				for (const b of result) {
					if (b.tokens && b.tokens.length > 0) {
						console.log(`[Dashboard:rpc-tokens] ${b.chainId}: ${b.tokens.length} tokens`)
						for (const t of b.tokens.slice(0, 3)) {
							console.log(`  ${t.symbol}: balanceUsd=${t.balanceUsd}, priceUsd=${t.priceUsd}, balance=${t.balance}, caip=${t.caip?.substring(0, 40)}`)
						}
					}
				}
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

	// Auto-refresh after new seed (OOB setup) — one-shot, then clear the flag
	useEffect(() => {
		if (forceRefresh && initialLoaded && !hasEverRefreshed && !loadingBalances) {
			console.log('[Dashboard] New seed detected — auto-refreshing balances (one-shot)')
			refreshBalances()
			onForceRefreshConsumed?.()
		}
	}, [forceRefresh, initialLoaded, hasEverRefreshed, loadingBalances, refreshBalances, onForceRefreshConsumed])

	// Auto-refresh balances when a swap completes (both chains affected)
	useEffect(() => {
		const handler = () => {
			console.log('[Dashboard] Swap completed — refreshing balances')
			refreshBalances()
		}
		window.addEventListener('keepkey-swap-completed', handler)
		return () => window.removeEventListener('keepkey-swap-completed', handler)
	}, [refreshBalances])

	// Live balance sync: merge single-chain updates from backend (e.g. AssetPage refresh)
	useEffect(() => {
		return onRpcMessage("balance-updated", (updated: ChainBalance) => {
			setBalances(prev => {
				const old = prev.get(updated.chainId)
				const oldUsd = old?.balanceUsd ?? 0
				const newUsd = updated.balanceUsd ?? 0
				// Cha-ching when balance increased
				if (newUsd > oldUsd && oldUsd > 0) {
					playChaChing()
				}
				const next = new Map(prev)
				next.set(updated.chainId, updated)
				return next
			})
			setCacheUpdatedAt(Date.now())
		})
	}, [])

	const cleanBalanceUsd = useMemo(() => {
		const overrides = new Map(
			Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const),
		)
		const result = new Map<string, { usd: number; cleanTokenCount: number }>()
		for (const [chainId, bal] of balances) {
			if (bal.tokens && bal.tokens.length > 0) {
				const { clean } = categorizeTokens(bal.tokens, overrides)
				const spamUsd = (bal.tokens.length - clean.length) > 0
					? bal.tokens.reduce((s, t) => s + (t.balanceUsd || 0), 0) - clean.reduce((s, t) => s + (t.balanceUsd || 0), 0)
					: 0
				result.set(chainId, {
					usd: (bal.balanceUsd || 0) - spamUsd,
					cleanTokenCount: clean.length,
				})
			} else {
				result.set(chainId, { usd: bal.balanceUsd || 0, cleanTokenCount: 0 })
			}
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

	/* Portfolio view mode — orbital is the new default per design handoff,
	 * donut is preserved as a toggle so power users can still get the
	 * percentage-bar legend. Persisted to localStorage. */
	const [viewMode, setViewMode] = useState<DashboardView>(readSavedView)
	useEffect(() => {
		try { localStorage.setItem(DASHBOARD_VIEW_KEY, viewMode) } catch { /* private mode etc. */ }
	}, [viewMode])

	/* Splits totalUsd into dollars + cents so the orbital can render the
	 * cents in a smaller weight (matches handoff layout). */
	const totalDollars = Math.floor(totalUsd)
	const totalCents = (totalUsd % 1).toFixed(2).slice(2) || '00'

	/* cleanTokenTotal — sum of non-spam tokens across all chains. Used for
	 * the "N CHAINS · M ASSETS" subtitle on the orbital. */
	const cleanTokenTotal = useMemo(() => {
		let n = 0
		for (const v of cleanBalanceUsd.values()) n += v.cleanTokenCount
		return n
	}, [cleanBalanceUsd])

	const visibleChains = useMemo(() => allChains.filter(c => {
		if (!isChainSupported(c, firmwareVersion)) return false
		// Zcash transparent is hidden by default — show when feature flag is on
		if (c.id === 'zcash') return zcashEnabled
		return !c.hidden
	}), [allChains, firmwareVersion, zcashEnabled])

	const sortedChains = useMemo(() => [...visibleChains].sort((a, b) => {
		const aUsd = cleanBalanceUsd.get(a.id)?.usd || 0
		const bUsd = cleanBalanceUsd.get(b.id)?.usd || 0
		const aHas = aUsd > 0 || parseFloat(balances.get(a.id)?.balance || '0') > 0
		const bHas = bUsd > 0 || parseFloat(balances.get(b.id)?.balance || '0') > 0
		if (aHas && !bHas) return -1
		if (!aHas && bHas) return 1
		if (aHas && bHas) return bUsd - aUsd
		return 0
	}), [visibleChains, balances, cleanBalanceUsd])

	// Is data stale? (loaded from cache but haven't refreshed yet this session)
	const isStale = !hasEverRefreshed && !loadingBalances

	// Show big CTA when last check is older than 24 hours
	const cacheOlderThanDay = !loadingBalances && !watchOnly && initialLoaded && (
		!cacheUpdatedAt || (Date.now() - cacheUpdatedAt > 86_400_000)
	)

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return (
			<AssetPageErrorBoundary onBack={() => setSelectedChain(null)} chainName={selectedChain.coin}>
				<AssetPage chain={selectedChain} balance={bal} onBack={() => setSelectedChain(null)} firmwareVersion={firmwareVersion} />
			</AssetPageErrorBoundary>
		)
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
					bg="rgba(233,196,106,0.08)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.2)"
					borderRadius="lg"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
					bg="rgba(224,140,123,0.08)"
					border="1px solid"
					borderColor="rgba(224,140,123,0.3)"
					borderRadius="lg"
				>
					<Flex direction="column" gap="2">
						<Flex align="center" gap="2">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<circle cx="12" cy="12" r="10" />
								<line x1="12" y1="8" x2="12" y2="12" />
								<line x1="12" y1="16" x2="12.01" y2="16" />
							</svg>
							<Text fontSize="sm" fontWeight="600" color="var(--rose)">
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
									bg="rgba(233,196,106,0.2)"
									border="1px solid"
									borderColor="kk.gold"
									borderRadius="md"
									cursor="pointer"
									_hover={{ bg: "rgba(233,196,106,0.35)" }}
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
								onClick={() => rpcRequest('openUrl', { url: "https://support.keepkey.com" }).catch((e: any) => console.warn('[openUrl]', e?.message))}
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
					bg="rgba(233,196,106,0.08)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.3)"
					borderRadius="lg"
				>
					<Flex align="center" gap="2" mb="1">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
							<line x1="12" y1="9" x2="12" y2="13" />
							<line x1="12" y1="17" x2="12.01" y2="17" />
						</svg>
						<Text fontSize="xs" fontWeight="600" color="var(--gold)">
							{t("tokenWarningTitle")}
						</Text>
					</Flex>
					<Text fontSize="xs" color="kk.textSecondary" lineHeight="1.4">
						{t("tokenWarningDesc")}
					</Text>
				</Box>
			)}

			{/* Portfolio view — orbital (default) or donut, switchable via the
			    pill toggle in the top-right of the card. */}
			{hasAnyBalance ? (
				<Box
					w="100%"
					p="4"
					mb="2"
					borderRadius="xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor="kk.border"
					position="relative"
				>
					{/* View toggle — orbital / donut. Two-state pill with icon glyphs. */}
					<Flex
						position="absolute"
						top="3"
						right="3"
						bg="rgba(255,255,255,0.04)"
						border="1px solid"
						borderColor="kk.border"
						borderRadius="999px"
						p="1"
						gap="1"
						zIndex={2}
					>
						<Box
							as="button"
							onClick={() => setViewMode('orbital')}
							w="26px" h="22px"
							borderRadius="999px"
							display="flex" alignItems="center" justifyContent="center"
							bg={viewMode === 'orbital' ? 'rgba(233,196,106,0.18)' : 'transparent'}
							color={viewMode === 'orbital' ? 'var(--gold)' : 'var(--text-3)'}
							_hover={{ color: 'var(--text-1)' }}
							transition="all 0.15s"
							cursor="pointer"
							title="Orbital view"
						>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<circle cx="12" cy="12" r="9" strokeDasharray="2 3"/>
								<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>
								<circle cx="21" cy="12" r="2.2" fill="currentColor" stroke="none"/>
								<circle cx="3" cy="12" r="1.6" fill="currentColor" stroke="none"/>
							</svg>
						</Box>
						<Box
							as="button"
							onClick={() => setViewMode('donut')}
							w="26px" h="22px"
							borderRadius="999px"
							display="flex" alignItems="center" justifyContent="center"
							bg={viewMode === 'donut' ? 'rgba(233,196,106,0.18)' : 'transparent'}
							color={viewMode === 'donut' ? 'var(--gold)' : 'var(--text-3)'}
							_hover={{ color: 'var(--text-1)' }}
							transition="all 0.15s"
							cursor="pointer"
							title="Donut view"
						>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<circle cx="12" cy="12" r="9"/>
								<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>
							</svg>
						</Box>
					</Flex>

					{viewMode === 'orbital' ? (
						<OrbitalView
							chains={visibleChains}
							balances={balances}
							cleanBalanceUsd={cleanBalanceUsd}
							totalUsd={totalUsd}
							totalDollars={totalDollars}
							totalCents={totalCents}
							cleanTokenTotal={cleanTokenTotal}
							onSelect={(c) => setSelectedChain(c)}
						/>
					) : (
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
					)}
				</Box>
			) : !loadingBalances && initialLoaded && (
				<Box
					w="100%"
					p="5"
					mb="5"
					borderRadius="xl"
					bg="kk.cardBg"
					border="1px solid"
					borderColor="rgba(233,196,106,0.2)"
				>
					<Flex direction="column" align="center" gap="3" textAlign="center">
						{/* Shield / vault icon */}
						<Box
							w="56px"
							h="56px"
							borderRadius="full"
							bg="rgba(233,196,106,0.1)"
							display="flex"
							alignItems="center"
							justifyContent="center"
						>
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
						</Flex>
					</Flex>
				</Box>
			)}

			{/* Refresh + Reports buttons — below chart */}
			{!watchOnly && (
				<Flex justify="center" gap="3" mb="4">
					{!isHiddenWallet && <Box
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
						_hover={{ color: "white", bg: "rgba(233,196,106,0.12)" }}
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
					</Box>}
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
							bg: "rgba(233,196,106,0.12)",
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
											if (age < 3_600_000) return "var(--teal)"
											if (age < 86_400_000) return "var(--gold)"
											return "var(--rose)"
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

			{/* Big glowing CTA when balances haven't been checked in over a day */}
			{cacheOlderThanDay && (
				<Box
					as="button"
					w="100%"
					mb="4"
					px="5"
					py="4"
					bg="rgba(233,196,106,0.08)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.35)"
					borderRadius="xl"
					cursor="pointer"
					transition="all 0.3s ease-out"
					css={{ animation: "glowCta 3s ease-in-out infinite" }}
					_hover={{
						bg: "rgba(233,196,106,0.15)",
						borderColor: "kk.gold",
						transform: "scale(1.02)",
						boxShadow: "0 0 24px rgba(233,196,106,0.5), 0 0 48px rgba(233,196,106,0.2)",
					}}
					_active={{ transform: "scale(0.98)", transition: "transform 0.1s" }}
					onClick={refreshBalances}
				>
					<Flex align="center" justify="center" gap="3">
						<Box
							w="40px"
							h="40px"
							borderRadius="full"
							bg="rgba(233,196,106,0.15)"
							display="flex"
							alignItems="center"
							justifyContent="center"
							flexShrink={0}
						>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
								<path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
							</svg>
						</Box>
						<Flex direction="column" align="flex-start">
							<Text fontSize="md" fontWeight="700" color="kk.gold" lineHeight="1.3">
								{t("staleCtaTitle")}
							</Text>
							<Text fontSize="xs" color="kk.textMuted" lineHeight="1.3">
								{cacheUpdatedAt
									? t("staleCtaSubtitle", { time: formatTimeAgo(cacheUpdatedAt, t) })
									: t("lastUpdatedNever")}
							</Text>
						</Flex>
					</Flex>
				</Box>
			)}

		<SimpleGrid columns={{ base: 2, sm: 3 }} gap="2.5">
				{sortedChains.map((chain) => {
					const bal = balances.get(chain.id)
					const clean = cleanBalanceUsd.get(chain.id)
					const balNum = parseFloat(bal?.balance || '0')
					const usdNum = clean?.usd || 0
					const hasBalance = balNum > 0 || usdNum > 0
					const tokenCount = clean?.cleanTokenCount || 0

					// Low-gas warning: EVM chain with < $1 native but > $1 in tokens
					const nativeUsd = bal?.nativeBalanceUsd ?? 0
					const tokenUsd = usdNum - nativeUsd
					const lowGas = chain.chainFamily === 'evm' && nativeUsd < 1 && tokenUsd > 1

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
									<Box overflow="hidden" flex="1">
										<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2" truncate>
											{chain.coin}
										</Text>
										<Text fontSize="10px" color="kk.textMuted" lineHeight="1.2">
											{chain.symbol}
										</Text>
									</Box>
									{lowGas && (
										<Flex
											direction="column"
											align="center"
											title={`Low ${chain.symbol} for gas \u2014 you need ${chain.symbol} to send tokens on ${chain.coin}`}
											flexShrink={0}
											cursor="help"
											onClick={(e) => e.stopPropagation()}
										>
											<svg width="16" height="16" viewBox="0 0 24 24" fill="#E53E3E" xmlns="http://www.w3.org/2000/svg">
												<path d="M3 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v9h1a3 3 0 0 1 3 3v3a1 1 0 0 0 2 0v-7.5l-2.4-2.4a1 1 0 0 1 1.4-1.4l3.3 3.3c.2.2.3.4.3.7V19a3 3 0 0 1-6 0v-3a1 1 0 0 0-1-1h-1v7H3zM7 6h4v5H7V6z"/>
											</svg>
											<Text fontSize="8px" fontWeight="700" color="#E53E3E" lineHeight="1" mt="1">LOW GAS</Text>
										</Flex>
									)}
								</Flex>

								{bal ? (
									<Box>
										<Text fontSize="xs" fontFamily="mono" fontWeight="500" color={isStale ? "kk.textMuted" : "white"} lineHeight="1.3" truncate>
											{formatBalance(bal.balance)} {chain.symbol}
										</Text>
										{usdNum > 0 && (
											<AnimatedUsd value={usdNum} fontSize="11px" color={isStale ? "kk.textMuted" : undefined} fontWeight="500" lineHeight="1.3" />
										)}
										{(() => {
											// Zcash gets a special "+ shielded" sub-row instead of generic token count.
											// The shielded balance is appended as a synthetic token with type:'shielded'
											// in getBalances; surface it explicitly so users see the private balance.
											const shielded = bal.tokens?.find(tk => tk.type === 'shielded')
											const otherTokens = bal.tokens?.filter(tk => tk.type !== 'shielded') ?? []
											return (
												<>
													{shielded && parseFloat(shielded.balance || '0') > 0 && (
														<Flex align="center" gap="1" mt="0.5" title="Shielded (Orchard) balance — visible only to you">
															<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={chain.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
																<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
															</svg>
															<Text fontSize="10px" fontFamily="mono" color={chain.color} fontWeight="600" lineHeight="1.3" truncate>
																+ {formatBalance(shielded.balance)} private
															</Text>
														</Flex>
													)}
													{otherTokens.length > 0 && (
														<Text fontSize="10px" color={chain.color} fontWeight="600" lineHeight="1.3" mt="0.5">
															{t("tokensCount", { count: otherTokens.length })}
														</Text>
													)}
												</>
											)
										})()}
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
							bg: "rgba(233,196,106,0.05)",
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

			{showBip85 && (
				<Bip85VaultDialog onClose={() => setShowBip85(false)} />
			)}

			{/* BIP-85 lock icon — bottom right (only when feature enabled AND firmware >= 7.15.0) */}
			{bip85Enabled && !watchOnly && firmwareVersion && versionCompare(firmwareVersion, '7.15.0') >= 0 && (
				<Box
					as="button"
					position="fixed"
					bottom="24px"
					right="24px"
					w="52px"
					h="52px"
					borderRadius="full"
					bg="rgba(233,196,106,0.15)"
					border="1px solid"
					borderColor="rgba(233,196,106,0.3)"
					display="flex"
					alignItems="center"
					justifyContent="center"
					cursor="pointer"
					transition="all 0.2s"
					_hover={{
						bg: "rgba(233,196,106,0.25)",
						borderColor: "kk.gold",
						transform: "scale(1.08)",
						boxShadow: "0 0 20px rgba(233,196,106,0.3)",
					}}
					_active={{ transform: "scale(0.95)" }}
					onClick={() => setShowBip85(true)}
					zIndex={10}
					title="BIP-85 Seed Vault"
				>
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
						<path d="M7 11V7a5 5 0 0 1 10 0v4" />
					</svg>
				</Box>
			)}
		</Box>
	)
}
