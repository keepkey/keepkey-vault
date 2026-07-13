import { Flex, Text } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { Z } from "../lib/z-index"

/** Persistent bottom strip shown whenever the app is offline (airplane-mode
 *  setting OR no network reachable). Tells the user plainly what still works and
 *  what's paused — the header OFFLINE badge is the compact echo of this. */
export function OfflineBanner({ airplane }: { airplane?: boolean }) {
  const { t } = useTranslation("nav")
  return (
    <Flex
      position="fixed"
      bottom={0}
      left={0}
      right={0}
      h="30px"
      align="center"
      justify="center"
      gap="2"
      px="4"
      bg="rgba(224,140,123,0.14)"
      borderTop="1px solid rgba(224,140,123,0.35)"
      backdropFilter="blur(12px)"
      zIndex={Z.nav}
      color="var(--rose)"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="2" y1="2" x2="22" y2="22" />
        <path d="M8.5 16.5a5 5 0 0 1 7 0" />
        <path d="M2 8.82a15 15 0 0 1 4.17-2.65" />
        <path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76" />
        <path d="M16.85 11.25a10 10 0 0 1 2.22 1.68" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
      <Text fontSize="11px" fontWeight="600" letterSpacing="0.01em" textAlign="center">
        {airplane
          ? t("offlineBannerAirplane", { defaultValue: "Offline mode on — no network. Device, addresses & receiving work; balances, history & sending are paused." })
          : t("offlineBannerNoNet", { defaultValue: "No network — Vault is offline. Device, addresses & receiving still work; balances, history & sending are paused." })}
      </Text>
    </Flex>
  )
}
