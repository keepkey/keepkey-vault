import { Component, Fragment, lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef, type ReactNode, type ErrorInfo } from "react"
import { Box, Flex, Text, Spinner, Image, SimpleGrid, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { CHAINS, customChainToChainDef, isChainSupported, type ChainDef } from "../../shared/chains"
import { versionCompare } from "../../shared/firmware-versions"
import { formatBalance } from "../lib/formatting"
import { AnimatedUsd } from "./AnimatedUsd"
import { getAssetIcon, registerCustomAsset } from "../../shared/assetLookup"
import { AssetPage } from "./AssetPage"
import { ActivityPage } from "./ActivityPage"
import { DonutChart, SelectedSlice, type DonutChartItem } from "./DonutChart"
import { AddChainDialog } from "./AddChainDialog"
import { ReportDialog } from "./ReportDialog"
import { Bip85VaultDialog } from "./Bip85VaultDialog"
import { DogeEasterEgg } from "./DogeEasterEgg"
import { HeatmapView, buildAllChainsTiles, buildChainDetailTiles } from "./HeatmapView"
import { StackedBarView, type StackedBarItem } from "./StackedBarView"

// SwapDialog is heavy (loads swapper providers) — lazy so it doesn't enter the
// initial Dashboard chunk. Used to open Swap directly from the action row
// without routing through AssetPage.
const LazySwapDialog = lazy(() => import("./SwapDialog").then(m => ({ default: m.SwapDialog })))

import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { subscribeVaultCommand, publishBalances, clearBalances } from "../lib/commandBus"
import { useIconColor } from "../lib/iconColor"
import { preloadIcons } from "../lib/iconPreload"
import { useDashboardView } from "../lib/dashboardViewContext"
import { useFiat } from "../lib/fiat-context"
import { ViewPickerButton } from "./ViewPickerMenu"
import { DashboardLoading } from "./DashboardLoading"
import { categorizeTokens } from "../../shared/spamFilter"
import { useBtcAccounts } from "../hooks/useBtcAccounts"
import { useEvmAddresses } from "../hooks/useEvmAddresses"
import type { ChainBalance, CustomChain, TokenVisibilityStatus, AppSettings, TokenBalance, PendingSwap, SwapStatusUpdate } from "../../shared/types"
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
	@keyframes pulseTeal {
		0%, 100% { opacity: 1; box-shadow: 0 0 4px rgba(80,200,120,0.6); }
		50% { opacity: 0.5; box-shadow: 0 0 8px rgba(80,200,120,0.9); }
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
	privateModeEnabled,
}: {
	chains: ChainDef[]
	balances: Map<string, ChainBalance>
	cleanBalanceUsd: Map<string, { usd: number; cleanTokenCount: number }>
	totalUsd: number
	totalDollars: number
	totalCents: string
	cleanTokenTotal: number
	onSelect: (c: ChainDef) => void
	privateModeEnabled: boolean
}) {
	const [hover, setHover] = useState<string | null>(null)
	const [size, setSize] = useState(540)

	useEffect(() => {
		const compute = () => {
			const w = window.innerWidth - 420 // minus sidebar
			const h = window.innerHeight - 220 // minus topnav + utility row
			setSize(Math.max(320, Math.min(640, w, h)))
		}
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
					{privateModeEnabled ? (
						<Text
							fontSize={{ base: "38px", md: "48px" }}
							fontWeight="500"
							color="var(--text-0)"
							letterSpacing="-0.04em"
							lineHeight="1"
						>
							••••••
						</Text>
					) : (
						<>
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
						</>
					)}
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
				// Flip the hover tip below the satellite when it's in the upper
				// half of the orbit so the TopNav doesn't clip it.
				const tipBelow = y < cy
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
								{...(tipBelow ? { bottom: "-58px" } : { top: "-58px" })}
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
								zIndex={20}
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

/** Single token satellite — separate component so each call site gets its own
 *  hook stack (useIconColor) keyed by the token icon. */
function TokenSatellite({
	tok,
	x,
	y,
	sat,
	isHover,
	tipBelow,
	fallbackColor,
	onEnter,
	onLeave,
	onClick,
}: {
	tok: import("../../shared/types").TokenBalance
	x: number
	y: number
	sat: number
	isHover: boolean
	tipBelow: boolean
	fallbackColor: string
	onEnter: () => void
	onLeave: () => void
	onClick: () => void
}) {
	const iconUrl = tok.icon || getAssetIcon(tok.caip)
	const glow = useIconColor(iconUrl, fallbackColor)
	const usd = tok.balanceUsd ?? 0
	return (
		<Box
			as="button"
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
			onClick={onClick}
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
			transform={isHover ? 'scale(1.15)' : 'scale(1)'}
			filter={isHover
				? `drop-shadow(0 0 24px ${glow})`
				: `drop-shadow(0 0 12px ${glow}66) drop-shadow(0 4px 14px rgba(0,0,0,0.55))`}
			zIndex={isHover ? 10 : 1}
			cursor="pointer"
			aria-label={tok.symbol}
		>
			<Image
				src={iconUrl}
				alt={tok.symbol}
				w="100%"
				h="100%"
				borderRadius="full"
				bg="var(--ink-2)"
				boxShadow={`0 0 0 1px var(--line), 0 6px 18px -8px ${glow}`}
			/>
			{isHover && (
				<Box
					position="absolute"
					{...(tipBelow ? { bottom: "-66px" } : { top: "-66px" })}
					left="50%"
					transform="translateX(-50%)"
					bg="var(--ink-3)"
					border={`1px solid ${glow}`}
					px="3"
					py="1.5"
					borderRadius="10px"
					whiteSpace="nowrap"
					boxShadow={`inset 0 0 0 1px ${glow}40, 0 8px 24px -8px ${glow}66, 0 8px 24px -8px rgba(0,0,0,0.6)`}
					pointerEvents="none"
					zIndex={20}
				>
					<Text fontSize="12px" fontWeight="600" color={glow === fallbackColor ? "var(--text-0)" : glow} textAlign="center">
						{tok.symbol}
					</Text>
					<Text fontSize="11px" color="var(--text-2)" textAlign="center">
						{formatBalance(tok.balance)} · ${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
					</Text>
				</Box>
			)}
		</Box>
	)
}

/** Heatmap canvas — fills the chart-slot height set by the Dashboard.
 *  When drilled (sharing space with the token list), caps at a smaller maxW
 *  for visual consistency with the other view modes. In All Chains view, the
 *  chart slot is full-pane so the heatmap expands wider too. */
function HeatmapHost({ tiles, drilled }: { tiles: Parameters<typeof HeatmapView>[0]["tiles"]; drilled: boolean }) {
	return (
		<Box w="100%" maxW={drilled ? "640px" : "1100px"} mx="auto" h="100%">
			<HeatmapView tiles={tiles} />
		</Box>
	)
}

/** Chain-detail orbital — chain icon as the sun, tokens orbiting as satellites.
 *  Shown when the user picks a chain from the sidebar list. */
function ChainDetailOrbital({
	chain,
	balance,
	nativeBalanceUsd,
	cleanTokens,
	onSelectChain,
	onSelectToken,
}: {
	chain: ChainDef
	balance?: ChainBalance
	nativeBalanceUsd: number
	cleanTokens: import("../../shared/types").TokenBalance[]
	onSelectChain: () => void
	onSelectToken: (tok: import("../../shared/types").TokenBalance) => void
}) {
	const [hover, setHover] = useState<string | null>(null)
	const [size, setSize] = useState(380)

	useEffect(() => {
		const compute = () => setSize(Math.min(380, Math.max(280, window.innerWidth - 420)))
		compute()
		window.addEventListener('resize', compute)
		return () => window.removeEventListener('resize', compute)
	}, [])

	const cx = size / 2
	const cy = size / 2
	const orbitR = size * 0.42
	const ringR  = size * 0.46

	const tokenSats = cleanTokens
		.slice()
		.sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0))
		.slice(0, 8)

	const nativeBal = balance?.balance || '0'

	return (
		<Box position="relative" w={`${size}px`} h={`${size}px`} mx="auto" my="2">
			<svg width={size} height={size} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
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

			{/* Center sun — chain icon + native balance */}
			<Box
				position="absolute"
				top="50%"
				left="50%"
				transform="translate(-50%, -50%)"
				w="70%"
				textAlign="center"
				display="flex"
				flexDirection="column"
				alignItems="center"
				gap="2"
			>
				<Box
					as="button"
					onClick={onSelectChain}
					w="96px"
					h="96px"
					borderRadius="full"
					bg="transparent"
					border="0"
					p={0}
					cursor="pointer"
					title={`Open ${chain.coin}`}
					transition="transform 0.2s"
					_hover={{ transform: 'scale(1.05)' }}
				>
					<Image
						src={getAssetIcon(chain.caip)}
						alt={chain.symbol}
						w="100%"
						h="100%"
						borderRadius="full"
						bg="var(--ink-2)"
						boxShadow={`0 0 0 1px var(--line), 0 0 70px -10px ${chain.color}, 0 8px 24px -8px rgba(0,0,0,0.6)`}
					/>
				</Box>
				<Text
					fontSize={{ base: "10px" }}
					color="var(--text-3)"
					letterSpacing="0.20em"
					textTransform="uppercase"
					fontWeight="500"
					mt="1"
				>
					{chain.coin}
				</Text>
				<Text
					fontSize={{ base: "26px", md: "32px" }}
					fontWeight="500"
					color="var(--text-0)"
					letterSpacing="-0.02em"
					lineHeight="1"
				>
					{formatBalance(nativeBal)} {chain.symbol}
				</Text>
				{nativeBalanceUsd > 0 && (
					<Text fontSize="13px" color="var(--text-2)" fontWeight="400">
						≈ ${nativeBalanceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
					</Text>
				)}
			</Box>

			{/* Token satellites — each pulls its glow color from its own icon. */}
			{tokenSats.map((tok, i) => {
				const angle = (Math.PI * 2 * i) / tokenSats.length - Math.PI / 2
				const x = cx + Math.cos(angle) * orbitR
				const y = cy + Math.sin(angle) * orbitR
				const usd = tok.balanceUsd ?? 0
				const sat = Math.max(40, Math.min(64, 32 + Math.sqrt(usd) * 1.2))
				const isHover = hover === tok.caip
				const tipBelow = y < cy
				return (
					<TokenSatellite
						key={tok.caip}
						tok={tok}
						x={x}
						y={y}
						sat={sat}
						isHover={isHover}
						tipBelow={tipBelow}
						fallbackColor={chain.color}
						onEnter={() => setHover(tok.caip)}
						onLeave={() => setHover(null)}
						onClick={() => onSelectToken(tok)}
					/>
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

const PIONEER_ERROR_GRACE_MS = 5 * 60 * 1000

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
	const [selectedChainAction, setSelectedChainAction] = useState<"send" | "receive" | "swap" | "privacy" | undefined>(undefined)
	const [selectedChainInitialToken, setSelectedChainInitialToken] = useState<TokenBalance | undefined>(undefined)
	const [showActivityPage, setShowActivityPage] = useState(false)
	const [activityDefaultChain, setActivityDefaultChain] = useState('')
	const [activityResumeSwap, setActivityResumeSwap] = useState<import('../../shared/types').PendingSwap | null>(null)
	const handleViewActivity = useCallback((chainId: string) => {
		setActivityDefaultChain(chainId)
		setShowActivityPage(true)
	}, [])
	// Listen for the global event dispatched by ActivityTracker's panel
	useEffect(() => {
		const handler = () => { setActivityDefaultChain(''); setShowActivityPage(true) }
		window.addEventListener('keepkey-open-activity', handler)
		return () => window.removeEventListener('keepkey-open-activity', handler)
	}, [])
	const [drilledChainId, setDrilledChainId] = useState<string | null>(null)
	const [swapDialogChain, setSwapDialogChain] = useState<ChainDef | null>(null)
	const openChainPage = useCallback((chain: ChainDef, action?: "send" | "receive" | "swap" | "privacy", token?: TokenBalance) => {
		// Swap routes directly to SwapDialog — skip the AssetPage shell that
		// would otherwise show the Receive view underneath.
		if (action === "swap") {
			setSwapDialogChain(chain)
			return
		}
		setSelectedChainAction(action)
		setSelectedChainInitialToken(token)
		setSelectedChain(chain)
	}, [])
	const [balances, setBalances] = useState<Map<string, ChainBalance>>(new Map())
	// Per-account (BTC) and per-address (EVM) balances for the sidebar account drop-down.
	// The Bun side already derives + tracks these; we only render what's already there.
	const { btcAccounts: btcAccountSet, selectXpub: btcSelectXpub } = useBtcAccounts()
	const { evmAddresses: evmAddressSet, selectIndex: evmSelectIndex } = useEvmAddresses()
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
	const [streamStatus, setStreamStatus] = useState<{ connected: boolean; watching: number } | null>(null)
	const [cacheUpdatedAt, setCacheUpdatedAt] = useState<number | null>(null)
	const [hasEverRefreshed, setHasEverRefreshed] = useState(false)
	const [visibilityMap, setVisibilityMap] = useState<Record<string, TokenVisibilityStatus>>({})
	const [activeSwaps, setActiveSwaps] = useState<PendingSwap[]>([])
	const dismissedSwapTxids = useRef<Set<string>>((() => {
		try {
			const stored = localStorage.getItem('kk-dismissed-swaps')
			const parsed = stored ? JSON.parse(stored) : []
			return new Set<string>(Array.isArray(parsed) ? parsed.filter((x: unknown) => typeof x === 'string') : [])
		} catch { return new Set<string>() }
	})())
	const refreshGenRef = useRef(0)
	const loadingBalancesRef = useRef(false)
	// Records when each chain's balance was last set via a single-chain balance-updated event.
	// Used by full refreshes to skip chains that received a fresher per-chain update while
	// the bulk request was in-flight (prevents old getBalances response from overwriting newer data).
	const chainLastUpdatedRef = useRef(new Map<string, number>())

	// Fetch pending swaps on mount and keep them live via swap-update messages.
	// Non-terminal swaps mean funds are in-flight — we surface a banner so the
	// user knows their balance isn't missing, it's in a swap.
	useEffect(() => {
		const TERMINAL = new Set(['completed', 'failed', 'refunded'])
		rpcRequest<PendingSwap[]>('getPendingSwaps', undefined, 5000)
			.then(r => { if (r) setActiveSwaps(r.filter(s => !TERMINAL.has(s.status) && !dismissedSwapTxids.current.has(s.txid))) })
			.catch(() => {})
		const unsub = onRpcMessage('swap-update', (update: SwapStatusUpdate) => {
			if (dismissedSwapTxids.current.has(update.txid)) return
			setActiveSwaps(prev => {
				const next = prev.filter(s => s.txid !== update.txid)
				if (!TERMINAL.has(update.status)) {
					const existing = prev.find(s => s.txid === update.txid)
					if (existing) {
						next.push({ ...existing, ...update })
					} else {
						// New swap started after mount — fetch full details
						rpcRequest<PendingSwap[]>('getPendingSwaps', undefined, 5000)
							.then(r => { if (r) setActiveSwaps(r.filter(s => !TERMINAL.has(s.status) && !dismissedSwapTxids.current.has(s.txid))) })
							.catch(() => {})
					}
				}
				return next
			})
		})
		return unsub
	}, [])

	const pioneerErrorFirstSeenRef = useRef<number | null>(null)
	const pioneerErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const hasUsableBalanceSnapshot = balances.size > 0 || cacheUpdatedAt !== null

	const clearPioneerError = useCallback(() => {
		pioneerErrorFirstSeenRef.current = null
		if (pioneerErrorTimerRef.current) {
			clearTimeout(pioneerErrorTimerRef.current)
			pioneerErrorTimerRef.current = null
		}
		setPioneerError(null)
	}, [])

	const stagePioneerError = useCallback((error: PioneerError) => {
		if (!hasUsableBalanceSnapshot) {
			pioneerErrorFirstSeenRef.current = Date.now()
			if (pioneerErrorTimerRef.current) {
				clearTimeout(pioneerErrorTimerRef.current)
				pioneerErrorTimerRef.current = null
			}
			setPioneerError(error)
			return
		}
		if (!pioneerErrorFirstSeenRef.current) pioneerErrorFirstSeenRef.current = Date.now()
		const elapsed = Date.now() - pioneerErrorFirstSeenRef.current
		if (elapsed >= PIONEER_ERROR_GRACE_MS) {
			setPioneerError(error)
			return
		}
		if (!pioneerErrorTimerRef.current) {
			pioneerErrorTimerRef.current = setTimeout(() => {
				pioneerErrorTimerRef.current = null
				setPioneerError(error)
			}, PIONEER_ERROR_GRACE_MS - elapsed)
		}
	}, [hasUsableBalanceSnapshot])

	useEffect(() => {
		return () => {
			if (pioneerErrorTimerRef.current) clearTimeout(pioneerErrorTimerRef.current)
		}
	}, [])

	// Publish balances to the command bus so out-of-tree consumers
	// (CommandPalette) can render token results without us having to lift
	// balances state up to App. Clear on unmount so stale balances from a
	// previous wallet session don't persist after disconnect.
	useEffect(() => {
		publishBalances(balances)
	}, [balances])
	useEffect(() => {
		return () => { clearBalances() }
	}, [])

	// Subscribe to imperative vault commands from CommandPalette (⌘K). These
	// drive the existing drill/open behavior without exposing Dashboard's
	// internal state to App.
	useEffect(() => {
		return subscribeVaultCommand((cmd) => {
			if (cmd.type === "open-chain") {
				setDrilledChainId(cmd.chainId)
				return
			}
			if (cmd.type === "open-token") {
				const chain = [...CHAINS, ...customChainDefs].find(c => c.id === cmd.chainId)
				if (!chain) return
				setDrilledChainId(cmd.chainId)
				const bal = balances.get(cmd.chainId)
				const token = bal?.tokens?.find(tk => tk.caip === cmd.tokenCaip)
				if (token) openChainPage(chain, undefined, token)
			}
		})
	}, [customChainDefs, balances, openChainPage])

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
			stagePioneerError(payload as PioneerError)
		})
	}, [stagePioneerError])

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
	// forceRefresh=true bypasses Pioneer's balance cache — only pass it on explicit user action
	const refreshBalances = useCallback(async (forceRefresh = false) => {
		if (watchOnly) return
		// Non-forced calls yield to any in-progress refresh (avoids non-forced swap-complete
		// poll superseding an already-running forced user refresh).
		if (!forceRefresh && loadingBalancesRef.current) return
		// Generation counter: discard responses from older concurrent full refreshes.
		const gen = ++refreshGenRef.current
		const refreshStartedAt = Date.now()
		loadingBalancesRef.current = true
		setLoadingBalances(true)

		try {
			const result = await rpcRequest<ChainBalance[]>('getBalances', { forceRefresh }, 200000)
			if (result && gen === refreshGenRef.current) {
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
				// Merge: skip chains where a per-chain balance-updated arrived AFTER this
				// full refresh started — that single-chain data is fresher than our bulk result.
				setBalances(prev => {
					const map = new Map(prev)
					for (const b of result) {
						if ((chainLastUpdatedRef.current.get(b.chainId) ?? 0) > refreshStartedAt) continue
						map.set(b.chainId, b)
					}
					return map
				})
				setCacheUpdatedAt(Date.now())
				setHasEverRefreshed(true)
				clearPioneerError()
			}
		} catch (e: any) {
			if (gen === refreshGenRef.current) {
				const message = e?.message || 'Unable to refresh balances'
				console.warn('[Dashboard] getBalances failed:', message)
				stagePioneerError({ message, url: 'the configured balance server' })
			}
		}

		if (gen === refreshGenRef.current) {
			loadingBalancesRef.current = false
			setLoadingBalances(false)
		}
	}, [watchOnly, clearPioneerError, stagePioneerError])

	// Auto-refresh balances when Zcash feature flag is enabled mid-session
	const prevZcashRef = useRef(zcashEnabled)
	useEffect(() => {
		const becameEnabled = zcashEnabled && !prevZcashRef.current
		if (becameEnabled && !loadingBalances) {
			console.log('[Dashboard] Zcash enabled — refreshing balances')
			refreshBalances()
			prevZcashRef.current = true
		} else if (!zcashEnabled) {
			prevZcashRef.current = false
		}
	}, [zcashEnabled, refreshBalances, loadingBalances])

	// Auto-refresh after new seed (OOB setup) — one-shot, then clear the flag
	useEffect(() => {
		if (forceRefresh && initialLoaded && !hasEverRefreshed && !loadingBalances) {
			console.log('[Dashboard] New seed detected — auto-refreshing balances (one-shot)')
			refreshBalances(true)
			onForceRefreshConsumed?.()
		}
	}, [forceRefresh, initialLoaded, hasEverRefreshed, loadingBalances, refreshBalances, onForceRefreshConsumed])

	// Auto-refresh balances when a swap completes (both chains affected).
	// Force-refresh bypasses Pioneer's balance cache since we know balances changed.
	// Delayed retries catch Pioneer's indexer lag (1-2 blocks after confirmation).
	useEffect(() => {
		let t1: ReturnType<typeof setTimeout>
		let t2: ReturnType<typeof setTimeout>
		const handler = () => {
			console.log('[Dashboard] Swap completed — force-refreshing balances')
			refreshBalances(true)
			t1 = setTimeout(() => refreshBalances(true), 30000)
			t2 = setTimeout(() => refreshBalances(true), 90000)
		}
		window.addEventListener('keepkey-swap-completed', handler)
		return () => {
			window.removeEventListener('keepkey-swap-completed', handler)
			clearTimeout(t1)
			clearTimeout(t2)
		}
	}, [refreshBalances])


	// SSE stream status updates from backend
	useEffect(() => {
		return onRpcMessage("stream-status", (s) => setStreamStatus(s))
	}, [])

	// Live balance sync: merge single-chain updates from backend (e.g. AssetPage refresh)
	useEffect(() => {
		return onRpcMessage("balance-updated", (updated: ChainBalance) => {
			const receivedAt = Date.now()
			chainLastUpdatedRef.current.set(updated.chainId, receivedAt)
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
			setCacheUpdatedAt(receivedAt)
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

	// Per-account scoping for drilled-view rendering. When an EVM account is
	// selected in the sidebar drop-down, the center chart, native ETH balance,
	// and token list should show ONLY that account's holdings — not the
	// chain-wide aggregate. Non-EVM chains and absent per-account data fall
	// back to the aggregate balance.
	const getEffectiveBalance = useCallback((chainId: string): ChainBalance | undefined => {
		const agg = balances.get(chainId)
		const chain = allChains.find(c => c.id === chainId)
		if (!chain || chain.chainFamily !== 'evm') return agg
		const selected = evmAddressSet.addresses.find(a => a.addressIndex === evmAddressSet.selectedIndex)
		const cb = selected?.chainBalances?.[chainId]
		if (!cb || !selected) return agg
		return {
			chainId,
			symbol: agg?.symbol || chain.symbol,
			balance: cb.balance,
			balanceUsd: cb.balanceUsd,
			nativeBalanceUsd: cb.nativeBalanceUsd,
			address: selected.address,
			tokens: cb.tokens,
			updatedAt: agg?.updatedAt,
		}
	}, [balances, allChains, evmAddressSet])

	// Warm the browser-level image cache + hold live Image references so chain
	// and token logos don't visibly re-fetch when the user switches between
	// chains in the sidebar.
	useEffect(() => {
		const urls: (string | undefined)[] = []
		for (const chain of allChains) urls.push(getAssetIcon(chain.caip))
		for (const bal of balances.values()) {
			if (!bal.tokens) continue
			for (const tok of bal.tokens) urls.push(tok.icon || getAssetIcon(tok.caip))
		}
		preloadIcons(urls)
	}, [allChains, balances])

	const existingChainIds = useMemo(() => [
		...CHAINS.filter(c => c.chainFamily === 'evm' && c.chainId).map(c => Number(c.chainId)),
		...customChainDefs.filter(c => c.chainId).map(c => Number(c.chainId)),
	], [customChainDefs])

	const allChainsChartData = useMemo<DonutChartItem[]>(() => allChains
		.map((chain) => {
			const clean = cleanBalanceUsd.get(chain.id)
			return { name: chain.coin, value: clean?.usd || 0, color: chain.color, chainId: chain.id }
		})
		.filter((d) => d.value > 0)
		.sort((a, b) => b.value - a.value), [allChains, cleanBalanceUsd])

	// Token palette used for the drilled-chain donut so each slice reads as a
	// distinct color even though tokens don't carry a brand color of their own.
	const TOKEN_PALETTE = ['#e9c46a', '#8be3c4', '#6c7be8', '#e08c7b', '#9f8ce0', '#f0a85c', '#4eb591', '#4f7fc8']

	const drilledChainTokensChartData = useMemo<DonutChartItem[]>(() => {
		if (!drilledChainId) return []
		const chain = allChains.find(c => c.id === drilledChainId)
		const bal = getEffectiveBalance(drilledChainId)
		if (!chain || !bal) return []
		const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const))
		const cleanTokens = bal.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
		const nativeUsd = bal.nativeBalanceUsd ?? Math.max(0, (bal.balanceUsd || 0) - cleanTokens.reduce((s, t) => s + (t.balanceUsd || 0), 0))
		const out: DonutChartItem[] = []
		if (nativeUsd > 0) {
			out.push({ name: chain.symbol, value: nativeUsd, color: chain.color })
		}
		cleanTokens
			.slice()
			.sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0))
			.forEach((tok, i) => {
				out.push({ name: tok.symbol, value: tok.balanceUsd ?? 0, color: TOKEN_PALETTE[i % TOKEN_PALETTE.length] })
			})
		return out.filter(d => d.value > 0)
	}, [drilledChainId, allChains, getEffectiveBalance, visibilityMap])

	// When drilled but no balance data yet, synthesise a single placeholder slice
	// so the donut always renders something for the selected chain.
	const drilledPlaceholder = useMemo<DonutChartItem[]>(() => {
		if (!drilledChainId || drilledChainTokensChartData.length > 0) return drilledChainTokensChartData
		const chain = allChains.find(c => c.id === drilledChainId)
		if (!chain) return []
		return [{ name: chain.symbol, value: 0, color: chain.color + '55' }]
	}, [drilledChainId, drilledChainTokensChartData, allChains])

	// Token-level breakdown for a chain — native asset plus each non-spam token —
	// as stacked-bar items. Shared by the stacked-bar view and the donut's
	// selected-slice breakdown.
	const buildChainTokenItems = (chain: ChainDef): StackedBarItem[] => {
		const bal = getEffectiveBalance(chain.id)
		const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const))
		const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
		const cleanTokensUsd = cleanTokens.reduce((s, t) => s + (t.balanceUsd ?? 0), 0)
		const nativeUsd = bal?.nativeBalanceUsd ?? Math.max(0, (bal?.balanceUsd ?? 0) - cleanTokensUsd)
		const arr: StackedBarItem[] = []
		if (nativeUsd > 0) arr.push({ id: `${chain.id}:native`, label: chain.symbol, color: chain.color, value: nativeUsd, onSelect: () => openChainPage(chain) })
		cleanTokens
			.slice()
			.sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0))
			.forEach((tok, i) => arr.push({
				id: tok.caip,
				label: tok.symbol,
				color: TOKEN_PALETTE[i % TOKEN_PALETTE.length]!,
				value: tok.balanceUsd ?? 0,
				onSelect: () => openChainPage(chain, undefined, tok),
			}))
		return arr
	}

	const chartData = drilledChainId ? drilledPlaceholder : allChainsChartData

	// Reset active slice whenever the drill target changes so the index never
	// points at a stale item from the previous dataset.
	useEffect(() => { setActiveSliceIndex(0) }, [drilledChainId])

	const hasAnyBalance = allChainsChartData.length > 0

	/* Portfolio view mode — pulled from a shared context so the toggle living
	 * in the TopNav can drive Dashboard's rendering. Persistence happens in
	 * the provider. */
	const { viewMode } = useDashboardView()
	const { privateModeEnabled } = useFiat()

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

	if (showActivityPage) {
		return (
			<>
				<ActivityPage
					defaultChainId={activityDefaultChain}
					onBack={() => setShowActivityPage(false)}
					onResumeSwap={(swap) => setActivityResumeSwap(swap)}
				/>
				<Suspense fallback={null}>
					<LazySwapDialog
						open={!!activityResumeSwap}
						onClose={() => setActivityResumeSwap(null)}
						resumeSwap={activityResumeSwap}
					/>
				</Suspense>
			</>
		)
	}

	if (selectedChain) {
		const bal = balances.get(selectedChain.id)
		return (
			<AssetPageErrorBoundary onBack={() => setSelectedChain(null)} chainName={selectedChain.coin}>
				<AssetPage chain={selectedChain} balance={bal} onBack={() => { setSelectedChain(null); setSelectedChainAction(undefined); setSelectedChainInitialToken(undefined) }} firmwareVersion={firmwareVersion} initialAction={selectedChainAction} initialToken={selectedChainInitialToken} onViewActivity={handleViewActivity} />
			</AssetPageErrorBoundary>
		)
	}

	return (
		<Flex w="100%" pt="2" align="stretch" gap={{ base: 0, md: 3 }} px={{ base: 0, md: 3 }} minH="100%">
			<style>{DASHBOARD_ANIMATIONS}</style>

			{/* ── Sidebar: chains list (replaces the cards grid) ───────────── */}
			{hasUsableBalanceSnapshot && (
				<Box
					className="kk-sidebar-scroll"
					w={{ base: "260px", md: "320px" }}
					flexShrink={0}
					alignSelf="stretch"
					position="sticky"
					top="2"
					maxH="calc(100vh - 110px)"
					overflowY="auto"
					pr="1"
					style={{ colorScheme: "dark" }}
					css={{
						"&::-webkit-scrollbar": {
							width: "6px",
							height: "6px",
							background: "transparent",
						},
						"&::-webkit-scrollbar-track": {
							background: "transparent",
							border: "0",
						},
						"&::-webkit-scrollbar-thumb": {
							background: "transparent",
							borderRadius: "3px",
							border: "0",
							transition: "background-color 0.2s ease",
						},
						"&::-webkit-scrollbar-corner": { background: "transparent" },
						"&:hover::-webkit-scrollbar-thumb": {
							background: "rgba(255,255,255,0.08)",
						},
						"&::-webkit-scrollbar-thumb:hover": {
							background: "rgba(255,255,255,0.18)",
						},
						"@supports (-moz-appearance: none)": {
							scrollbarWidth: "thin",
							scrollbarColor: "transparent transparent",
							"&:hover": { scrollbarColor: "rgba(255,255,255,0.10) transparent" },
						},
					}}
				>
					{/* "All Chains" reset row */}
					<Box
						as="button"
						onClick={() => setDrilledChainId(null)}
						w="100%"
						textAlign="left"
						p="2.5"
						mb="2"
						borderRadius="lg"
						bg={drilledChainId === null ? "kk.cardBgHover" : "transparent"}
						border="1px solid"
						borderColor={drilledChainId === null ? "kk.border" : "transparent"}
						_hover={{ bg: "kk.cardBg" }}
						cursor="pointer"
						transition="all 0.15s"
					>
						<Flex align="center" gap="2.5">
							<Box w="28px" h="28px" borderRadius="full" bg="kk.cardBg" border="1px solid" borderColor="kk.border" display="grid" placeItems="center" flexShrink={0}>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<circle cx="12" cy="12" r="9" strokeDasharray="2 3"/>
									<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>
								</svg>
							</Box>
							<Box flex="1" minW="0">
								<Text fontSize="14px" fontWeight="600" color="var(--text-0)" lineHeight="1.2">All Chains</Text>
								<Text fontSize="14px" color="var(--text-1)" fontWeight="500" lineHeight="1.3" letterSpacing="-0.01em">
									{privateModeEnabled ? "••••••" : `$${totalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
								</Text>
							</Box>
						</Flex>
					</Box>

					{sortedChains.map((chain) => {
						const bal = balances.get(chain.id)
						const clean = cleanBalanceUsd.get(chain.id)
						const balNum = parseFloat(bal?.balance || '0')
						const usdNum = clean?.usd || 0
						const hasBalance = balNum > 0 || usdNum > 0
						const tokenCount = clean?.cleanTokenCount || 0
						const isActive = drilledChainId === chain.id
						// Per-account (BIP44) sub-rows: BTC accountIndex or EVM addressIndex.
						// Only chains that have multiple funded accounts/addresses get a drop-down.
						const evmSelectedIndex = evmAddressSet.selectedIndex
						const btcSelected = btcAccountSet.selectedXpub
						const accountRows: Array<{
							key: string; index: number; balance: number; balanceUsd: number;
							isSelected: boolean; address: string; onSelect: () => void;
						}> = chain.id === 'bitcoin'
							? btcAccountSet.accounts
								.map(acc => {
									const xp = acc.xpubs.find(x => x.scriptType === (btcSelected?.scriptType ?? 'p2wpkh')) || acc.xpubs[0]
									return {
										key: `btc-${acc.accountIndex}`,
										index: acc.accountIndex,
										balance: acc.xpubs.reduce((s, x) => s + parseFloat(x.balance || '0'), 0),
										balanceUsd: acc.totalBalanceUsd,
										isSelected: btcSelected?.accountIndex === acc.accountIndex,
										address: xp?.xpub || '',
										onSelect: () => btcSelectXpub(acc.accountIndex, btcSelected?.scriptType ?? 'p2wpkh'),
									}
								})
								.filter(a => a.balanceUsd > 0 || a.balance > 0)
							: chain.chainFamily === 'evm'
								? evmAddressSet.addresses
									.map(addr => ({
										key: `evm-${addr.addressIndex}`,
										index: addr.addressIndex,
										balance: parseFloat(addr.chainBalances?.[chain.id]?.balance || '0'),
										balanceUsd: addr.chainBalances?.[chain.id]?.balanceUsd || 0,
										isSelected: evmSelectedIndex === addr.addressIndex,
										address: addr.address,
										onSelect: () => evmSelectIndex(addr.addressIndex),
									}))
									.filter(a => a.balanceUsd > 0 || a.balance > 0)
								: []
						// Show the per-account drop-down only for the currently drilled
						// chain and only when there are 2+ funded accounts — a single
						// funded account is already represented by the chain row itself.
						const showAccountRows = isActive && accountRows.length > 1
						return (
							<Fragment key={chain.id}>
							<Box
								as="button"
								onClick={() => setDrilledChainId(prev => prev === chain.id ? null : chain.id)}
								w="100%"
								textAlign="left"
								p="2.5"
								mb={showAccountRows ? "1" : "1.5"}
								borderRadius="lg"
								bg={isActive ? "kk.cardBgHover" : "transparent"}
								border="1px solid"
								borderColor={isActive ? `${chain.color}80` : "transparent"}
								_hover={{ bg: "kk.cardBg", borderColor: `${chain.color}50` }}
								cursor="pointer"
								transition="all 0.15s"
								opacity={hasBalance ? 1 : 0.55}
							>
								<Flex align="center" gap="3">
									<Image src={getAssetIcon(chain.caip)} alt={chain.symbol} w="32px" h="32px" borderRadius="full" flexShrink={0} bg={chain.color} />
									<Box flex="1" minW="0">
										<Flex align="baseline" justify="space-between" gap="2">
											<Text fontSize="14px" fontWeight="600" color="var(--text-0)" lineHeight="1.2" truncate>
												{chain.coin}
											</Text>
											{usdNum > 0 && (
												<Text fontSize="14px" color="var(--text-0)" fontWeight="500" lineHeight="1.2" letterSpacing="-0.01em" flexShrink={0}>
													{privateModeEnabled ? "••••" : `$${usdNum.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
												</Text>
											)}
										</Flex>
										<Flex align="baseline" justify="space-between" gap="2" mt="0.5">
											<Text fontSize="12px" color="var(--text-2)" lineHeight="1.3" truncate>
												{hasBalance ? `${formatBalance(bal?.balance || '0')} ${chain.symbol}` : t("noBalance")}
											</Text>
											{tokenCount > 0 && (
												<Text fontSize="10px" color={chain.color} fontWeight="600" lineHeight="1.3" flexShrink={0}>
													+{tokenCount}
												</Text>
											)}
										</Flex>
									</Box>
								</Flex>
							</Box>
							{showAccountRows && (
								<Box pl="2" mb="1.5" ml="5">
									{accountRows.map(acc => {
										const snippet = acc.address
											? (acc.address.startsWith('0x')
												? `${acc.address.slice(0, 6)}…${acc.address.slice(-4)}`
												: `${acc.address.slice(0, 6)}…${acc.address.slice(-4)}`)
											: ''
										return (
											<Flex
												key={acc.key}
												as="button"
												onClick={acc.onSelect}
												w="100%"
												align="center"
												justify="space-between"
												gap="2"
												py="1.5"
												pl="2.5"
												pr="2"
												mb="0.5"
												borderRadius="md"
												bg={acc.isSelected ? `${chain.color}15` : "transparent"}
												borderLeft="2px solid"
												borderLeftColor={acc.isSelected ? chain.color : `${chain.color}25`}
												cursor="pointer"
												transition="all 0.15s"
												_hover={{ bg: acc.isSelected ? `${chain.color}22` : "kk.cardBg", borderLeftColor: chain.color }}
												textAlign="left"
											>
												<Box minW="0" flex="1">
													<Text fontSize="11px" color={acc.isSelected ? "var(--text-0)" : "var(--text-1)"} fontWeight={acc.isSelected ? "600" : "500"} lineHeight="1.2">
														Account #{acc.index}
													</Text>
													{snippet && (
														<Text fontSize="9px" color="var(--text-2)" lineHeight="1.2" fontFamily="mono" mt="0.5">
															{snippet}
														</Text>
													)}
												</Box>
												<Box textAlign="right" flexShrink={0}>
													<Text fontSize="11px" color="var(--text-0)" fontWeight={acc.isSelected ? "600" : "500"} lineHeight="1.2">
														{privateModeEnabled ? "••••" : `$${acc.balanceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
													</Text>
													<Text fontSize="9px" color="var(--text-2)" lineHeight="1.2" mt="0.5">
														{formatBalance(String(acc.balance))} {chain.symbol}
													</Text>
												</Box>
											</Flex>
										)
									})}
								</Box>
							)}
							</Fragment>
						)
					})}

					{/* Add Chain row */}
					{!watchOnly && (
						<Box
							as="button"
							onClick={() => setShowAddChain(true)}
							w="100%"
							mt="2"
							p="2.5"
							borderRadius="lg"
							bg="transparent"
							border="1px dashed"
							borderColor="kk.border"
							_hover={{ borderColor: "kk.gold", bg: "rgba(233,196,106,0.05)" }}
							cursor="pointer"
							transition="all 0.15s"
						>
							<Flex align="center" gap="2" justify="center">
								<Text fontSize="14px" color="kk.textMuted">+</Text>
								<Text fontSize="11px" color="kk.textMuted">{t("addChain")}</Text>
							</Flex>
						</Box>
					)}
				</Box>
			)}

			<Flex flex="1" direction="column" minW="0" px={{ base: 2, md: 4 }} w="100%">

			{/* Top-right utility row: Reports + Refresh (sits above all main content) */}
			{!watchOnly && (
				<Flex justify="flex-end" align="center" gap="3" mb="2" pt="1">
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
						onClick={loadingBalances ? undefined : () => refreshBalances(true)}
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

					{/* SSE stream status dot */}
					{streamStatus !== null && (
						<Flex
							align="center"
							gap="1"
							px="2"
							py="1"
							borderRadius="full"
							bg={streamStatus.connected ? "rgba(80,200,120,0.08)" : "rgba(255,100,100,0.08)"}
							border="1px solid"
							borderColor={streamStatus.connected ? "rgba(80,200,120,0.22)" : "rgba(255,100,100,0.18)"}
							title={streamStatus.connected
								? `Live: watching ${streamStatus.watching} address${streamStatus.watching !== 1 ? 'es' : ''}`
								: 'Event stream disconnected — using polling'}
							cursor="default"
							flexShrink={0}
						>
							<Box
								w="6px" h="6px" borderRadius="full" flexShrink={0}
								bg={streamStatus.connected ? "rgb(80,200,120)" : "rgb(200,80,80)"}
								style={streamStatus.connected ? { animation: "pulseTeal 2s ease-in-out infinite" } : undefined}
							/>
							<Text fontSize="9px" fontWeight="700" letterSpacing="0.04em"
								color={streamStatus.connected ? "rgb(80,200,120)" : "rgb(200,80,80)"}>
								{streamStatus.connected ? "LIVE" : "POLL"}
							</Text>
						</Flex>
					)}
				</Flex>
			)}

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

			{/* In-flight swap banners — shown when funds are in a pending swap so
			    users don't think their balance is missing */}
			{activeSwaps.map(swap => (
				<Box
					key={swap.txid}
					mb="2"
					px="3"
					py="2.5"
					bg="rgba(139,227,196,0.06)"
					border="1px solid"
					borderColor="rgba(139,227,196,0.22)"
					borderRadius="lg"
					cursor="pointer"
					_hover={{ bg: "rgba(139,227,196,0.10)", borderColor: "rgba(139,227,196,0.40)" }}
					onClick={() => setActivityResumeSwap(swap)}
				>
					<Flex align="center" gap="2">
						<Box
							as="button"
							flexShrink={0}
							w="14px"
							h="14px"
							display="flex"
							alignItems="center"
							justifyContent="center"
							color="whiteAlpha.400"
							_hover={{ color: "var(--rose)" }}
							onClick={(e) => { e.stopPropagation(); dismissedSwapTxids.current.add(swap.txid); try { localStorage.setItem('kk-dismissed-swaps', JSON.stringify([...dismissedSwapTxids.current])) } catch {} ; setActiveSwaps(prev => prev.filter(s => s.txid !== swap.txid)) }}
							title="Dismiss"
						>
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
								<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
							</svg>
						</Box>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
							<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
						</svg>
						<Text fontSize="11px" color="var(--teal)" fontWeight="600" flex="1">
							{swap.fromAmount} {swap.fromSymbol} → {swap.toSymbol} swap in progress
						</Text>
						<Text fontSize="10px" color="kk.textMuted" textTransform="capitalize">{swap.status.replace(/_/g, ' ')}</Text>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--teal)' }}>
							<polyline points="9 18 15 12 9 6"/>
						</svg>
					</Flex>
				</Box>
			))}

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
						{pioneerError.message && (
							<Text fontSize="11px" color="kk.textMuted" lineHeight="1.4" fontFamily="mono">
								{pioneerError.message}
							</Text>
						)}
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
										clearPioneerError()
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
									clearPioneerError()
									refreshBalances(true)
								}}
							>
								{t("retry")}
							</Box>
						</Flex>
					</Flex>
				</Box>
			)}

			{/* Centered hero region — split into a flex-1 "sun" area (vertically
			    centered) and a fixed-min-height "below" area. The split anchors
			    the sun and the donut center at the same y-coordinate regardless
			    of how much below content is rendered. */}
			<Flex direction="column" w="100%" minH={viewMode === 'heatmap' ? "0" : "auto"}>
				{/* View picker — top center of the hero area */}
				<Flex justify="center" pt="2" pb="1">
					<ViewPickerButton assetCount={(() => {
						if (drilledChainId) {
							const dchain = visibleChains.find(c => c.id === drilledChainId)
							const bal = dchain ? getEffectiveBalance(dchain.id) : undefined
							const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const))
							const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
							const nativeUsd = bal?.nativeBalanceUsd ?? Math.max(0, (bal?.balanceUsd ?? 0) - cleanTokens.reduce((s, t) => s + (t.balanceUsd ?? 0), 0))
							return (nativeUsd > 0 ? 1 : 0) + cleanTokens.filter(t => (t.balanceUsd ?? 0) > 0).length
						}
						return Array.from(cleanBalanceUsd.values()).filter(b => b.usd > 0).length
					})()} />
				</Flex>
				{/* Top: orbital widget / donut / welcome — vertically centered.
				    overflow:hidden prevents the orbital box from visually and
				    pointer-event-wise spilling into the action button row below. */}
				<Flex
					h={drilledChainId ? "380px" : "62vh"}
					align="center"
					justify="center"
					w="100%"
					px="3"
					pt="6"
					overflow="hidden"
					position="relative"
					zIndex={1}
				>
					{hasAnyBalance ? (() => {
						if (drilledChainId && viewMode === 'orbital') {
							const dchain = visibleChains.find(c => c.id === drilledChainId)
							if (!dchain) return null
							const bal = getEffectiveBalance(dchain.id)
							const overrides = new Map(
								Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const),
							)
							const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
							const nativeUsd = bal?.nativeBalanceUsd ?? bal?.balanceUsd ?? 0
							return (
								<ChainDetailOrbital
									chain={dchain}
									balance={bal}
									nativeBalanceUsd={nativeUsd}
									cleanTokens={cleanTokens}
									onSelectChain={() => openChainPage(dchain)}
									onSelectToken={(tok) => openChainPage(dchain, undefined, tok)}
								/>
							)
						}
						if (viewMode === 'orbital') {
							return (
								<OrbitalView
									chains={visibleChains}
									balances={balances}
									cleanBalanceUsd={cleanBalanceUsd}
									totalUsd={totalUsd}
									totalDollars={totalDollars}
									totalCents={totalCents}
									cleanTokenTotal={cleanTokenTotal}
									onSelect={(c) => setDrilledChainId(c.id)}
									privateModeEnabled={privateModeEnabled}
								/>
							)
						}
						if (viewMode === 'heatmap') {
							const tiles = drilledChainId
								? (() => {
									const dchain = visibleChains.find(c => c.id === drilledChainId)
									if (!dchain) return []
									const bal = getEffectiveBalance(dchain.id)
									const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const))
									const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
									const cleanTokensUsd = cleanTokens.reduce((s, t) => s + (t.balanceUsd ?? 0), 0)
									const nativeUsd = bal?.nativeBalanceUsd ?? Math.max(0, (bal?.balanceUsd ?? 0) - cleanTokensUsd)
									return buildChainDetailTiles(dchain, bal, cleanTokens, nativeUsd, (tok) => openChainPage(dchain, undefined, tok))
								})()
								: buildAllChainsTiles(visibleChains, cleanBalanceUsd, (chainId) => setDrilledChainId(chainId))
							// Heatmap is a comparison view — needs 2+ tiles to be meaningful.
							// Fall back to the orbital view when there's only one (or zero)
							// asset, since a single-tile heatmap (or single-slice donut) is
							// visually meaningless. Orbital still reads well with one item.
							if (tiles.length < 2) {
								if (drilledChainId) {
									const dchain = visibleChains.find(c => c.id === drilledChainId)
									if (dchain) {
										const bal = getEffectiveBalance(dchain.id)
										const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const))
										const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
										const nativeUsd = bal?.nativeBalanceUsd ?? bal?.balanceUsd ?? 0
										return (
											<ChainDetailOrbital
												chain={dchain}
												balance={bal}
												nativeBalanceUsd={nativeUsd}
												cleanTokens={cleanTokens}
												onSelectChain={() => openChainPage(dchain)}
												onSelectToken={(tok) => openChainPage(dchain, undefined, tok)}
											/>
										)
									}
								}
								return (
									<OrbitalView
										chains={visibleChains}
										balances={balances}
										cleanBalanceUsd={cleanBalanceUsd}
										totalUsd={totalUsd}
										totalDollars={totalDollars}
										totalCents={totalCents}
										cleanTokenTotal={cleanTokenTotal}
										onSelect={(c) => setDrilledChainId(c.id)}
										privateModeEnabled={privateModeEnabled}
									/>
								)
							}
							// Full-canvas: dynamically measure where the heatmap container
							// starts in the viewport and stretch it down to the bottom edge.
							// Static `calc(100vh - <fudge>)` got the offset wrong because of
							// banners / utility row variability.
							return <HeatmapHost tiles={tiles} drilled={!!drilledChainId} />
						}
						if (viewMode === 'stack') {
							const items: StackedBarItem[] = drilledChainId
								? (() => {
									const dchain = visibleChains.find(c => c.id === drilledChainId)
									return dchain ? buildChainTokenItems(dchain) : []
								})()
								: visibleChains.map(chain => ({
									id: chain.id,
									label: chain.coin,
									color: chain.color,
									value: cleanBalanceUsd.get(chain.id)?.usd ?? 0,
									onSelect: () => setDrilledChainId(chain.id),
								})).filter(it => it.value > 0)
							const stackTotal = drilledChainId
								? items.reduce((s, it) => s + it.value, 0)
								: totalUsd
							return <StackedBarView items={items} total={stackTotal} maxWidth={720} />
						}
						const safeIndex = activeSliceIndex !== null && activeSliceIndex < chartData.length ? activeSliceIndex : (chartData.length > 0 ? 0 : null)
						return (
							<DonutChart
								data={chartData}
								size={300}
								activeIndex={safeIndex}
								onHoverSlice={(i) => setActiveSliceIndex(i === null ? 0 : i)}
								onClickSlice={(i) => {
									if (drilledChainId) {
										// Drilled view: slices are tokens — open their AssetPage
										const dchain = visibleChains.find(c => c.id === drilledChainId)
										const bal = dchain ? getEffectiveBalance(dchain.id) : undefined
										const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const))
										const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
										const item = chartData[i]
										if (!item) return
										if (item.name === dchain?.symbol) { openChainPage(dchain!); return }
										const tok = cleanTokens.find(t => t.symbol === item.name)
										if (tok && dchain) openChainPage(dchain, undefined, tok)
									} else {
										const item = allChainsChartData[i]
										if (!item) return
										const chain = allChains.find(c => c.coin === (item as any).name)
										if (chain) setDrilledChainId(chain.id)
									}
								}}
							/>
						)
					})() : (loadingBalances || !initialLoaded) && !pioneerError ? (
						<DashboardLoading />
					) : !loadingBalances && initialLoaded && !pioneerError ? (
						<Flex direction="column" align="center" gap="3" textAlign="center" maxW="400px" mx="auto" py="4">
							<Box
								w="48px" h="48px" borderRadius="full"
								bg="rgba(233,196,106,0.1)"
								display="flex" alignItems="center" justifyContent="center"
							>
								<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
									<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
									<path d="M9 12l2 2 4-4" />
								</svg>
							</Box>
							<Box>
								<Text fontSize="15px" fontWeight="600" color="var(--text-0)" mb="1">
									{t("welcomeTitle")}
								</Text>
								<Text fontSize="13px" color="var(--text-2)" lineHeight="1.5">
									Pick a chain from the list on the left to get your deposit address.
								</Text>
							</Box>
							{visibleChains.length > 0 && (
								<Box
									as="button"
									onClick={() => openChainPage(visibleChains[0]!)}
									px="5" py="2.5"
									bg="var(--gold)" color="var(--ink-0)"
									borderRadius="999px"
									fontSize="13px" fontWeight="600"
									cursor="pointer"
									_hover={{ bg: 'var(--gold-2)' }}
									transition="all 0.15s"
									className="electrobun-webkit-app-region-no-drag"
								>
									Get {visibleChains[0]!.symbol} address →
								</Box>
							)}
						</Flex>
					) : null}
				</Flex>

				{/* Below the sun: token list / action buttons / donut legend / empty.
				    Fixed min-height keeps the sun's y-position stable across modes.
				    position+zIndex ensures this row sits above any orbital overflow. */}
				<Flex
					direction="column"
					align="center"
					w="100%"
					maxW="540px"
					mx="auto"
					px="3"
					position="relative"
					zIndex={2}
					minH={viewMode === 'heatmap' && !drilledChainId ? '0' : '140px'}
					pt={viewMode === 'heatmap' && !drilledChainId ? '0' : '0'}
					pb={viewMode === 'heatmap' && !drilledChainId ? '0' : '2'}
					gap="1"
				>
					{hasAnyBalance && viewMode === 'donut' && chartData.length > 0 && (() => {
						const safeIndex = activeSliceIndex !== null && activeSliceIndex < chartData.length ? activeSliceIndex : 0
						// Use real token sum when drilled; placeholder has value:0 so use real balance sum
						const legendTotal = drilledChainId
							? drilledChainTokensChartData.reduce((s, d) => s + d.value, 0)
							: totalUsd
						const active = chartData[safeIndex] ?? null
						// Top-level slices are chains — break the active chain down by token.
						// Drilled slices are already tokens, so they carry no nested breakdown.
						const activeChain = !drilledChainId && active
							? allChains.find(c => c.coin === active.name)
							: undefined
						const breakdown = activeChain ? buildChainTokenItems(activeChain) : undefined
						const handleClick = () => {
							if (!active) return
							if (drilledChainId) {
								// Drilled view: the selected key is a token
								const dchain = visibleChains.find(c => c.id === drilledChainId)
								const bal = dchain ? getEffectiveBalance(dchain.id) : undefined
								const overrides = new Map(Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const))
								const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []
								if (active.name === dchain?.symbol) { openChainPage(dchain!); return }
								const tok = cleanTokens.find(t => t.symbol === active.name)
								if (tok && dchain) openChainPage(dchain, undefined, tok)
							} else if (activeChain) {
								setDrilledChainId(activeChain.id)
							}
						}
						return (
							<Box w="100%" maxW="440px">
								<SelectedSlice
									active={active}
									total={legendTotal}
									breakdown={breakdown}
									onClick={handleClick}
								/>
							</Box>
						)
					})()}

					{hasAnyBalance && drilledChainId && (() => {
						const dchain = visibleChains.find(c => c.id === drilledChainId)
						if (!dchain) return null
						const bal = getEffectiveBalance(dchain.id)
						const overrides = new Map(
							Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const),
						)
						const cleanTokens = bal?.tokens ? categorizeTokens(bal.tokens, overrides).clean : []

						return (
							<>
								{/* Always-on action row: Receive / Send / Swap. Sits in the same
								    slot whether or not the chain has tokens. */}
								<Flex
									align="center"
									gap="2px"
									bg="var(--ink-2)"
									border="1px solid var(--line)"
									p="3px"
									borderRadius="999px"
								>
									{([
										{ id: 'receive' as const, label: 'Receive', color: '#4ade80', bg: 'rgba(74,222,128,0.12)', icon: (
											<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="5 12 12 19 19 12" /></svg>
										) },
										{ id: 'send' as const, label: 'Send', color: '#fb923c', bg: 'rgba(251,146,60,0.12)', icon: (
											<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
										) },
										{ id: 'swap' as const, label: 'Swap', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', icon: (
											<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
										) },
										...(dchain.id === 'zcash' && zcashEnabled ? [{
											id: 'privacy' as const, label: 'Privacy', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)', icon: (
												<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
											),
										}] : []),
									]).map((p) => (
										<Box
											key={p.id}
											as="button"
											onClick={() => openChainPage(dchain, p.id)}
											display="flex"
											alignItems="center"
											gap="1.5"
											px="4"
											py="2"
											borderRadius="999px"
											fontSize="13px"
											fontWeight="600"
											letterSpacing="-0.01em"
											color={p.color}
											bg={p.bg}
											border="1px solid transparent"
											_hover={{ borderColor: p.color, bg: p.bg, opacity: 0.9 }}
											transition="all 0.15s"
											cursor="pointer"
											minW="100px"
											justifyContent="center"
										>
											{p.icon}
											{p.label}
										</Box>
									))}
								</Flex>

								{/* Token list (only when the chain has clean tokens).
								    maxH + overflowY="auto" keep the chart+actions pinned while
								    the user scrolls through a long token list independently. */}
								{cleanTokens.length > 0 && (
									<Box w="100%" mt="-1">
										<Text fontSize="10px" color="var(--text-3)" letterSpacing="0.20em" textTransform="uppercase" mb="1" px="1">
											{t("tokensCount", { count: cleanTokens.length })}
										</Text>
										<Flex direction="column" gap="0.5" maxH="38vh" overflowY="auto" pr="1" className="kk-tokens-scroll">
											{cleanTokens
												.slice()
												.sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0))
												.map((tok) => (
													<Flex
														key={tok.caip}
														as="button"
														onClick={() => openChainPage(dchain, undefined, tok)}
														align="center"
														gap="2.5"
														px="2"
														py="1.5"
														borderRadius="md"
														bg="transparent"
														_hover={{ bg: "kk.cardBg" }}
														cursor="pointer"
														transition="all 0.15s"
														border="0"
														title={tok.name || tok.symbol}
													>
														<Image
															src={tok.icon || getAssetIcon(tok.caip)}
															alt={tok.symbol}
															w="26px"
															h="26px"
															borderRadius="full"
															flexShrink={0}
															bg="var(--ink-2)"
														/>
														<Box flex="1" minW="0" textAlign="left">
															<Text fontSize="13px" fontWeight="600" color="var(--text-0)" lineHeight="1.2" truncate>
																{tok.symbol}
															</Text>
															<Text fontSize="10px" color="var(--text-3)" lineHeight="1.3" truncate>
																{tok.name || dchain.coin}
															</Text>
														</Box>
														<Box textAlign="right" flexShrink={0}>
															<Text fontSize="12px" fontWeight="500" color="var(--text-0)" lineHeight="1.2">
																{formatBalance(tok.balance)}
															</Text>
															<Text fontSize="10px" color="var(--text-2)" lineHeight="1.3">
																${(tok.balanceUsd ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
															</Text>
														</Box>
													</Flex>
												))}
										</Flex>
									</Box>
								)}
							</>
						)
					})()}
				</Flex>

			</Flex>


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
					onClick={() => refreshBalances(true)}
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

		{false && <SimpleGrid columns={{ base: 2, sm: 3 }} gap="2.5">
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
			</SimpleGrid>}

			{drilledChainId === 'dogecoin' && <DogeEasterEgg />}

			{swapDialogChain && (
				<Suspense fallback={null}>
					<LazySwapDialog
						open={true}
						onClose={() => setSwapDialogChain(null)}
						chain={swapDialogChain}
						balance={balances.get(swapDialogChain.id)}
						address={balances.get(swapDialogChain.id)?.address}
					/>
				</Suspense>
			)}

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

			{/* BIP-85 lock icon — bottom right (only when feature enabled AND firmware >= 7.16.0) */}
			{bip85Enabled && !watchOnly && firmwareVersion && versionCompare(firmwareVersion, '7.16.0') >= 0 && (
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
			</Flex>
		</Flex>
	)
}
