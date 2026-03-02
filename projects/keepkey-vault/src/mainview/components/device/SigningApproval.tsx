import { useEffect, useState } from "react"
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../../lib/z-index"
import type { SigningRequestInfo, EIP712DecodedInfo } from "../../../shared/types"

interface SigningApprovalProps {
	request: SigningRequestInfo
	onApprove: () => void
	onReject: () => void
}

const METHOD_LABEL_KEYS: Record<string, string> = {
	"/eth/sign-transaction": "signing.methodEthSignTx",
	"/eth/sign-typed-data": "signing.methodEthSignTypedData",
	"/eth/sign": "signing.methodEthSignMessage",
	"/utxo/sign-transaction": "signing.methodBtcSignTx",
	"/xrp/sign-transaction": "signing.methodXrpSignTx",
	"/cosmos/sign-amino": "signing.methodCosmosSign",
	"/thorchain/sign-amino-transfer": "signing.methodThorchainTransfer",
	"/thorchain/sign-amino-deposit": "signing.methodThorchainDeposit",
	"/mayachain/sign-amino-transfer": "signing.methodMayaTransfer",
	"/mayachain/sign-amino-deposit": "signing.methodMayaDeposit",
	"/osmosis/sign-amino": "signing.methodOsmosisSign",
	"/solana/sign-transaction": "signing.methodSolanaSignTx",
	"/solana/sign-message": "signing.methodSolanaSignTx",
}

const SIGNING_ANIMATIONS = `
	@keyframes signingPulseGlow {
		0%, 100% { box-shadow: 0 0 8px 2px rgba(192,168,96,0.4); }
		50% { box-shadow: 0 0 24px 8px rgba(192,168,96,0.7), 0 0 48px 16px rgba(192,168,96,0.15); }
	}
	@keyframes signingFlashBorder {
		0%, 100% { border-color: rgba(192,168,96,0.5); }
		50% { border-color: rgba(192,168,96,1); }
	}
	@keyframes signingBadgePulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.7; transform: scale(1.05); }
	}
	@keyframes signingOverlayIn {
		0% { opacity: 0; }
		100% { opacity: 1; }
	}
	@keyframes signingCardIn {
		0% { opacity: 0; transform: scale(0.92) translateY(12px); }
		100% { opacity: 1; transform: scale(1) translateY(0); }
	}
`

function DetailRow({ label, value }: { label: string; value?: string }) {
	if (!value) return null
	return (
		<Flex justify="space-between" align="flex-start" w="100%">
			<Text fontSize="xs" color="kk.textSecondary" flexShrink={0} mr="3">
				{label}
			</Text>
			<Text fontSize="xs" color="kk.textPrimary" fontFamily="mono" textAlign="right" wordBreak="break-all" maxW="260px">
				{value}
			</Text>
		</Flex>
	)
}

function TypedDataDetails({ decoded, t }: { decoded: EIP712DecodedInfo; t: (key: string, fallback?: string) => string }) {
	return (
		<VStack gap="2" w="100%">
			{/* Operation badge */}
			<Flex justify="center" w="100%">
				<Text
					fontSize="xs"
					fontWeight="600"
					px="3"
					py="1"
					borderRadius="full"
					bg={decoded.isKnownType ? "rgba(192,168,96,0.15)" : "rgba(255,255,255,0.06)"}
					color={decoded.isKnownType ? "kk.gold" : "kk.textSecondary"}
				>
					{decoded.operationName}
				</Text>
			</Flex>

			{/* Domain info */}
			<VStack
				gap="2"
				w="100%"
				bg="rgba(0,0,0,0.3)"
				borderRadius="xl"
				p="4"
			>
				{decoded.domain.name && (
					<DetailRow label={t("signing.domainName", "Domain")} value={decoded.domain.name} />
				)}
				{decoded.domain.verifyingContract && (
					<DetailRow label={t("signing.contract", "Contract")} value={decoded.domain.verifyingContract} />
				)}
				{decoded.domain.chainId !== undefined && (
					<DetailRow label={t("signing.chainId")} value={String(decoded.domain.chainId)} />
				)}
			</VStack>

			{/* Decoded fields */}
			<VStack
				gap="2"
				w="100%"
				bg="rgba(0,0,0,0.3)"
				borderRadius="xl"
				p="4"
			>
				{decoded.fields.map((field, i) => (
					<DetailRow key={i} label={field.label} value={field.value} />
				))}
			</VStack>
		</VStack>
	)
}

export function SigningApproval({ request, onApprove, onReject }: SigningApprovalProps) {
	const { t } = useTranslation("device")
	const [elapsed, setElapsed] = useState(0)

	// Keyboard: Enter=approve, Escape=reject
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); onApprove() }
			if (e.key === "Escape") { e.preventDefault(); onReject() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [onApprove, onReject])

	// Tick elapsed seconds for countdown timer
	useEffect(() => {
		const iv = setInterval(() => setElapsed((s) => s + 1), 1000)
		return () => clearInterval(iv)
	}, [])

	const labelKey = METHOD_LABEL_KEYS[request.method]
	const methodLabel = labelKey ? t(labelKey) : request.method
	const timeoutSec = 120
	const remaining = Math.max(0, timeoutSec - elapsed)
	const minutes = Math.floor(remaining / 60)
	const seconds = remaining % 60
	const timeStr = `${minutes}:${seconds.toString().padStart(2, "0")}`
	const urgent = remaining <= 30

	return (
		<Box
			position="fixed"
			inset="0"
			zIndex={Z.overlay + 1}
			bg="rgba(0,0,0,0.85)"
			backdropFilter="blur(8px)"
			display="flex"
			alignItems="center"
			justifyContent="center"
			css={{ animation: "signingOverlayIn 0.25s ease-out" }}
		>
			<style>{SIGNING_ANIMATIONS}</style>
			<VStack
				bg="kk.cardBg"
				border="2px solid"
				borderColor="kk.gold"
				borderRadius="2xl"
				p="8"
				gap="4"
				maxW="440px"
				w="90vw"
				css={{ animation: "signingCardIn 0.3s ease-out, signingPulseGlow 2s ease-in-out infinite 0.3s, signingFlashBorder 2s ease-in-out infinite 0.3s" }}
			>
				{/* Urgent action badge */}
				<Flex
					bg="rgba(192,168,96,0.15)"
					border="1px solid"
					borderColor="kk.gold"
					borderRadius="lg"
					px="4"
					py="2"
					w="100%"
					justify="center"
					align="center"
					gap="2"
					css={{ animation: "signingBadgePulse 1.5s ease-in-out infinite" }}
				>
					<Text fontSize="sm" fontWeight="700" color="kk.gold" textTransform="uppercase" letterSpacing="wider">
						{t("signing.actionRequired", "Action Required")}
					</Text>
				</Flex>

				{/* Header */}
				<VStack gap="1" w="100%" textAlign="center">
					<Text fontSize="lg" fontWeight="700" color="white">
						{t("signing.title")}
					</Text>
					<Flex
						bg="rgba(192,168,96,0.12)"
						px="3"
						py="1"
						borderRadius="full"
						align="center"
						gap="2"
					>
						<Box w="6px" h="6px" borderRadius="full" bg="kk.gold" />
						<Text fontSize="xs" fontWeight="500" color="kk.gold">
							{request.appName}
						</Text>
					</Flex>
				</VStack>

				{/* Method */}
				<Text fontSize="md" fontWeight="600" color="white">
					{methodLabel}
				</Text>

				{/* Details — typed data vs standard transaction */}
				{request.typedDataDecoded ? (
					<TypedDataDetails decoded={request.typedDataDecoded} t={t} />
				) : (
					<VStack
						gap="2"
						w="100%"
						bg="rgba(0,0,0,0.3)"
						borderRadius="xl"
						p="4"
					>
						<DetailRow label={t("signing.chain")} value={request.chain?.toUpperCase()} />
						<DetailRow label={t("signing.from")} value={request.from} />
						<DetailRow label={t("signing.to")} value={request.to} />
						<DetailRow label={t("signing.value")} value={request.value} />
						{request.chainId !== undefined && (
							<DetailRow label={t("signing.chainId")} value={String(request.chainId)} />
						)}
						<DetailRow label={t("signing.data")} value={request.data} />
					</VStack>
				)}

				{/* Countdown timer */}
				<Text fontSize="xs" color={urgent ? "red.400" : "kk.textMuted"} fontWeight={urgent ? "600" : "400"}>
					{t("signing.expiresIn", "Expires in {{time}}", { time: timeStr })}
				</Text>

				{/* Action buttons */}
				<Flex gap="3" w="100%" mt="1">
					<Button
						flex="1"
						bg="kk.gold"
						color="black"
						fontWeight="600"
						size="lg"
						_hover={{ bg: "kk.goldHover" }}
						onClick={onApprove}
					>
						{t("signing.approve")}
					</Button>
					<Button
						flex="1"
						variant="ghost"
						color="kk.textSecondary"
						border="1px solid"
						borderColor="kk.border"
						size="lg"
						_hover={{ color: "white", borderColor: "kk.textSecondary" }}
						onClick={onReject}
					>
						{t("signing.reject")}
					</Button>
				</Flex>

				<Text fontSize="xs" color="kk.textMuted">
					{t("signing.keyboardHint")}
				</Text>
			</VStack>
		</Box>
	)
}
