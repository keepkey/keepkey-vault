import { useState, useCallback } from "react"
import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { CustomChain } from "../../shared/types"

interface AddChainDialogProps {
	onClose: () => void
	onAdded?: (chain: CustomChain) => void
}

export function AddChainDialog({ onClose, onAdded }: AddChainDialogProps) {
	const [chainId, setChainId] = useState('')
	const [name, setName] = useState('')
	const [symbol, setSymbol] = useState('')
	const [rpcUrl, setRpcUrl] = useState('')
	const [explorerUrl, setExplorerUrl] = useState('')
	const [loading, setLoading] = useState(false)
	const [testing, setTesting] = useState(false)
	const [tested, setTested] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const chainIdNum = parseInt(chainId, 10)
	const isValid = chainIdNum > 0 && name.trim().length > 0 && symbol.trim().length > 0 && rpcUrl.trim().startsWith('http')

	const handleTest = useCallback(async () => {
		setTesting(true)
		setError(null)
		setTested(false)
		try {
			const resp = await fetch(rpcUrl.trim(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
			})
			const json = await resp.json() as { result?: string; error?: { message: string } }
			if (json.error) throw new Error(json.error.message)
			const returnedId = Number(BigInt(json.result || '0x0'))
			if (returnedId !== chainIdNum) {
				throw new Error(`RPC returned chainId ${returnedId}, expected ${chainIdNum}`)
			}
			setTested(true)
		} catch (e: any) {
			setError(e.message || 'Connection failed')
		}
		setTesting(false)
	}, [rpcUrl, chainIdNum])

	const handleAdd = useCallback(async () => {
		if (!isValid) return
		setLoading(true)
		setError(null)
		try {
			const chain: CustomChain = {
				chainId: chainIdNum,
				name: name.trim(),
				symbol: symbol.trim().toUpperCase(),
				rpcUrl: rpcUrl.trim(),
				explorerUrl: explorerUrl.trim() || undefined,
			}
			await rpcRequest('addCustomChain', chain, 10000)
			onAdded?.(chain)
			onClose()
		} catch (e: any) {
			setError(e.message || 'Failed to add chain')
		}
		setLoading(false)
	}, [isValid, chainIdNum, name, symbol, rpcUrl, explorerUrl, onAdded, onClose])

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Escape') onClose()
	}, [onClose])

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
				onKeyDown={handleKeyDown}
			>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" mb="3">
					Add Custom EVM Chain
				</Text>

				<Flex gap="3" mb="3">
					<Box flex="1">
						<Text fontSize="xs" color="kk.textMuted" mb="1">Chain ID</Text>
						<Input
							placeholder="e.g. 324"
							value={chainId}
							onChange={(e) => { setChainId(e.target.value.replace(/\D/g, '')); setTested(false); setError(null) }}
							size="sm"
							bg="rgba(255,255,255,0.06)"
							border="1px solid"
							borderColor="kk.border"
							color="white"
							fontFamily="mono"
							autoFocus
						/>
					</Box>
					<Box flex="2">
						<Text fontSize="xs" color="kk.textMuted" mb="1">Chain Name</Text>
						<Input
							placeholder="e.g. zkSync Era"
							value={name}
							onChange={(e) => setName(e.target.value)}
							size="sm"
							bg="rgba(255,255,255,0.06)"
							border="1px solid"
							borderColor="kk.border"
							color="white"
						/>
					</Box>
				</Flex>

				<Text fontSize="xs" color="kk.textMuted" mb="1">Gas Token Symbol</Text>
				<Input
					placeholder="e.g. ETH"
					value={symbol}
					onChange={(e) => setSymbol(e.target.value)}
					size="sm"
					bg="rgba(255,255,255,0.06)"
					border="1px solid"
					borderColor="kk.border"
					color="white"
					mb="3"
				/>

				<Text fontSize="xs" color="kk.textMuted" mb="1">RPC URL</Text>
				<Flex gap="2" mb="3">
					<Input
						placeholder="https://..."
						value={rpcUrl}
						onChange={(e) => { setRpcUrl(e.target.value); setTested(false); setError(null) }}
						size="sm"
						bg="rgba(255,255,255,0.06)"
						border="1px solid"
						borderColor="kk.border"
						color="white"
						fontFamily="mono"
						fontSize="xs"
						flex="1"
					/>
					<Button
						size="sm"
						variant="outline"
						color={tested ? "green.400" : "kk.textSecondary"}
						borderColor={tested ? "green.400" : "kk.border"}
						onClick={handleTest}
						disabled={!rpcUrl.startsWith('http') || !chainIdNum || testing}
						minW="80px"
					>
						{testing ? 'Testing...' : tested ? 'OK' : 'Test'}
					</Button>
				</Flex>

				<Text fontSize="xs" color="kk.textMuted" mb="1">Block Explorer URL (optional)</Text>
				<Input
					placeholder="https://explorer.example.com"
					value={explorerUrl}
					onChange={(e) => setExplorerUrl(e.target.value)}
					size="sm"
					bg="rgba(255,255,255,0.06)"
					border="1px solid"
					borderColor="kk.border"
					color="white"
					fontSize="xs"
					mb="3"
				/>

				{error && (
					<Text fontSize="xs" color="red.400" mb="3">{error}</Text>
				)}

				<Flex justify="flex-end" gap="2">
					<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={onClose}>
						Cancel
					</Button>
					<Button
						size="sm"
						bg="kk.gold"
						color="black"
						_hover={{ bg: "kk.goldHover" }}
						onClick={handleAdd}
						disabled={!isValid || loading}
					>
						{loading ? 'Adding...' : 'Add Chain'}
					</Button>
				</Flex>
			</Box>
		</Box>
	)
}
