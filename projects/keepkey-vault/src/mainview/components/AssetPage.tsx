import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, Button, Image, VStack, HStack, IconButton } from "@chakra-ui/react"
import { FaArrowDown, FaArrowUp, FaPlus, FaEye, FaEyeSlash, FaShieldAlt, FaCheck } from "react-icons/fa"
import { rpcRequest } from "../lib/rpc"
import type { ChainDef } from "../../shared/chains"
import { BTC_SCRIPT_TYPES, btcAccountPath } from "../../shared/chains"
import type { ChainBalance, TokenBalance, TokenVisibilityStatus } from "../../shared/types"
import { getAssetIcon, caipToIcon } from "../../shared/assetLookup"
import { AnimatedUsd } from "./AnimatedUsd"
import { formatBalance, formatUsd } from "../lib/formatting"
import { ReceiveView } from "./ReceiveView"
import { SendForm } from "./SendForm"
import { BtcXpubSelector } from "./BtcXpubSelector"
import { EvmAddressSelector } from "./EvmAddressSelector"
import { useBtcAccounts } from "../hooks/useBtcAccounts"
import { useEvmAddresses } from "../hooks/useEvmAddresses"
import { AddTokenDialog } from "./AddTokenDialog"
import { detectSpamToken, type SpamResult } from "../../shared/spamFilter"

type AssetView = "receive" | "send"

interface AssetPageProps {
	chain: ChainDef
	balance?: ChainBalance
	onBack: () => void
}

export function AssetPage({ chain, balance, onBack }: AssetPageProps) {
	const { t } = useTranslation("asset")
	const [view, setView] = useState<AssetView>("receive")
	const [selectedToken, setSelectedToken] = useState<TokenBalance | null>(null)
	const [address, setAddress] = useState<string | null>(balance?.address || null)
	const [loading, setLoading] = useState(false)
	const [deriveError, setDeriveError] = useState<string | null>(null)
	const [currentPath, setCurrentPath] = useState<number[]>(chain.defaultPath)

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

	const deriveAddress = useCallback(async (path?: number[]) => {
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
			const result = await rpcRequest(chain.rpcMethod, params, 60000)
			const addr = typeof result === "string" ? result : result?.address || String(result)
			setAddress(addr)
		} catch (e: any) {
			console.error(`${chain.coin} address:`, e)
			setDeriveError(e.message || 'Address derivation failed')
			setAddress(null)
		}
		setLoading(false)
	}, [chain, effectivePath, isBtc, btcSelected])

	// Re-derive address when BTC xpub selection or change/index changes
	useEffect(() => {
		if (isBtc && btcSelected) {
			deriveAddress(btcSelected.fullPath)
		}
	}, [btcSelected?.scriptType, btcSelected?.fullPath?.[2], btcChangeIndex, btcAddressIndex]) // scriptType, account, change, or index change

	// Fetch next unused address indices from Pioneer API when xpub selection changes
	const prevScriptRef = useMemo(() => btcAccounts.selectedXpub?.scriptType, [btcAccounts.selectedXpub?.scriptType])
	const prevAcctRef = useMemo(() => btcAccounts.selectedXpub?.accountIndex, [btcAccounts.selectedXpub?.accountIndex])
	useEffect(() => {
		if (!isBtc) return
		setBtcChangeIndex(0)
		setBtcAddressIndex(0)
		setPioneerIndices(null)
		// Look up next unused indices from Pioneer API
		const xpub = btcAccounts.accounts
			.find(a => a.accountIndex === (btcAccounts.selectedXpub?.accountIndex ?? 0))
			?.xpubs.find(x => x.scriptType === (btcAccounts.selectedXpub?.scriptType ?? 'p2wpkh'))
			?.xpub
		if (xpub) {
			rpcRequest<{ receiveIndex: number; changeIndex: number }>('getBtcAddressIndices', { xpub }, 30000)
				.then((indices) => {
					setPioneerIndices(indices)
					// Default to receive tab → set receive index
					setBtcAddressIndex(indices.receiveIndex)
				})
				.catch(e => console.warn('[AssetPage] getBtcAddressIndices failed:', e.message))
		}
	}, [prevScriptRef, prevAcctRef])

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
			// Update path to reflect the selected index
			setCurrentPath([0x8000002C, 0x8000003C, 0x80000000, 0, selected.addressIndex])
		}
	}, [isEvm, evmAddresses.selectedIndex, evmAddresses.addresses])

	// Only auto-derive once on mount, not on every address change
	useEffect(() => {
		if (!address && !deriveError) deriveAddress()
	}, []) // eslint-disable-line react-hooks/exhaustive-deps

	// ── Token spam filter ──────────────────────────────────────────────
	const tokens = useMemo(() => balance?.tokens || [], [balance?.tokens])
	const [visibilityMap, setVisibilityMap] = useState<Record<string, TokenVisibilityStatus>>({})
	const [showHidden, setShowHidden] = useState(false)

	// Load visibility overrides once on mount
	useEffect(() => {
		rpcRequest<Record<string, TokenVisibilityStatus>>('getTokenVisibilityMap', undefined, 5000)
			.then(setVisibilityMap)
			.catch(() => {})
	}, [])

	// Categorize tokens: clean (shown), spam (hidden by default), zeroValue (hidden by default)
	const { cleanTokens, spamTokens, zeroValueTokens, spamResults } = useMemo(() => {
		const clean: TokenBalance[] = []
		const spam: TokenBalance[] = []
		const zero: TokenBalance[] = []
		const results = new Map<string, SpamResult>()

		for (const t of tokens) {
			const override = visibilityMap[t.caip?.toLowerCase()] ?? null
			const result = detectSpamToken(t, override)
			results.set(t.caip, result)

			if (result.isSpam) {
				spam.push(t)
			} else if ((t.balanceUsd ?? 0) === 0) {
				zero.push(t)
			} else {
				clean.push(t)
			}
		}

		return {
			cleanTokens: clean.sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0)),
			spamTokens: spam.sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0)),
			zeroValueTokens: zero.sort((a, b) => a.symbol.localeCompare(b.symbol)),
			spamResults: results,
		}
	}, [tokens, visibilityMap])

	const hiddenCount = spamTokens.length + zeroValueTokens.length
	const tokenTotalUsd = useMemo(() => cleanTokens.reduce((sum, t) => sum + (t.balanceUsd || 0), 0), [cleanTokens])

	const [showAddToken, setShowAddToken] = useState(false)
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

	const PILLS: { id: AssetView; label: string; icon: typeof FaArrowDown }[] = [
		{ id: "receive", label: t("receive"), icon: FaArrowDown },
		{ id: "send", label: t("send"), icon: FaArrowUp },
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
									${formatUsd(tok.balanceUsd)}
								</Text>
							)}
						</Box>
						{/* Per-token actions */}
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
					{balance && (
						<Flex ml="auto" align="baseline" gap="2" flexShrink={0}>
							<Text fontSize={{ base: "xs", md: "sm" }} fontFamily="mono" color="kk.textPrimary">
								{balance.balance} {chain.symbol}
							</Text>
							{balance.balanceUsd > 0 && (
								<AnimatedUsd value={balance.balanceUsd} prefix="($" suffix=")" fontSize="xs" color="white" fontWeight="500" display={{ base: "none", sm: "block" }} />
							)}
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
								onClick={() => { setView(p.id); if (p.id === 'receive') setSelectedToken(null) }}
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
				{/* Show "+" to add first additional EVM address when only index 0 exists */}
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

				{/* Content — fixed minH prevents bounce when switching views */}
				<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p={{ base: "3", md: "5" }} minH="280px">
					{view === "receive" && (
						<ReceiveView
							chain={chain}
							address={address}
							loading={loading}
							error={deriveError}
							currentPath={isBtc && btcSelected ? btcSelected.fullPath : currentPath}
							onDerive={deriveAddress}
							scriptType={effectiveScriptType}
							xpub={isBtc ? btcSelected?.xpubData?.xpub : undefined}
							isBtc={isBtc}
							btcChangeIndex={btcChangeIndex}
							btcAddressIndex={btcAddressIndex}
							onBtcChangeIndex={handleBtcChangeIndex}
							onBtcAddressIndex={setBtcAddressIndex}
						/>
					)}
					{view === "send" && (
						<SendForm
							chain={chain}
							address={address}
							balance={balance}
							token={selectedToken}
							onClearToken={() => setSelectedToken(null)}
							xpubOverride={isBtc ? btcSelected?.xpubData?.xpub : undefined}
							scriptTypeOverride={isBtc ? btcSelected?.scriptType : undefined}
							evmAddressIndex={isEvm ? evmAddresses.selectedIndex : undefined}
						/>
					)}
				</Box>

				{/* Tokens Section — with spam filter */}
				{(tokens.length > 0 || isEvmChain) && (
					<Box mt="4">
						{/* Section header */}
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
									<Text fontSize="xs" color="kk.gold" fontWeight="500">${formatUsd(tokenTotalUsd)}</Text>
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

						{/* Clean tokens (always visible) */}
						<VStack gap="1.5">
							{cleanTokens.map((tok) => renderTokenRow(tok))}
						</VStack>

						{/* Hidden tokens toggle */}
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
										{/* Zero-value tokens */}
										{zeroValueTokens.length > 0 && (
											<>
												<Text fontSize="10px" color="kk.textMuted" w="100%" px="1" mt="1">
													{t("zeroValueTokens", { count: zeroValueTokens.length })}
												</Text>
												{zeroValueTokens.map((tok) => renderTokenRow(tok))}
											</>
										)}
										{/* Spam tokens */}
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
		</Flex>
	)
}
