import { useEffect } from "react"
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../../lib/z-index"
import type { SigningRequestInfo } from "../../../shared/types"

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
}

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

export function SigningApproval({ request, onApprove, onReject }: SigningApprovalProps) {
	const { t } = useTranslation("device")
	// Keyboard: Enter=approve, Escape=reject
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); onApprove() }
			if (e.key === "Escape") { e.preventDefault(); onReject() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [onApprove, onReject])

	const labelKey = METHOD_LABEL_KEYS[request.method]
	const methodLabel = labelKey ? t(labelKey) : request.method

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
		>
			<VStack
				bg="kk.cardBg"
				border="1px solid"
				borderColor="kk.border"
				borderRadius="2xl"
				p="8"
				gap="4"
				maxW="440px"
				w="90vw"
			>
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

				{/* Details */}
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

				{/* Action buttons */}
				<Flex gap="3" w="100%" mt="1">
					<Button
						flex="1"
						bg="kk.gold"
						color="black"
						fontWeight="600"
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
