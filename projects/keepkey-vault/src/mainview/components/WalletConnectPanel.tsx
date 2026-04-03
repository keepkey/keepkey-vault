import { Box, Flex, Text, Button, Input } from "@chakra-ui/react"
import { useRef, useEffect, useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { Z } from "../lib/z-index"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import type { WcSessionInfo } from "../../shared/types"

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

				{/* Pair input */}
				<Box px="4" py="3" borderBottom="1px solid" borderColor="kk.border">
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
							disabled={pairing}
						/>
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							_hover={{ bg: "kk.goldHover" }}
							onClick={handlePair}
							disabled={pairing || !pairInput.trim()}
							px="4"
						>
							{pairing ? "..." : "Pair"}
						</Button>
					</Flex>
					{pairError && (
						<Text fontSize="xs" color="red.400" mt="1">{pairError}</Text>
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
