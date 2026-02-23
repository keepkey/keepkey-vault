import { Box, Flex, Text, Button } from "@chakra-ui/react"

interface WatchOnlyPromptProps {
  deviceLabel: string
  lastSynced: number
  onViewPortfolio: () => void
  onConnectWallet: () => void
}

function formatTimeAgo(ts: number): string {
  const diffMs = Date.now() - ts
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function WatchOnlyPrompt({ deviceLabel, lastSynced, onViewPortfolio, onConnectWallet }: WatchOnlyPromptProps) {
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
          Last synced {formatTimeAgo(lastSynced)}
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
          Connect
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
          View Portfolio
        </Button>
      </Flex>
    </Box>
  )
}
