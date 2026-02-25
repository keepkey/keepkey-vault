import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Input, Spinner, Image } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { CustomChain, PioneerChainInfo } from "../../shared/types"

type Mode = 'browse' | 'configure' | 'manual'

interface AddChainDialogProps {
	onClose: () => void
	onAdded?: (chain: CustomChain) => void
	existingChainIds?: number[]
}

export function AddChainDialog({ onClose, onAdded, existingChainIds = [] }: AddChainDialogProps) {
	const [mode, setMode] = useState<Mode>('browse')

	// Browse mode state
	const [query, setQuery] = useState('')
	const [results, setResults] = useState<PioneerChainInfo[]>([])
	const [searching, setSearching] = useState(false)
	const [searchError, setSearchError] = useState(false)
	const searchRef = useRef<HTMLInputElement>(null)
	const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

	// Configure mode state (pre-filled from catalog)
	const [selectedChain, setSelectedChain] = useState<PioneerChainInfo | null>(null)

	// Form state (shared between configure and manual modes)
	const [chainId, setChainId] = useState('')
	const [name, setName] = useState('')
	const [symbol, setSymbol] = useState('')
	const [rpcUrl, setRpcUrl] = useState('')
	const [explorerUrl, setExplorerUrl] = useState('')
	const [loading, setLoading] = useState(false)
	const [testing, setTesting] = useState(false)
	const [tested, setTested] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const existingSet = new Set(existingChainIds)
	const chainIdNum = parseInt(chainId, 10)

	const isValidManual = chainIdNum > 0 && name.trim().length > 0 && symbol.trim().length > 0 && rpcUrl.trim().startsWith('http')
	const isValidConfigure = chainIdNum > 0 && rpcUrl.trim().startsWith('http')

	// Autofocus search input on mount
	useEffect(() => {
		if (mode === 'browse') {
			setTimeout(() => searchRef.current?.focus(), 50)
		}
	}, [mode])

	// Debounced search
	useEffect(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current)
		if (query.trim().length < 2) {
			setResults([])
			setSearching(false)
			setSearchError(false)
			return
		}
		setSearching(true)
		setSearchError(false)
		debounceRef.current = setTimeout(async () => {
			try {
				const data = await rpcRequest<PioneerChainInfo[]>('searchChains', { query: query.trim(), limit: 50 }, 15000)
				setResults(data || [])
				setSearchError(false)
			} catch {
				setResults([])
				setSearchError(true)
			}
			setSearching(false)
		}, 300)
		return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
	}, [query])

	const handleSelectChain = useCallback((chain: PioneerChainInfo) => {
		if (existingSet.has(chain.chainId)) return
		setSelectedChain(chain)
		setChainId(String(chain.chainId))
		setName(chain.name)
		setSymbol(chain.symbol)
		setExplorerUrl(chain.explorer || '')
		setRpcUrl('')
		setTested(false)
		setError(null)
		setMode('configure')
	}, [existingSet])

	const handleManualMode = useCallback(() => {
		setSelectedChain(null)
		setChainId('')
		setName('')
		setSymbol('')
		setRpcUrl('')
		setExplorerUrl('')
		setTested(false)
		setError(null)
		setMode('manual')
	}, [])

	const handleBack = useCallback(() => {
		setMode('browse')
		setError(null)
		setTested(false)
	}, [])

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
		const isValid = mode === 'configure' ? isValidConfigure : isValidManual
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
	}, [mode, isValidConfigure, isValidManual, chainIdNum, name, symbol, rpcUrl, explorerUrl, onAdded, onClose])

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Escape') {
			if (mode !== 'browse') handleBack()
			else onClose()
		}
	}, [mode, handleBack, onClose])

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
				w="560px"
				maxW="92vw"
				maxH="80vh"
				display="flex"
				flexDirection="column"
				overflow="hidden"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				{/* Header */}
				<Flex align="center" justify="space-between" px="5" pt="4" pb="3" borderBottom="1px solid" borderColor="kk.border" flexShrink={0}>
					<Flex align="center" gap="2">
						{mode !== 'browse' && (
							<Box
								as="button"
								onClick={handleBack}
								color="kk.textMuted"
								_hover={{ color: "white" }}
								cursor="pointer"
								mr="1"
							>
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
								</svg>
							</Box>
						)}
						<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
							{mode === 'browse' ? 'Add EVM Chain' : mode === 'configure' ? 'Configure Chain' : 'Add Custom Chain'}
						</Text>
					</Flex>
					<Box
						as="button"
						onClick={onClose}
						color="kk.textMuted"
						_hover={{ color: "white" }}
						cursor="pointer"
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M18 6L6 18" /><path d="M6 6l12 12" />
						</svg>
					</Box>
				</Flex>

				{/* Browse Mode */}
				{mode === 'browse' && (
					<Box display="flex" flexDirection="column" overflow="hidden" flex="1">
						{/* Search input */}
						<Box px="5" pt="3" pb="2" flexShrink={0}>
							<Flex align="center" gap="2" bg="rgba(255,255,255,0.06)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="3">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
								</svg>
								<Input
									ref={searchRef}
									placeholder="Search chains..."
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									size="sm"
									variant="unstyled"
									color="white"
									py="2"
									_placeholder={{ color: "kk.textMuted" }}
								/>
								{searching && <Spinner size="xs" color="kk.gold" />}
							</Flex>
						</Box>

						{/* Results list */}
						<Box flex="1" overflowY="auto" px="5" pb="3" minH="0" maxH="400px">
							{query.trim().length < 2 && !searching && (
								<Flex direction="column" align="center" justify="center" py="10" gap="2">
									<Text fontSize="xs" color="kk.textMuted" textAlign="center">
										Type to search 2,000+ EVM chains
									</Text>
								</Flex>
							)}

							{searchError && (
								<Flex direction="column" align="center" justify="center" py="8" gap="2">
									<Text fontSize="xs" color="red.400" textAlign="center">Catalog unavailable</Text>
									<Box
										as="button"
										fontSize="xs"
										color="kk.gold"
										textDecoration="underline"
										cursor="pointer"
										onClick={handleManualMode}
									>
										Enter chain details manually
									</Box>
								</Flex>
							)}

							{!searchError && query.trim().length >= 2 && !searching && results.length === 0 && (
								<Flex direction="column" align="center" justify="center" py="8" gap="2">
									<Text fontSize="xs" color="kk.textMuted">No chains found for "{query}"</Text>
								</Flex>
							)}

							{results.map((chain) => {
								const isAdded = existingSet.has(chain.chainId)
								return (
									<Flex
										key={chain.chainId}
										align="center"
										gap="3"
										px="3"
										py="2.5"
										borderRadius="lg"
										cursor={isAdded ? "default" : "pointer"}
										opacity={isAdded ? 0.45 : 1}
										transition="background 0.1s"
										_hover={isAdded ? {} : { bg: "rgba(255,255,255,0.06)" }}
										onClick={() => !isAdded && handleSelectChain(chain)}
									>
										<Image
											src={chain.icon}
											alt={chain.symbol}
											w="32px"
											h="32px"
											borderRadius="full"
											bg={chain.color || '#627EEA'}
											flexShrink={0}
											fallback={
												<Flex w="32px" h="32px" borderRadius="full" bg={chain.color || '#627EEA'} align="center" justify="center" flexShrink={0}>
													<Text fontSize="xs" fontWeight="700" color="white">{chain.symbol?.charAt(0) || '?'}</Text>
												</Flex>
											}
										/>
										<Box flex="1" overflow="hidden">
											<Text fontSize="sm" fontWeight="500" color="white" lineHeight="1.3" truncate>
												{chain.name}
											</Text>
											<Text fontSize="10px" color="kk.textMuted" lineHeight="1.3">
												{chain.symbol}
											</Text>
										</Box>
										{isAdded ? (
											<Text fontSize="10px" color="kk.textMuted" bg="rgba(255,255,255,0.06)" px="2" py="0.5" borderRadius="full" flexShrink={0}>
												Added
											</Text>
										) : (
											<Text fontSize="10px" color="kk.textMuted" fontFamily="mono" flexShrink={0}>
												{chain.chainId}
											</Text>
										)}
									</Flex>
								)
							})}
						</Box>

						{/* Manual entry link */}
						<Box px="5" py="3" borderTop="1px solid" borderColor="kk.border" flexShrink={0}>
							<Text fontSize="xs" color="kk.textMuted" textAlign="center">
								Chain not listed?{' '}
								<Box
									as="span"
									color="kk.gold"
									cursor="pointer"
									textDecoration="underline"
									_hover={{ color: "white" }}
									onClick={handleManualMode}
								>
									Enter manually
								</Box>
							</Text>
						</Box>
					</Box>
				)}

				{/* Configure Mode (pre-filled from catalog) */}
				{mode === 'configure' && selectedChain && (
					<Box px="5" py="4" display="flex" flexDirection="column" gap="3">
						{/* Chain identity badge */}
						<Flex align="center" gap="3" p="3" bg="rgba(255,255,255,0.04)" borderRadius="lg" border="1px solid" borderColor="kk.border">
							<Image
								src={selectedChain.icon}
								alt={selectedChain.symbol}
								w="36px"
								h="36px"
								borderRadius="full"
								bg={selectedChain.color || '#627EEA'}
								flexShrink={0}
								fallback={
									<Flex w="36px" h="36px" borderRadius="full" bg={selectedChain.color || '#627EEA'} align="center" justify="center" flexShrink={0}>
										<Text fontSize="sm" fontWeight="700" color="white">{selectedChain.symbol?.charAt(0) || '?'}</Text>
									</Flex>
								}
							/>
							<Box flex="1">
								<Text fontSize="sm" fontWeight="600" color="white" lineHeight="1.3">
									{selectedChain.name} ({selectedChain.symbol})
								</Text>
								<Text fontSize="10px" color="kk.textMuted" fontFamily="mono">
									Chain ID: {selectedChain.chainId}
								</Text>
							</Box>
						</Flex>

						{/* RPC URL (required) */}
						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">RPC URL *</Text>
							<Flex gap="2">
								<Input
									placeholder="https://rpc.example.com"
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
									autoFocus
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
						</Box>

						{/* Explorer URL (pre-filled, editable) */}
						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Explorer URL</Text>
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
							/>
						</Box>

						{error && (
							<Text fontSize="xs" color="red.400">{error}</Text>
						)}

						<Flex justify="flex-end" gap="2" pt="1">
							<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={handleBack}>
								Back
							</Button>
							<Button
								size="sm"
								bg="kk.gold"
								color="black"
								_hover={{ bg: "kk.goldHover" }}
								onClick={handleAdd}
								disabled={!isValidConfigure || loading}
							>
								{loading ? 'Adding...' : 'Add Chain'}
							</Button>
						</Flex>
					</Box>
				)}

				{/* Manual Mode (full form) */}
				{mode === 'manual' && (
					<Box px="5" py="4" display="flex" flexDirection="column" gap="3">
						<Flex gap="3">
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

						<Box>
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
							/>
						</Box>

						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">RPC URL</Text>
							<Flex gap="2">
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
						</Box>

						<Box>
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
							/>
						</Box>

						{error && (
							<Text fontSize="xs" color="red.400">{error}</Text>
						)}

						<Flex justify="flex-end" gap="2" pt="1">
							<Button size="sm" variant="ghost" color="kk.textSecondary" onClick={handleBack}>
								Back
							</Button>
							<Button
								size="sm"
								bg="kk.gold"
								color="black"
								_hover={{ bg: "kk.goldHover" }}
								onClick={handleAdd}
								disabled={!isValidManual || loading}
							>
								{loading ? 'Adding...' : 'Add Chain'}
							</Button>
						</Flex>
					</Box>
				)}
			</Box>
		</Box>
	)
}
