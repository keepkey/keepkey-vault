import { useState, useEffect, useCallback, useMemo, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { formatBalance, formatUsd } from "../lib/formatting"
import { getAsset } from "../../shared/assetLookup"
import { QrScannerOverlay } from "./QrScannerOverlay"
import type { ChainDef } from "../../shared/chains"
import type { ChainBalance, TokenBalance, BuildTxResult, BroadcastResult } from "../../shared/types"
import { validateAddress } from "../../shared/address-validation"

type SendPhase = 'input' | 'built' | 'signed' | 'broadcast'

// ── Confetti ────────────────────────────────────────────────────────────────
const CONFETTI_COLORS = ['#4CAF50', '#FFD700', '#23DCC8', '#3b82f6', '#8b5cf6', '#ec4899']
const confettiPieces = Array.from({ length: 40 }, (_, i) => ({
  id: i,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  left: `${Math.random() * 100}%`,
  delay: `${Math.random() * 2}s`,
  duration: `${2.5 + Math.random() * 2}s`,
}))

const CONFETTI_CSS = `
  @keyframes kkSendConfetti {
    0%   { transform: translateY(-20px) rotate(0deg); opacity: 1; }
    100% { transform: translateY(300px) rotate(720deg); opacity: 0; }
  }
`

interface SendFormProps {
	chain: ChainDef
	address: string | null
	balance?: ChainBalance
	token?: TokenBalance | null
	onClearToken?: () => void
	xpubOverride?: string         // BTC multi-account: use this xpub for buildTx
	scriptTypeOverride?: string   // BTC multi-account: use this scriptType for buildTx
	evmAddressIndex?: number      // EVM multi-address: derivation index for buildTx
}

export function SendForm({ chain, address, balance, token, onClearToken, xpubOverride, scriptTypeOverride, evmAddressIndex }: SendFormProps) {
	const { t } = useTranslation("send")
	const [recipient, setRecipient] = useState("")
	const [amount, setAmount] = useState("")
	const [usdAmount, setUsdAmount] = useState("")
	const [inputMode, setInputMode] = useState<'crypto' | 'usd'>('crypto')
	const [memo, setMemo] = useState("")
	const [isMax, setIsMax] = useState(false)
	const [feeLevel, setFeeLevel] = useState(5) // 1=slow, 5=avg, 10=fast

	const [phase, setPhase] = useState<SendPhase>('input')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const [buildResult, setBuildResult] = useState<BuildTxResult | null>(null)
	const [signedTx, setSignedTx] = useState<any>(null)
	const [txid, setTxid] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)
	const [showPayload, setShowPayload] = useState(false)
	const [showScanner, setShowScanner] = useState(false)

	// Reset form when token selection changes
	const tokenCaip = token?.caip ?? null
	useEffect(() => {
		setPhase('input')
		setBuildResult(null)
		setSignedTx(null)
		setTxid(null)
		setError(null)
		setRecipient("")
		setAmount("")
		setUsdAmount("")
		setMemo("")
		setIsMax(false)
	}, [tokenCaip])

	// Derived display values — token mode vs native mode
	const isTokenSend = !!(token && token.caip && !token.caip.endsWith('/slip44:501') && (token.caip.includes('erc20') || token.caip.includes('/token:') || token.caip.includes('/spl:') || token.caip.includes('/trc20:')))
	const displaySymbol = isTokenSend ? token!.symbol : chain.symbol
	const displayBalance = isTokenSend ? token!.balance : (balance?.balance || '0')

	// Basic client-side validation
	const amountNum = parseFloat(amount)
	const balanceNum = parseFloat(displayBalance)
	const exceedsBalance = !isMax && !isNaN(amountNum) && amountNum > 0 && balanceNum > 0 && amountNum > balanceNum

	// Derive per-unit USD price from available balance data
	const pricePerUnit = useMemo(() => {
		if (isTokenSend && token?.priceUsd) return token.priceUsd
		if (!isTokenSend && balance?.balanceUsd && balance.balance) {
			const bal = parseFloat(balance.balance)
			if (bal > 0) return balance.balanceUsd / bal
		}
		return 0
	}, [isTokenSend, token?.priceUsd, balance?.balanceUsd, balance?.balance])

	const hasPrice = pricePerUnit > 0

	// Bidirectional conversion: crypto → USD
	const handleCryptoChange = useCallback((v: string) => {
		setIsMax(false)
		setAmount(v)
		if (hasPrice && v) {
			const n = parseFloat(v)
			if (!isNaN(n)) setUsdAmount((n * pricePerUnit).toFixed(2))
			else setUsdAmount("")
		} else {
			setUsdAmount("")
		}
	}, [hasPrice, pricePerUnit])

	// Bidirectional conversion: USD → crypto
	const handleUsdChange = useCallback((v: string) => {
		setIsMax(false)
		setUsdAmount(v)
		if (hasPrice && v) {
			const n = parseFloat(v)
			if (!isNaN(n)) {
				const crypto = n / pricePerUnit
				setAmount(crypto < 1 ? crypto.toPrecision(8) : crypto.toFixed(8).replace(/\.?0+$/, ''))
			} else {
				setAmount("")
			}
		} else {
			setAmount("")
		}
	}, [hasPrice, pricePerUnit])

	// Swap input mode
	const toggleInputMode = useCallback(() => {
		setInputMode(prev => prev === 'crypto' ? 'usd' : 'crypto')
	}, [])

	// USD equivalent of current amount for display
	const amountUsdPreview = useMemo(() => {
		if (!hasPrice || isMax) return null
		const n = parseFloat(amount)
		if (isNaN(n) || n <= 0) return null
		return n * pricePerUnit
	}, [amount, hasPrice, pricePerUnit, isMax])

	const addressValidation = useMemo(() => {
		if (!recipient) return null
		return validateAddress(recipient, chain)
	}, [recipient, chain])

	const handleBuild = useCallback(async () => {
		if (!recipient || (!amount && !isMax)) return
		if (addressValidation && !addressValidation.valid) { setError(t(addressValidation.error!)); return }
		if (exceedsBalance) { setError(t("exceedsBalanceShort")); return }
		setLoading(true)
		setError(null)

		try {
			const result = await rpcRequest<BuildTxResult>('buildTx', {
				chainId: chain.id,
				to: recipient,
				amount: isMax ? '0' : amount,
				memo: memo || undefined,
				feeLevel,
				isMax,
				caip: isTokenSend ? token!.caip : undefined,
				tokenBalance: isTokenSend ? token!.balance : undefined,
				tokenDecimals: isTokenSend && token!.decimals != null ? token!.decimals : undefined,
				xpubOverride: xpubOverride || undefined,
				scriptTypeOverride: scriptTypeOverride || undefined,
				evmAddressIndex: evmAddressIndex,
			}, 60000)

			setBuildResult(result)
			setPhase('built')
		} catch (e: any) {
			setError(e.message || t("failedToBuild"))
		}
		setLoading(false)
	}, [chain, recipient, amount, memo, feeLevel, isMax, addressValidation, exceedsBalance, isTokenSend, token, xpubOverride, scriptTypeOverride, evmAddressIndex])

	const handleSign = useCallback(async () => {
		if (!buildResult) return
		setLoading(true)
		setError(null)

		try {
			const result = await rpcRequest(chain.signMethod, buildResult.unsignedTx, 120000)
			setSignedTx(result)
			setPhase('signed')
		} catch (e: any) {
			setError(e.message || t("signingFailed"))
		}
		setLoading(false)
	}, [chain, buildResult])

	const handleBroadcast = useCallback(async () => {
		if (!signedTx) return
		setLoading(true)
		setError(null)

		try {
			const result = await rpcRequest<BroadcastResult>('broadcastTx', {
				chainId: chain.id,
				signedTx,
			}, 60000)
			setTxid(result.txid)
			setPhase('broadcast')
		} catch (e: any) {
			setError(e.message || t("broadcastFailed"))
		}
		setLoading(false)
	}, [chain, signedTx])

	const reset = useCallback(() => {
		setPhase('input')
		setBuildResult(null)
		setSignedTx(null)
		setTxid(null)
		setError(null)
		setRecipient("")
		setAmount("")
		setUsdAmount("")
		setMemo("")
		setIsMax(false)
	}, [])

	const copyTxid = useCallback(() => {
		if (!txid) return
		navigator.clipboard.writeText(txid)
			.then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
			.catch(() => console.warn('[SendForm] Clipboard not available'))
	}, [txid])

	// Parse QR scan result — handles plain addresses and BIP-21 / EIP-681 URIs
	const handleQrScan = useCallback((data: string) => {
		setShowScanner(false)
		// Sanitize: trim, strip control chars, limit length
		const clean = data.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256)
		if (!clean) return

		// BIP-21 / EIP-681: scheme:addr?amount=X&label=Y
		const schemeMatch = clean.match(/^([a-z]+):(.+)/i)
		let addr = schemeMatch ? schemeMatch[2] : clean
		// Strip query params, extract amount/memo if present
		const qIdx = addr.indexOf('?')
		let params: URLSearchParams | null = null
		if (qIdx >= 0) {
			params = new URLSearchParams(addr.slice(qIdx + 1))
			addr = addr.slice(0, qIdx)
		}
		setRecipient(addr)
		if (params) {
			const amt = params.get('amount') || params.get('value')
			if (amt) { setAmount(amt); setIsMax(false) }
			const m = params.get('memo') || params.get('dt') || params.get('label')
			if (m) setMemo(m)
		}
	}, [])

	// Build explorer URL from assetData
	const explorerUrl = useMemo(() => {
		if (!txid) return null
		const caip = isTokenSend && token?.caip ? token.caip : chain.caip
		const asset = getAsset(caip)
		if (asset?.explorerTxLink) return asset.explorerTxLink.replace('{{txid}}', txid)
		// Fallback: try the chain's native CAIP
		const chainAsset = getAsset(chain.caip)
		if (chainAsset?.explorerTxLink) return chainAsset.explorerTxLink.replace('{{txid}}', txid)
		return null
	}, [txid, chain, token, isTokenSend])

	const truncatedTxid = useMemo(() => {
		if (!txid) return ''
		return txid
	}, [txid])

	const needsMemo = !isTokenSend && (chain.chainFamily === 'cosmos' || chain.chainFamily === 'xrp')

	return (
		<VStack gap="4" align="stretch" py="2" px="2">
			{/* Token badge — shown when sending a token */}
			{isTokenSend && (
				<Flex align="center" justify="space-between" bg="rgba(255,215,0,0.06)" border="1px solid" borderColor="kk.gold" px="3" py="2" borderRadius="lg">
					<Flex align="center" gap="2">
						<Text fontSize="xs" color="kk.gold" fontWeight="600">{t("sendingToken")}</Text>
						<Text fontSize="xs" fontWeight="600" color="kk.textPrimary">{token!.symbol}</Text>
						<Text fontSize="10px" color="kk.textMuted">{token!.name}</Text>
					</Flex>
					{onClearToken && (
						<Button size="xs" variant="ghost" color="kk.textMuted" _hover={{ color: "kk.textPrimary" }} onClick={onClearToken} px="1" minW="auto">
							&times;
						</Button>
					)}
				</Flex>
			)}

			{/* Balance display */}
			<Flex justify="space-between" align="center" bg="rgba(255,255,255,0.03)" px="3" py="2" borderRadius="lg">
				<Text fontSize="xs" color="kk.textMuted">{t("available")}</Text>
				<Flex direction="column" align="flex-end">
					<Text fontSize="sm" fontFamily="mono" color="kk.textPrimary">
						{formatBalance(displayBalance)} {displaySymbol}
					</Text>
					{hasPrice && (
						<Text fontSize="10px" fontFamily="mono" color="kk.textMuted">
							${formatUsd(parseFloat(displayBalance) * pricePerUnit)}
						</Text>
					)}
				</Flex>
			</Flex>
			{/* Gas balance hint for token sends */}
			{isTokenSend && balance && (
				<Flex justify="space-between" align="center" px="3">
					<Text fontSize="10px" color="kk.textMuted">{t("gas")} ({chain.symbol})</Text>
					<Text fontSize="10px" fontFamily="mono" color="kk.textMuted">
						{formatBalance(balance.balance)} {chain.symbol}
					</Text>
				</Flex>
			)}

			{/* Phase: Input */}
			{phase === 'input' && (
				<>
					<Box>
						<Text fontSize="xs" color="kk.textMuted" mb="1">{t("recipient")}</Text>
						<Flex gap="2">
							<Input
								value={recipient}
								onChange={(e) => setRecipient(e.target.value)}
								placeholder={t("addressPlaceholder")}
								bg="kk.bg"
								border="1px solid"
								borderColor="kk.border"
								color="kk.textPrimary"
								size="sm"
								fontFamily="mono"
								px="3"
								flex="1"
							/>
							<Button
								size="sm"
								variant="outline"
								borderColor="kk.border"
								color="kk.textSecondary"
								_hover={{ borderColor: "kk.gold", color: "kk.gold", bg: "rgba(255,215,0,0.06)" }}
								onClick={() => setShowScanner(true)}
								px="2"
								minW="36px"
								h="32px"
								title={t("scanQrCode")}
							>
								<QrIcon />
							</Button>
						</Flex>
						{addressValidation && !addressValidation.valid && (
							<Text fontSize="11px" color="kk.error" mt="1">{t(addressValidation.error!)}</Text>
						)}
					</Box>

					{/* Amount input with USD conversion */}
					<Box>
						<Flex justify="space-between" align="center" mb="1">
							<Text fontSize="xs" color="kk.textMuted">
								{inputMode === 'crypto' ? `${t("amount")} (${displaySymbol})` : `${t("amount")} (USD)`}
							</Text>
							{hasPrice && (
								<Button
									size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto" h="auto" py="0"
									_hover={{ color: "kk.gold" }}
									onClick={toggleInputMode}
									title={t("switchInput")}
								>
									<SwapIcon />
								</Button>
							)}
						</Flex>
						<Flex gap="2" align="center">
							<Box flex="1">
								<Input
									value={isMax ? 'MAX' : (inputMode === 'crypto' ? amount : usdAmount)}
									onChange={(e) => inputMode === 'crypto' ? handleCryptoChange(e.target.value) : handleUsdChange(e.target.value)}
									placeholder={inputMode === 'usd' ? '0.00' : t("amountPlaceholder")}
									bg="kk.bg"
									border="1px solid"
									borderColor="kk.border"
									color="kk.textPrimary"
									size="sm"
									fontFamily="mono"
									disabled={isMax}
									px="3"
								/>
							</Box>
							<Button
								size="sm"
								variant={isMax ? "solid" : "outline"}
								bg={isMax ? "kk.gold" : "transparent"}
								color={isMax ? "black" : "kk.textSecondary"}
								borderColor="kk.border"
								_hover={{ bg: isMax ? "kk.goldHover" : "rgba(255,255,255,0.06)" }}
								onClick={() => { setIsMax(!isMax); setAmount(""); setUsdAmount("") }}
								h="32px"
							>
								{t("max")}
							</Button>
						</Flex>

						{/* Secondary display: shows the converted value */}
						{!isMax && hasPrice && (
							<Flex mt="1" px="1" justify="space-between">
								{inputMode === 'crypto' && amountUsdPreview !== null ? (
									<Text fontSize="11px" color="kk.textMuted" fontFamily="mono">${formatUsd(amountUsdPreview)}</Text>
								) : inputMode === 'usd' && amount ? (
									<Text fontSize="11px" color="kk.textMuted" fontFamily="mono">{formatBalance(amount)} {displaySymbol}</Text>
								) : (
									<Box />
								)}
								{pricePerUnit > 0 && (
									<Text fontSize="10px" color="kk.textMuted">1 {displaySymbol} = ${formatUsd(pricePerUnit)}</Text>
								)}
							</Flex>
						)}
					</Box>

					{needsMemo && (
						<Field
							label={chain.chainFamily === 'xrp' ? t("memoLabel") : t("memoLabelShort")}
							value={memo}
							onChange={setMemo}
							placeholder={t("memoPlaceholder")}
						/>
					)}

					{chain.chainFamily === 'utxo' && (
						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">{t("feePriority")}</Text>
							<Flex gap="2">
								{[{ label: t("feeSlow"), val: 1 }, { label: t("feeNormal"), val: 5 }, { label: t("feeFast"), val: 10 }].map((opt) => (
									<Button
										key={opt.val}
										size="xs"
										flex="1"
										variant={feeLevel === opt.val ? "solid" : "outline"}
										bg={feeLevel === opt.val ? "kk.gold" : "transparent"}
										color={feeLevel === opt.val ? "black" : "kk.textSecondary"}
										borderColor="kk.border"
										_hover={{ bg: feeLevel === opt.val ? "kk.goldHover" : "rgba(255,255,255,0.06)" }}
										onClick={() => setFeeLevel(opt.val)}
									>
										{opt.label}
									</Button>
								))}
							</Flex>
						</Box>
					)}

					{exceedsBalance && (
						<Text fontSize="xs" color="kk.error">{t("exceedsBalance", { balance: formatBalance(displayBalance), symbol: displaySymbol })}</Text>
					)}

					<Button
						size="sm"
						bg="kk.gold"
						color="black"
						_hover={{ bg: "kk.goldHover" }}
						onClick={handleBuild}
						disabled={loading || !recipient || (!amount && !isMax) || (addressValidation != null && !addressValidation.valid)}
						w="full"
					>
						{loading ? t("buildingTransaction") : t("buildTransaction")}
					</Button>
				</>
			)}

			{/* Phase: Built — show fee, sign button */}
			{phase === 'built' && buildResult && (
				<>
					<Box bg="rgba(255,215,0,0.06)" border="1px solid" borderColor="kk.gold" borderRadius="lg" p="4">
						<Text fontSize="xs" color="kk.textMuted" mb="2">{t("transactionReady")}</Text>
						<Flex justify="space-between" mb="1">
							<Text fontSize="xs" color="kk.textSecondary">{t("to")}</Text>
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" maxW="250px" truncate>{recipient}</Text>
						</Flex>
						<Flex justify="space-between" mb="1">
							<Text fontSize="xs" color="kk.textSecondary">{t("amount")}</Text>
							<Flex direction="column" align="flex-end">
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{isMax ? 'MAX' : amount} {displaySymbol}</Text>
								{!isMax && amountUsdPreview !== null && (
									<Text fontSize="10px" fontFamily="mono" color="kk.textMuted">${formatUsd(amountUsdPreview)}</Text>
								)}
							</Flex>
						</Flex>
						<Flex justify="space-between">
							<Text fontSize="xs" color="kk.textSecondary">{t("fee")}</Text>
							<Flex direction="column" align="flex-end">
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{formatBalance(buildResult.fee)} {chain.symbol}</Text>
								{buildResult.feeUsd != null && buildResult.feeUsd > 0 && (
									<Text fontSize="10px" fontFamily="mono" color="kk.textMuted">${formatUsd(buildResult.feeUsd)}</Text>
								)}
							</Flex>
						</Flex>
					</Box>

					{/* Debug: hdwallet payload */}
					<Box>
						<Button
							size="xs" variant="ghost" color="kk.textMuted" w="full"
							onClick={() => setShowPayload(!showPayload)}
							_hover={{ color: "kk.textSecondary" }}
						>
							{showPayload ? t("hidePayload") : t("showPayload")}
						</Button>
						{showPayload && buildResult.unsignedTx && (
							<Box bg="rgba(0,0,0,0.3)" borderRadius="md" p="2" mt="1" maxH="300px" overflow="auto">
								<Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" whiteSpace="pre-wrap" wordBreak="break-all">
									{JSON.stringify(buildResult.unsignedTx, null, 2)}
								</Text>
							</Box>
						)}
					</Box>

					<Flex gap="2">
						<Button
							size="sm"
							flex="1"
							variant="outline"
							color="kk.textSecondary"
							borderColor="kk.border"
							_hover={{ bg: "rgba(255,255,255,0.06)" }}
							onClick={() => setPhase('input')}
						>
							{t("back", { ns: "common" })}
						</Button>
						<Button
							size="sm"
							flex="2"
							bg="kk.gold"
							color="black"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleSign}
							disabled={loading}
						>
							{loading ? t("confirmOnDevice") : t("signOnDevice")}
						</Button>
					</Flex>
				</>
			)}

			{/* Phase: Signed — show broadcast button */}
			{phase === 'signed' && signedTx && (
				<>
					<Box bg="rgba(35,220,200,0.06)" border="1px solid" borderColor="#23DCC8" borderRadius="lg" p="4">
						<Text fontSize="xs" color="#23DCC8" mb="1">{t("transactionSigned")}</Text>
						<Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" maxH="80px" overflow="auto" wordBreak="break-all">
							{typeof signedTx === 'string' ? signedTx : (signedTx?.value?.signatures?.[0]?.serializedTx || signedTx?.serializedTx || signedTx?.serialized || JSON.stringify(signedTx))}
						</Text>
					</Box>

					<Flex gap="2">
						<Button
							size="sm"
							flex="1"
							variant="outline"
							color="kk.textSecondary"
							borderColor="kk.border"
							_hover={{ bg: "rgba(255,255,255,0.06)" }}
							onClick={() => setPhase('input')}
						>
							{t("cancel", { ns: "common" })}
						</Button>
						<Button
							size="sm"
							flex="2"
							bg="#23DCC8"
							color="black"
							_hover={{ opacity: 0.9 }}
							onClick={handleBroadcast}
							disabled={loading}
						>
							{loading ? t("broadcasting") : t("broadcastTransaction")}
						</Button>
					</Flex>
				</>
			)}

			{/* Phase: Broadcast — success with confetti */}
			{phase === 'broadcast' && txid && (
				<Box position="relative" overflow="hidden" borderRadius="lg">
					<style>{CONFETTI_CSS}</style>
					{confettiPieces.map(p => (
						<Box
							key={p.id} position="absolute" w="6px" h="6px" bg={p.color}
							left={p.left} top="-6px" borderRadius="1px" transform="rotate(45deg)"
							style={{ animation: `kkSendConfetti ${p.duration} linear ${p.delay} 1 forwards` }}
						/>
					))}

					<VStack gap="3" position="relative" zIndex={1}>
						<Box bg="rgba(76,175,80,0.08)" border="1px solid" borderColor="#4CAF50" borderRadius="lg" p="3" w="full">
							<Text fontSize="xs" color="#4CAF50" fontWeight="600" mb="2">{t("sent")}</Text>
							<Flex justify="space-between" align="center" gap="2">
								<Flex align="center" gap="1" minW="0" flex="1">
									<Text fontSize="10px" color="kk.textMuted" flexShrink={0}>{t("tx")}</Text>
									<Text fontSize="10px" fontFamily="mono" color="kk.textPrimary" truncate title={txid}>
										{truncatedTxid}
									</Text>
								</Flex>
								<Button size="xs" variant="ghost" color="kk.textSecondary" onClick={copyTxid} px="1" minW="auto" h="auto" py="0.5">
									{copied ? t("copied", { ns: "common" }) : t("copy", { ns: "common" })}
								</Button>
							</Flex>
						</Box>

						<Flex gap="2" w="full">
							{explorerUrl && (
								<Button
									size="sm" flex="1" bg="#23DCC8" color="black"
									_hover={{ opacity: 0.9 }}
									onClick={() => rpcRequest('openUrl', { url: explorerUrl! }).catch(() => {})}
								>
									{t("viewInExplorer")}
								</Button>
							)}
							<Button
								size="sm" flex="1" bg="kk.gold" color="black"
								_hover={{ bg: "kk.goldHover" }}
								onClick={reset}
							>
								{t("sendAnother")}
							</Button>
						</Flex>
					</VStack>
				</Box>
			)}

			{/* Error display */}
			{error && (
				<Box bg="rgba(255,23,68,0.08)" border="1px solid" borderColor="kk.error" borderRadius="lg" p="3">
					<Text fontSize="xs" color="kk.error">{error}</Text>
				</Box>
			)}

			{/* QR Scanner overlay */}
			{showScanner && (
				<QrScannerOverlay onScan={handleQrScan} onClose={() => setShowScanner(false)} />
			)}
		</VStack>
	)
}

function SwapIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
		</svg>
	)
}

function QrIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
			<rect x="2" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
			<rect x="4" y="4" width="4" height="4" fill="currentColor" />
			<rect x="14" y="2" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
			<rect x="16" y="4" width="4" height="4" fill="currentColor" />
			<rect x="2" y="14" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="2" fill="none" />
			<rect x="4" y="16" width="4" height="4" fill="currentColor" />
			<rect x="14" y="14" width="3" height="3" fill="currentColor" />
			<rect x="19" y="14" width="3" height="3" fill="currentColor" />
			<rect x="14" y="19" width="3" height="3" fill="currentColor" />
			<rect x="19" y="19" width="3" height="3" fill="currentColor" />
		</svg>
	)
}

function Field({ label, value, onChange, placeholder, disabled }: {
	label: string; value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean
}) {
	return (
		<Box>
			<Text fontSize="xs" color="kk.textMuted" mb="1">{label}</Text>
			<Input
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				bg="kk.bg"
				border="1px solid"
				borderColor="kk.border"
				color="kk.textPrimary"
				size="sm"
				fontFamily="mono"
				disabled={disabled}
				px="3"
			/>
		</Box>
	)
}
