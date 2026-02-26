import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"

interface WatchOnlyPromptProps {
  deviceLabel: string
  lastSynced: number
  onViewPortfolio: () => void
  onConnectWallet: () => void
}

function useFormatTimeAgo() {
  const { t } = useTranslation("dialogs")
  return (ts: number): string => {
    const diffMs = Date.now() - ts
    const mins = Math.floor(diffMs / 60_000)
    if (mins < 1) return t("watchOnly.justNow")
    if (mins < 60) return t("watchOnly.minutesAgo", { count: mins })
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t("watchOnly.hoursAgo", { count: hours })
    const days = Math.floor(hours / 24)
    return t("watchOnly.daysAgo", { count: days })
  }
}

export function WatchOnlyPrompt({ deviceLabel, lastSynced, onViewPortfolio, onConnectWallet }: WatchOnlyPromptProps) {
  const { t } = useTranslation("dialogs")
  const formatTimeAgo = useFormatTimeAgo()
  return (
    <Box
      position="absolute"
      bottom="100px"
      left="50%"
      transform="translateX(-50%)"
      w="320px"
      maxW="90vw"
      bg="rgba(20, 20, 22, 0.95)"
      border="1px solid"
      borderColor="kk.border"
      borderRadius="xl"
      overflow="hidden"
      backdropFilter="blur(12px)"
    >
      <Box px="5" pt="4" pb="3">
        <Text fontSize="sm" fontWeight="600" color="kk.textPrimary" mb="1">
          {deviceLabel || "KeepKey"}
        </Text>
        <Text fontSize="xs" color="kk.textMuted">
          {t("watchOnly.lastSynced", { time: formatTimeAgo(lastSynced) })}
        </Text>
      </Box>
      <Flex px="5" pb="4" gap="3">
        <Button
          flex="1"
          size="sm"
          variant="outline"
          color="kk.textSecondary"
          borderColor="kk.border"
          _hover={{ color: "kk.textPrimary", borderColor: "kk.textMuted" }}
          onClick={onConnectWallet}
        >
          {t("watchOnly.connect")}
        </Button>
        <Button
          flex="1"
          size="sm"
          bg="kk.gold"
          color="black"
          fontWeight="600"
          _hover={{ bg: "kk.goldHover" }}
          onClick={onViewPortfolio}
        >
          {t("watchOnly.viewPortfolio")}
        </Button>
      </Flex>
    </Box>
  )
}
