import { useEffect } from "react"
import { Box, Text, VStack, Flex, Button } from "@chakra-ui/react"
import { Z } from "../../lib/z-index"
import type { SigningRequestInfo } from "../../../shared/types"

interface SigningApprovalProps {
	request: SigningRequestInfo
	onApprove: () => void
	onReject: () => void
}

const METHOD_LABELS: Record<string, string> = {
	"/eth/sign-transaction": "ETH Sign Transaction",
	"/eth/sign-typed-data": "ETH Sign Typed Data",
	"/eth/sign": "ETH Sign Message",
	"/utxo/sign-transaction": "BTC Sign Transaction",
	"/xrp/sign-transaction": "XRP Sign Transaction",
	"/cosmos/sign-amino": "Cosmos Sign",
	"/thorchain/sign-amino-transfer": "THORChain Transfer",
	"/thorchain/sign-amino-deposit": "THORChain Deposit",
	"/mayachain/sign-amino-transfer": "Maya Transfer",
	"/mayachain/sign-amino-deposit": "Maya Deposit",
	"/osmosis/sign-amino": "Osmosis Sign",
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
	// Keyboard: Enter=approve, Escape=reject
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); onApprove() }
			if (e.key === "Escape") { e.preventDefault(); onReject() }
		}
		document.addEventListener("keydown", handler)
		return () => document.removeEventListener("keydown", handler)
	}, [onApprove, onReject])

	const methodLabel = METHOD_LABELS[request.method] || request.method

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
						Signing Request
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
					<DetailRow label="Chain" value={request.chain?.toUpperCase()} />
					<DetailRow label="From" value={request.from} />
					<DetailRow label="To" value={request.to} />
					<DetailRow label="Value" value={request.value} />
					{request.chainId !== undefined && (
						<DetailRow label="Chain ID" value={String(request.chainId)} />
					)}
					<DetailRow label="Data" value={request.data} />
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
						Approve
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
						Reject
					</Button>
				</Flex>

				<Text fontSize="xs" color="kk.textMuted">
					Enter to approve · Esc to reject
				</Text>
			</VStack>
		</Box>
	)
}
