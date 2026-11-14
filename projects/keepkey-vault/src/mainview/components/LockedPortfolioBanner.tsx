import { Box, Button, Flex, Text } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { useUiTranslation } from "../i18n/ui"
import { actionToneProps } from "./ui/ActionButton"

/** A wallet the KeepKey auto-locked while open keeps its portfolio on screen.
 * Unlock is the one thing to do here, so it is the primary (gold) button. */
export function LockedPortfolioBanner({ unlocking, unlockError, onUnlock }: {
	unlocking: boolean; unlockError: string | null; onUnlock: () => void
}) {
	const { t } = useTranslation()
	const uiText = useUiTranslation()
	return (
		<Flex mx="4" my="2" px="3" py="2" align="center" justify="space-between" gap="3" flexWrap="wrap" border="1px solid" borderColor="kk.gold" borderRadius="lg" bg="rgba(233,196,106,0.04)" role="status">
			<Box>
				<Text fontSize="sm" color="kk.textPrimary">{uiText("KeepKey locked")}</Text>
				{unlockError && <Text fontSize="xs" color="kk.error">{unlockError}</Text>}
			</Box>
			<Button {...actionToneProps("primary")} size="sm" loading={unlocking} loadingText={uiText("Unlocking…")} onClick={onUnlock}>{t("pin.unlock", { ns: "device" })}</Button>
		</Flex>
	)
}
