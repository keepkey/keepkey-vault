import { useState, useCallback } from "react"
import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"
import { CHAINS } from "../../shared/chains"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { CustomToken } from "../../shared/types"

interface AddTokenDialogProps {
	defaultChainId?: string
	onClose: () => void
	onAdded?: (token: CustomToken) => void
}

const evmChains = CHAINS.filter(c => c.chainFamily === 'evm')

export function AddTokenDialog({ defaultChainId, onClose, onAdded }: AddTokenDialogProps) {
	const [chainId, setChainId] = useState(defaultChainId || evmChains[0]?.id || '')
	const [contractAddress, setContractAddress] = useState('')
	const [loading, setLoading] = useState(false)
	const [result, setResult] = useState<CustomToken | null>(null)
	const [error, setError] = useState<string | null>(null)

	const isValidAddress = /^0x[a-fA-F0-9]{40}$/.test(contractAddress.trim())

	const handleLookup = useCallback(async () => {
		if (!isValidAddress) return
		setLoading(true)
		setError(null)
		setResult(null)
		try {
			const token = await rpcRequest<CustomToken>('addCustomToken', {
				chainId,
				contractAddress: contractAddress.trim(),
			}, 30000)
			setResult(token)
			onAdded?.(token)
		} catch (e: any) {
			setError(e.message || 'Failed to add token')
		}
		setLoading(false)
	}, [chainId, contractAddress, isValidAddress, onAdded])

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && isValidAddress && !loading) handleLookup()
		if (e.key === 'Escape') onClose()
	}, [handleLookup, onClose, isValidAddress, loading])

	return (
		<Box
			position="fixed"
			inset="0"
			zIndex={Z.dialog}
			display="flex"
			alignItems="center"
			justifyContent="center"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
		>
			<Box position="absolute" inset="0" bg="blackAlpha.700" />
			<Box
				position="relative"
				bg="kk.cardBg"
				border="1px solid"
				borderColor="kk.border"
				borderRadius="xl"
				p="5"
				w="420px"
				maxW="90vw"
				onClick={(e) => e.stopPropagation()}
			>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" mb="3">
					Add Custom Token
				</Text>

				{/* Chain selector */}
				<Text fontSize="xs" color="kk.textMuted" mb="1">Chain</Text>
				<Box
					as="select"
					w="100%"
					p="2"
					mb="3"
					bg="rgba(255,255,255,0.06)"
					border="1px solid"
					borderColor="kk.border"
					borderRadius="md"
					color="white"
					fontSize="sm"
					value={chainId}
					onChange={(e: any) => { setChainId(e.target.value); setResult(null); setError(null) }}
				>
					{evmChains.map(c => (
						<option key={c.id} value={c.id} style={{ background: '#1a1a2e' }}>
							{c.coin} ({c.symbol})
						</option>
					))}
				</Box>

				{/* Contract address */}
				<Text fontSize="xs" color="kk.textMuted" mb="1">Contract Address</Text>
				<Input
					placeholder="0x..."
					value={contractAddress}
					onChange={(e) => { setContractAddress(e.target.value); setResult(null); setError(null) }}
					onKeyDown={handleKeyDown}
					size="sm"
					bg="rgba(255,255,255,0.06)"
					border="1px solid"
					borderColor="kk.border"
					color="white"
					fontFamily="mono"
					fontSize="xs"
					mb="3"
					autoFocus
				/>

				{/* Result */}
				{result && (
					<Box p="3" bg="rgba(255,215,0,0.08)" borderRadius="md" mb="3">
						<Text fontSize="sm" fontWeight="600" color="kk.gold">{result.symbol}</Text>
						<Text fontSize="xs" color="kk.textMuted">{result.name}</Text>
						<Text fontSize="xs" color="kk.textMuted">{result.decimals} decimals</Text>
					</Box>
				)}

				{error && (
					<Text fontSize="xs" color="red.400" mb="3">{error}</Text>
				)}

				{/* Actions */}
				<Flex justify="flex-end" gap="2">
					<Button
						size="sm"
						variant="ghost"
						color="kk.textSecondary"
						onClick={onClose}
					>
						{result ? 'Done' : 'Cancel'}
					</Button>
					{!result && (
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handleLookup}
							disabled={!isValidAddress || loading}
						>
							{loading ? 'Looking up...' : 'Add Token'}
						</Button>
					)}
				</Flex>
			</Box>
		</Box>
	)
}
