import { Box, Button, Flex, HStack, Text, VStack } from "@chakra-ui/react"
import { FaChevronRight, FaKey, FaLock } from "react-icons/fa"
import { CARD_CSS } from "./TutorialCards"

/**
 * First of the three create-wallet windows:
 *
 *   briefing (this) -> verify randomness -> dice rolls
 *
 * A wizard STEP, not a modal — it renders on the clean wizard background with
 * the same card grammar as TutorialPage and SecurityStepPage, so the ceremony
 * reads as one sequence. One picture, one paragraph: the RNG audit and dice
 * mixing each have their own page right after this, so the briefing says only
 * the thing the user must understand before anything is written to the
 * device: the words are the wallet. Back is the wizard footer's Previous.
 */

const GOLD = "#E9C46A"

function WordGrid() {
	// A recovery sentence as a motif: two rows of word-length bars.
	const widths = [16, 12, 18, 10, 14, 17]
	return (
		<VStack gap="4px" align="flex-start">
			{[0, 1].map((row) => (
				<Flex key={row} gap="4px">
					{widths.slice(row * 3, row * 3 + 3).map((w, i) => (
						<Box key={i} w={`${w}px`} h="5px" borderRadius="2px" bg={GOLD} opacity={0.8 - (row * 3 + i) * 0.09} />
					))}
				</Flex>
			))}
		</VStack>
	)
}

export function CreateWalletBriefing({
	wordCount,
	onConfirm,
}: {
	wordCount: number
	onConfirm: () => void
}) {
	return (
		<VStack gap={4} w="100%" maxW="400px" mx="auto" css={{ animation: "tutorialFadeIn 0.3s ease-out" }}>
			<style>{CARD_CSS}</style>

			<Box
				w="100%"
				bg="rgba(255,255,255,0.03)"
				border="1px solid"
				borderColor={`${GOLD}33`}
				borderRadius="2xl"
				p={6}
				position="relative"
				overflow="hidden"
			>
				<Box
					position="absolute"
					top="-50px"
					right="-50px"
					w="150px"
					h="150px"
					borderRadius="full"
					bg={`${GOLD}08`}
					filter="blur(40px)"
				/>

				<VStack gap={4}>
					<HStack gap={6} justify="center" align="center">
						<Box opacity={0.7}>
							<FaLock size={22} color="rgba(233,196,106,0.6)" />
						</Box>
						<Box css={{ animation: "tutorialPulse 2s ease-in-out infinite" }}>
							<FaKey size={28} color={GOLD} />
						</Box>
						<Box>
							<WordGrid />
						</Box>
					</HStack>

					<Text fontSize="xl" fontWeight="800" color="white" textAlign="center" letterSpacing="-0.02em">
						Before you create a wallet
					</Text>

					<Text fontSize="sm" color="gray.400" textAlign="center" lineHeight="1.6" maxW="340px">
						The device generates the seed and shows the {wordCount} recovery words only on its
						own screen — this computer never sees them. The words are the wallet: write them
						on paper and never type them anywhere. A PIN protects the device, not the words.
					</Text>
				</VStack>
			</Box>

			<Button
				w="100%"
				size="md"
				bg={GOLD}
				color="black"
				fontWeight="700"
				_hover={{ opacity: 0.9, transform: "translateY(-1px)", boxShadow: `0 4px 16px ${GOLD}40` }}
				_active={{ transform: "scale(0.98)" }}
				transition="all 0.15s ease"
				onClick={onConfirm}
			>
				<HStack gap={2} justify="center">
					<Text>Continue</Text>
					<FaChevronRight size={10} />
				</HStack>
			</Button>
		</VStack>
	)
}
