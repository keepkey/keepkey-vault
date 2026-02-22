import { useEffect, useCallback } from "react"
import { Box, Text, VStack, Flex, Button, Image } from "@chakra-ui/react"
import { Z } from "../../lib/z-index"
import type { PairingRequestInfo } from "../../../shared/types"

interface PairingApprovalProps {
	request: PairingRequestInfo
	onApprove: () => void
	onReject: () => void
}

export function PairingApproval({ request, onApprove, onReject }: PairingApprovalProps) {
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
		>
			<VStack
				bg="kk.cardBg"
				border="1px solid"
				borderColor="kk.border"
				borderRadius="2xl"
				p="8"
				gap="5"
				maxW="400px"
				w="90vw"
				textAlign="center"
			>
				{/* App icon */}
				<Image
					src={request.imageUrl || undefined}
					alt={request.name}
					w="64px"
					h="64px"
					borderRadius="xl"
					bg="gray.800"
					fallback={
						<Flex w="64px" h="64px" borderRadius="xl" bg="gray.800" align="center" justify="center">
							<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#C0A860" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
								<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
							</svg>
						</Flex>
					}
				/>

				{/* App name + URL */}
				<VStack gap="1">
					<Text fontSize="lg" fontWeight="700" color="white">
						{request.name}
					</Text>
					{request.url && (
						<Text fontSize="xs" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">
							{request.url}
						</Text>
					)}
				</VStack>

				<Text fontSize="sm" color="kk.textSecondary">
					wants to connect to your KeepKey
				</Text>

				{/* Action buttons */}
				<Flex gap="3" w="100%">
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
