import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { FaUserSecret } from "react-icons/fa"
import { Z } from "../lib/z-index"

const ACCENT = "#8B5CF6"

interface PassphraseIntroDialogProps {
	/** Called when the user dismisses — the parent persists the one-time flag. */
	onClose: () => void
}

/**
 * One-time, first-run education about BIP-39 passphrases / hidden wallets.
 * Shown the first time a user reaches the dashboard (gated by the persisted
 * `passphraseIntroShown` setting). Informational only — points users to Settings
 * to actually enable it; works regardless of device/connection state.
 */
export function PassphraseIntroDialog({ onClose }: PassphraseIntroDialogProps) {
	const { t } = useTranslation("setup")

	return (
		<Flex
			position="fixed"
			top={0}
			left={0}
			w="100vw"
			h="100vh"
			bg="rgba(0,0,0,0.45)"
			align="center"
			justify="center"
			zIndex={Z.dialog}
			backdropFilter="blur(3px)"
		>
			<Box
				bg="kk.cardBg"
				borderRadius="2xl"
				border="1px solid"
				borderColor={`${ACCENT}55`}
				p="8"
				maxW="440px"
				w="90%"
				position="relative"
				overflow="hidden"
				boxShadow={`0 4px 24px ${ACCENT}33, 0 8px 32px rgba(0,0,0,0.6)`}
			>
				{/* Accent glow */}
				<Box position="absolute" top="-50px" right="-50px" w="160px" h="160px"
					borderRadius="full" bg={`${ACCENT}14`} filter="blur(40px)" />

				<Flex direction="column" align="center" gap="4">
					<Flex align="center" justify="center" w="56px" h="56px" borderRadius="full" bg={`${ACCENT}1A`}>
						<FaUserSecret size={28} color={ACCENT} />
					</Flex>

					<Text fontSize="xl" fontWeight="800" color="kk.textPrimary" textAlign="center" letterSpacing="-0.02em">
						{t("tutorial.cards.hiddenWallets.title")}
					</Text>

					<Text fontSize="sm" color="kk.textSecondary" textAlign="center" lineHeight="1.6">
						{t("tutorial.cards.hiddenWallets.body")}
					</Text>

					<Text fontSize="xs" color="kk.textMuted" textAlign="center">
						{t("tutorial.cards.hiddenWallets.settingsHint", { defaultValue: "You can turn this on or off anytime in Settings." })}
					</Text>

					<Button
						mt="2"
						w="100%"
						size="md"
						bg={ACCENT}
						color="white"
						fontWeight="700"
						_hover={{ opacity: 0.9 }}
						_active={{ transform: "scale(0.98)" }}
						transition="all 0.15s ease"
						onClick={onClose}
					>
						{t("tutorial.cards.hiddenWallets.gotIt", { defaultValue: "Got it" })}
					</Button>
				</Flex>
			</Box>
		</Flex>
	)
}
