import { Box, Flex, Text, VStack, IconButton } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { generateQRSvg } from "../lib/qr"
import { Z } from "../lib/z-index"
import { rpcRequest } from "../lib/rpc"

const APP_STORE_URL = "https://apps.apple.com/us/app/keepkey-mobile/id6755204956"

interface MobilePanelProps {
	open: boolean
	onClose: () => void
	deviceReady?: boolean
	onOpenPairing?: () => void
}

export function MobilePanel({ open, onClose, deviceReady, onOpenPairing }: MobilePanelProps) {
	const { t } = useTranslation("settings")
	const appStoreQr = generateQRSvg(APP_STORE_URL, 4, 3)

	if (!open) return null

	return (
		<Box
			position="fixed"
			top="0"
			right="0"
			h="100vh"
			w="380px"
			maxW="90vw"
			bg="kk.bg"
			borderLeft="1px solid"
			borderColor="kk.border"
			zIndex={Z.drawerPanel}
			overflowY="auto"
			role="dialog"
			aria-label={t("mobile.panelTitle")}
			aria-modal="true"
		>
			{/* Header */}
			<Flex
				align="center"
				justify="space-between"
				px="4"
				py="3"
				borderBottom="1px solid"
				borderColor="kk.border"
				position="sticky"
				top="0"
				bg="kk.bg"
				zIndex={1}
			>
				<Flex align="center" gap="2">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
						<line x1="12" y1="18" x2="12.01" y2="18" />
					</svg>
					<Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
						{t("mobile.panelTitle")}
					</Text>
				</Flex>
				<IconButton
					aria-label={t("mobile.close")}
					onClick={onClose}
					size="sm"
					variant="ghost"
					color="kk.textSecondary"
					_hover={{ color: "kk.textPrimary" }}
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</IconButton>
			</Flex>

			<VStack gap="0" align="stretch" p="4">

				{/* ── Get the App ───────────────────────────────── */}
				<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5" mb="4">
					<Flex align="center" gap="2" mb="3">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="7 10 12 15 17 10" />
							<line x1="12" y1="15" x2="12" y2="3" />
						</svg>
						<Text fontSize="md" fontWeight="600" color="kk.gold">
							{t("mobile.getTheApp")}
						</Text>
					</Flex>

					<Text fontSize="sm" color="kk.textSecondary" mb="4">
						{t("mobile.getTheAppDescription")}
					</Text>

					{/* QR Code */}
					<Box
						mx="auto"
						w="200px"
						h="200px"
						bg="white"
						borderRadius="lg"
						p="2"
						mb="3"
						dangerouslySetInnerHTML={{ __html: appStoreQr }}
					/>

					<Text fontSize="xs" color="kk.textMuted" textAlign="center" mb="3">
						{t("mobile.scanToDownload")}
					</Text>

					{/* Open in browser button */}
					<Box
						as="button"
						w="100%"
						py="2.5"
						borderRadius="lg"
						bg="rgba(192,168,96,0.12)"
						color="kk.gold"
						fontSize="sm"
						fontWeight="500"
						cursor="pointer"
						textAlign="center"
						_hover={{ bg: "rgba(192,168,96,0.22)" }}
						transition="all 0.15s"
						onClick={() => rpcRequest("openUrl", { url: APP_STORE_URL })}
					>
						{t("mobile.openAppStore")}
					</Box>
				</Box>

				{/* ── Pair Device ───────────────────────────────── */}
				<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5" mb="4">
					<Flex align="center" gap="2" mb="3">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
							<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
						</svg>
						<Text fontSize="md" fontWeight="600" color="kk.gold">
							{t("mobile.pairDevice")}
						</Text>
					</Flex>

					<Text fontSize="sm" color="kk.textSecondary" mb="3">
						{t("mobile.pairDescription")}
					</Text>

					<Box
						as="button"
						w="100%"
						py="2.5"
						borderRadius="lg"
						bg={deviceReady ? "kk.gold" : "rgba(192,168,96,0.12)"}
						color={deviceReady ? "black" : "kk.textMuted"}
						fontSize="sm"
						fontWeight="600"
						cursor={deviceReady ? "pointer" : "not-allowed"}
						opacity={deviceReady ? 1 : 0.5}
						textAlign="center"
						_hover={deviceReady ? { opacity: 0.9 } : {}}
						transition="all 0.15s"
						onClick={() => { if (deviceReady && onOpenPairing) onOpenPairing() }}
					>
						{deviceReady ? t("mobile.pairNow") : t("mobile.connectDevice")}
					</Box>
				</Box>

				{/* ── About Mobile ──────────────────────────────── */}
				<Box bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="5">
					<Text fontSize="md" fontWeight="600" color="kk.gold" mb="3">
						{t("mobile.about")}
					</Text>
					<VStack align="start" gap="2" fontSize="sm" color="kk.textSecondary">
						<Flex align="start" gap="2">
							<Text color="kk.gold" flexShrink={0}>1.</Text>
							<Text>{t("mobile.feature1")}</Text>
						</Flex>
						<Flex align="start" gap="2">
							<Text color="kk.gold" flexShrink={0}>2.</Text>
							<Text>{t("mobile.feature2")}</Text>
						</Flex>
						<Flex align="start" gap="2">
							<Text color="kk.gold" flexShrink={0}>3.</Text>
							<Text>{t("mobile.feature3")}</Text>
						</Flex>
					</VStack>
					<Box mt="3" pt="3" borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
						<Text fontSize="xs" color="kk.textMuted">
							{t("mobile.watchOnlyNote")}
						</Text>
					</Box>
				</Box>

			</VStack>
		</Box>
	)
}
