import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, Button, Image, VStack, HStack, IconButton, Spinner } from "@chakra-ui/react"
import { FaArrowDown, FaArrowUp, FaExchangeAlt, FaPlus, FaEye, FaEyeSlash, FaShieldAlt, FaCheck, FaCopy } from "react-icons/fa"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { ChainDef } from "../../shared/chains"
import { CHAINS, BTC_SCRIPT_TYPES, btcAccountPath, isChainSupported } from "../../shared/chains"
import type { ChainBalance, TokenBalance, TokenVisibilityStatus, AppSettings } from "../../shared/types"
import { getAssetIcon, caipToIcon } from "../../shared/assetLookup"
import { AnimatedUsd } from "./AnimatedUsd"
import { formatBalance } from "../lib/formatting"
import { useFiat } from "../lib/fiat-context"
import { ReceiveView } from "./ReceiveView"
import { SendForm } from "./SendForm"

// Lazy-load optional feature components — defers module evaluation to avoid
// bundler TDZ issues when these heavy modules are statically imported.
const SwapDialog = lazy(() => import("./SwapDialog").then(m => ({ default: m.SwapDialog })).catch(err => { console.error("[SwapDialog lazy] TDZ or load error:", err, err?.stack); throw err }))
const ZcashPrivacyTab = lazy(() => import("./ZcashPrivacyTab").then(m => ({ default: m.ZcashPrivacyTab })))
const StakingPanel = lazy(() => import("./StakingPanel").then(m => ({ default: m.StakingPanel })))

import { SweepDialog } from "./SweepDialog"
import { BtcXpubSelector } from "./BtcXpubSelector"
import { EvmAddressSelector } from "./EvmAddressSelector"
import { useBtcAccounts } from "../hooks/useBtcAccounts"
import { useEvmAddresses } from "../hooks/useEvmAddresses"
import { AddTokenDialog } from "./AddTokenDialog"
import { detectSpamToken, categorizeTokens, type SpamResult } from "../../shared/spamFilter"

type AssetView = "receive" | "send" | "privacy"

class SwapErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null }
	static getDerivedStateFromError(error: Error) { return { error } }
	componentDidCatch(error: Error, info: React.ErrorInfo) {
		console.error("[SwapErrorBoundary]", error.message, error.stack, info.componentStack)
	}
	render() {
		if (this.state.error) return <Box p="4" color="red.300" fontSize="sm"><Text fontWeight="bold">Swap load error:</Text><Text fontFamily="mono" whiteSpace="pre-wrap">{this.state.error.message}{"\n"}{this.state.error.stack}</Text></Box>
		return this.props.children
	}
}

interface AssetPageProps {
	chain: ChainDef
	balance?: ChainBalance
	onBack: () => void
	firmwareVersion?: string
}

export function AssetPage({ chain, balance, onBack, firmwareVersion }: AssetPageProps) {
	const { t } = useTranslation("asset")
	const { fmtCompact, symbol: fiatSymbol } = useFiat()
	const [view, setView] = useState<AssetView>("receive")
	const [selectedToken, setSelectedToken] = useState<TokenBalance | null>(null)
	const [copiedCaip, setCopiedCaip] = useState<string | null>(null)
	const [address, setAddress] = useState<string | null>(balance?.address || null)
	const [loading, setLoading] = useState(false)
	const [deriveError, setDeriveError] = useState<string | null>(null)
	const [currentPath, setCurrentPath] = useState<number[]>(chain.defaultPath)

	// BTC multi-account support (declared early — handleRefresh depends on isBtc + refreshBtcAccounts)
	const isBtc = chain.id === 'bitcoin'
	const { btcAccounts, selectXpub, addAccount, refresh: refreshBtcAccounts, loading: btcLoading } = useBtcAccounts()

	// Single-chain refresh
	const [refreshing, setRefreshing] = useState(false)
	const [refreshedBalance, setRefreshedBalance] = useState<ChainBalance | null>(null)
	const handleRefresh = useCallback(async () => {
		setRefreshing(true)
		try {
			const updated = await rpcRequest<ChainBalance>("getBalance", { chainId: chain.id })
			setRefreshedBalance(updated)
			// BTC: re-fetch per-xpub balances so the selector pills update
			if (isBtc) await refreshBtcAccounts()
		} catch (e) {
			console.warn(`[AssetPage] refresh ${chain.id} failed:`, e)
		} finally {
			setRefreshing(false)
		}
	}, [chain.id, isBtc, refreshBtcAccounts])

	// Use refreshed balance if available, otherwise prop
	const baseBalance = refreshedBalance || balance

	// Feature flags: swaps, zcash privacy
	const [swapsEnabled, setSwapsEnabled] = useState(false)
	const [swappableChainIds, setSwappableChainIds] = useState<Set<string>>(new Set())
	const [zcashPrivacyEnabled, setZcashPrivacyEnabled] = useState(false)
	const refreshFeatureFlags = useCallback(() => {
		rpcRequest<AppSettings>("getAppSettings")
			.then(s => {
				setSwapsEnabled(s.swapsEnabled)
				setZcashPrivacyEnabled(s.zcashPrivacyEnabled)
				if (s.swapsEnabled) {
					rpcRequest<string[]>("getSwappableChainIds", undefined, 20000)
						.then(ids => setSwappableChainIds(new Set(ids)))
						.catch(() => {})
				} else {
					setSwappableChainIds(new Set())
				}
			})
			.catch(() => {})
	}, [])
	useEffect(() => { refreshFeatureFlags() }, [refreshFeatureFlags])
	useEffect(() => {
		window.addEventListener('keepkey-settings-changed', refreshFeatureFlags)
		return () => window.removeEventListener('keepkey-settings-changed', refreshFeatureFlags)
	}, [refreshFeatureFlags])

	// Reset view if user is on privacy tab but flag got turned off
	useEffect(() => {
		if (view === "privacy" && !zcashPrivacyEnabled) setView("receive")
	}, [view, zcashPrivacyEnabled])

	// EVM multi-address support
	const isEvm = chain.chainFamily === 'evm'
	const { evmAddresses, selectIndex: evmSelectIndex, addIndex: evmAddIndex, removeIndex: evmRemoveIndex, loading: evmLoading } = useEvmAddresses()
	const previousEvmSelectedIndex = useRef<number | null>(null)
	const selectedEvmAddress = isEvm
		? evmAddresses.addresses.find(a => a.addressIndex === evmAddresses.selectedIndex)
		: undefined
	const selectedEvmChainBalance = selectedEvmAddress?.chainBalances?.[chain.id]
	const activeBalance: ChainBalance | undefined = isEvm && selectedEvmAddress && selectedEvmChainBalance
		? {
			chainId: chain.id,
			symbol: chain.symbol,
			balance: selectedEvmChainBalance.balance,
			balanceUsd: selectedEvmChainBalance.balanceUsd,
			nativeBalanceUsd: selectedEvmChainBalance.nativeBalanceUsd,
			address: selectedEvmAddress.address,
			tokens: selectedEvmChainBalance.tokens,
		}
		: baseBalance

	// BTC address index state: change (0=receive, 1=change) and address index
	const [btcChangeIndex, setBtcChangeIndex] = useState<0 | 1>(0)
	const [btcAddressIndex, setBtcAddressIndex] = useState(0)
	// Cache Pioneer-reported indices so we don't re-fetch on every toggle
	const [pioneerIndices, setPioneerIndices] = useState<{ receiveIndex: number; changeIndex: number } | null>(null)

	// Derive active BTC script type config and path from selected xpub + change/index
	const btcSelected = useMemo(() => {
		if (!isBtc || !btcAccounts.selectedXpub) return null
		const { accountIndex, scriptType } = btcAccounts.selectedXpub
		const stConfig = BTC_SCRIPT_TYPES.find(s => s.scriptType === scriptType)
		if (!stConfig) return null
		const accountPath = btcAccountPath(stConfig.purpose, accountIndex)
		const fullPath = [...accountPath, btcChangeIndex, btcAddressIndex]
		const account = btcAccounts.accounts.find(a => a.accountIndex === accountIndex)
		const xpubData = account?.xpubs.find(x => x.scriptType === scriptType)
		return { scriptType, fullPath, accountPath, xpubData, stConfig }
	}, [isBtc, btcAccounts, btcChangeIndex, btcAddressIndex])

	// Effective path and scriptType — BTC overrides from multi-account selector
	const effectivePath = (isBtc && btcSelected) ? btcSelected.fullPath : currentPath
	const effectiveScriptType = (isBtc && btcSelected) ? btcSelected.scriptType : chain.scriptType

	// TON: bounceable toggle (default: non-bounceable / UQ for safe receiving)
	const isTon = chain.chainFamily === 'ton'
	const [tonBounceable, setTonBounceable] = useState(false)

	const deriveAddress = useCallback(async (path?: number[], overrideBounceable?: boolean) => {
		const usePath = path || effectivePath
		if (path) setCurrentPath(path)
		setLoading(true)
		setDeriveError(null)
		try {
			const params: any = {
				addressNList: usePath,
				showDisplay: false,
				coin: chain.chainFamily === 'evm' ? 'Ethereum' : chain.coin,
			}
			const st = (isBtc && btcSelected) ? btcSelected.scriptType : chain.scriptType
			if (st) params.scriptType = st
			if (isTon) params.bounceable = overrideBounceable ?? tonBounceable
			const result = await rpcRequest(chain.rpcMethod, params, 60000)
			const addr = typeof result === "string" ? result : result?.address || String(result)
			setAddress(addr)
		} catch (e: any) {
			console.error(`${chain.coin} address:`, e)
			setDeriveError(e.message || 'Address derivation failed')
			setAddress(null)
		}
		setLoading(false)
	}, [chain, effectivePath, isBtc, btcSelected, isTon, tonBounceable])

	// Re-derive address when BTC xpub selection or change/index changes
	// Cancellation guard prevents stale responses from overwriting current address (Finding 5)
	useEffect(() => {
		if (!isBtc || !btcSelected) return
		let cancelled = false
		const path = btcSelected.fullPath
		;(async () => {
			setLoading(true)
			setDeriveError(null)
			try {
				const params: any = { addressNList: path, showDisplay: false, coin: chain.coin }
				if (btcSelected.scriptType) params.scriptType = btcSelected.scriptType
				const result = await rpcRequest(chain.rpcMethod, params, 60000)
				if (cancelled) return
				const addr = typeof result === 'string' ? result : result?.address || String(result)
				setAddress(addr)
				setCurrentPath(path)
			} catch (e: any) {
				if (cancelled) return
				console.error(`${chain.coin} address:`, e)
				setDeriveError(e.message || 'Address derivation failed')
				setAddress(null)
			}
			setLoading(false)
		})()
		return () => { cancelled = true }
	}, [btcSelected?.scriptType, btcSelected?.fullPath?.[2], btcChangeIndex, btcAddressIndex]) // eslint-disable-line react-hooks/exhaustive-deps

	// Fetch next unused address indices from Pioneer API when xpub selection changes
	// Cancellation guard prevents stale responses from snapping to wrong index (Finding 4)
	const prevScriptRef = useMemo(() => btcAccounts.selectedXpub?.scriptType, [btcAccounts.selectedXpub?.scriptType])
	const prevAcctRef = useMemo(() => btcAccounts.selectedXpub?.accountIndex, [btcAccounts.selectedXpub?.accountIndex])
	useEffect(() => {
		if (!isBtc) return
		setBtcChangeIndex(0)
		setBtcAddressIndex(0)
		setPioneerIndices(null)
		const xpub = btcAccounts.accounts
			.find(a => a.accountIndex === (btcAccounts.selectedXpub?.accountIndex ?? 0))
			?.xpubs.find(x => x.scriptType === (btcAccounts.selectedXpub?.scriptType ?? 'p2wpkh'))
			?.xpub
		if (!xpub) return
		let cancelled = false
		rpcRequest<{ receiveIndex: number; changeIndex: number }>('getBtcAddressIndices', { xpub }, 30000)
			.then((indices) => {
				if (cancelled) return
				setPioneerIndices(indices)
				setBtcAddressIndex(indices.receiveIndex)
			})
			.catch(e => console.warn('[AssetPage] getBtcAddressIndices failed:', e.message))
		return () => { cancelled = true }
	}, [prevScriptRef, prevAcctRef]) // eslint-disable-line react-hooks/exhaustive-deps

	// When toggling Receive/Change, set index to the cached Pioneer value
	const handleBtcChangeIndex = useCallback((v: 0 | 1) => {
		setBtcChangeIndex(v)
		if (pioneerIndices) {
			setBtcAddressIndex(v === 0 ? pioneerIndices.receiveIndex : pioneerIndices.changeIndex)
		} else {
			setBtcAddressIndex(0)
		}
	}, [pioneerIndices])

	// When EVM selected index changes, update address from cached value or re-derive
	useEffect(() => {
		if (!isEvm || evmAddresses.addresses.length === 0) return
		const selected = evmAddresses.addresses.find(a => a.addressIndex === evmAddresses.selectedIndex)
		if (selected) {
			if (previousEvmSelectedIndex.current !== null && previousEvmSelectedIndex.current !== selected.addressIndex) {
				setSelectedToken(null)
			}
			previousEvmSelectedIndex.current = selected.addressIndex
			setAddress(selected.address)
			setCurrentPath([0x8000002C, 0x8000003C, 0x80000000, 0, selected.addressIndex])
		}
	}, [isEvm, evmAddresses.selectedIndex, evmAddresses.addresses])

	// Auto-derive once on mount; TON always re-derives to ensure correct bounceable flag;
	// UTXO chains always re-derive because balance.address may be empty (xpub is not an address)
	// BTC is excluded — it has its own cancellation-guarded effect (line 170) that uses
	// the selected account/script path instead of the default path.
	const isUtxo = chain.chainFamily === 'utxo'
	useEffect(() => {
		if (isBtc) return // BTC address derived by account-aware effect above
		if (isTon || isUtxo || (!address && !deriveError)) deriveAddress()
	}, []) // eslint-disable-line react-hooks/exhaustive-deps

	// Fetch xpub/zpub for non-BTC UTXO chains (Litecoin, DASH, DOGE, BCH)
	const [utxoXpub, setUtxoXpub] = useState<string | null>(null)
	useEffect(() => {
		if (!isUtxo || isBtc) return
		rpcRequest<Array<{ xpub: string }>>('getPublicKeys', {
			paths: [{
				addressNList: chain.defaultPath.slice(0, 3),
				coin: chain.coin,
				scriptType: chain.scriptType,
				curve: 'secp256k1',
			}],
		}, 30000)
			.then(result => { if (result?.[0]?.xpub) setUtxoXpub(result[0].xpub) })
			.catch(e => console.warn(`[AssetPage] ${chain.coin} xpub fetch failed:`, e))
	}, [isUtxo, isBtc, chain.coin, chain.scriptType, chain.defaultPath])

	// ── Token spam filter ──────────────────────────────────────────────
	const tokens = useMemo(() => activeBalance?.tokens || [], [activeBalance?.tokens])
	const [visibilityMap, setVisibilityMap] = useState<Record<string, TokenVisibilityStatus>>({})
	const [showHidden, setShowHidden] = useState(false)

	// Load visibility overrides + refetch on push so changes from Dashboard
	// or another AssetPage tab stay in sync without a full reload.
	useEffect(() => {
		const refetch = () => {
			rpcRequest<Record<string, TokenVisibilityStatus>>('getTokenVisibilityMap', undefined, 5000)
				.then(setVisibilityMap)
				.catch(() => {})
		}
		refetch()
		return onRpcMessage('token-visibility-changed', refetch)
	}, [])

	const { cleanTokens, spamTokens, zeroValueTokens, spamResults } = useMemo(() => {
		const overrides = new Map(
			Object.entries(visibilityMap).map(([k, v]) => [k.toLowerCase(), v] as const),
		)
		const results = new Map<string, SpamResult>()
		for (const t of tokens) {
			results.set(t.caip, detectSpamToken(t, overrides.get(t.caip?.toLowerCase()) ?? null))
		}
		const { clean, spam, zeroValue } = categorizeTokens(tokens, overrides)
		return {
			cleanTokens: clean.sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0)),
			spamTokens: spam,
			zeroValueTokens: zeroValue,
			spamResults: results,
		}
	}, [tokens, visibilityMap])

	const hiddenCount = spamTokens.length + zeroValueTokens.length
	const tokenTotalUsd = useMemo(() => cleanTokens.reduce((sum, t) => sum + (t.balanceUsd || 0), 0), [cleanTokens])
	const spamTotalUsd = useMemo(() => spamTokens.reduce((sum, t) => sum + (t.balanceUsd || 0), 0), [spamTokens])
	const cleanBalanceUsd = (activeBalance?.balanceUsd || 0) - spamTotalUsd

	const [showAddToken, setShowAddToken] = useState(false)
	const [showSwapDialog, setShowSwapDialog] = useState(false)
	const [showSweep, setShowSweep] = useState(false)
	useEffect(() => { if (!swapsEnabled) setShowSwapDialog(false) }, [swapsEnabled])
	const isEvmChain = chain.chainFamily === 'evm'

	// Toggle token visibility via RPC
	const handleSetVisibility = useCallback(async (caip: string, status: TokenVisibilityStatus) => {
		try {
			await rpcRequest('setTokenVisibility', { caip, status }, 5000)
			setVisibilityMap(prev => ({ ...prev, [caip.toLowerCase()]: status }))
		} catch (e: any) {
			console.warn('[AssetPage] setTokenVisibility failed:', e.message)
		}
	}, [])

	const handleRemoveVisibility = useCallback(async (caip: string) => {
		try {
			await rpcRequest('removeTokenVisibility', { caip }, 5000)
			setVisibilityMap(prev => {
				const next = { ...prev }
				delete next[caip.toLowerCase()]
				return next
			})
		} catch (e: any) {
			console.warn('[AssetPage] removeTokenVisibility failed:', e.message)
		}
	}, [])

	const isZcash = chain.id === 'zcash'
	const zcashShieldedDef = CHAINS.find(c => c.id === 'zcash-shielded')
	const zcashShieldedSupported = isZcash && zcashShieldedDef && isChainSupported(zcashShieldedDef, firmwareVersion)

	const PILLS: { id: AssetView | 'swap'; label: string; icon: typeof FaArrowDown }[] = [
		{ id: "receive", label: t("receive"), icon: FaArrowDown },
		{ id: "send", label: t("send"), icon: FaArrowUp },
		...(swapsEnabled && swappableChainIds.has(chain.id) ? [{ id: "swap" as const, label: t("swap"), icon: FaExchangeAlt }] : []),
		...(zcashPrivacyEnabled && zcashShieldedSupported ? [{ id: "privacy" as const, label: t("privacy"), icon: FaShieldAlt }] : []),
	]

	// Shared token row renderer
	const renderTokenRow = (tok: TokenBalance, opts?: { showSpamBadge?: boolean; showActions?: boolean }) => {
		const spamResult = spamResults.get(tok.caip)
		const override = visibilityMap[tok.caip?.toLowerCase()]
		const isUserHidden = override === 'hidden'
		const isUserSafe = override === 'visible'

		return (
			<Box
				key={tok.caip}
				w="100%"
				py="2"
				px="3"
				bg="kk.cardBg"
				border="1px solid"
				borderColor={
					isUserHidden ? "red.900"
					: spamResult?.isSpam ? "orange.900"
					: tok.balanceUsd > 0 ? `${chain.color}30`
					: "kk.border"
				}
				borderRadius="lg"
				transition="all 0.15s"
				opacity={isUserHidden ? 0.5 : 1}
			>
				<Flex align="center" justify="space-between">
					<HStack
						gap="2"
						flex="1"
						cursor="pointer"
						_hover={{ opacity: 0.8 }}
						onClick={() => { setSelectedToken(tok); setView('send') }}
					>
						<Image
							src={tok.icon || caipToIcon(tok.caip)}
							alt={tok.symbol}
							w="24px"
							h="24px"
							borderRadius="full"
							flexShrink={0}
							bg="gray.700"
						/>
						<Box>
							<HStack gap="1">
								<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2">
									{tok.symbol}
								</Text>
								{opts?.showSpamBadge && spamResult?.level === 'confirmed' && (
									<Text fontSize="9px" bg="red.900" color="red.300" px="1" py="0.5" borderRadius="sm" lineHeight="1">
										{t("scam")}
									</Text>
								)}
								{opts?.showSpamBadge && spamResult?.level === 'possible' && !isUserSafe && (
									<Text fontSize="9px" bg="orange.900" color="orange.300" px="1" py="0.5" borderRadius="sm" lineHeight="1">
										{t("spamSuspected")}
									</Text>
								)}
								{isUserSafe && (
									<Box as={FaCheck} fontSize="9px" color="green.400" />
								)}
							</HStack>
							<Text fontSize="10px" color="kk.textMuted" lineHeight="1.2" maxW="140px" truncate>
								{tok.name}
							</Text>
							{tok.contractAddress && (
								<HStack
									gap="1"
									mt="0.5"
									cursor="pointer"
									onClick={(e) => {
										e.stopPropagation()
										navigator.clipboard.writeText(tok.contractAddress!)
										setCopiedCaip(tok.caip)
										setTimeout(() => setCopiedCaip(c => c === tok.caip ? null : c), 1500)
									}}
									_hover={{ color: "kk.textSecondary" }}
									title={`Click to copy: ${tok.contractAddress}`}
									color="kk.textMuted"
								>
									<Text fontSize="9px" fontFamily="mono" lineHeight="1.2">
										{tok.contractAddress}
									</Text>
									<Box as={copiedCaip === tok.caip ? FaCheck : FaCopy} fontSize="8px" color={copiedCaip === tok.caip ? "green.400" : "inherit"} />
								</HStack>
							)}
						</Box>
					</HStack>
					<Flex align="center" gap="1.5">
						<Box textAlign="right">
							<Text fontSize="xs" fontFamily="mono" fontWeight="500" color="white" lineHeight="1.2">
								{formatBalance(tok.balance)}
							</Text>
							{tok.balanceUsd > 0 && (
								<Text fontSize="11px" color="kk.textMuted" lineHeight="1.2">
									{fmtCompact(tok.balanceUsd)}
								</Text>
							)}
						</Box>
						{spamResult?.isSpam && !isUserSafe && (
							<IconButton
								aria-label={t("markAsSafe")}
								size="xs"
								variant="ghost"
								color="green.500"
								_hover={{ bg: "rgba(72,187,120,0.15)" }}
								onClick={(e) => { e.stopPropagation(); handleSetVisibility(tok.caip, 'visible') }}
								title={t("markAsSafe")}
							>
								<FaShieldAlt />
							</IconButton>
						)}
						{!spamResult?.isSpam && !isUserHidden && (
							<IconButton
								aria-label={t("hideToken")}
								size="xs"
								variant="ghost"
								color="kk.textMuted"
								_hover={{ color: "red.400", bg: "rgba(245,101,101,0.1)" }}
								onClick={(e) => { e.stopPropagation(); handleSetVisibility(tok.caip, 'hidden') }}
								title={t("hideToken")}
							>
								<FaEyeSlash />
							</IconButton>
						)}
						{isUserSafe && (
							<IconButton
								aria-label={t("revertToAutoDetect")}
								size="xs"
								variant="ghost"
								color="kk.textMuted"
								_hover={{ color: "orange.400", bg: "rgba(237,137,54,0.1)" }}
								onClick={(e) => { e.stopPropagation(); handleRemoveVisibility(tok.caip) }}
								title={t("revertToAutoDetect")}
							>
								<FaEyeSlash />
							</IconButton>
						)}
						{isUserHidden && (
							<IconButton
								aria-label={t("unhide")}
								size="xs"
								variant="ghost"
								color="kk.textMuted"
								_hover={{ color: "green.400", bg: "rgba(72,187,120,0.1)" }}
								onClick={(e) => { e.stopPropagation(); handleSetVisibility(tok.caip, 'visible') }}
								title={t("unhide")}
							>
								<FaEye />
							</IconButton>
						)}
					</Flex>
				</Flex>
			</Box>
		)
	}

	return (
		<Flex flex="1" direction="column" align="center" px={{ base: "3", md: "6" }} py={{ base: "5", md: "8" }} className="v3-page-enter">
			<Box w="100%" maxW={{ base: "100%", sm: "640px", md: "880px" }}>
				{/* Header — back button + chain identity hero + sync status + refresh */}
				<Flex align="center" justify="space-between" gap={{ base: "3", md: "4" }} mb="6">
					<Flex align="center" gap={{ base: "3", md: "4" }} flex="1" minW="0">
						<Box
							as="button"
							onClick={onBack}
							w="36px"
							h="36px"
							borderRadius="10px"
							bg="var(--ink-2)"
							border="1px solid var(--line)"
							color="var(--text-1)"
							display="grid"
							placeItems="center"
							cursor="pointer"
							_hover={{ bg: "var(--ink-3)", color: "var(--text-0)", borderColor: "var(--line-2)" }}
							transition="all 0.18s"
							flexShrink={0}
							className="electrobun-webkit-app-region-no-drag"
							aria-label="Back"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
								<path d="M19 12H5M12 19l-7-7 7-7"/>
							</svg>
						</Box>

						<Image
							src={getAssetIcon(chain.caip)}
							alt={chain.symbol}
							w={{ base: "44px", md: "52px" }}
							h={{ base: "44px", md: "52px" }}
							borderRadius="full"
							flexShrink={0}
							bg="var(--ink-2)"
							boxShadow={`0 0 0 1px var(--line), 0 8px 24px -8px ${chain.color}`}
						/>

						<Box flex="1" minW="0">
							<Flex align="baseline" gap="2.5">
								<Text
									fontFamily="serif"
									fontStyle="italic"
									fontWeight="400"
									fontSize={{ base: "26px", md: "34px" }}
									letterSpacing="-0.02em"
									color="var(--text-0)"
									lineHeight="1.05"
									truncate
								>
									{chain.coin}
								</Text>
								<Text fontSize={{ base: "13px", md: "15px" }} color="var(--text-3)" fontWeight="500" letterSpacing="-0.005em">{chain.symbol}</Text>
							</Flex>
							<Text fontSize="11px" fontFamily="mono" color="var(--text-3)" letterSpacing="0.02em" mt="0.5" truncate>
								{chain.caip}
							</Text>
						</Box>
					</Flex>

					<Flex direction="column" align="flex-end" gap="1.5" flexShrink={0}>
						{/* Sync status indicator */}
						{activeBalance ? (
							<Flex align="center" gap="1" color="var(--teal)">
								<Box as={FaCheck} fontSize="10px" />
								<Text fontSize="10px" fontFamily="mono" fontWeight="500">{t("synced")}</Text>
							</Flex>
						) : (
							<Flex align="center" gap="1" color="var(--rose)">
								<Box w="7px" h="7px" borderRadius="full" bg="var(--rose)" />
								<Text fontSize="10px" fontFamily="mono" fontWeight="500">{t("outOfSync")}</Text>
							</Flex>
						)}
						{/* Balance display (only when available) */}
						{activeBalance && (
							<Flex direction="column" align="flex-end" flexShrink={0} display={{ base: "none", sm: "flex" }}>
								<Text
									fontFamily="mono"
									fontSize={{ base: "16px", md: "20px" }}
									fontWeight="500"
									color="var(--text-0)"
									letterSpacing="0.01em"
									lineHeight="1.2"
								>
									{activeBalance.balance}
									<Box as="span" color="var(--text-3)" ml="1.5" fontSize={{ base: "13px", md: "15px" }}>{chain.symbol}</Box>
								</Text>
								{cleanBalanceUsd > 0 && (
									<AnimatedUsd
										value={cleanBalanceUsd}
										prefix="≈ "
										fontSize="12px"
										fontFamily="mono"
										color="var(--text-2)"
										fontWeight="400"
									/>
								)}
							</Flex>
						)}
					</Flex>

					<Box
						as="button"
						onClick={refreshing ? undefined : handleRefresh}
						disabled={refreshing}
						className="electrobun-webkit-app-region-no-drag"
						w="36px"
						h="36px"
						borderRadius="10px"
						bg="transparent"
						color={refreshing ? "var(--text-3)" : "var(--text-2)"}
						display="grid"
						placeItems="center"
						cursor={refreshing ? "default" : "pointer"}
						_hover={refreshing ? {} : { bg: "var(--ink-2)", color: "var(--text-0)" }}
						transition="all 0.18s"
						flexShrink={0}
						aria-label={String(t("refresh"))}
					>
						{refreshing ? (
							<Spinner size="xs" color="var(--gold)" />
						) : (
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
								<path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
								<path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
							</svg>
						)}
					</Box>
				</Flex>

				{/* Mobile-only balance row */}
				{activeBalance && (
					<Flex display={{ base: "flex", sm: "none" }} align="baseline" justify="space-between" mb="4" gap="3">
						<Text fontFamily="mono" fontSize="18px" fontWeight="500" color="var(--text-0)" letterSpacing="0.01em">
							{activeBalance.balance}
							<Box as="span" color="var(--text-3)" ml="1.5" fontSize="13px">{chain.symbol}</Box>
						</Text>
						{cleanBalanceUsd > 0 && (
							<AnimatedUsd value={cleanBalanceUsd} prefix="≈ " fontSize="13px" fontFamily="mono" color="var(--text-2)" fontWeight="400" />
						)}
					</Flex>
				)}

				{/* Action tabs — v3 pill toggle, gold active fill */}
				<Flex justify="center" mb="5">
					<Flex gap="2px" bg="var(--ink-2)" border="1px solid var(--line)" p="3px" borderRadius="999px">
						{PILLS.map((p) => {
							const isActive = view === p.id
							return (
								<Box
									key={p.id}
									as="button"
									className="electrobun-webkit-app-region-no-drag"
									onClick={() => {
										if (p.id === 'swap') { setShowSwapDialog(true); return }
										setView(p.id as AssetView); if (p.id === 'receive') setSelectedToken(null)
									}}
									display="flex"
									alignItems="center"
									gap="2"
									px={{ base: "5", md: "6" }}
									py="2.5"
									borderRadius="999px"
									fontSize="13px"
									fontWeight="500"
									letterSpacing="-0.005em"
									color={isActive ? "var(--ink-0)" : "var(--text-2)"}
									bg={isActive ? "var(--gold)" : "transparent"}
									_hover={isActive ? {} : { color: "var(--text-0)", bg: "var(--ink-3)" }}
									transition="all 0.18s"
									cursor="pointer"
									minW="110px"
									justifyContent="center"
								>
									<Box as={p.icon} fontSize="12px" />
									{p.label}
								</Box>
							)
						})}
					</Flex>
				</Flex>

				{/* BTC multi-account selector */}
				{isBtc && btcAccounts.accounts.length > 0 && (
					<BtcXpubSelector
						btcAccounts={btcAccounts}
						onSelectXpub={selectXpub}
						onAddAccount={addAccount}
						addingAccount={btcLoading}
					/>
				)}

				{/* EVM multi-address selector */}
				{isEvm && evmAddresses.addresses.length > 1 && (
					<EvmAddressSelector
						evmAddresses={evmAddresses}
						onSelectIndex={evmSelectIndex}
						onAddIndex={() => evmAddIndex()}
						onRemoveIndex={evmRemoveIndex}
						adding={evmLoading}
					/>
				)}
				{isEvm && evmAddresses.addresses.length === 1 && (
					<Flex mb="3" align="center" gap="2">
						<Button
							size="xs"
							variant="ghost"
							color="kk.textMuted"
							_hover={{ color: "kk.gold" }}
							onClick={() => evmAddIndex()}
							disabled={evmLoading}
							fontSize="10px"
							px="2"
						>
							<Box as={FaPlus} fontSize="9px" mr="1" /> Add Address
						</Button>
					</Flex>
				)}

				{/* Content */}
				<Box bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))" border="1px solid var(--line)" borderRadius="var(--r-lg)" p={{ base: "4", md: "6" }} minH="280px">
					{view === "send" ? (
						isBtc && !btcSelected?.xpubData ? (
							<Flex align="center" justify="center" minH="200px">
								<Spinner size="sm" color="kk.gold" mr="2" />
								<Text color="kk.textMuted" fontSize="sm">Loading BTC accounts...</Text>
							</Flex>
						) : (
						<SendForm
							chain={chain}
							address={address}
							balance={isBtc && btcSelected?.xpubData ? {
								...activeBalance!,
								balance: btcSelected.xpubData.balance,
								balanceUsd: btcSelected.xpubData.balanceUsd,
								nativeBalanceUsd: btcSelected.xpubData.balanceUsd,
							} : activeBalance}
							token={selectedToken}
							onClearToken={() => setSelectedToken(null)}
							xpubOverride={isBtc ? btcSelected?.xpubData?.xpub : undefined}
							scriptTypeOverride={isBtc ? btcSelected?.scriptType : undefined}
							evmAddressIndex={isEvm ? evmAddresses.selectedIndex : undefined}
						/>
						)
					) : view === "privacy" && isZcash && zcashPrivacyEnabled ? (
						<Suspense fallback={<Spinner size="sm" color="kk.gold" />}>
							<ZcashPrivacyTab />
						</Suspense>
					) : (
						<ReceiveView
							chain={chain}
							address={address}
							loading={loading}
							error={deriveError}
							currentPath={isBtc && btcSelected ? btcSelected.fullPath : currentPath}
							onDerive={deriveAddress}
							scriptType={effectiveScriptType}
							xpub={isBtc ? btcSelected?.xpubData?.xpub : utxoXpub ?? undefined}
							isBtc={isBtc}
							btcChangeIndex={btcChangeIndex}
							btcAddressIndex={btcAddressIndex}
							onBtcChangeIndex={handleBtcChangeIndex}
							onBtcAddressIndex={setBtcAddressIndex}
							isTon={isTon}
							tonBounceable={tonBounceable}
							onTonBounceableChange={(v) => { setTonBounceable(v); deriveAddress(undefined, v) }}
						/>
					)}
				</Box>

				{/* Staking section — Cosmos-family chains */}
				{chain.chainFamily === 'cosmos' && (chain.id === 'cosmos' || chain.id === 'osmosis') && (
					<Box mt="5" bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))" border="1px solid var(--line)" borderRadius="var(--r-lg)" p={{ base: "4", md: "6" }}>
						<Suspense fallback={<Spinner size="sm" color="kk.gold" />}>
							<StakingPanel
								chain={chain}
								address={address}
								availableBalance={activeBalance?.balance || '0'}
								watchOnly={!address}
							/>
						</Suspense>
					</Box>
				)}

				{/* Tokens Section — with spam filter */}
				{(tokens.length > 0 || isEvmChain) && (
					<Box mt="6">
						<Flex align="center" justify="space-between" mb="3" px="1">
							<Text fontSize="11px" fontWeight="500" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.18em">
								{t("tokens")}{cleanTokens.length > 0 && ` · ${cleanTokens.length}`}
							</Text>
							<HStack gap="2">
								{tokenTotalUsd > 0 && (
									<Text fontSize="12px" fontFamily="mono" color="var(--text-2)" fontWeight="500">{fmtCompact(tokenTotalUsd)}</Text>
								)}
								{isEvmChain && (
									<IconButton
										aria-label={t("addCustomToken")}
										size="xs"
										variant="ghost"
										color="var(--text-3)"
										_hover={{ color: "var(--gold)", bg: "var(--ink-2)" }}
										onClick={() => setShowAddToken(true)}
									>
										<FaPlus />
									</IconButton>
								)}
							</HStack>
						</Flex>

						<VStack gap="1.5">
							{cleanTokens.map((tok) => renderTokenRow(tok, { showSpamBadge: true }))}
						</VStack>

						{hiddenCount > 0 && (
							<Box mt="3">
								<Button
									size="xs"
									variant="ghost"
									color={showHidden ? "kk.gold" : "kk.textMuted"}
									_hover={{ color: "kk.gold", bg: "rgba(255,255,255,0.04)" }}
									onClick={() => setShowHidden(!showHidden)}
									w="100%"
									justifyContent="center"
									gap="1.5"
									py="1.5"
								>
									<Box as={showHidden ? FaEyeSlash : FaEye} fontSize="10px" />
									{showHidden ? t("hideFiltered", { count: hiddenCount }) : t("showFiltered", { count: hiddenCount })}
								</Button>

								{showHidden && (
									<VStack gap="1.5" mt="2">
										{zeroValueTokens.length > 0 && (
											<>
												<Text fontSize="10px" color="kk.textMuted" w="100%" px="1" mt="1">
													{t("zeroValueTokens", { count: zeroValueTokens.length, zeroValue: fmtCompact(0) || `${fiatSymbol}0` })}
												</Text>
												{zeroValueTokens.map((tok) => renderTokenRow(tok))}
											</>
										)}
										{spamTokens.length > 0 && (
											<>
												<Text fontSize="10px" color="orange.400" w="100%" px="1" mt="1">
													{t("suspectedSpam", { count: spamTokens.length })}
												</Text>
												{spamTokens.map((tok) => renderTokenRow(tok, { showSpamBadge: true, showActions: true }))}
											</>
										)}
									</VStack>
								)}
							</Box>
						)}
					</Box>
				)}
				{showAddToken && (
					<AddTokenDialog
						defaultChainId={chain.id}
						onClose={() => setShowAddToken(false)}
					/>
				)}
			</Box>
			{/* SwapDialog rendered outside overflow container so position:fixed works */}
			{swapsEnabled && showSwapDialog && (
				<SwapErrorBoundary>
					<Suspense fallback={null}>
						<SwapDialog
							open={showSwapDialog}
							onClose={() => setShowSwapDialog(false)}
							chain={chain}
							balance={isBtc && btcSelected?.xpubData ? {
								...activeBalance!,
								balance: btcSelected.xpubData.balance,
								balanceUsd: btcSelected.xpubData.balanceUsd,
								nativeBalanceUsd: btcSelected.xpubData.balanceUsd,
							} : activeBalance}
							address={address}
						/>
					</Suspense>
				</SwapErrorBoundary>
			)}

			{/* BTC Sweep broom — bottom left on receive tab */}
			{isBtc && view === 'receive' && (
				<Box
					as="button"
					position="fixed"
					bottom="24px"
					left="24px"
					w="40px"
					h="40px"
					borderRadius="full"
					bg="rgba(139,227,196,0.08)"
					border="1px solid"
					borderColor="rgba(139,227,196,0.18)"
					display="flex"
					alignItems="center"
					justifyContent="center"
					cursor="pointer"
					transition="all 0.2s"
					opacity={0.6}
					_hover={{
						opacity: 1,
						bg: "rgba(139,227,196,0.18)",
						borderColor: "rgba(139,227,196,0.4)",
						transform: "scale(1.08)",
					}}
					_active={{ transform: "scale(0.95)" }}
					onClick={() => setShowSweep(true)}
					zIndex={10}
					title="Sweep Scanner — find BTC on non-standard paths & higher accounts"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
						<path d="M3 21h4l-1-3-3 3z" />
						<path d="M6 18L18 6" />
						<path d="M14 6h4v4" />
						<path d="M18 2l4 4-4 4" />
					</svg>
				</Box>
			)}

			{showSweep && (
				<SweepDialog
					onClose={() => setShowSweep(false)}
					currentMaxAccountHint={btcAccounts.accounts.length > 0 ? Math.max(...btcAccounts.accounts.map(a => a.accountIndex)) : 0}
					refreshAccounts={refreshBtcAccounts}
				/>
			)}
		</Flex>
	)
}
