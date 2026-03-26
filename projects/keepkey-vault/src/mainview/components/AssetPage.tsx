import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, Button, Image, VStack, HStack, IconButton, Spinner } from "@chakra-ui/react"
import { FaArrowDown, FaArrowUp, FaExchangeAlt, FaPlus, FaEye, FaEyeSlash, FaShieldAlt, FaCheck } from "react-icons/fa"
import { rpcRequest } from "../lib/rpc"
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
	const [address, setAddress] = useState<string | null>(balance?.address || null)
	const [loading, setLoading] = useState(false)
	const [deriveError, setDeriveError] = useState<string | null>(null)
	const [currentPath, setCurrentPath] = useState<number[]>(chain.defaultPath)

	// Single-chain refresh
	const [refreshing, setRefreshing] = useState(false)
	const [refreshedBalance, setRefreshedBalance] = useState<ChainBalance | null>(null)
	const handleRefresh = useCallback(async () => {
		setRefreshing(true)
		try {
			const updated = await rpcRequest<ChainBalance>("getBalance", { chainId: chain.id })
			setRefreshedBalance(updated)
		} catch (e) {
			console.warn(`[AssetPage] refresh ${chain.id} failed:`, e)
		} finally {
			setRefreshing(false)
		}
	}, [chain.id])

	// Use refreshed balance if available, otherwise prop
	const activeBalance = refreshedBalance || balance

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

	// BTC multi-account support
	const isBtc = chain.id === 'bitcoin'
	const { btcAccounts, selectXpub, addAccount, loading: btcLoading } = useBtcAccounts()

	// EVM multi-address support
	const isEvm = chain.chainFamily === 'evm'
	const { evmAddresses, selectIndex: evmSelectIndex, addIndex: evmAddIndex, removeIndex: evmRemoveIndex, loading: evmLoading } = useEvmAddresses()

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
	useEffect(() => {
		if (isBtc && btcSelected) {
			deriveAddress(btcSelected.fullPath)
		}
	}, [btcSelected?.scriptType, btcSelected?.fullPath?.[2], btcChangeIndex, btcAddressIndex]) // eslint-disable-line react-hooks/exhaustive-deps

	// Fetch next unused address indices from Pioneer API when xpub selection changes
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
		if (xpub) {
			rpcRequest<{ receiveIndex: number; changeIndex: number }>('getBtcAddressIndices', { xpub }, 30000)
				.then((indices) => {
					setPioneerIndices(indices)
					setBtcAddressIndex(indices.receiveIndex)
				})
				.catch(e => console.warn('[AssetPage] getBtcAddressIndices failed:', e.message))
		}
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
			setAddress(selected.address)
			setCurrentPath([0x8000002C, 0x8000003C, 0x80000000, 0, selected.addressIndex])
		}
	}, [isEvm, evmAddresses.selectedIndex, evmAddresses.addresses])

	// Auto-derive once on mount; TON always re-derives to ensure correct bounceable flag;
	// UTXO chains always re-derive because balance.address may be empty (xpub is not an address)
	const isUtxo = chain.chainFamily === 'utxo'
	useEffect(() => {
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

	// Load visibility overrides once on mount
	useEffect(() => {
		rpcRequest<Record<string, TokenVisibilityStatus>>('getTokenVisibilityMap', undefined, 5000)
			.then(setVisibilityMap)
			.catch(() => {})
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
		<Flex flex="1" direction="column" align="center" justify="center" px={{ base: "3", md: "6" }} py="4">
			<Box w="100%" maxW={{ base: "100%", sm: "560px", md: "680px" }}>
				{/* Header */}
				<Flex align="center" gap={{ base: "2", md: "3" }} mb="1">
					<Button
						size="sm"
						variant="ghost"
						color="kk.textSecondary"
						_hover={{ color: "kk.textPrimary" }}
						onClick={onBack}
						px="2"
						minW="auto"
					>
						&larr;
					</Button>
					<Image
						src={getAssetIcon(chain.caip)}
						alt={chain.symbol}
						w="28px"
						h="28px"
						borderRadius="full"
						flexShrink={0}
						bg={chain.color}
					/>
					<Text fontSize={{ base: "md", md: "lg" }} fontWeight="600" color="kk.textPrimary">{chain.coin}</Text>
					<Text fontSize={{ base: "xs", md: "sm" }} color="kk.textMuted">{chain.symbol}</Text>
					{activeBalance && (
						<Flex ml="auto" align="center" gap="2" flexShrink={0}>
							<Text fontSize={{ base: "xs", md: "sm" }} fontFamily="mono" color="kk.textPrimary">
								{activeBalance.balance} {chain.symbol}
							</Text>
							{cleanBalanceUsd > 0 && (
								<AnimatedUsd value={cleanBalanceUsd} prefix="(" suffix=")" fontSize="xs" fontWeight="500" display={{ base: "none", sm: "block" }} />
							)}
							<Box
								as="button"
								px="2.5"
								py="1"
								fontSize="11px"
								fontWeight="600"
								color={refreshing ? "kk.textMuted" : "kk.gold"}
								bg="transparent"
								borderRadius="full"
								cursor={refreshing ? "default" : "pointer"}
								transition="all 0.2s"
								_hover={refreshing ? {} : { color: "white", bg: "rgba(192,168,96,0.12)" }}
								onClick={refreshing ? undefined : handleRefresh}
							>
								<Flex align="center" gap="1.5">
									{refreshing ? (
										<Spinner size="xs" color="kk.gold" />
									) : (
										<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
											<path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
											<path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
										</svg>
									)}
									{refreshing ? t("refreshing") : t("refresh")}
								</Flex>
							</Box>
						</Flex>
					)}
				</Flex>
				{/* CAIP badge */}
				<Flex justify="center" mb="2">
					<Text fontSize="10px" fontFamily="mono" color="kk.textMuted" bg="rgba(255,255,255,0.04)" px="2" py="0.5" borderRadius="md">
						{chain.caip}
					</Text>
				</Flex>

				{/* Pill toggle */}
				<Flex justify="center" mb="3">
					<Flex gap="1" bg="rgba(255,255,255,0.03)" p="1" borderRadius="lg">
						{PILLS.map((p) => (
							<Button
								key={p.id}
								size="sm"
								variant="ghost"
								color={view === p.id ? "kk.gold" : "kk.textSecondary"}
								bg={view === p.id ? "rgba(255,215,0,0.1)" : "transparent"}
								_hover={{ bg: "rgba(255,255,255,0.06)" }}
								fontWeight={view === p.id ? "600" : "400"}
								fontSize="13px"
								px={{ base: "5", md: "6" }}
								py="2"
								borderRadius="md"
								onClick={() => {
									if (p.id === 'swap') { setShowSwapDialog(true); return }
									setView(p.id as AssetView); if (p.id === 'receive') setSelectedToken(null)
								}}
								display="flex"
								alignItems="center"
								gap="1.5"
								minW="100px"
								justifyContent="center"
							>
								<Box as={p.icon} fontSize="12px" />
								{p.label}
							</Button>
						))}
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
				<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p={{ base: "3", md: "5" }} minH="280px">
					{view === "send" ? (
						<SendForm
							chain={chain}
							address={address}
							balance={activeBalance}
							token={selectedToken}
							onClearToken={() => setSelectedToken(null)}
							xpubOverride={isBtc ? btcSelected?.xpubData?.xpub : undefined}
							scriptTypeOverride={isBtc ? btcSelected?.scriptType : undefined}
							evmAddressIndex={isEvm ? evmAddresses.selectedIndex : undefined}
						/>
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
					<Box mt="4" bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p={{ base: "3", md: "5" }}>
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
					<Box mt="4">
						<Flex align="center" justify="space-between" mb="2" px="1">
							<Text fontSize="xs" fontWeight="600" color="kk.textSecondary" textTransform="uppercase" letterSpacing="0.05em">
								{t("tokens")}
							</Text>
							<HStack gap="2">
								{cleanTokens.length > 0 && (
									<Text fontSize="xs" color="kk.textMuted">
										{t("tokenCount", { count: cleanTokens.length })}
									</Text>
								)}
								{tokenTotalUsd > 0 && (
									<Text fontSize="xs" color="kk.gold" fontWeight="500">{fmtCompact(tokenTotalUsd)}</Text>
								)}
								{isEvmChain && (
									<IconButton
										aria-label={t("addCustomToken")}
										size="xs"
										variant="ghost"
										color="kk.textMuted"
										_hover={{ color: "kk.gold", bg: "rgba(255,255,255,0.06)" }}
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
							balance={activeBalance}
							address={address}
						/>
					</Suspense>
				</SwapErrorBoundary>
			)}
		</Flex>
	)
}
