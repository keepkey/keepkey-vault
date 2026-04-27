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
						<Flex direction="column" align="center" justify="center" h="100%" gap="2" opacity={0.5}>
							<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
								<path d="M6.5 9.5c3-3 8-3 11 0" />
								<path d="M4 7c4.5-4.5 11.5-4.5 16 0" />
								<circle cx="12" cy="15" r="1.5" />
							</svg>
							<Text fontSize="sm" color="kk.textSecondary">No active sessions</Text>
							<Text fontSize="xs" color="kk.textSecondary">Paste a WC URI above to connect</Text>
						</Flex>
					) : (
						sessions.map(session => (
							<Flex
								key={session.topic}
								align="center"
								gap="3"
								p="3"
								mb="2"
								borderRadius="lg"
								border="1px solid"
								borderColor="kk.border"
								bg="rgba(255,255,255,0.02)"
							>
								{session.peerIcon ? (
									<Box as="img" src={session.peerIcon} w="32px" h="32px" borderRadius="md" flexShrink={0} />
								) : (
									<Flex w="32px" h="32px" borderRadius="md" bg="rgba(59,153,252,0.1)" align="center" justify="center" flexShrink={0}>
										<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3B99FC" strokeWidth="2">
											<circle cx="12" cy="12" r="10" />
										</svg>
									</Flex>
								)}
								<Box flex="1" minW="0">
									<Text fontSize="sm" fontWeight="500" color="kk.textPrimary" truncate>
										{session.peerName}
									</Text>
									<Text fontSize="xs" color="kk.textSecondary" truncate>
										{session.peerUrl}
									</Text>
								</Box>
								<Button
									size="xs"
									variant="ghost"
									color="red.400"
									_hover={{ bg: "rgba(255,0,0,0.08)" }}
									onClick={() => handleDisconnect(session.topic)}
								>
									Disconnect
								</Button>
							</Flex>
						))
					)}
				</Box>
			</Flex>
		</>
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
