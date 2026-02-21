import { useState, useCallback, useMemo } from "react"
import { Box, Flex, Text, VStack, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { formatBalance } from "../lib/formatting"
import { parseQrValue } from "../lib/qr-parse"
import { QrScannerOverlay } from "./QrScannerOverlay"
import type { ChainDef } from "../../shared/chains"
import type { ChainBalance, BuildTxResult, BroadcastResult } from "../../shared/types"

type SendPhase = 'input' | 'built' | 'signed' | 'broadcast'

interface SendFormProps {
	chain: ChainDef
	address: string | null
	balance?: ChainBalance
}

export function SendForm({ chain, address, balance }: SendFormProps) {
	const [recipient, setRecipient] = useState("")
	const [amount, setAmount] = useState("")
	const [memo, setMemo] = useState("")
	const [isMax, setIsMax] = useState(false)
	const [feeLevel, setFeeLevel] = useState(5) // 1=slow, 5=avg, 10=fast

	const [phase, setPhase] = useState<SendPhase>('input')
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const [scannerOpen, setScannerOpen] = useState(false)

	const [buildResult, setBuildResult] = useState<BuildTxResult | null>(null)
	const [signedTx, setSignedTx] = useState<any>(null)
	const [txid, setTxid] = useState<string | null>(null)
	const [copied, setCopied] = useState(false)

	const handleQrScan = useCallback((raw: string) => {
		setScannerOpen(false)
		const parsed = parseQrValue(raw)
		setRecipient(parsed.address)
		if (parsed.amount) { setAmount(parsed.amount); setIsMax(false) }
		if (parsed.memo) setMemo(parsed.memo)
	}, [])

	// Basic client-side validation
	const amountNum = parseFloat(amount)
	const balanceNum = parseFloat(balance?.balance || '0')
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
			}, 60000)

			setBuildResult(result)
			setPhase('built')
		} catch (e: any) {
			setError(e.message || 'Failed to build transaction')
		}
		setLoading(false)
	}, [chain, recipient, amount, memo, feeLevel, isMax])

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

	const needsMemo = chain.chainFamily === 'cosmos' || chain.chainFamily === 'binance' || chain.chainFamily === 'xrp'

	return (
		<VStack gap="4" align="stretch" py="2">
			{/* Balance display */}
			{balance && (
				<Flex justify="space-between" align="center" bg="rgba(255,255,255,0.03)" px="3" py="2" borderRadius="lg">
					<Text fontSize="xs" color="kk.textMuted">Available</Text>
					<Text fontSize="sm" fontFamily="mono" color="kk.textPrimary">
						{balance.balance} {chain.symbol}
					</Text>
				</Flex>
			)}

			{/* Phase: Input */}
			{phase === 'input' && (
				<>
					<Box>
					<Text fontSize="xs" color="kk.textMuted" mb="1">Recipient</Text>
					<Flex gap="1.5">
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
							flex="1"
						/>
						<Button
							size="sm"
							variant="outline"
							borderColor="kk.border"
							color="kk.textSecondary"
							_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
							onClick={() => setScannerOpen(true)}
							px="2"
							minW="auto"
							title="Scan QR code"
						>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
								<circle cx="12" cy="13" r="4"/>
							</svg>
						</Button>
					</Flex>
				</Box>
					<Flex gap="2" align="end">
						<Box flex="1">
							<Field
								label={`Amount (${chain.symbol})`}
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
						<Text fontSize="xs" color="kk.error">Amount exceeds available balance ({formatBalance(balance?.balance || '0')} {chain.symbol})</Text>
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
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{isMax ? 'MAX' : amount} {chain.symbol}</Text>
						</Flex>
						<Flex justify="space-between">
							<Text fontSize="xs" color="kk.textSecondary">Fee</Text>
							<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{formatBalance(buildResult.fee)} {chain.symbol}</Text>
						</Flex>
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
							{typeof signedTx === 'string' ? signedTx : (signedTx?.serializedTx || signedTx?.serialized || JSON.stringify(signedTx)).slice(0, 200)}...
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

			{/* Phase: Broadcast — show txid */}
			{phase === 'broadcast' && txid && (
				<>
					<Box bg="rgba(76,175,80,0.08)" border="1px solid" borderColor="#4CAF50" borderRadius="lg" p="4">
						<Text fontSize="xs" color="#4CAF50" mb="2">Transaction Broadcast Successfully</Text>
						<Flex justify="space-between" align="center">
							<Text fontSize="xs" color="kk.textMuted">TX ID</Text>
							<Button size="xs" variant="ghost" color="kk.textSecondary" onClick={copyTxid}>
								{copied ? "Copied!" : "Copy"}
							</Button>
						</Flex>
						<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">
							{txid}
						</Text>
					</Box>

					<Button
						size="sm"
						bg="kk.gold"
						color="black"
						_hover={{ bg: "kk.goldHover" }}
						onClick={reset}
						w="full"
					>
						Send Another
					</Button>
				</>
			)}

			{/* Error display */}
			{error && (
				<Box bg="rgba(255,23,68,0.08)" border="1px solid" borderColor="kk.error" borderRadius="lg" p="3">
					<Text fontSize="xs" color="kk.error">{error}</Text>
				</Box>
			)}
		</VStack>
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
			/>
		</Box>
	)
}
