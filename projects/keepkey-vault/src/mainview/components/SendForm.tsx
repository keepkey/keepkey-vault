import { useState, useEffect, useCallback, useMemo, Fragment } from "react"
import { Box, Flex, Text, VStack, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { formatBalance } from "../lib/formatting"
import { getAsset } from "../../shared/assetLookup"
import { QrScannerOverlay } from "./QrScannerOverlay"
import type { ChainDef } from "../../shared/chains"
import type { ChainBalance, TokenBalance, BuildTxResult, BroadcastResult } from "../../shared/types"

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
}

export function SendForm({ chain, address, balance, token, onClearToken, xpubOverride, scriptTypeOverride }: SendFormProps) {
	const [recipient, setRecipient] = useState("")
	const [amount, setAmount] = useState("")
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
		setMemo("")
		setIsMax(false)
	}, [tokenCaip])

	// Derived display values — token mode vs native mode
	const isTokenSend = !!(token && token.caip?.includes('erc20'))
	const displaySymbol = isTokenSend ? token!.symbol : chain.symbol
	const displayBalance = isTokenSend ? token!.balance : (balance?.balance || '0')

	// Basic client-side validation
	const amountNum = parseFloat(amount)
	const balanceNum = parseFloat(displayBalance)
	const exceedsBalance = !isMax && !isNaN(amountNum) && amountNum > 0 && balanceNum > 0 && amountNum > balanceNum

	const recipientTooShort = useMemo(() => {
		if (!recipient) return false
		// Most addresses are 25+ chars; catch obvious typos
		return recipient.length > 0 && recipient.length < 10
	}, [recipient])

	const handleBuild = useCallback(async () => {
		if (!recipient || (!amount && !isMax)) return
		if (recipientTooShort) { setError('Address looks too short — please verify'); return }
		if (exceedsBalance) { setError('Amount exceeds available balance'); return }
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
			}, 60000)

			setBuildResult(result)
			setPhase('built')
		} catch (e: any) {
			setError(e.message || 'Failed to build transaction')
		}
		setLoading(false)
	}, [chain, recipient, amount, memo, feeLevel, isMax, recipientTooShort, exceedsBalance, isTokenSend, token, xpubOverride, scriptTypeOverride])

	const handleSign = useCallback(async () => {
		if (!buildResult) return
		setLoading(true)
		setError(null)

		try {
			const result = await rpcRequest(chain.signMethod, buildResult.unsignedTx, 120000)
			setSignedTx(result)
			setPhase('signed')
		} catch (e: any) {
			setError(e.message || 'Signing failed')
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
			setError(e.message || 'Broadcast failed')
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
		// BIP-21: bitcoin:addr?amount=X&label=Y  or  ethereum:addr@chainId?value=X
		const colonIdx = data.indexOf(':')
		let addr = data
		if (colonIdx > 0 && colonIdx < 12) {
			// Strip scheme prefix
			addr = data.slice(colonIdx + 1)
		}
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

	const needsMemo = !isTokenSend && (chain.chainFamily === 'cosmos' || chain.chainFamily === 'binance' || chain.chainFamily === 'xrp')

	return (
		<VStack gap="4" align="stretch" py="2" px="2">
			{/* Token badge — shown when sending a token */}
			{isTokenSend && (
				<Flex align="center" justify="space-between" bg="rgba(255,215,0,0.06)" border="1px solid" borderColor="kk.gold" px="3" py="2" borderRadius="lg">
					<Flex align="center" gap="2">
						<Text fontSize="xs" color="kk.gold" fontWeight="600">Sending Token:</Text>
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
				<Text fontSize="xs" color="kk.textMuted">Available</Text>
				<Text fontSize="sm" fontFamily="mono" color="kk.textPrimary">
					{formatBalance(displayBalance)} {displaySymbol}
				</Text>
			</Flex>
			{/* Gas balance hint for token sends */}
			{isTokenSend && balance && (
				<Flex justify="space-between" align="center" px="3">
					<Text fontSize="10px" color="kk.textMuted">Gas ({chain.symbol})</Text>
					<Text fontSize="10px" fontFamily="mono" color="kk.textMuted">
						{formatBalance(balance.balance)} {chain.symbol}
					</Text>
				</Flex>
			)}

			{/* Phase: Input */}
			{phase === 'input' && (
				<>
					<Box>
						<Text fontSize="xs" color="kk.textMuted" mb="1">Recipient</Text>
						<Flex gap="2">
							<Input
								value={recipient}
								onChange={(e) => setRecipient(e.target.value)}
								placeholder="Address"
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
								title="Scan QR code"
							>
								<QrIcon />
							</Button>
						</Flex>
					</Box>
					<Flex gap="2" align="end">
						<Box flex="1">
							<Field
								label={`Amount (${displaySymbol})`}
								value={isMax ? 'MAX' : amount}
								onChange={(v) => { setIsMax(false); setAmount(v) }}
								placeholder="0.00"
								disabled={isMax}
							/>
						</Box>
						<Button
							size="sm"
							variant={isMax ? "solid" : "outline"}
							bg={isMax ? "kk.gold" : "transparent"}
							color={isMax ? "black" : "kk.textSecondary"}
							borderColor="kk.border"
							_hover={{ bg: isMax ? "kk.goldHover" : "rgba(255,255,255,0.06)" }}
							onClick={() => { setIsMax(!isMax); setAmount("") }}
							mb="0.5"
						>
							Max
						</Button>
					</Flex>

					{needsMemo && (
						<Field
							label={chain.chainFamily === 'xrp' ? "Memo / Destination Tag" : "Memo"}
							value={memo}
							onChange={setMemo}
							placeholder="Optional"
						/>
					)}

					{chain.chainFamily === 'utxo' && (
						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Fee Priority</Text>
							<Flex gap="2">
								{[{ label: 'Slow', val: 1 }, { label: 'Normal', val: 5 }, { label: 'Fast', val: 10 }].map((opt) => (
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
						<Text fontSize="xs" color="kk.error">Amount exceeds available balance ({formatBalance(displayBalance)} {displaySymbol})</Text>
					)}

					<Button
						size="sm"
						bg="kk.gold"
						color="black"
						_hover={{ bg: "kk.goldHover" }}
						onClick={handleBuild}
						disabled={loading || !recipient || (!amount && !isMax)}
						w="full"
					>
						{loading ? "Building Transaction..." : "Build Transaction"}
					</Button>
				</>
			)}

			{/* Phase: Built — show fee, sign button */}
			{phase === 'built' && buildResult && (
				<>
					<Box bg="rgba(255,215,0,0.06)" border="1px solid" borderColor="kk.gold" borderRadius="lg" p="4">
						<Text fontSize="xs" color="kk.textMuted" mb="2">Transaction Ready</Text>
						<Flex justify="space-between" mb="1">
							<Text fontSize="xs" color="kk.textSecondary">To</Text>
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" maxW="250px" truncate>{recipient}</Text>
						</Flex>
						<Flex justify="space-between" mb="1">
							<Text fontSize="xs" color="kk.textSecondary">Amount</Text>
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{isMax ? 'MAX' : amount} {displaySymbol}</Text>
						</Flex>
						<Flex justify="space-between">
							<Text fontSize="xs" color="kk.textSecondary">Fee</Text>
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{formatBalance(buildResult.fee)} {chain.symbol}</Text>
						</Flex>
					</Box>

					{/* Debug: hdwallet payload */}
					<Box>
						<Button
							size="xs" variant="ghost" color="kk.textMuted" w="full"
							onClick={() => setShowPayload(!showPayload)}
							_hover={{ color: "kk.textSecondary" }}
						>
							{showPayload ? 'Hide' : 'Show'} hdwallet payload
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
							Back
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
							{loading ? "Confirm on Device..." : "Sign on Device"}
						</Button>
					</Flex>
				</>
			)}

			{/* Phase: Signed — show broadcast button */}
			{phase === 'signed' && signedTx && (
				<>
					<Box bg="rgba(35,220,200,0.06)" border="1px solid" borderColor="#23DCC8" borderRadius="lg" p="4">
						<Text fontSize="xs" color="#23DCC8" mb="1">Transaction Signed</Text>
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
							Cancel
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
							{loading ? "Broadcasting..." : "Broadcast Transaction"}
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
							<Text fontSize="xs" color="#4CAF50" fontWeight="600" mb="2">Sent!</Text>
							<Flex justify="space-between" align="center" gap="2">
								<Flex align="center" gap="1" minW="0" flex="1">
									<Text fontSize="10px" color="kk.textMuted" flexShrink={0}>TX</Text>
									<Text fontSize="10px" fontFamily="mono" color="kk.textPrimary" truncate title={txid}>
										{truncatedTxid}
									</Text>
								</Flex>
								<Button size="xs" variant="ghost" color="kk.textSecondary" onClick={copyTxid} px="1" minW="auto" h="auto" py="0.5">
									{copied ? "Copied" : "Copy"}
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
									View in Explorer
								</Button>
							)}
							<Button
								size="sm" flex="1" bg="kk.gold" color="black"
								_hover={{ bg: "kk.goldHover" }}
								onClick={reset}
							>
								Send Another
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
