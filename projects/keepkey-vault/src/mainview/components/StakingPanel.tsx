import { useCallback, useEffect, useMemo, useState } from "react"
import { Box, Button, Flex, HStack, IconButton, Input, Spinner, Text, VStack, Badge } from "@chakra-ui/react"
import { FaCoins, FaExternalLinkAlt, FaMinus, FaPlus, FaSyncAlt, FaCopy, FaCheck } from "react-icons/fa"
import type { ChainDef } from "../../shared/chains"
import type { BuildTxResult, BroadcastResult, StakingPosition } from "../../shared/types"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"

interface StakingPanelProps {
	chain: ChainDef
	address: string | null
	availableBalance: string
	watchOnly?: boolean
}

type TxPhase = "input" | "built" | "signing" | "signed" | "broadcast"

function getExplorerTxUrl(chain: ChainDef, txid: string): string | null {
	if (chain.id === "cosmos") return `https://www.mintscan.io/cosmos/tx/${txid}`
	if (chain.id === "osmosis") return `https://www.mintscan.io/osmosis/tx/${txid}`
	return null
}

function getValidatorPrefix(chainId: string): string {
	if (chainId === "osmosis") return "osmovaloper"
	if (chainId === "cosmos") return "cosmosvaloper"
	return "cosmosvaloper"
}

function getValidatorExplorerUrl(chainId: string): string | null {
	if (chainId === "osmosis") return "https://www.mintscan.io/osmosis/validators"
	if (chainId === "cosmos") return "https://www.mintscan.io/cosmos/validators"
	return null
}

function getUnbondingPeriod(chainId: string): string {
	if (chainId === "osmosis") return "14 days"
	if (chainId === "cosmos") return "21 days"
	return "21 days"
}

interface DelegateDialogProps {
	isOpen: boolean
	onClose: () => void
	chain: ChainDef
	availableBalance: string
	rewardAmount?: string
	rewardUsd?: number
	onSuccess: () => void
	watchOnly?: boolean
}

function DelegateDialog({ isOpen, onClose, chain, availableBalance, rewardAmount, rewardUsd, onSuccess, watchOnly }: DelegateDialogProps) {
	const [validatorAddress, setValidatorAddress] = useState("")
	const [amount, setAmount] = useState("")
	const [memo, setMemo] = useState("Delegation via KeepKey Vault")
	const [phase, setPhase] = useState<TxPhase>("input")
	const [buildResult, setBuildResult] = useState<BuildTxResult | null>(null)
	const [signedTx, setSignedTx] = useState<any>(null)
	const [txid, setTxid] = useState("")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [txidCopied, setTxidCopied] = useState(false)
	const [signStart, setSignStart] = useState<number | null>(null)
	const [signTimeout, setSignTimeout] = useState<NodeJS.Timeout | null>(null)

	const expectedPrefix = getValidatorPrefix(chain.id)
	const isValidValidator = validatorAddress.startsWith(expectedPrefix)

	useEffect(() => {
		if (!isOpen) return
		setValidatorAddress("")
		setAmount("")
		setMemo("Delegation via KeepKey Vault")
		setPhase("input")
		setBuildResult(null)
		setSignedTx(null)
		setTxid("")
		setError(null)
		setLoading(false)
		setTxidCopied(false)
		setSignStart(null)
		if (signTimeout) clearTimeout(signTimeout)
		setSignTimeout(null)
	}, [isOpen])

	const canBuild = amount && parseFloat(amount) > 0 && isValidValidator && parseFloat(amount) <= parseFloat(availableBalance)

	const handleBuild = useCallback(async () => {
		if (!canBuild || watchOnly) return
		setLoading(true)
		setError(null)
		try {
			const result = await rpcRequest<BuildTxResult>('buildDelegateTx', {
				chainId: chain.id,
				validatorAddress: validatorAddress.trim(),
				amount,
				memo: memo || undefined,
			}, 60000)
			setBuildResult(result)
			setPhase("built")
		} catch (e: any) {
			setError(e.message || "Failed to build delegation transaction")
		}
		setLoading(false)
	}, [canBuild, watchOnly, chain.id, validatorAddress, amount, memo])

	const handleSign = useCallback(async () => {
		if (!buildResult || watchOnly) return
		setLoading(true)
		setError(null)
		setPhase("signing")
		const start = Date.now()
		setSignStart(start)
		if (signTimeout) clearTimeout(signTimeout)
		const timeout = setTimeout(() => {
			setError("Still waiting for device confirmation. Make sure your KeepKey is unlocked and approve the transaction on the device.")
		}, 120000)
		setSignTimeout(timeout)
		try {
			const result = await rpcRequest(chain.signMethod as any, buildResult.unsignedTx, 120000)
			setSignedTx(result)
			setPhase("signed")
		} catch (e: any) {
			setError(e.message || "Signing failed")
			setPhase("built")
		}
		setLoading(false)
		if (timeout) clearTimeout(timeout)
		setSignTimeout(null)
	}, [buildResult, watchOnly, chain])

	const handleBroadcast = useCallback(async () => {
		if (!signedTx || watchOnly) return
		setLoading(true)
		setError(null)
		try {
			const result = await rpcRequest<BroadcastResult>('broadcastTx', {
				chainId: chain.id,
				signedTx,
			}, 60000)
			setTxid(result.txid)
			setPhase("broadcast")
			onSuccess()
		} catch (e: any) {
			setError(e.message || "Broadcast failed")
		}
		setLoading(false)
	}, [signedTx, watchOnly, chain.id, onSuccess])

	const handleOpenExplorer = useCallback(async (txidValue: string) => {
		const url = getExplorerTxUrl(chain, txidValue)
		if (!url) return
		try {
			await rpcRequest('openUrl', { url }, 5000)
		} catch {
			window.open(url, "_blank")
		}
	}, [chain])

	const handleCopyTxid = useCallback(async (txidValue: string) => {
		try {
			await navigator.clipboard.writeText(txidValue)
			setTxidCopied(true)
			setTimeout(() => setTxidCopied(false), 1500)
		} catch {
			// ignore
		}
	}, [])

	if (!isOpen) return null

	return (
		<Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={onClose}>
			<Box position="absolute" inset="0" bg="blackAlpha.700" />
			<Box position="relative" bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5" w="520px" maxW="92vw" onClick={(e) => e.stopPropagation()}>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" mb="3">Delegate {chain.symbol}</Text>

				{error && (
					<Box p="3" bg="rgba(255,0,0,0.08)" border="1px solid" borderColor="red.500" borderRadius="md" mb="3">
						<Text fontSize="xs" color="red.300">{error}</Text>
					</Box>
				)}

				{phase === "input" && (
					<VStack align="stretch" gap="3">
						<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
							<Flex justify="space-between">
								<Text fontSize="xs" color="kk.textMuted">Available</Text>
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary">{availableBalance} {chain.symbol}</Text>
							</Flex>
						</Box>

						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="2">
								Delegate to a validator to help secure the network and earn rewards. You can undelegate later, but funds are locked during the unbonding period.
							</Text>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Validator Address</Text>
							<Input
								placeholder={`${expectedPrefix}...`}
								value={validatorAddress}
								onChange={(e) => setValidatorAddress(e.target.value)}
								bg="kk.bg"
								borderColor={!validatorAddress || isValidValidator ? "kk.border" : "red.500"}
								color="white"
								fontSize="sm"
								fontFamily="mono"
							/>
							{validatorAddress && !isValidValidator && (
								<Text fontSize="10px" color="red.300" mt="1">
									Validator address must start with "{expectedPrefix}"
								</Text>
							)}
							<Box mt="2" p="3" bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="md">
								<Text fontSize="10px" color="kk.textMuted" mb="1">Top validator examples</Text>
								{chain.id === "osmosis" && (
									<VStack align="start" gap="1">
										<Button
											size="xs"
											variant="ghost"
											color="kk.textSecondary"
											fontFamily="mono"
											fontSize="10px"
											p="0"
											h="auto"
											_hover={{ color: "kk.gold" }}
											onClick={() => setValidatorAddress("osmovaloper1q5xvvmf03dx8amz66ku6z0x4u39f0aphqf42wc")}
										>
											osmovaloper1q5xvvmf03dx8amz66ku6z0x4u39f0aphqf42wc (Meria)
										</Button>
										<Button
											size="xs"
											variant="ghost"
											color="kk.textSecondary"
											fontFamily="mono"
											fontSize="10px"
											p="0"
											h="auto"
											_hover={{ color: "kk.gold" }}
											onClick={() => setValidatorAddress("osmovaloper1pxphtfhqnx9ny27d53z4052e3r76e7qq495ehm")}
										>
											osmovaloper1pxphtfhqnx9ny27d53z4052e3r76e7qq495ehm (AutoStake)
										</Button>
									</VStack>
								)}
								{chain.id === "cosmos" && (
									<VStack align="start" gap="1">
										<Button
											size="xs"
											variant="ghost"
											color="kk.textSecondary"
											fontFamily="mono"
											fontSize="10px"
											p="0"
											h="auto"
											_hover={{ color: "kk.gold" }}
											onClick={() => setValidatorAddress("cosmosvaloper1sjllsnramtg3ewxqwwrwjxfgc4n4ef9u2lcnj0")}
										>
											cosmosvaloper1sjllsnramtg3ewxqwwrwjxfgc4n4ef9u2lcnj0 (Stake.fish)
										</Button>
										<Button
											size="xs"
											variant="ghost"
											color="kk.textSecondary"
											fontFamily="mono"
											fontSize="10px"
											p="0"
											h="auto"
											_hover={{ color: "kk.gold" }}
											onClick={() => setValidatorAddress("cosmosvaloper14lultfckehtszvzw4ehu0apvsr77afvyju5zzy")}
										>
											cosmosvaloper14lultfckehtszvzw4ehu0apvsr77afvyju5zzy (DokiaCapital)
										</Button>
									</VStack>
								)}
								<Button
									size="xs"
									variant="ghost"
									color="kk.gold"
									_hover={{ color: "kk.goldHover" }}
									mt="2"
									onClick={() => {
										const url = getValidatorExplorerUrl(chain.id)
										if (url) window.open(url, "_blank")
									}}
								>
									Browse all validators
								</Button>
								{rewardAmount && (
									<Text fontSize="10px" color="kk.textMuted" mt="2">
										Rewards available: {rewardAmount} {chain.symbol}{rewardUsd && rewardUsd > 0 ? ` (~$${rewardUsd.toFixed(2)})` : ""}
									</Text>
								)}
							</Box>
						</Box>

						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Amount</Text>
							<HStack>
								<Input
									placeholder="0.00"
									value={amount}
									onChange={(e) => setAmount(e.target.value)}
									bg="kk.bg"
									borderColor="kk.border"
									color="white"
									fontSize="sm"
								/>
								<Button
									size="sm"
									variant="outline"
									borderColor="kk.border"
									color="kk.textSecondary"
									_hover={{ color: "kk.gold", borderColor: "kk.gold" }}
									onClick={() => {
										const max = Math.max(0, parseFloat(availableBalance))
										setAmount(String(max))
									}}
								>
									MAX
								</Button>
							</HStack>
						</Box>

						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Memo (optional)</Text>
							<Input
								placeholder="Delegation via KeepKey Vault"
								value={memo}
								onChange={(e) => setMemo(e.target.value)}
								bg="kk.bg"
								borderColor="kk.border"
								color="white"
								fontSize="sm"
							/>
						</Box>
					</VStack>
				)}

				{phase !== "input" && (
					<VStack align="stretch" gap="2" mb="3">
						<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
							<HStack justify="space-between">
								<Text fontSize="xs" color="kk.textMuted">Amount</Text>
								<Text fontSize="sm" color="kk.textPrimary">{amount} {chain.symbol}</Text>
							</HStack>
							<HStack justify="space-between" mt="1">
								<Text fontSize="xs" color="kk.textMuted">Validator</Text>
								<Text fontSize="10px" fontFamily="mono" color="kk.textPrimary">
									{validatorAddress.slice(0, 10)}...{validatorAddress.slice(-6)}
								</Text>
							</HStack>
						</Box>
						<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
							<Text fontSize="xs" color="kk.textMuted">Fee</Text>
							<Text fontSize="sm" color="kk.textPrimary">{buildResult?.fee} {chain.symbol}</Text>
						</Box>
					</VStack>
				)}

				{phase === "signing" && (
					<Box p="3" bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="md" mb="3">
						<Flex align="center" gap="2">
							<Spinner size="xs" color="kk.gold" />
							<Text fontSize="xs" color="kk.textPrimary" fontWeight="600">Waiting for device confirmation</Text>
						</Flex>
						<Text fontSize="xs" color="kk.textMuted" mt="1">Confirm the transaction on your KeepKey. This can take up to 2 minutes.</Text>
						{signStart && (
							<Text fontSize="10px" color="kk.textMuted" mt="1">
								Elapsed: {Math.max(0, Math.floor((Date.now() - signStart) / 1000))}s
							</Text>
						)}
						<Text fontSize="10px" color="kk.textMuted" mt="1">
							Tips: unlock device, check cable, or reconnect if prompt doesn’t appear.
						</Text>
					</Box>
				)}

				{phase === "signed" && (
					<Box p="3" bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="md" mb="3">
						<Text fontSize="xs" color="kk.textPrimary" fontWeight="600" mb="1">Signed on device</Text>
						<Text fontSize="xs" color="kk.textMuted">Review and broadcast when ready.</Text>
					</Box>
				)}

				{phase === "broadcast" && (
					<Box p="3" bg="rgba(255,215,0,0.08)" border="1px solid" borderColor="rgba(255,215,0,0.3)" borderRadius="md" mb="3">
						<Text fontSize="xs" color="kk.gold" fontWeight="600" mb="1">Delegation submitted</Text>
						{txid ? (
							<Flex justify="space-between" align="center">
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">{txid}</Text>
								<HStack gap="1">
									<IconButton
										aria-label="Copy transaction id"
										size="xs"
										variant="ghost"
										color={txidCopied ? "green.300" : "kk.gold"}
										onClick={() => handleCopyTxid(txid)}
									>
										{txidCopied ? <FaCheck /> : <FaCopy />}
									</IconButton>
									{getExplorerTxUrl(chain, txid) && (
										<IconButton
											aria-label="View transaction"
											size="xs"
											variant="ghost"
											color="kk.gold"
											onClick={() => handleOpenExplorer(txid)}
										>
											<FaExternalLinkAlt />
										</IconButton>
									)}
								</HStack>
							</Flex>
						) : (
							<Text fontSize="xs" color="kk.textMuted">Broadcasted. Txid will appear shortly.</Text>
						)}
					</Box>
				)}

				<Flex justify="flex-end" gap="2" mt="4">
					<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={onClose}>
						{phase === "broadcast" ? "Done" : "Cancel"}
					</Button>
					{phase === "input" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled={!canBuild || loading || watchOnly} onClick={handleBuild}>
							{loading ? "Building..." : "Build"}
						</Button>
					)}
					{phase === "built" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled={loading || watchOnly} onClick={handleSign}>
							{loading ? "Signing..." : "Sign"}
						</Button>
					)}
					{phase === "signing" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled>
							Signing...
						</Button>
					)}
					{phase === "signed" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled={loading || watchOnly} onClick={handleBroadcast}>
							{loading ? "Broadcasting..." : "Broadcast"}
						</Button>
					)}
				</Flex>
				{watchOnly && (
					<Text fontSize="xs" color="kk.textMuted" mt="2">Connect your device to delegate.</Text>
				)}
			</Box>
		</Box>
	)
}

interface UndelegateDialogProps {
	isOpen: boolean
	onClose: () => void
	chain: ChainDef
	delegations: StakingPosition[]
	onSuccess: () => void
	watchOnly?: boolean
}

function UndelegateDialog({ isOpen, onClose, chain, delegations, onSuccess, watchOnly }: UndelegateDialogProps) {
	const [selected, setSelected] = useState("")
	const [amount, setAmount] = useState("")
	const [memo, setMemo] = useState("Undelegation via KeepKey Vault")
	const [phase, setPhase] = useState<TxPhase>("input")
	const [buildResult, setBuildResult] = useState<BuildTxResult | null>(null)
	const [signedTx, setSignedTx] = useState<any>(null)
	const [txid, setTxid] = useState("")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [txidCopied, setTxidCopied] = useState(false)
	const [signStart, setSignStart] = useState<number | null>(null)
	const [signTimeout, setSignTimeout] = useState<NodeJS.Timeout | null>(null)

	const selectedPosition = delegations.find(d => d.validatorAddress === selected)
	const unbondingPeriod = getUnbondingPeriod(chain.id)

	useEffect(() => {
		if (!isOpen) return
		setSelected("")
		setAmount("")
		setMemo("Undelegation via KeepKey Vault")
		setPhase("input")
		setBuildResult(null)
		setSignedTx(null)
		setTxid("")
		setError(null)
		setLoading(false)
		setTxidCopied(false)
		setSignStart(null)
		if (signTimeout) clearTimeout(signTimeout)
		setSignTimeout(null)
	}, [isOpen])

	const canBuild = selectedPosition && amount && parseFloat(amount) > 0 && parseFloat(amount) <= parseFloat(selectedPosition.balance || '0')

	const handleBuild = useCallback(async () => {
		if (!canBuild || watchOnly || !selectedPosition) return
		setLoading(true)
		setError(null)
		try {
			const result = await rpcRequest<BuildTxResult>('buildUndelegateTx', {
				chainId: chain.id,
				validatorAddress: selectedPosition.validatorAddress || selected,
				amount,
				memo: memo || undefined,
			}, 60000)
			setBuildResult(result)
			setPhase("built")
		} catch (e: any) {
			setError(e.message || "Failed to build undelegation transaction")
		}
		setLoading(false)
	}, [canBuild, watchOnly, chain.id, selectedPosition, selected, amount, memo])

	const handleSign = useCallback(async () => {
		if (!buildResult || watchOnly) return
		setLoading(true)
		setError(null)
		setPhase("signing")
		const start = Date.now()
		setSignStart(start)
		if (signTimeout) clearTimeout(signTimeout)
		const timeout = setTimeout(() => {
			setError("Still waiting for device confirmation. Make sure your KeepKey is unlocked and approve the transaction on the device.")
		}, 120000)
		setSignTimeout(timeout)
		try {
			const result = await rpcRequest(chain.signMethod as any, buildResult.unsignedTx, 120000)
			setSignedTx(result)
			setPhase("signed")
		} catch (e: any) {
			setError(e.message || "Signing failed")
			setPhase("built")
		}
		setLoading(false)
		if (timeout) clearTimeout(timeout)
		setSignTimeout(null)
	}, [buildResult, watchOnly, chain])

	const handleBroadcast = useCallback(async () => {
		if (!signedTx || watchOnly) return
		setLoading(true)
		setError(null)
		try {
			const result = await rpcRequest<BroadcastResult>('broadcastTx', {
				chainId: chain.id,
				signedTx,
			}, 60000)
			setTxid(result.txid)
			setPhase("broadcast")
			onSuccess()
		} catch (e: any) {
			setError(e.message || "Broadcast failed")
		}
		setLoading(false)
	}, [signedTx, watchOnly, chain.id, onSuccess])

	const handleOpenExplorer = useCallback(async (txidValue: string) => {
		const url = getExplorerTxUrl(chain, txidValue)
		if (!url) return
		try {
			await rpcRequest('openUrl', { url }, 5000)
		} catch {
			window.open(url, "_blank")
		}
	}, [chain])

	const handleCopyTxid = useCallback(async (txidValue: string) => {
		try {
			await navigator.clipboard.writeText(txidValue)
			setTxidCopied(true)
			setTimeout(() => setTxidCopied(false), 1500)
		} catch {
			// ignore
		}
	}, [])

	if (!isOpen) return null

	return (
		<Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={onClose}>
			<Box position="absolute" inset="0" bg="blackAlpha.700" />
			<Box position="relative" bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5" w="520px" maxW="92vw" onClick={(e) => e.stopPropagation()}>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" mb="3">Undelegate {chain.symbol}</Text>

				{error && (
					<Box p="3" bg="rgba(255,0,0,0.08)" border="1px solid" borderColor="red.500" borderRadius="md" mb="3">
						<Text fontSize="xs" color="red.300">{error}</Text>
					</Box>
				)}

				{phase === "input" && (
					<VStack align="stretch" gap="3">
						<Box p="3" bg="rgba(255,215,0,0.08)" border="1px solid" borderColor="rgba(255,215,0,0.2)" borderRadius="md">
							<Text fontSize="xs" color="kk.gold" fontWeight="600">Unbonding Period: {unbondingPeriod}</Text>
							<Text fontSize="xs" color="kk.textMuted">Tokens are locked during unbonding and stop earning rewards.</Text>
						</Box>

						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Delegation</Text>
							<Box
								as="select"
								w="100%"
								p="2"
								bg="kk.bg"
								border="1px solid"
								borderColor="kk.border"
								borderRadius="md"
								color="white"
								fontSize="sm"
								value={selected}
								onChange={(e: any) => { setSelected(e.target.value); setAmount("") }}
							>
								<option value="">Select delegation...</option>
								{delegations.map((pos, idx) => (
									<option key={`${pos.validatorAddress}-${idx}`} value={pos.validatorAddress || ""} style={{ background: '#1a1a2e' }}>
										{pos.validator || 'Unknown Validator'} — {pos.balance} {pos.ticker || chain.symbol}
									</option>
								))}
							</Box>
						</Box>

						{selectedPosition && (
							<Box>
								<Text fontSize="xs" color="kk.textMuted" mb="1">Amount</Text>
								<HStack>
									<Input
										placeholder="0.00"
										value={amount}
										onChange={(e) => setAmount(e.target.value)}
										bg="kk.bg"
										borderColor="kk.border"
										color="white"
										fontSize="sm"
									/>
									<Button
										size="sm"
										variant="outline"
										borderColor="kk.border"
										color="kk.textSecondary"
										_hover={{ color: "kk.gold", borderColor: "kk.gold" }}
										onClick={() => setAmount(String(selectedPosition.balance || '0'))}
									>
										MAX
									</Button>
								</HStack>
								<Text fontSize="10px" color="kk.textMuted" mt="1">
									Available: {selectedPosition.balance} {selectedPosition.ticker || chain.symbol}
								</Text>
							</Box>
						)}

						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Memo (optional)</Text>
							<Input
								placeholder="Undelegation via KeepKey Vault"
								value={memo}
								onChange={(e) => setMemo(e.target.value)}
								bg="kk.bg"
								borderColor="kk.border"
								color="white"
								fontSize="sm"
							/>
						</Box>
					</VStack>
				)}

				{phase !== "input" && (
					<VStack align="stretch" gap="2" mb="3">
						<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
							<HStack justify="space-between">
								<Text fontSize="xs" color="kk.textMuted">Amount</Text>
								<Text fontSize="sm" color="kk.textPrimary">{amount} {chain.symbol}</Text>
							</HStack>
							{selectedPosition && (
								<HStack justify="space-between" mt="1">
									<Text fontSize="xs" color="kk.textMuted">Validator</Text>
									<Text fontSize="10px" fontFamily="mono" color="kk.textPrimary">
										{(selectedPosition.validatorAddress || '').slice(0, 10)}...{(selectedPosition.validatorAddress || '').slice(-6)}
									</Text>
								</HStack>
							)}
						</Box>
						<Box p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
							<Text fontSize="xs" color="kk.textMuted">Fee</Text>
							<Text fontSize="sm" color="kk.textPrimary">{buildResult?.fee} {chain.symbol}</Text>
						</Box>
					</VStack>
				)}

				{phase === "signing" && (
					<Box p="3" bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="md" mb="3">
						<Flex align="center" gap="2">
							<Spinner size="xs" color="kk.gold" />
							<Text fontSize="xs" color="kk.textPrimary" fontWeight="600">Waiting for device confirmation</Text>
						</Flex>
						<Text fontSize="xs" color="kk.textMuted" mt="1">Confirm the transaction on your KeepKey. This can take up to 2 minutes.</Text>
						{signStart && (
							<Text fontSize="10px" color="kk.textMuted" mt="1">
								Elapsed: {Math.max(0, Math.floor((Date.now() - signStart) / 1000))}s
							</Text>
						)}
						<Text fontSize="10px" color="kk.textMuted" mt="1">
							Tips: unlock device, check cable, or reconnect if prompt doesn’t appear.
						</Text>
					</Box>
				)}

				{phase === "signed" && (
					<Box p="3" bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="md" mb="3">
						<Text fontSize="xs" color="kk.textPrimary" fontWeight="600" mb="1">Signed on device</Text>
						<Text fontSize="xs" color="kk.textMuted">Review and broadcast when ready.</Text>
					</Box>
				)}

				{phase === "broadcast" && (
					<Box p="3" bg="rgba(255,215,0,0.08)" border="1px solid" borderColor="rgba(255,215,0,0.3)" borderRadius="md" mb="3">
						<Text fontSize="xs" color="kk.gold" fontWeight="600" mb="1">Undelegation submitted</Text>
						{txid ? (
							<Flex justify="space-between" align="center">
								<Text fontSize="xs" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all">{txid}</Text>
								<HStack gap="1">
									<IconButton
										aria-label="Copy transaction id"
										size="xs"
										variant="ghost"
										color={txidCopied ? "green.300" : "kk.gold"}
										onClick={() => handleCopyTxid(txid)}
									>
										{txidCopied ? <FaCheck /> : <FaCopy />}
									</IconButton>
									{getExplorerTxUrl(chain, txid) && (
										<IconButton
											aria-label="View transaction"
											size="xs"
											variant="ghost"
											color="kk.gold"
											onClick={() => handleOpenExplorer(txid)}
										>
											<FaExternalLinkAlt />
										</IconButton>
									)}
								</HStack>
							</Flex>
						) : (
							<Text fontSize="xs" color="kk.textMuted">Broadcasted. Txid will appear shortly.</Text>
						)}
					</Box>
				)}

				<Flex justify="flex-end" gap="2" mt="4">
					<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={onClose}>
						{phase === "broadcast" ? "Done" : "Cancel"}
					</Button>
					{phase === "input" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled={!canBuild || loading || watchOnly} onClick={handleBuild}>
							{loading ? "Building..." : "Build"}
						</Button>
					)}
					{phase === "built" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled={loading || watchOnly} onClick={handleSign}>
							{loading ? "Signing..." : "Sign"}
						</Button>
					)}
					{phase === "signing" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled>
							Signing...
						</Button>
					)}
					{phase === "signed" && (
						<Button size="sm" bg="kk.gold" color="black" _hover={{ bg: "kk.goldHover" }} disabled={loading || watchOnly} onClick={handleBroadcast}>
							{loading ? "Broadcasting..." : "Broadcast"}
						</Button>
					)}
				</Flex>
				{watchOnly && (
					<Text fontSize="xs" color="kk.textMuted" mt="2">Connect your device to undelegate.</Text>
				)}
			</Box>
		</Box>
	)
}

export function StakingPanel({ chain, address, availableBalance, watchOnly }: StakingPanelProps) {
	const [positions, setPositions] = useState<StakingPosition[]>([])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [showDelegate, setShowDelegate] = useState(false)
	const [showUndelegate, setShowUndelegate] = useState(false)

	const delegationPositions = useMemo(() => positions.filter(p => p.type === "delegation"), [positions])
	const rewardPositions = useMemo(() => positions.filter(p => p.type === "reward"), [positions])
	const totalUsd = useMemo(() => positions.reduce((sum, p) => sum + (p.valueUsd || 0), 0), [positions])
	const rewardAmount = useMemo(() => {
		const total = rewardPositions.reduce((sum, p) => sum + parseFloat(p.balance || '0'), 0)
		return total > 0 ? total.toFixed(6).replace(/\.?0+$/, '') : ''
	}, [rewardPositions])
	const rewardUsd = useMemo(() => rewardPositions.reduce((sum, p) => sum + (p.valueUsd || 0), 0), [rewardPositions])

	const loadPositions = useCallback(async () => {
		if (!address) return
		setLoading(true)
		setError(null)
		try {
			const result = await rpcRequest<StakingPosition[]>('getStakingPositions', {
				chainId: chain.id,
				address,
			}, 60000)
			setPositions(result || [])
		} catch (e: any) {
			setError(e.message || 'Failed to load staking positions')
		}
		setLoading(false)
	}, [address, chain.id])

	useEffect(() => {
		loadPositions()
	}, [loadPositions])

	return (
		<Box>
			<Flex justify="space-between" align="center" mb="3">
				<HStack gap="2">
					<Box as={FaCoins} color="kk.gold" />
					<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">Staking</Text>
					{totalUsd > 0 && (
						<Badge colorScheme="yellow" variant="subtle">${totalUsd.toFixed(2)}</Badge>
					)}
				</HStack>
				<IconButton
					aria-label="Refresh staking"
					size="xs"
					variant="ghost"
					color="kk.textMuted"
					_hover={{ color: "kk.gold" }}
					onClick={loadPositions}
					disabled={loading || !address}
				>
					<FaSyncAlt />
				</IconButton>
			</Flex>

			{error && (
				<Box p="3" bg="rgba(255,0,0,0.08)" border="1px solid" borderColor="red.500" borderRadius="md" mb="3">
					<Text fontSize="xs" color="red.300">{error}</Text>
				</Box>
			)}

			{loading ? (
				<Flex justify="center" py="6">
					<Spinner color="kk.gold" size="md" />
				</Flex>
			) : (
				<>
					<Flex gap="2" mb="4">
						<Button
							size="sm"
							bg="kk.cardBg"
							border="1px solid"
							borderColor="kk.border"
							color="kk.textSecondary"
							_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
							leftIcon={<FaPlus />}
							onClick={() => setShowDelegate(true)}
							disabled={watchOnly || !address}
						>
							Delegate
						</Button>
						<Button
							size="sm"
							bg="kk.cardBg"
							border="1px solid"
							borderColor="kk.border"
							color="kk.textSecondary"
							_hover={{ borderColor: "kk.gold", color: "kk.gold" }}
							leftIcon={<FaMinus />}
							onClick={() => setShowUndelegate(true)}
							disabled={watchOnly || delegationPositions.length === 0}
						>
							Undelegate
						</Button>
						{watchOnly && (
							<Text fontSize="xs" color="kk.textMuted" alignSelf="center">Connect device to manage staking.</Text>
						)}
					</Flex>

					{positions.length === 0 ? (
						<Box p="4" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
							<Text fontSize="sm" color="kk.textMuted">No staking positions found.</Text>
							<Text fontSize="xs" color="kk.textMuted" mt="1">Delegate {chain.symbol} to earn rewards.</Text>
						</Box>
					) : (
						<VStack align="stretch" gap="2">
							{positions.map((pos, idx) => (
								<Box key={`${pos.validatorAddress}-${idx}`} p="3" bg="kk.bg" border="1px solid" borderColor="kk.border" borderRadius="md">
									<Flex justify="space-between" align="center">
										<VStack align="start" gap="0">
											<HStack gap="2">
												<Badge
													colorScheme={pos.type === 'delegation' ? 'blue' : pos.type === 'reward' ? 'green' : 'yellow'}
													variant="subtle"
													fontSize="10px"
												>
													{pos.type}
												</Badge>
												<Text fontSize="sm" color="kk.textPrimary">{pos.balance} {pos.ticker || chain.symbol}</Text>
											</HStack>
											<Text fontSize="10px" color="kk.textMuted" fontFamily="mono">
												{pos.validator || pos.validatorAddress || 'Unknown Validator'}
											</Text>
										</VStack>
										<VStack align="end" gap="0">
											<Text fontSize="xs" color="kk.gold">${(pos.valueUsd || 0).toFixed(2)}</Text>
											{pos.status && <Text fontSize="10px" color="kk.textMuted">{pos.status}</Text>}
										</VStack>
									</Flex>
								</Box>
							))}
						</VStack>
					)}
				</>
			)}

			<DelegateDialog
				isOpen={showDelegate}
				onClose={() => setShowDelegate(false)}
				chain={chain}
				availableBalance={availableBalance}
				rewardAmount={rewardAmount || undefined}
				rewardUsd={rewardUsd || undefined}
				onSuccess={loadPositions}
				watchOnly={watchOnly}
			/>

			<UndelegateDialog
				isOpen={showUndelegate}
				onClose={() => setShowUndelegate(false)}
				chain={chain}
				delegations={delegationPositions}
				onSuccess={loadPositions}
				watchOnly={watchOnly}
			/>
		</Box>
	)
}
