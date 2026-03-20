import { useState, useEffect, useCallback } from "react"
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import type { PinRequestType } from "../../../shared/types"
import { KeepKeyUILogo } from "../logo/keepkey-ui"

interface PinEntryProps {
	type?: PinRequestType
	onSubmit: (pin: string) => void
	onCancel: () => void
	onWipe?: () => void
}

const TITLE_KEYS: Record<PinRequestType, string> = {
	"current": "pin.enterPin",
	"new-first": "pin.createPin",
	"new-second": "pin.confirmPin",
}

const DESCRIPTION_KEYS: Record<PinRequestType, string> = {
	"current": "pin.enterDescription",
	"new-first": "pin.createDescription",
	"new-second": "pin.confirmDescription",
}

const PIN_ANIMATIONS = `
	@keyframes pinFadeIn {
		0%   { opacity: 0; transform: scale(0.92); }
		100% { opacity: 1; transform: scale(1); }
	}
	@keyframes pinOverlayFadeIn {
		0%   { opacity: 0; }
		100% { opacity: 1; }
	}
	@keyframes pinDotPop {
		0%   { transform: scale(0.5); opacity: 0; }
		60%  { transform: scale(1.2); }
		100% { transform: scale(1); opacity: 1; }
	}
	@keyframes pinLogoGlow {
		0%, 100% { filter: drop-shadow(0 0 2px rgba(255, 215, 0, 0.3)); }
		50%      { filter: drop-shadow(0 0 6px rgba(255, 215, 0, 0.6)); }
	}
`

/**
 * PIN entry pad matching KeepKey's scrambled 3x3 layout.
 * The device screen shows scrambled numbers; the user taps
 * position-based buttons (1-9) on this grid.
 */
export function PinEntry({ type = "current", onSubmit, onCancel, onWipe }: PinEntryProps) {
	const { t } = useTranslation("device")
	const [pin, setPin] = useState("")
	const [showWipeConfirm, setShowWipeConfirm] = useState(false)
	const [wipeAcknowledged, setWipeAcknowledged] = useState(false)
	const [wiping, setWiping] = useState(false)

	// Reset pin when type changes (e.g. new-first → new-second)
	useEffect(() => {
		setPin("")
		setShowWipeConfirm(false)
		setWipeAcknowledged(false)
	}, [type])

	const handleWipe = useCallback(async () => {
		if (!onWipe) return
		setWiping(true)
		onWipe()
	}, [onWipe])

	const handleDigit = useCallback((digit: string) => {
		setPin((p) => (p.length < 9 ? p + digit : p))
	}, [])

	const handleBackspace = useCallback(() => {
		setPin((p) => p.slice(0, -1))
	}, [])

	const handleSubmit = useCallback(() => {
		if (pin.length > 0) {
			onSubmit(pin)
			setPin("")
		}
	}, [pin, onSubmit])

	// Keyboard support: 1-9 digits, backspace, enter
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key >= "1" && e.key <= "9") {
				handleDigit(e.key)
			} else if (e.key === "Backspace") {
				handleBackspace()
			} else if (e.key === "Enter") {
				handleSubmit()
			}
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [handleDigit, handleBackspace, handleSubmit])

	// KeepKey PIN pad layout: 7 8 9 / 4 5 6 / 1 2 3
	const rows = [
		["7", "8", "9"],
		["4", "5", "6"],
		["1", "2", "3"],
	]

	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			w="100vw"
			h="100vh"
			bg="rgba(0,0,0,0.3)"
			align="center"
			justify="center"
			zIndex={2000}
			backdropFilter="blur(2px)"
			style={{ animation: "pinOverlayFadeIn 0.25s ease-out" }}
		>
			<style>{PIN_ANIMATIONS}</style>
			<Box
				bg="kk.cardBg"
				borderRadius="xl"
				border="1px solid"
				borderColor="kk.gold"
				p="8"
				maxW="360px"
				w="90%"
				boxShadow="0 0 20px rgba(255, 215, 0, 0.08), 0 8px 32px rgba(0,0,0,0.6)"
				style={{ animation: "pinFadeIn 0.3s ease-out" }}
			>
				<Text fontSize="xl" fontWeight="bold" mb="2" textAlign="center" color="kk.textPrimary">
					{t(TITLE_KEYS[type])}
				</Text>
				<Text color="kk.textSecondary" fontSize="sm" mb="6" textAlign="center">
					{t(DESCRIPTION_KEYS[type])}
				</Text>

				{!showWipeConfirm && (<>
				{/* PIN display — masked dots */}
				<Box
					bg="kk.bg"
					borderRadius="md"
					border="1px solid"
					borderColor={pin.length > 0 ? "kk.gold" : "rgba(255, 215, 0, 0.3)"}
					p="3"
					mb="5"
					textAlign="center"
					fontFamily="mono"
					fontSize="2xl"
					letterSpacing="8px"
					minH="48px"
					color="kk.gold"
					transition="border-color 0.2s ease"
				>
					{pin.length > 0
						? pin.split("").map((_, i) => (
							<Box
								key={i}
								as="span"
								display="inline-block"
								style={{ animation: `pinDotPop 0.15s ease-out ${i * 0.03}s both` }}
							>
								{"\u2022"}
							</Box>
						))
						: "\u00A0"
					}
				</Box>

				{/* 3x3 PIN pad */}
				<VStack gap="3" mb="5">
					{rows.map((row, i) => (
						<Flex key={i} gap="3" justifyContent="center">
							{row.map((digit) => (
								<Button
									key={digit}
									onClick={() => handleDigit(digit)}
									w="72px"
									h="72px"
									bg="kk.cardBg"
									border="1px solid"
									borderColor="rgba(255, 215, 0, 0.25)"
									color="kk.textPrimary"
									fontSize="xl"
									fontWeight="bold"
									borderRadius="xl"
									transition="all 0.15s ease"
									_hover={{ borderColor: "kk.gold", bg: "kk.cardBgHover", transform: "scale(1.05)" }}
									_active={{ bg: "kk.gold", borderColor: "kk.gold", color: "black", transform: "scale(0.95)" }}
									disabled={pin.length >= 9}
								>
									{"\u2022"}
								</Button>
							))}
						</Flex>
					))}
				</VStack>

				{/* Action buttons */}
				<Flex gap="3" justifyContent="center">
					<Button
						onClick={handleBackspace}
						size="md"
						variant="outline"
						borderColor="rgba(255, 215, 0, 0.2)"
						color="kk.textSecondary"
						transition="all 0.15s ease"
						_hover={{ borderColor: "kk.gold", color: "kk.textPrimary" }}
						_active={{ transform: "scale(0.97)" }}
						disabled={pin.length === 0}
						flex={1}
					>
						{t("pin.backspace")}
					</Button>
					<Button
						onClick={handleSubmit}
						size="md"
						bg="kk.gold"
						color="black"
						fontWeight="semibold"
						transition="all 0.15s ease"
						_hover={{ bg: "kk.goldHover", transform: "scale(1.02)" }}
						_active={{ transform: "scale(0.97)" }}
						disabled={pin.length === 0}
						flex={1}
					>
						{type === "current" ? t("pin.unlock") : t("confirm", { ns: "common" })}
					</Button>
				</Flex>
			</>)}

				{type === "current" && !showWipeConfirm && (
					<>
						<Button
							onClick={onCancel}
							size="sm"
							variant="ghost"
							color="kk.textMuted"
							transition="color 0.15s ease"
							_hover={{ color: "kk.error" }}
							w="100%"
							mt="3"
						>
							{t("cancel", { ns: "common" })}
						</Button>
						{onWipe && (
							<Text
								fontSize="xs"
								color="kk.textMuted"
								textAlign="center"
								mt="2"
								cursor="pointer"
								transition="color 0.15s ease"
								_hover={{ color: "kk.error" }}
								onClick={() => setShowWipeConfirm(true)}
							>
								{t("pin.forgotPinWipe")}
							</Text>
						)}
					</>
				)}

				{/* Wipe confirmation panel */}
				{showWipeConfirm && (
					<Box
						mt="4"
						p="4"
						bg="rgba(255, 59, 48, 0.06)"
						borderRadius="lg"
						border="1px solid"
						borderColor="rgba(255, 59, 48, 0.3)"
					>
						<Text fontSize="sm" fontWeight="600" color="kk.error" mb="2">
							{t("pin.wipeWarningTitle")}
						</Text>
						<Text fontSize="xs" color="kk.textSecondary" mb="3" lineHeight="1.5">
							{t("pin.wipeWarningDescription")}
						</Text>
						<Flex
							as="label"
							align="flex-start"
							gap="2"
							mb="3"
							cursor="pointer"
							userSelect="none"
						>
							<Box
								as="input"
								type="checkbox"
								checked={wipeAcknowledged}
								onChange={(e: any) => setWipeAcknowledged(e.target.checked)}
								mt="1"
								accentColor="#FFD700"
							/>
							<Text fontSize="xs" color="kk.textSecondary" lineHeight="1.4">
								{t("pin.wipeAcknowledge")}
							</Text>
						</Flex>
						<Flex gap="2">
							<Button
								size="sm"
								variant="outline"
								borderColor="rgba(255, 215, 0, 0.2)"
								color="kk.textSecondary"
								_hover={{ borderColor: "kk.gold", color: "kk.textPrimary" }}
								flex={1}
								onClick={() => { setShowWipeConfirm(false); setWipeAcknowledged(false) }}
								disabled={wiping}
							>
								{t("cancel", { ns: "common" })}
							</Button>
							<Button
								size="sm"
								bg="kk.error"
								color="white"
								fontWeight="600"
								_hover={{ opacity: 0.85 }}
								_active={{ transform: "scale(0.97)" }}
								flex={1}
								onClick={handleWipe}
								disabled={!wipeAcknowledged || wiping}
							>
								{wiping ? t("pin.wiping") : t("pin.wipeDevice")}
							</Button>
						</Flex>
					</Box>
				)}

				<Flex justify="flex-end" mt="3">
					<Box
						w="28px"
						h="28px"
						p="3px"
						borderRadius="md"
						border="1px solid"
						borderColor="rgba(255, 215, 0, 0.3)"
						style={{ animation: "pinLogoGlow 3s ease-in-out infinite" }}
					>
						<KeepKeyUILogo style={{ opacity: 0.5 }} />
					</Box>
				</Flex>
			</Box>
		</Flex>
	)
}
