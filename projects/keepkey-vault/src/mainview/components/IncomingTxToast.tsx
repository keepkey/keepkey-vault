import { Box, Flex, Text } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"

export interface IncomingTx {
  /** Human chain name (e.g. "Base"), resolved from the event networkId. */
  chainName?: string
}

interface Props {
  tx: IncomingTx | null
  onDismiss: () => void
}

/** Subtle bottom-right toast shown when an inbound payment is detected on a
 *  watched address. Mirrors the UpdateBanner toast styling. Presentational
 *  only — the auto-dismiss timer is owned by the parent (App) so it fires
 *  even if this component is unmounted (e.g. device disconnects mid-display). */
export function IncomingTxToast({ tx, onDismiss }: Props) {
  const { t } = useTranslation("common")

  if (!tx) return null

  const subtitle = tx.chainName
    ? t("incomingTx.onChain", { chain: tx.chainName, defaultValue: `${tx.chainName} · refreshing balance` })
    : t("incomingTx.refreshing", { defaultValue: "Refreshing balance" })

  return (
    <Box
      position="fixed"
      bottom="16px"
      right="16px"
      zIndex={1400}
      maxW="360px"
      opacity={1}
      transition="opacity 0.3s, transform 0.3s"
    >
      <Flex
        align="center"
        bg="rgba(139,227,196,0.10)"
        border="1px solid"
        borderColor="rgba(139,227,196,0.25)"
        borderRadius="999px"
        px="3.5"
        py="2"
        gap="2.5"
        backdropFilter="blur(12px)"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <line x1="12" y1="5" x2="12" y2="19" />
          <polyline points="19 12 12 19 5 12" />
        </svg>
        <Box flex="1" minW="0">
          <Text fontSize="12px" color="var(--text-0)" fontWeight="500" lineHeight="1.3" truncate letterSpacing="-0.005em">
            {t("incomingTx.title", { defaultValue: "Incoming payment" })}
          </Text>
          <Text fontSize="11px" color="var(--text-3)" lineHeight="1.3" truncate>
            {subtitle}
          </Text>
        </Box>
        <Box
          as="button"
          onClick={onDismiss}
          color="var(--text-3)"
          _hover={{ color: "var(--text-0)" }}
          cursor="pointer"
          fontSize="13px"
          lineHeight="1"
          px="1"
          flexShrink={0}
        >
          ✕
        </Box>
      </Flex>
    </Box>
  )
}
