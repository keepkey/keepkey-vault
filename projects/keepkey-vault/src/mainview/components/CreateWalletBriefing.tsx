import { Box, Button, Flex, Text, VStack } from "@chakra-ui/react"
import { Z } from "../lib/z-index"

/**
 * Shown once, when the user chooses "Create wallet" and before anything is
 * written to the device. Two jobs:
 *
 *   1. Say what is actually about to happen, including where the seed comes
 *      from and what the PIN does and does not protect. Users are repeatedly
 *      told "write these words down" and almost never told why the words are
 *      the wallet and the PIN is not.
 *   2. Offer the RNG health test, which is only meaningful here — the device
 *      answers entropy requests without a button press while it is
 *      uninitialized, and creating the wallet also sets the PIN.
 *
 * Deliberately not a wall of warnings. Each line is something that changes
 * what a competent user does, and nothing is repeated twice.
 */

const STEPS: { n: string; title: string; body: string }[] = [
	{
		n: "1",
		title: "The device generates the seed",
		body:
			"It draws 32 bytes from its hardware random number generator and mixes them with 32 bytes " +
			"from this computer — seed = SHA256(device ‖ host). Neither side alone decides the result, " +
			"so a compromised computer cannot choose your wallet.",
	},
	{
		n: "2",
		title: "The words are shown on the device only",
		body:
			"The seed is derived on the device and displayed on its screen. It is never sent here. " +
			"This computer never learns your recovery sentence.",
	},
	{
		n: "3",
		title: "You write the words down",
		body:
			"This is the only copy that leaves the device. Lose it and the funds are gone; copy it " +
			"badly and you will not find out until you need it.",
	},
	{
		n: "4",
		title: "You set a PIN",
		body:
			"The PIN stops someone who physically takes the device. It does not protect the words — " +
			"anyone holding those can rebuild the wallet without it.",
	},
]

const PRACTICES: string[] = [
	"Write the words on paper. Not a photo, not a notes app, not a password manager.",
	"Never type them into a computer except during a genuine recovery on the device.",
	"Test the backup before you fund the wallet — an untested backup is not a backup.",
	"Store it where fire and water cannot reach it; metal beats paper for anything long-term.",
	"Nobody legitimate will ever ask for these words. Support, ourselves included, never will.",
]

export function CreateWalletBriefing({
	open,
	wordCount,
	onRunRngTest,
	onConfirm,
	onCancel,
}: {
	open: boolean
	wordCount: number
	onRunRngTest: () => void
	onConfirm: () => void
	onCancel: () => void
}) {
	if (!open) return null

	return (
		<>
			<Box position="fixed" inset="0" bg="rgba(0,0,0,0.65)" zIndex={Z.dialog} onClick={onCancel} />
			<Flex position="fixed" inset="0" align="center" justify="center" zIndex={Z.dialog + 1} pointerEvents="none">
				<Box
					role="dialog"
					aria-modal="true"
					aria-label="Before you create a wallet"
					pointerEvents="auto"
					w="min(620px, 94vw)"
					maxH="88vh"
					overflowY="auto"
					bg="kk.cardBg"
					border="1px solid rgba(255,255,255,0.10)"
					boxShadow="0 24px 64px rgba(0,0,0,0.6)"
					borderRadius="16px"
					p="5"
				>
					<Text fontSize="md" fontWeight="700" color="white">Before you create a wallet</Text>
					<Text fontSize="xs" color="kk.textSecondary" mt="1">
						A {wordCount}-word wallet, created on the device. Here is what happens and what it costs you
						to get wrong.
					</Text>

					<VStack align="stretch" gap="2.5" mt="4">
						{STEPS.map((s) => (
							<Flex key={s.n} gap="3" align="flex-start">
								<Flex
									flexShrink={0}
									w="20px"
									h="20px"
									mt="1px"
									align="center"
									justify="center"
									borderRadius="full"
									bg="rgba(233,196,106,0.14)"
								>
									<Text fontSize="2xs" fontWeight="700" color="var(--gold)">{s.n}</Text>
								</Flex>
								<Box>
									<Text fontSize="xs" fontWeight="600" color="white">{s.title}</Text>
									<Text fontSize="2xs" color="kk.textSecondary" lineHeight="tall">{s.body}</Text>
								</Box>
							</Flex>
						))}
					</VStack>

					<Box mt="4" pt="3" borderTop="1px solid rgba(255,255,255,0.06)">
						<Text fontSize="xs" fontWeight="600" color="white">Worth doing</Text>
						<VStack align="stretch" gap="1" mt="1.5">
							{PRACTICES.map((p) => (
								<Flex key={p} gap="2" align="flex-start">
									<Text fontSize="2xs" color="var(--gold)" mt="1px">•</Text>
									<Text fontSize="2xs" color="kk.textSecondary" lineHeight="tall">{p}</Text>
								</Flex>
							))}
						</VStack>
					</Box>

					<Flex
						mt="4"
						px="3"
						py="2.5"
						gap="3"
						align="center"
						justify="space-between"
						borderRadius="lg"
						bg="rgba(233,196,106,0.06)"
						borderWidth="1px"
						borderColor="rgba(233,196,106,0.22)"
					>
						<Box>
							<Text fontSize="xs" fontWeight="600" color="white">Check the randomness first (optional)</Text>
							<Text fontSize="2xs" color="kk.textSecondary" lineHeight="tall">
								Step 1 rests on the device's random number generator. You can test it for stuck,
								repeated, or biased output — but only now, while the device is still empty.
							</Text>
						</Box>
						<Button
							size="xs"
							flexShrink={0}
							variant="outline"
							borderColor="rgba(233,196,106,0.45)"
							color="var(--gold)"
							_hover={{ bg: "rgba(233,196,106,0.12)" }}
							onClick={onRunRngTest}
						>
							Run test
						</Button>
					</Flex>

					<Flex mt="5" gap="2" justify="flex-end">
						<Button size="sm" variant="ghost" onClick={onCancel}>Back</Button>
						<Button
							size="sm"
							bg="var(--gold)"
							color="black"
							fontWeight="600"
							_hover={{ bg: "#D4BC6A" }}
							onClick={onConfirm}
						>
							Create wallet
						</Button>
					</Flex>
				</Box>
			</Flex>
		</>
	)
}
