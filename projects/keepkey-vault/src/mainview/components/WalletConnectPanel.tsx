import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"
import { useRef, useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import jsQR from "jsqr"
import { Z } from "../lib/z-index"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { WcSessionInfo } from "../../shared/types"

function decodeQrFromImageSrc(src: string): Promise<string | null> {
	return new Promise((resolve) => {
		const img = new Image()
		img.onload = () => {
			const canvas = document.createElement("canvas")
			canvas.width = img.width
			canvas.height = img.height
			const ctx = canvas.getContext("2d", { willReadFrequently: true })
			if (!ctx) { resolve(null); return }
			ctx.drawImage(img, 0, 0)
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
			const code = jsQR(imageData.data, imageData.width, imageData.height)
			resolve(code?.data ?? null)
		}
		img.onerror = () => resolve(null)
		img.src = src
	})
}

function decodePngBase64ToQrString(pngBase64: string): Promise<string | null> {
	return decodeQrFromImageSrc(`data:image/png;base64,${pngBase64}`)
}

async function decodeQrFromFile(file: File | Blob): Promise<string | null> {
	const url = URL.createObjectURL(file)
	try {
		return await decodeQrFromImageSrc(url)
	} finally {
		URL.revokeObjectURL(url)
	}
}

// CAIP-2 → display label. Mirrors the chains advertised by walletconnect.ts.
const CAIP_LABEL: Record<string, string> = {
	"eip155:1": "ETH",
	"eip155:137": "Polygon",
	"eip155:42161": "Arbitrum",
	"eip155:10": "Optimism",
	"eip155:43114": "Avalanche",
	"eip155:56": "BNB",
	"eip155:8453": "Base",
	"eip155:100": "Gnosis",
	"cosmos:cosmoshub-4": "Cosmos",
	"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
}

function formatRelativeExpiry(epochSec: number): string {
	const ms = epochSec * 1000 - Date.now()
	if (ms <= 0) return "expired"
	const days = Math.floor(ms / 86_400_000)
	if (days >= 1) return `${days}d`
	const hours = Math.floor(ms / 3_600_000)
	if (hours >= 1) return `${hours}h`
	const mins = Math.max(1, Math.floor(ms / 60_000))
	return `${mins}m`
}

interface PairRequestInfo {
	id: string
	peerName: string
	peerUrl: string
	peerIcon: string
	chains: string[]
	methods: string[]
}

// Legacy iframe URL — used when native WC is disabled (feature flag OFF)
const WC_DAPP_BASE = "http://localhost:1646/wc"

interface WalletConnectPanelProps {
	open: boolean
	wcUri?: string | null
	onClose: () => void
	nativeEnabled: boolean
}

export function WalletConnectPanel({ open, wcUri, onClose, nativeEnabled }: WalletConnectPanelProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const { t } = useTranslation("settings")
	const [sessions, setSessions] = useState<WcSessionInfo[]>([])
	const [pairInput, setPairInput] = useState("")
	const [pairing, setPairing] = useState(false)
	const [pairError, setPairError] = useState("")
	const [scanning, setScanning] = useState(false)
	const [dragOver, setDragOver] = useState(false)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [pairRequest, setPairRequest] = useState<PairRequestInfo | null>(null)

	// Load sessions on open
	useEffect(() => {
		if (open && nativeEnabled) {
			rpcRequest<WcSessionInfo[]>("wcGetSessions").then(setSessions).catch(() => {})
		}
	}, [open, nativeEnabled])

	// Listen for session changes
	useEffect(() => {
		return onRpcMessage("wc-sessions", (data) => {
			setSessions(data as WcSessionInfo[])
		})
	}, [])

	// Listen for pending pair-approval requests
	useEffect(() => {
		const offReq = onRpcMessage("wc-pair-request", (data) => {
			setPairRequest(data as PairRequestInfo)
		})
		const offDismiss = onRpcMessage("wc-pair-dismiss", (data) => {
			const { id } = data as { id: string }
			setPairRequest(prev => (prev && prev.id === id ? null : prev))
		})
		return () => { offReq(); offDismiss() }
	}, [])

	const handleApprovePair = useCallback(async () => {
		if (!pairRequest) return
		const id = pairRequest.id
		setPairRequest(null) // optimistic dismiss; server will also send wc-pair-dismiss
		try { await rpcRequest("wcApprovePair", { id }) } catch { /* user already saw decision */ }
	}, [pairRequest])

	const handleRejectPair = useCallback(async () => {
		if (!pairRequest) return
		const id = pairRequest.id
		setPairRequest(null)
		try { await rpcRequest("wcRejectPair", { id }) } catch { /* same */ }
	}, [pairRequest])

	// Auto-pair if URI is provided (from deep link)
	useEffect(() => {
		if (open && nativeEnabled && wcUri) {
			setPairing(true)
			setPairError("")
			rpcRequest("wcPair", { uri: wcUri })
				.then(() => { setPairing(false) })
				.catch((e: any) => { setPairError(e.message || "Pairing failed"); setPairing(false) })
		}
	}, [open, nativeEnabled, wcUri])

	const handlePair = useCallback(async () => {
		if (!pairInput.trim()) return
		setPairing(true)
		setPairError("")
		try {
			await rpcRequest("wcPair", { uri: pairInput.trim() })
			setPairInput("")
		} catch (e: any) {
			setPairError(e.message || "Pairing failed")
		}
		setPairing(false)
	}, [pairInput])

	const handleScanScreen = useCallback(async () => {
		setScanning(true)
		setPairError("")
		try {
			console.log('[wc-scan] requesting screencapture')
			const result = await rpcRequest<{ pngBase64: string } | null>("wcScanScreen")
			if (!result) {
				console.log('[wc-scan] user canceled screencapture')
				setScanning(false)
				return
			}
			console.log('[wc-scan] got PNG bytes:', result.pngBase64.length, 'b64 chars')
			const decoded = await decodePngBase64ToQrString(result.pngBase64)
			console.log('[wc-scan] jsqr decoded:', decoded ? `len=${decoded.length} prefix=${decoded.slice(0, 16)}` : 'null')
			if (!decoded) {
				setPairError("No QR code found in selection")
				setScanning(false)
				return
			}
			// WC URIs are case-sensitive `wc:` per spec, but be tolerant just in case
			if (!decoded.toLowerCase().startsWith("wc:")) {
				setPairError(`QR is not a WalletConnect URI (got "${decoded.slice(0, 30)}…")`)
				setScanning(false)
				return
			}
			setPairing(true)
			setScanning(false)
			await rpcRequest("wcPair", { uri: decoded })
			setPairInput("")
			setPairing(false)
		} catch (e: any) {
			console.error('[wc-scan] failed:', e)
			if (e.message === 'SCREEN_RECORDING_PERMISSION_PROMPTED' || e.message === 'SCREEN_RECORDING_PERMISSION_REQUIRED') {
				setPairError("Screen Recording permission required. Approve the macOS prompt or add the app via the + button in the Settings window that just opened, then quit (⌘Q) and reopen.")
			} else {
				setPairError(e.message || "Scan failed")
			}
			setScanning(false)
			setPairing(false)
		}
	}, [])

	const handleQrFile = useCallback(async (file: File | Blob) => {
		setPairError("")
		try {
			const decoded = await decodeQrFromFile(file)
			console.log('[wc-scan] file decoded:', decoded ? `len=${decoded.length} prefix=${decoded.slice(0, 16)}` : 'null')
			if (!decoded) {
				setPairError("No QR code found in image")
				return
			}
			if (!decoded.toLowerCase().startsWith("wc:")) {
				setPairError(`QR is not a WalletConnect URI (got "${decoded.slice(0, 30)}…")`)
				return
			}
			setPairing(true)
			await rpcRequest("wcPair", { uri: decoded })
			setPairInput("")
			setPairing(false)
		} catch (e: any) {
			console.error('[wc-scan] file pair failed:', e)
			setPairError(e.message || "Pairing failed")
			setPairing(false)
		}
	}, [])

	const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		if (file) handleQrFile(file)
		e.target.value = "" // allow re-selecting the same file
	}, [handleQrFile])

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		setDragOver(false)
		const file = e.dataTransfer.files?.[0]
		if (file && file.type.startsWith("image/")) handleQrFile(file)
	}, [handleQrFile])

	const handleDisconnect = useCallback(async (topic: string) => {
		try {
			await rpcRequest("wcDisconnectSession", { topic })
			setSessions(prev => prev.filter(s => s.topic !== topic))
		} catch {
			// Refresh from backend to resync on failure
			rpcRequest<WcSessionInfo[]>("wcGetSessions").then(setSessions).catch(() => {})
		}
	}, [])

	if (!open) return null

	// Legacy iframe mode (feature flag OFF but somehow got here)
	if (!nativeEnabled) {
		const iframeSrc = wcUri
			? `${WC_DAPP_BASE}?uri=${encodeURIComponent(wcUri)}`
			: WC_DAPP_BASE
		return (
			<>
				<Box position="fixed" inset="0" bg="blackAlpha.600" zIndex={Z.drawerBackdrop} onClick={onClose} />
				<Flex position="fixed" top="0" right="0" bottom="0" w={{ base: "100vw", md: "480px" }} maxW="100vw" direction="column" bg="kk.bg" borderLeft="1px solid" borderColor="kk.border" zIndex={Z.drawerPanel} boxShadow="-4px 0 24px rgba(0,0,0,0.5)">
					<PanelHeader onClose={onClose} title={t('walletConnect.title')} />
					<Box flex="1" overflow="hidden">
						<iframe ref={iframeRef} src={iframeSrc} style={{ width: "100%", height: "100%", border: "none" }} allow="clipboard-read; clipboard-write" title={t('walletConnect.iframeTitle')} />
					</Box>
				</Flex>
			</>
		)
	}

	// Native WC v2 mode
	return (
		<>
			<Box position="fixed" inset="0" bg="blackAlpha.600" zIndex={Z.drawerBackdrop} onClick={onClose} />
			<Flex position="fixed" top="0" right="0" bottom="0" w={{ base: "100vw", md: "480px" }} maxW="100vw" direction="column" bg="kk.bg" borderLeft="1px solid" borderColor="kk.border" zIndex={Z.drawerPanel} boxShadow="-4px 0 24px rgba(0,0,0,0.5)">
				<PanelHeader onClose={onClose} title={t('walletConnect.title')} />

				{/* Pair input + Scan QR + Upload */}
				<Box
					px="4" py="3"
					borderBottom="1px solid"
					borderColor={dragOver ? "kk.gold" : "kk.border"}
					bg={dragOver ? "rgba(255,215,0,0.04)" : "transparent"}
					transition="background 0.15s, border-color 0.15s"
					onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
					onDragLeave={() => setDragOver(false)}
					onDrop={handleDrop}
				>
					<Flex gap="2">
						<Input
							size="sm"
							placeholder="wc:..."
							value={pairInput}
							onChange={(e: any) => setPairInput(e.target.value)}
							onKeyDown={(e: any) => e.key === 'Enter' && handlePair()}
							bg="rgba(255,255,255,0.04)"
							border="1px solid"
							borderColor="kk.border"
							color="kk.textPrimary"
							_placeholder={{ color: "kk.textSecondary" }}
							disabled={pairing || scanning}
						/>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handlePair}
							disabled={pairing || scanning || !pairInput.trim()}
							px="4"
						>
							{pairing ? "..." : "Pair"}
						</Button>
					</Flex>
					<Flex gap="2" mt="2">
						<Button
							size="sm"
							flex="1"
							variant="outline"
							borderColor="kk.border"
							color="kk.textPrimary"
							_hover={{ borderColor: "kk.gold", color: "kk.gold", bg: "rgba(255,215,0,0.04)" }}
							onClick={handleScanScreen}
							disabled={pairing || scanning}
						>
							<Flex align="center" gap="2">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<rect x="3" y="3" width="7" height="7" />
									<rect x="14" y="3" width="7" height="7" />
									<rect x="3" y="14" width="7" height="7" />
									<line x1="14" y1="14" x2="14" y2="17" />
									<line x1="17" y1="14" x2="20" y2="14" />
									<line x1="14" y1="20" x2="20" y2="20" />
									<line x1="20" y1="14" x2="20" y2="20" />
								</svg>
								<Text fontSize="sm">{scanning ? "Selecting…" : "Scan screen"}</Text>
							</Flex>
						</Button>
						<Button
							size="sm"
							flex="1"
							variant="outline"
							borderColor="kk.border"
							color="kk.textPrimary"
							_hover={{ borderColor: "kk.gold", color: "kk.gold", bg: "rgba(255,215,0,0.04)" }}
							onClick={() => fileInputRef.current?.click()}
							disabled={pairing || scanning}
						>
							<Flex align="center" gap="2">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
									<polyline points="17 8 12 3 7 8" />
									<line x1="12" y1="3" x2="12" y2="15" />
								</svg>
								<Text fontSize="sm">Upload image</Text>
							</Flex>
						</Button>
					</Flex>
					<Text fontSize="xs" color="kk.textSecondary" mt="2" textAlign="center">
						{dragOver ? "Drop QR image to pair" : "Or drop a screenshot here"}
					</Text>
					<input
						ref={fileInputRef}
						type="file"
						accept="image/*"
						style={{ display: "none" }}
						onChange={handleFileChange}
					/>
					{pairError && (
						<Text fontSize="xs" color="red.400" mt="2">{pairError}</Text>
					)}
				</Box>

				{/* Sessions list */}
				<Box flex="1" overflow="auto" px="4" py="3">
					{sessions.length === 0 ? (
						<EmptyState />
					) : (
						sessions.map(session => (
							<SessionCard
								key={session.topic}
								session={session}
								onDisconnect={() => handleDisconnect(session.topic)}
							/>
						))
					)}
				</Box>
				{pairRequest && (
					<PairApprovalOverlay
						request={pairRequest}
						onApprove={handleApprovePair}
						onReject={handleRejectPair}
					/>
				)}
			</Flex>
		</>
	)
}

function EmptyState() {
	const steps: Array<{ n: number; title: string; body: string }> = [
		{ n: 1, title: "Open a dApp", body: "Uniswap, Aave, OpenSea — anything that supports WalletConnect." },
		{ n: 2, title: "Find the QR", body: "Click \"Connect Wallet\" → \"WalletConnect\"." },
		{ n: 3, title: "Bring it here", body: "Scan it, drop a screenshot, or paste the wc: URI above." },
	]
	return (
		<Flex direction="column" h="100%" px="2" pt="6" pb="4" gap="5">
			<Flex direction="column" align="center" gap="2">
				<Box
					w="48px" h="48px"
					borderRadius="full"
					bg="rgba(59,153,252,0.08)"
					border="1px solid rgba(59,153,252,0.2)"
					display="flex"
					alignItems="center"
					justifyContent="center"
				>
					<svg width="24" height="24" viewBox="0 0 100 100" aria-hidden>
						<path d="M31.5 38.5c10.2-10.2 26.8-10.2 37 0l1.2 1.2a1.3 1.3 0 0 1 0 1.8l-4.2 4.2a.65.65 0 0 1-.9 0l-1.7-1.7a19.3 19.3 0 0 0-26.8 0l-1.8 1.8a.65.65 0 0 1-.9 0l-4.2-4.2a1.3 1.3 0 0 1 0-1.8l1.3-1.3zm45.7 8.5l3.7 3.7a1.3 1.3 0 0 1 0 1.8L64.7 68.7a1.3 1.3 0 0 1-1.8 0L52.1 57.9a.33.33 0 0 0-.45 0L40.9 68.7a1.3 1.3 0 0 1-1.8 0L22.9 52.5a1.3 1.3 0 0 1 0-1.8l3.7-3.7a1.3 1.3 0 0 1 1.8 0l10.8 10.8a.33.33 0 0 0 .45 0L50.4 47a1.3 1.3 0 0 1 1.8 0L63 57.8a.33.33 0 0 0 .45 0L74.3 47a1.3 1.3 0 0 1 1.8 0z" fill="#3B99FC" />
					</svg>
				</Box>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">No active sessions</Text>
				<Text fontSize="xs" color="kk.textSecondary" textAlign="center" maxW="280px">
					Connect to a dApp in three steps:
				</Text>
			</Flex>
			<Flex direction="column" gap="2.5" px="2">
				{steps.map(s => (
					<Flex key={s.n} gap="3" align="flex-start">
						<Flex
							w="22px" h="22px"
							borderRadius="full"
							bg="rgba(255,215,0,0.1)"
							color="kk.gold"
							align="center"
							justify="center"
							flexShrink={0}
							fontSize="11px"
							fontWeight="700"
							border="1px solid rgba(255,215,0,0.25)"
						>
							{s.n}
						</Flex>
						<Box>
							<Text fontSize="xs" fontWeight="600" color="kk.textPrimary">{s.title}</Text>
							<Text fontSize="xs" color="kk.textSecondary" lineHeight="1.4" mt="0.5">{s.body}</Text>
						</Box>
					</Flex>
				))}
			</Flex>
		</Flex>
	)
}

function PairApprovalOverlay({ request, onApprove, onReject }: {
	request: PairRequestInfo
	onApprove: () => void
	onReject: () => void
}) {
	const host = (() => { try { return new URL(request.peerUrl).host } catch { return request.peerUrl } })()
	const labels = request.chains
		.map(c => CAIP_LABEL[c] ?? c)
		.filter((v, i, a) => a.indexOf(v) === i)
	return (
		<Flex
			position="absolute"
			inset="0"
			bg="rgba(0,0,0,0.6)"
			align="center"
			justify="center"
			direction="column"
			p="4"
			zIndex={1}
			backdropFilter="blur(4px)"
		>
			<Box
				w="100%"
				maxW="380px"
				bg="kk.bg"
				borderRadius="xl"
				border="1px solid"
				borderColor="kk.border"
				p="5"
				boxShadow="0 12px 32px rgba(0,0,0,0.6)"
			>
				<Flex direction="column" align="center" gap="3">
					{request.peerIcon ? (
						<Box as="img" src={request.peerIcon} w="56px" h="56px" borderRadius="lg" bg="rgba(255,255,255,0.04)" />
					) : (
						<Flex w="56px" h="56px" borderRadius="lg" bg="rgba(59,153,252,0.1)" align="center" justify="center">
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#3B99FC" strokeWidth="2">
								<circle cx="12" cy="12" r="10" />
							</svg>
						</Flex>
					)}
					<Box textAlign="center">
						<Text fontSize="md" fontWeight="600" color="kk.textPrimary">
							{request.peerName || "Unknown dApp"}
						</Text>
						<Text fontSize="xs" color="kk.textSecondary" mt="0.5">
							wants to connect
						</Text>
					</Box>
					<Text fontSize="xs" color="kk.textSecondary">{host}</Text>
				</Flex>

				<Box my="4" h="1px" bg="kk.border" />

				<Box>
					<Text fontSize="xs" color="kk.textSecondary" mb="1.5">Networks</Text>
					<Flex gap="1.5" wrap="wrap">
						{labels.length === 0 ? (
							<Text fontSize="xs" color="kk.textSecondary">(none specified)</Text>
						) : labels.map(label => (
							<Box
								key={label}
								px="2" py="0.5"
								fontSize="10px"
								fontWeight="600"
								borderRadius="full"
								bg="rgba(255,215,0,0.08)"
								color="kk.gold"
								border="1px solid rgba(255,215,0,0.2)"
							>
								{label}
							</Box>
						))}
					</Flex>
				</Box>

				<Flex mt="5" gap="2">
					<Button
						flex="1"
						variant="outline"
						size="md"
						borderColor="kk.border"
						color="kk.textPrimary"
						_hover={{ borderColor: "red.400", color: "red.400" }}
						onClick={onReject}
					>
						Reject
					</Button>
					<Button
						flex="1"
						size="md"
						bg="kk.gold"
						color="black"
						fontWeight="600"
						_hover={{ bg: "kk.goldHover" }}
						onClick={onApprove}
					>
						Approve
					</Button>
				</Flex>
			</Box>
		</Flex>
	)
}

function SessionCard({ session, onDisconnect }: { session: WcSessionInfo; onDisconnect: () => void }) {
	const labels = session.chains
		.map(c => CAIP_LABEL[c] ?? c.split(":")[0])
		.filter((v, i, a) => a.indexOf(v) === i) // dedupe
	const visible = labels.slice(0, 4)
	const overflow = labels.length - visible.length
	const expiresIn = formatRelativeExpiry(session.expiry)
	const host = (() => {
		try { return new URL(session.peerUrl).host } catch { return session.peerUrl }
	})()
	return (
		<Box
			mb="2"
			p="3"
			borderRadius="lg"
			border="1px solid"
			borderColor="kk.border"
			bg="rgba(255,255,255,0.02)"
			_hover={{ borderColor: "rgba(255,215,0,0.3)" }}
			transition="border-color 0.15s"
		>
			<Flex align="flex-start" gap="3">
				{session.peerIcon ? (
					<Box as="img" src={session.peerIcon} w="40px" h="40px" borderRadius="md" flexShrink={0} bg="rgba(255,255,255,0.04)" />
				) : (
					<Flex w="40px" h="40px" borderRadius="md" bg="rgba(59,153,252,0.1)" align="center" justify="center" flexShrink={0}>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3B99FC" strokeWidth="2">
							<circle cx="12" cy="12" r="10" />
						</svg>
					</Flex>
				)}
				<Box flex="1" minW="0">
					<Flex align="center" gap="2">
						<Box w="6px" h="6px" borderRadius="full" bg="green.400" flexShrink={0} title="Connected" />
						<Text fontSize="sm" fontWeight="600" color="kk.textPrimary" truncate>
							{session.peerName || "Unknown dApp"}
						</Text>
					</Flex>
					<Text fontSize="xs" color="kk.textSecondary" truncate mt="0.5">
						{host}
					</Text>
				</Box>
				<Box
					as="button"
					p="1.5"
					borderRadius="md"
					color="kk.textSecondary"
					_hover={{ color: "red.400", bg: "rgba(255,0,0,0.08)" }}
					onClick={onDisconnect}
					aria-label="Disconnect"
					title="Disconnect"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</Box>
			</Flex>
			<Flex mt="2.5" align="center" gap="1.5" wrap="wrap">
				{visible.map(label => (
					<Box
						key={label}
						px="2" py="0.5"
						fontSize="10px"
						fontWeight="600"
						borderRadius="full"
						bg="rgba(255,215,0,0.08)"
						color="kk.gold"
						border="1px solid rgba(255,215,0,0.2)"
					>
						{label}
					</Box>
				))}
				{overflow > 0 && (
					<Text fontSize="10px" color="kk.textSecondary" fontWeight="600">
						+{overflow}
					</Text>
				)}
				<Box flex="1" />
				<Text fontSize="10px" color="kk.textSecondary">
					expires in {expiresIn}
				</Text>
			</Flex>
		</Box>
	)
}

function PanelHeader({ onClose, title }: { onClose: () => void; title: string }) {
	return (
		<Flex align="center" justify="space-between" px="4" py="3" borderBottom="1px solid" borderColor="kk.border" flexShrink={0}>
			<Flex align="center" gap="2">
				<svg width="20" height="20" viewBox="0 0 100 100">
					<rect width="100" height="100" rx="20" fill="#3B99FC" />
					<path d="M31.5 38.5c10.2-10.2 26.8-10.2 37 0l1.2 1.2a1.3 1.3 0 0 1 0 1.8l-4.2 4.2a.65.65 0 0 1-.9 0l-1.7-1.7a19.3 19.3 0 0 0-26.8 0l-1.8 1.8a.65.65 0 0 1-.9 0l-4.2-4.2a1.3 1.3 0 0 1 0-1.8l1.3-1.3zm45.7 8.5l3.7 3.7a1.3 1.3 0 0 1 0 1.8L64.7 68.7a1.3 1.3 0 0 1-1.8 0L52.1 57.9a.33.33 0 0 0-.45 0L40.9 68.7a1.3 1.3 0 0 1-1.8 0L22.9 52.5a1.3 1.3 0 0 1 0-1.8l3.7-3.7a1.3 1.3 0 0 1 1.8 0l10.8 10.8a.33.33 0 0 0 .45 0L50.4 47a1.3 1.3 0 0 1 1.8 0L63 57.8a.33.33 0 0 0 .45 0L74.3 47a1.3 1.3 0 0 1 1.8 0z" fill="#fff" />
				</svg>
				<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{title}</Text>
			</Flex>
			<Box as="button" p="1" borderRadius="md" color="kk.textSecondary" _hover={{ color: "kk.textPrimary", bg: "rgba(255,255,255,0.06)" }} onClick={onClose}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</Box>
		</Flex>
	)
}
