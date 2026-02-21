import { useState, useEffect, useCallback, useMemo } from "react"
import { Box, Flex, Text, Button, Image, VStack, HStack, IconButton } from "@chakra-ui/react"
import { FaArrowDown, FaArrowUp, FaPlus } from "react-icons/fa"
import { rpcRequest } from "../lib/rpc"
import type { ChainDef } from "../../shared/chains"
import { BTC_SCRIPT_TYPES, btcAccountPath } from "../../shared/chains"
import type { ChainBalance, TokenBalance } from "../../shared/types"
import { getAssetIcon, caipToIcon } from "../../shared/assetLookup"
import { AnimatedUsd } from "./AnimatedUsd"
import { formatBalance, formatUsd } from "../lib/formatting"
import { ReceiveView } from "./ReceiveView"
import { SendForm } from "./SendForm"
import { BtcXpubSelector } from "./BtcXpubSelector"
import { useBtcAccounts } from "../hooks/useBtcAccounts"
import { AddTokenDialog } from "./AddTokenDialog"

type AssetView = "receive" | "send"

interface AssetPageProps {
	chain: ChainDef
	balance?: ChainBalance
	onBack: () => void
}

export function AssetPage({ chain, balance, onBack }: AssetPageProps) {
	const [view, setView] = useState<AssetView>("receive")
	const [selectedToken, setSelectedToken] = useState<TokenBalance | null>(null)
	const [address, setAddress] = useState<string | null>(balance?.address || null)
	const [loading, setLoading] = useState(false)
	const [deriveError, setDeriveError] = useState<string | null>(null)
	const [currentPath, setCurrentPath] = useState<number[]>(chain.defaultPath)

	// BTC multi-account support
	const isBtc = chain.id === 'bitcoin'
	const { btcAccounts, selectXpub, addAccount, loading: btcLoading } = useBtcAccounts()

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

	// Only auto-derive once on mount, not on every address change
	useEffect(() => {
		if (!address && !deriveError) deriveAddress()
	}, []) // eslint-disable-line react-hooks/exhaustive-deps

	const tokens = balance?.tokens || []
	const tokenTotalUsd = tokens.reduce((sum, t) => sum + (t.balanceUsd || 0), 0)
	const [showAddToken, setShowAddToken] = useState(false)
	const isEvmChain = chain.chainFamily === 'evm'

	const PILLS: { id: AssetView; label: string; icon: typeof FaArrowDown }[] = [
		{ id: "receive", label: "Receive", icon: FaArrowDown },
		{ id: "send", label: "Send", icon: FaArrowUp },
	]

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
						/>
					)}
				</Box>

				{/* Tokens Section */}
				{(tokens.length > 0 || isEvmChain) && (
					<Box mt="4">
						<Flex align="center" justify="space-between" mb="2" px="1">
							<Text fontSize="xs" fontWeight="600" color="kk.textSecondary" textTransform="uppercase" letterSpacing="0.05em">
								Tokens
							</Text>
							<HStack gap="2">
								{tokens.length > 0 && (
									<Text fontSize="xs" color="kk.textMuted">{tokens.length} token{tokens.length > 1 ? 's' : ''}</Text>
								)}
								{tokenTotalUsd > 0 && (
									<Text fontSize="xs" color="kk.gold" fontWeight="500">${formatUsd(tokenTotalUsd)}</Text>
								)}
								{isEvmChain && (
									<IconButton
										aria-label="Add custom token"
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
							{tokens
								.sort((a, b) => (b.balanceUsd || 0) - (a.balanceUsd || 0))
								.map((tok) => (
								<Box
									key={tok.caip}
									w="100%"
									py="2"
									px="3"
									bg="kk.cardBg"
									border="1px solid"
									borderColor={tok.balanceUsd > 0 ? `${chain.color}30` : "kk.border"}
									borderRadius="lg"
									cursor="pointer"
									_hover={{ bg: "rgba(255,255,255,0.04)", borderColor: "kk.gold" }}
									transition="all 0.15s"
									onClick={() => { setSelectedToken(tok); setView('send') }}
								>
									<Flex align="center" justify="space-between">
										<HStack gap="2">
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
												<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.2">
													{tok.symbol}
												</Text>
												<Text fontSize="10px" color="kk.textMuted" lineHeight="1.2" maxW="140px" truncate>
													{tok.name}
												</Text>
											</Box>
										</HStack>
										<Flex align="center" gap="2">
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
											<Box as={FaArrowUp} fontSize="10px" color="kk.textMuted" />
										</Flex>
									</Flex>
								</Box>
							))}
						</VStack>
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
