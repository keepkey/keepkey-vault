import { useEffect, useState } from "react"
import { Box, Text, VStack, Flex, Button, Image } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../../lib/z-index"
import type { PairingRequestInfo } from "../../../shared/types"

interface PairingApprovalProps {
	request: PairingRequestInfo
	onApprove: () => void
	onReject: () => void
}

const PAIRING_ANIMATIONS = `
	@keyframes pairingOverlayIn {
		0% { opacity: 0; }
		100% { opacity: 1; }
	}
	@keyframes pairingCardIn {
		0% { opacity: 0; transform: scale(0.92) translateY(12px); }
		100% { opacity: 1; transform: scale(1) translateY(0); }
	}
	@keyframes pairingGlow {
		0%, 100% { box-shadow: 0 0 12px 3px rgba(34,197,94,0.35); }
		50% { box-shadow: 0 0 28px 10px rgba(34,197,94,0.6), 0 0 56px 20px rgba(34,197,94,0.12); }
	}
	@keyframes pairingBorderFlash {
		0%, 100% { border-color: rgba(34,197,94,0.5); }
		50% { border-color: rgba(34,197,94,1); }
	}
	@keyframes pairingIconPulse {
		0%, 100% { transform: scale(1); filter: drop-shadow(0 0 8px rgba(34,197,94,0.4)); }
		50% { transform: scale(1.06); filter: drop-shadow(0 0 20px rgba(34,197,94,0.7)); }
	}
	@keyframes pairingIconSpin {
		0% { transform: rotate(0deg); }
		100% { transform: rotate(360deg); }
	}
	@keyframes pairingRingPulse {
		0% { transform: scale(0.8); opacity: 0.6; }
		50% { transform: scale(1.15); opacity: 0; }
		100% { transform: scale(0.8); opacity: 0; }
	}
`

function PairingFallbackIcon() {
	return (
		<Box position="relative" w="96px" h="96px" css={{ animation: "pairingIconPulse 2s ease-in-out infinite" }}>
			{/* Animated ring behind icon */}
			<Box
				position="absolute"
				inset="-12px"
				borderRadius="full"
				border="2px solid rgba(34,197,94,0.3)"
				css={{ animation: "pairingRingPulse 2s ease-in-out infinite" }}
			/>
			<Flex
				w="96px"
				h="96px"
				borderRadius="full"
				bg="rgba(34,197,94,0.12)"
				border="2px solid rgba(34,197,94,0.4)"
				align="center"
				justify="center"
			>
				<svg width="48" height="48" viewBox="0 0 24 24" fill="none">
					{/* Chain link icon */}
					<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="#22C55E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
					<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="#22C55E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</Flex>
		</Box>
	)
}

export function PairingApproval({ request, onApprove, onReject }: PairingApprovalProps) {
	const { t } = useTranslation("device")
	const [imgError, setImgError] = useState(false)
	const hasImage = !!request.imageUrl && !imgError

	// Keyboard: Enter=approve, Escape=reject
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); onApprove() }
			if (e.key === "Escape") { e.preventDefault(); onReject() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [onApprove, onReject])

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
			css={{ animation: "pairingOverlayIn 0.25s ease-out" }}
		>
			<style>{PAIRING_ANIMATIONS}</style>
			<VStack
				bg="kk.cardBg"
				border="2px solid"
				borderColor="rgba(34,197,94,0.6)"
				borderRadius="2xl"
				p="8"
				gap="5"
				maxW="420px"
				w="90vw"
				textAlign="center"
				css={{ animation: "pairingCardIn 0.3s ease-out, pairingGlow 2s ease-in-out infinite 0.3s, pairingBorderFlash 2s ease-in-out infinite 0.3s" }}
			>
				{/* App icon */}
				<Flex justify="center" py="2">
					{hasImage ? (
						<Image
							src={request.imageUrl!}
							alt={request.name}
							w="80px"
							h="80px"
							borderRadius="xl"
							border="2px solid rgba(34,197,94,0.3)"
							onError={() => setImgError(true)}
						/>
					) : (
						<PairingFallbackIcon />
					)}
				</Flex>

				{/* App name + URL */}
				<VStack gap="1">
					<Text fontSize="xl" fontWeight="700" color="white">
						{request.name}
					</Text>
					{request.url && (
						<Text fontSize="xs" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">
							{request.url}
						</Text>
					)}
				</VStack>

				<Flex
					bg="rgba(34,197,94,0.1)"
					border="1px solid rgba(34,197,94,0.25)"
					borderRadius="lg"
					px="4"
					py="2"
					w="100%"
					justify="center"
				>
					<Text fontSize="sm" color="#22C55E" fontWeight="500">
						{t("pairing.wantsToConnect")}
					</Text>
				</Flex>

				{/* Action buttons */}
				<Flex gap="3" w="100%">
					<Button
						flex="1"
						bg="#22C55E"
						color="black"
						fontWeight="700"
						fontSize="md"
						size="lg"
						h="52px"
						borderRadius="xl"
						_hover={{ bg: "#16A34A" }}
						onClick={onApprove}
					>
						{t("pairing.approve")}
					</Button>
					<Button
						flex="1"
						bg="rgba(239,68,68,0.12)"
						color="#EF4444"
						fontWeight="600"
						fontSize="md"
						size="lg"
						h="52px"
						borderRadius="xl"
						border="1px solid rgba(239,68,68,0.3)"
						_hover={{ bg: "rgba(239,68,68,0.25)", borderColor: "rgba(239,68,68,0.5)" }}
						onClick={onReject}
					>
						{t("pairing.reject")}
					</Button>
				</Flex>

				<Text fontSize="xs" color="kk.textMuted">
					{t("pairing.keyboardHint")}
				</Text>
			</VStack>
		</Box>
	)
}
