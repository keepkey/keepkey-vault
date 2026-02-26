import { Box, Flex, Text } from "@chakra-ui/react"
import { useRef, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Z } from "../lib/z-index"

// Served via reverse proxy on the REST API server (same-origin, avoids WKWebView mixed-content block)
const WC_DAPP_BASE = "http://localhost:1646/wc"

interface WalletConnectPanelProps {
	open: boolean
	wcUri?: string | null
	onClose: () => void
}

export function WalletConnectPanel({ open, wcUri, onClose }: WalletConnectPanelProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const { t } = useTranslation("settings")

	const iframeSrc = wcUri
		? `${WC_DAPP_BASE}?uri=${encodeURIComponent(wcUri)}`
		: WC_DAPP_BASE

	// Reset iframe when URI changes
	useEffect(() => {
		if (open && iframeRef.current) {
			iframeRef.current.src = iframeSrc
		}
	}, [iframeSrc, open])

	if (!open) return null

	return (
		<>
			{/* Backdrop */}
			<Box
				position="fixed"
				inset="0"
				bg="blackAlpha.600"
				zIndex={Z.drawerBackdrop}
				onClick={onClose}
			/>
			{/* Panel — slides in from right */}
			<Flex
				position="fixed"
				top="0"
				right="0"
				bottom="0"
				w={{ base: "100vw", md: "480px" }}
				maxW="100vw"
				direction="column"
				bg="kk.bg"
				borderLeft="1px solid"
				borderColor="kk.border"
				zIndex={Z.drawerPanel}
				boxShadow="-4px 0 24px rgba(0,0,0,0.5)"
			>
				{/* Header */}
				<Flex
					align="center"
					justify="space-between"
					px="4"
					py="3"
					borderBottom="1px solid"
					borderColor="kk.border"
					flexShrink={0}
				>
					<Flex align="center" gap="2">
						<svg width="20" height="20" viewBox="0 0 100 100">
							<rect width="100" height="100" rx="20" fill="#3B99FC" />
							<path
								d="M31.5 38.5c10.2-10.2 26.8-10.2 37 0l1.2 1.2a1.3 1.3 0 0 1 0 1.8l-4.2 4.2a.65.65 0 0 1-.9 0l-1.7-1.7a19.3 19.3 0 0 0-26.8 0l-1.8 1.8a.65.65 0 0 1-.9 0l-4.2-4.2a1.3 1.3 0 0 1 0-1.8l1.3-1.3zm45.7 8.5l3.7 3.7a1.3 1.3 0 0 1 0 1.8L64.7 68.7a1.3 1.3 0 0 1-1.8 0L52.1 57.9a.33.33 0 0 0-.45 0L40.9 68.7a1.3 1.3 0 0 1-1.8 0L22.9 52.5a1.3 1.3 0 0 1 0-1.8l3.7-3.7a1.3 1.3 0 0 1 1.8 0l10.8 10.8a.33.33 0 0 0 .45 0L50.4 47a1.3 1.3 0 0 1 1.8 0L63 57.8a.33.33 0 0 0 .45 0L74.3 47a1.3 1.3 0 0 1 1.8 0z"
								fill="#fff"
							/>
						</svg>
						<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
							{t('walletConnect.title')}
						</Text>
					</Flex>
					<Box
						as="button"
						p="1"
						borderRadius="md"
						color="kk.textSecondary"
						_hover={{ color: "kk.textPrimary", bg: "rgba(255,255,255,0.06)" }}
						onClick={onClose}
						aria-label={t('walletConnect.closePanel')}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</Box>
				</Flex>
				{/* Iframe */}
				<Box flex="1" overflow="hidden">
					<iframe
						ref={iframeRef}
						src={iframeSrc}
						style={{ width: "100%", height: "100%", border: "none" }}
						allow="clipboard-read; clipboard-write"
						title={t('walletConnect.iframeTitle')}
					/>
				</Box>
			</Flex>
		</>
	)
}
