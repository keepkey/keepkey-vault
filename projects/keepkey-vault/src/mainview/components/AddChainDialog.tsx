import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Flex, Text, Button, Input, Spinner, Image } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { CustomChain, PioneerChainInfo } from "../../shared/types"

type Mode = 'browse' | 'configure' | 'manual'
const PAGE_SIZE = 20

interface BrowseResult {
	chains: PioneerChainInfo[]
	total: number
	page: number
	pageSize: number
}

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
	const [total, setTotal] = useState(0)
	const [page, setPage] = useState(0)
	const [loading, setLoading] = useState(true)
	const [browseError, setBrowseError] = useState(false)
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
	const [explorerAddressLink, setExplorerAddressLink] = useState('')
	const [explorerTxLink, setExplorerTxLink] = useState('')
	const [saving, setSaving] = useState(false)
	const [testing, setTesting] = useState(false)
	const [tested, setTested] = useState(false)
	const [error, setError] = useState<string | null>(null)

	// Multi-RPC status: url → 'pending' | 'testing' | 'ok' | 'fail'
	const [rpcStatuses, setRpcStatuses] = useState<Record<string, 'pending' | 'testing' | 'ok' | 'fail'>>({})

	const existingSet = new Set(existingChainIds)
	const chainIdNum = parseInt(chainId, 10)
	const totalPages = Math.ceil(total / PAGE_SIZE)

	const isValidManual = chainIdNum > 0 && name.trim().length > 0 && symbol.trim().length > 0 && rpcUrl.trim().startsWith('http')
	const isValidConfigure = chainIdNum > 0 && rpcUrl.trim().startsWith('http')

	// Fetch a page of chains
	const fetchPage = useCallback(async (q: string, p: number) => {
		setLoading(true)
		setBrowseError(false)
		try {
			const data = await rpcRequest<BrowseResult>('browseChains', { query: q || undefined, page: p, pageSize: PAGE_SIZE }, 15000)
			const sorted = (data.chains || []).slice().sort((a, b) => a.chainId - b.chainId)
			setResults(sorted)
			setTotal(data.total || 0)
			setPage(data.page || 0)
		} catch {
			setResults([])
			setTotal(0)
			setBrowseError(true)
		}
		setLoading(false)
	}, [])

	// Load first page on mount
	useEffect(() => {
		fetchPage('', 0)
	}, [fetchPage])

	// Debounced search — reset to page 0
	useEffect(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current)
		debounceRef.current = setTimeout(() => {
			setPage(0)
			fetchPage(query.trim(), 0)
		}, 300)
		return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
	}, [query, fetchPage])

	// Autofocus search input on mount
	useEffect(() => {
		if (mode === 'browse') {
			setTimeout(() => searchRef.current?.focus(), 50)
		}
	}, [mode])

	const handlePageChange = useCallback((newPage: number) => {
		setPage(newPage)
		fetchPage(query.trim(), newPage)
	}, [query, fetchPage])

	const testSingleRpc = useCallback(async (url: string, expectedChainId: number): Promise<boolean> => {
		try {
			const resp = await fetch(url.trim(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
				signal: AbortSignal.timeout(8000),
			})
			const json = await resp.json() as { result?: string; error?: { message: string } }
			if (json.error) return false
			const returnedId = Number(BigInt(json.result || '0x0'))
			return returnedId === expectedChainId
		} catch {
			return false
		}
	}, [])

	const handleSelectChain = useCallback((chain: PioneerChainInfo) => {
		if (existingSet.has(chain.chainId)) return
		setSelectedChain(chain)
		setChainId(String(chain.chainId))
		setName(chain.name)
		setSymbol(chain.symbol)
		setExplorerUrl(chain.explorer || '')
		setExplorerAddressLink(chain.explorerAddressLink || '')
		setExplorerTxLink(chain.explorerTxLink || '')
		setRpcUrl(chain.rpcUrl || '')
		setTested(false)
		setError(null)
		setMode('configure')

		// Auto-test all available RPC URLs
		const urls = chain.rpcUrls?.length ? chain.rpcUrls : chain.rpcUrl ? [chain.rpcUrl] : []
		if (urls.length > 0) {
			const initial: Record<string, 'pending' | 'testing' | 'ok' | 'fail'> = {}
			for (const u of urls) initial[u] = 'testing'
			setRpcStatuses(initial)
			let firstOk = false
			for (const u of urls) {
				testSingleRpc(u, chain.chainId).then(ok => {
					setRpcStatuses(prev => ({ ...prev, [u]: ok ? 'ok' : 'fail' }))
					// Auto-select first working RPC
					if (ok && !firstOk) {
						firstOk = true
						setRpcUrl(u)
						setTested(true)
					}
				})
			}
		} else {
			setRpcStatuses({})
		}
	}, [existingSet, testSingleRpc])

	const handleManualMode = useCallback(() => {
		setSelectedChain(null)
		setChainId('')
		setName('')
		setSymbol('')
		setRpcUrl('')
		setExplorerUrl('')
		setExplorerAddressLink('')
		setExplorerTxLink('')
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
		setSaving(true)
		setError(null)
		try {
			// Derive base explorerUrl from the address link template
			const addrLink = explorerAddressLink.trim()
			const txLink = explorerTxLink.trim()
			let baseExplorer = ''
			try { baseExplorer = addrLink ? new URL(addrLink).origin : txLink ? new URL(txLink).origin : '' } catch { /* invalid URL */ }
			const chain: CustomChain = {
				chainId: chainIdNum,
				name: name.trim(),
				symbol: symbol.trim().toUpperCase(),
				rpcUrl: rpcUrl.trim(),
				explorerUrl: baseExplorer || undefined,
				explorerAddressLink: addrLink || undefined,
				explorerTxLink: txLink || undefined,
			}
			await rpcRequest('addCustomChain', chain, 10000)
			onAdded?.(chain)
			onClose()
		} catch (e: any) {
			setError(e.message || 'Failed to add chain')
		}
		setSaving(false)
	}, [mode, isValidConfigure, isValidManual, chainIdNum, name, symbol, rpcUrl, explorerAddressLink, explorerTxLink, onAdded, onClose])

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
				maxH="85vh"
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
							<Flex align="center" gap="2" bg="black" border="1px solid" borderColor="kk.border" borderRadius="lg" px="3">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
								</svg>
								<Input
									ref={searchRef}
									placeholder="Search by name, symbol, or chain ID..."
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									size="sm"
									variant="unstyled"
									bg="transparent"
									color="white"
									py="2"
									_placeholder={{ color: "#666666" }}
								/>
								{loading && <Spinner size="xs" color="kk.gold" />}
							</Flex>
						</Box>

						{/* Column headers */}
						<Flex align="center" gap="3" px="8" py="1.5" flexShrink={0} borderBottom="1px solid" borderColor="kk.border">
							<Box w="28px" flexShrink={0} />
							<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="wider" w="55px" flexShrink={0}>
								Symbol
							</Text>
							<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="wider" flex="1">
								Network
							</Text>
							<Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="wider" w="65px" flexShrink={0} textAlign="right">
								Chain ID
							</Text>
							<Box w="80px" flexShrink={0} />
						</Flex>

						{/* Results list */}
						<Box flex="1" overflowY="auto" px="5" pb="2" minH="0">
							{browseError && (
								<Flex direction="column" align="center" justify="center" py="8" gap="2">
									<Text fontSize="xs" color="red.400" textAlign="center">Chain catalog unavailable</Text>
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

							{!browseError && !loading && results.length === 0 && (
								<Flex direction="column" align="center" justify="center" py="8" gap="2">
									<Text fontSize="xs" color="kk.textMuted">
										{query.trim() ? `No chains match "${query}"` : 'No chains available'}
									</Text>
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
										py="2"
										borderRadius="lg"
										cursor={isAdded ? "default" : "pointer"}
										opacity={isAdded ? 0.4 : 1}
										transition="background 0.15s"
										_hover={isAdded ? {} : { bg: "#1A1A1A" }}
										onClick={() => !isAdded && handleSelectChain(chain)}
									>
										<Image
											src={chain.icon}
											alt={chain.symbol}
											w="28px"
											h="28px"
											borderRadius="full"
											bg={chain.color || '#627EEA'}
											flexShrink={0}
											fallback={
												<Flex w="28px" h="28px" borderRadius="full" bg={chain.color || '#627EEA'} align="center" justify="center" flexShrink={0}>
													<Text fontSize="10px" fontWeight="700" color="white">{chain.symbol?.charAt(0) || '?'}</Text>
												</Flex>
											}
										/>
										<Text fontSize="xs" color={isAdded ? "kk.textMuted" : "kk.textSecondary"} fontFamily="mono" w="55px" flexShrink={0} fontWeight="600">
											{chain.symbol}
										</Text>
										<Box flex="1" overflow="hidden">
											<Text fontSize="sm" fontWeight="500" color={isAdded ? "kk.textMuted" : "white"} lineHeight="1.3" truncate>
												{chain.name}
											</Text>
										</Box>
										<Text fontSize="xs" color={isAdded ? "kk.textMuted" : "kk.gold"} fontFamily="mono" w="65px" flexShrink={0} textAlign="right" fontWeight="600">
											{chain.chainId}
										</Text>
										<Box w="80px" flexShrink={0} textAlign="right">
											{isAdded ? (
												<Text fontSize="10px" color="kk.textMuted" fontStyle="italic">
													Already Added
												</Text>
											) : (
												<Text fontSize="10px" color="kk.gold" opacity={0}>
													+
												</Text>
											)}
										</Box>
									</Flex>
								)
							})}
						</Box>

						{/* Pagination bar */}
						<Flex align="center" justify="space-between" px="5" py="2.5" borderTop="1px solid" borderColor="kk.border" flexShrink={0}>
							<Text fontSize="10px" color="kk.textMuted">
								{total > 0 ? `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total} chains` : ''}
							</Text>
							<Flex align="center" gap="2">
								<Box
									as="button"
									fontSize="xs"
									color={page > 0 ? "kk.gold" : "kk.textMuted"}
									cursor={page > 0 ? "pointer" : "default"}
									opacity={page > 0 ? 1 : 0.4}
									onClick={() => page > 0 && handlePageChange(page - 1)}
								>
									Prev
								</Box>
								<Text fontSize="10px" color="kk.textMuted" fontFamily="mono">
									{totalPages > 0 ? `${page + 1}/${totalPages}` : '-'}
								</Text>
								<Box
									as="button"
									fontSize="xs"
									color={page < totalPages - 1 ? "kk.gold" : "kk.textMuted"}
									cursor={page < totalPages - 1 ? "pointer" : "default"}
									opacity={page < totalPages - 1 ? 1 : 0.4}
									onClick={() => page < totalPages - 1 && handlePageChange(page + 1)}
								>
									Next
								</Box>
							</Flex>
							<Box
								as="button"
								fontSize="10px"
								color="kk.gold"
								cursor="pointer"
								textDecoration="underline"
								_hover={{ color: "white" }}
								onClick={handleManualMode}
							>
								Enter manually
							</Box>
						</Flex>
					</Box>
				)}

				{/* Configure Mode (pre-filled from catalog) */}
				{mode === 'configure' && selectedChain && (
					<Box px="5" py="4" display="flex" flexDirection="column" gap="3">
						{/* Chain identity badge */}
						<Flex align="center" gap="3" p="3" bg="#161616" borderRadius="lg" border="1px solid" borderColor="kk.border">
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

						{/* RPC URLs — show all with status */}
						<Box>
							<Flex align="center" justify="space-between" mb="1">
								<Text fontSize="xs" color="kk.textMuted">RPC URL *</Text>
								{Object.keys(rpcStatuses).length > 0 && (
									<Text fontSize="10px" color="kk.textMuted">
										{Object.values(rpcStatuses).filter(s => s === 'ok').length} / {Object.keys(rpcStatuses).length} online
									</Text>
								)}
							</Flex>

							{/* Available RPC list (scrollable if many) */}
							{Object.keys(rpcStatuses).length > 0 && (
								<Box
									maxH="140px"
									overflowY="auto"
									bg="#111"
									border="1px solid"
									borderColor="kk.border"
									borderRadius="lg"
									mb="2"
								>
									{Object.entries(rpcStatuses).map(([url, status]) => (
										<Flex
											key={url}
											align="center"
											gap="2"
											px="3"
											py="1.5"
											cursor="pointer"
											bg={url === rpcUrl ? "rgba(192,168,96,0.1)" : "transparent"}
											_hover={{ bg: url === rpcUrl ? "rgba(192,168,96,0.15)" : "#1A1A1A" }}
											borderBottom="1px solid"
											borderColor="rgba(255,255,255,0.04)"
											onClick={() => {
												setRpcUrl(url)
												setTested(status === 'ok')
												setError(null)
											}}
										>
											{/* Status indicator: green=online, red=offline, grey=testing */}
											<Box w="8px" h="8px" borderRadius="full" flexShrink={0}
												bg={status === 'ok' ? '#22C55E' : status === 'fail' ? '#EF4444' : '#666'}
												boxShadow={status === 'ok' ? '0 0 4px rgba(34,197,94,0.5)' : status === 'fail' ? '0 0 4px rgba(239,68,68,0.4)' : 'none'}
											/>
											<Text
												fontSize="10px"
												fontFamily="mono"
												color={url === rpcUrl ? 'kk.gold' : status === 'fail' ? 'kk.textMuted' : 'kk.textSecondary'}
												flex="1"
												truncate
												opacity={status === 'fail' ? 0.5 : 1}
											>
												{url}
											</Text>
											{url === rpcUrl && (
												<Text fontSize="9px" color="kk.gold" fontWeight="600" flexShrink={0}>SELECTED</Text>
											)}
										</Flex>
									))}
								</Box>
							)}

							{/* No working nodes warning */}
							{Object.keys(rpcStatuses).length > 0
								&& Object.values(rpcStatuses).every(s => s === 'ok' || s === 'fail')
								&& Object.values(rpcStatuses).every(s => s !== 'ok')
								&& (
								<Flex align="center" gap="2" px="3" py="2" bg="rgba(239,68,68,0.08)" border="1px solid" borderColor="rgba(239,68,68,0.2)" borderRadius="lg" mb="2">
									<Text fontSize="xs" color="red.300">
										No working RPC nodes found. Find one at{' '}
										<Box as="a" href="https://chainlist.org" target="_blank" rel="noopener noreferrer" color="kk.gold" textDecoration="underline" _hover={{ color: "white" }}>
											chainlist.org
										</Box>
									</Text>
								</Flex>
							)}

							{/* Manual RPC input + test */}
							<Flex gap="2">
								<Input
									placeholder="https://rpc.example.com"
									value={rpcUrl}
									onChange={(e) => { setRpcUrl(e.target.value); setTested(false); setError(null) }}
									size="sm"
									bg="#1A1A1A"
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

						{/* Explorer link templates */}
						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Explorer Address URL</Text>
							<Input
								placeholder="https://etherscan.io/address/{{address}}"
								value={explorerAddressLink}
								onChange={(e) => setExplorerAddressLink(e.target.value)}
								size="sm"
								bg="#1A1A1A"
								border="1px solid"
								borderColor="kk.border"
								color="white"
								fontFamily="mono"
								fontSize="xs"
							/>
							<Text fontSize="9px" color="kk.textMuted" mt="0.5">Use {"{{address}}"} as placeholder</Text>
						</Box>
						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Explorer TX URL</Text>
							<Input
								placeholder="https://etherscan.io/tx/{{txid}}"
								value={explorerTxLink}
								onChange={(e) => setExplorerTxLink(e.target.value)}
								size="sm"
								bg="#1A1A1A"
								border="1px solid"
								borderColor="kk.border"
								color="white"
								fontFamily="mono"
								fontSize="xs"
							/>
							<Text fontSize="9px" color="kk.textMuted" mt="0.5">Use {"{{txid}}"} as placeholder</Text>
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
								disabled={!isValidConfigure || saving}
							>
								{saving ? 'Adding...' : 'Add Chain'}
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
									bg="#1A1A1A"
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
									bg="#1A1A1A"
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
								bg="#1A1A1A"
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
									bg="#1A1A1A"
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
							<Text fontSize="xs" color="kk.textMuted" mb="1">Explorer Address URL (optional)</Text>
							<Input
								placeholder="https://etherscan.io/address/{{address}}"
								value={explorerAddressLink}
								onChange={(e) => setExplorerAddressLink(e.target.value)}
								size="sm"
								bg="#1A1A1A"
								border="1px solid"
								borderColor="kk.border"
								color="white"
								fontFamily="mono"
								fontSize="xs"
							/>
							<Text fontSize="9px" color="kk.textMuted" mt="0.5">Use {"{{address}}"} as placeholder</Text>
						</Box>
						<Box>
							<Text fontSize="xs" color="kk.textMuted" mb="1">Explorer TX URL (optional)</Text>
							<Input
								placeholder="https://etherscan.io/tx/{{txid}}"
								value={explorerTxLink}
								onChange={(e) => setExplorerTxLink(e.target.value)}
								size="sm"
								bg="#1A1A1A"
								border="1px solid"
								borderColor="kk.border"
								color="white"
								fontFamily="mono"
								fontSize="xs"
							/>
							<Text fontSize="9px" color="kk.textMuted" mt="0.5">Use {"{{txid}}"} as placeholder</Text>
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
								disabled={!isValidManual || saving}
							>
								{saving ? 'Adding...' : 'Add Chain'}
							</Button>
						</Flex>
					</Box>
				)}
			</Box>
		</Box>
	)
}
