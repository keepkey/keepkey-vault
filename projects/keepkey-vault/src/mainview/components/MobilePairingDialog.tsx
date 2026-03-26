import { useState, useEffect, useCallback } from "react"
import { Box, Flex, Text, VStack, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { generateQRSvg } from "../lib/qr"
import { Z } from "../lib/z-index"

interface MobilePairingDialogProps {
	open: boolean
	onClose: () => void
}

interface PairingResult {
	code: string
	expiresAt: number
	expiresIn: number
	qrPayload: string
}

export function MobilePairingDialog({ open, onClose }: MobilePairingDialogProps) {
	const { t } = useTranslation("settings")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState("")
	const [result, setResult] = useState<PairingResult | null>(null)
	const [timeLeft, setTimeLeft] = useState("")

	const generate = useCallback(async () => {
		setLoading(true)
		setError("")
		setResult(null)
		try {
			const data = await rpcRequest<PairingResult>("generateMobilePairing", undefined, 120000)
			setResult(data)
		} catch (e: any) {
			setError(e.message || "Failed to generate pairing code")
		}
		setLoading(false)
	}, [])

	// Generate on open
	useEffect(() => {
		if (open) generate()
	}, [open, generate])

	// Countdown timer
	useEffect(() => {
		if (!result?.expiresAt) { setTimeLeft(""); return }
		const tick = () => {
			const diff = result.expiresAt - Date.now()
			if (diff <= 0) { setTimeLeft(t("mobilePairing.expired")); return }
			const min = Math.floor(diff / 60000)
			const sec = Math.floor((diff % 60000) / 1000)
			setTimeLeft(`${min}:${sec.toString().padStart(2, "0")}`)
		}
		tick()
		const id = setInterval(tick, 1000)
		return () => clearInterval(id)
	}, [result?.expiresAt, t])

	// Escape to close
	useEffect(() => {
		if (!open) return
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") { e.preventDefault(); onClose() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [open, onClose])

	if (!open) return null

	const qrSvg = result?.qrPayload ? generateQRSvg(result.qrPayload, 5, 4) : ""

	return (
		<Box
			position="fixed"
			inset="0"
			zIndex={Z.overlay}
			bg="rgba(0,0,0,0.85)"
			backdropFilter="blur(8px)"
			display="flex"
			alignItems="center"
			justifyContent="center"
			onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
		>
			<VStack
				bg="kk.cardBg"
				border="1px solid"
				borderColor="kk.border"
				borderRadius="2xl"
				p="6"
				gap="4"
				maxW="440px"
				w="90vw"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<Flex align="center" justify="space-between" w="100%">
					<Flex align="center" gap="2">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
							<line x1="12" y1="18" x2="12.01" y2="18" />
						</svg>
						<Text fontSize="lg" fontWeight="600" color="kk.gold">
							{t("mobilePairing.title")}
						</Text>
					</Flex>
					<Box
						as="button"
						color="kk.textSecondary"
						cursor="pointer"
						_hover={{ color: "kk.textPrimary" }}
						onClick={onClose}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</Box>
				</Flex>

				{/* Loading */}
				{loading && (
					<Box py="8" textAlign="center">
						<Text fontSize="sm" color="kk.textSecondary">
							{t("mobilePairing.generating")}
						</Text>
						<Text fontSize="xs" color="kk.textMuted" mt="2">
							{t("mobilePairing.derivingKeys")}
						</Text>
					</Box>
				)}

				{/* Error */}
				{error && (
					<Box bg="rgba(239,68,68,0.1)" border="1px solid rgba(239,68,68,0.3)" borderRadius="lg" p="3" w="100%">
						<Text fontSize="sm" color="#EF4444">{error}</Text>
					</Box>
				)}

				{/* Success — QR + Code */}
				{!loading && !error && result && (
					<>
						{/* Pairing code */}
						<Box textAlign="center" bg="kk.bg" borderRadius="lg" border="1px solid" borderColor="kk.border" px="4" py="3" w="100%">
							<Text fontSize="xs" color="kk.textMuted" mb="1">
								{t("mobilePairing.codeLabel")}
							</Text>
							<Text fontSize="3xl" fontWeight="700" letterSpacing="wider" color="kk.gold" fontFamily="mono">
								{result.code}
							</Text>
							{timeLeft && (
								<Text fontSize="xs" color={timeLeft === t("mobilePairing.expired") ? "#EF4444" : "kk.textMuted"} mt="1">
									{timeLeft === t("mobilePairing.expired") ? timeLeft : t("mobilePairing.expiresIn", { time: timeLeft })}
								</Text>
							)}
						</Box>

						{/* QR code */}
						<Box textAlign="center">
							<Text fontSize="xs" color="kk.textMuted" mb="2">
								{t("mobilePairing.scanQr")}
							</Text>
							<Box
								mx="auto"
								w="240px"
								h="240px"
								bg="white"
								borderRadius="lg"
								p="2"
								dangerouslySetInnerHTML={{ __html: qrSvg }}
							/>
						</Box>

						{/* Instructions */}
						<Box bg="kk.bg" borderRadius="lg" border="1px solid" borderColor="kk.border" px="4" py="3" w="100%">
							<Text fontSize="xs" fontWeight="600" color="kk.gold" mb="2">
								{t("mobilePairing.instructions")}
							</Text>
							<VStack align="start" gap="1" fontSize="xs" color="kk.textSecondary">
								<Text>1. {t("mobilePairing.step1")}</Text>
								<Text>2. {t("mobilePairing.step2")}</Text>
								<Text>3. {t("mobilePairing.step3")}</Text>
							</VStack>
						</Box>

						{/* Security note */}
						<Box fontSize="xs" color="kk.textMuted" w="100%">
							<Text fontWeight="500" color="kk.textSecondary">{t("mobilePairing.security")}</Text>
							<Text mt="0.5">{t("mobilePairing.securityNote")}</Text>
						</Box>
					</>
				)}

				{/* Actions */}
				<Flex gap="3" w="100%" justify="flex-end">
					{!loading && (error || result) && (
						<Button
							size="sm"
							bg="kk.gold"
							color="black"
							fontWeight="600"
							_hover={{ opacity: 0.9 }}
							onClick={generate}
						>
							{error ? t("mobilePairing.retry") : t("mobilePairing.regenerate")}
						</Button>
					)}
				</Flex>
			</VStack>
		</Box>
	)
}
