import { useState, useEffect } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { Z } from "../lib/z-index"
import { rpcRequest } from "../lib/rpc"
import type { AppSettings } from "../../shared/types"
import { SelfHostNodePanel } from "./SelfHostNodePanel"

const ACCENT = "#F7931A" // bitcoin orange

/** One-time first-run onboarding for a bitcoin-only KeepKey. Introduces how Vault
 *  gets its Bitcoin data — Pioneer (default), your own node (self-host), or fully
 *  offline (airplane) — since sovereignty & air-gap are exactly why btc-only users
 *  are here. Gated by the persisted `btcOnboardingShown` flag; the parent marks it
 *  on close. Every choice is changeable later in Settings → Bitcoin node. */
export function BitcoinOnlyOnboardingDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<"intro" | "selfhost">("intro")
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { rpcRequest<AppSettings>("getAppSettings").then(setSettings).catch(() => {}) }, [])

  const goOffline = async () => {
    setBusy(true)
    try { await rpcRequest("setOfflineMode", { enabled: true }, 10000) } catch { /* best effort */ }
    setBusy(false)
    onClose()
  }

  return (
    <Flex position="fixed" top={0} left={0} w="100vw" h="100vh" bg="rgba(0,0,0,0.5)"
          align="center" justify="center" zIndex={Z.dialog} backdropFilter="blur(3px)">
      <Box bg="kk.cardBg" borderRadius="2xl" border="1px solid" borderColor={`${ACCENT}55`}
           p="7" maxW="480px" w="92%" position="relative" overflow="hidden"
           boxShadow={`0 4px 24px ${ACCENT}33, 0 8px 32px rgba(0,0,0,0.6)`} maxH="88vh" overflowY="auto">
        <Box position="absolute" top="-50px" right="-50px" w="160px" h="160px" borderRadius="full" bg={`${ACCENT}18`} filter="blur(40px)" pointerEvents="none" />

        {view === "intro" ? (
          <Flex direction="column" gap="4">
            <Flex align="center" gap="3">
              <Flex align="center" justify="center" w="44px" h="44px" borderRadius="full" bg={`${ACCENT}1A`} flexShrink={0}>
                <Text fontSize="24px" fontWeight="800" color={ACCENT} lineHeight="1">₿</Text>
              </Flex>
              <Box>
                <Text fontSize="lg" fontWeight="800" color="kk.textPrimary" letterSpacing="-0.02em">Your Bitcoin-only KeepKey</Text>
                <Text fontSize="xs" color="kk.textSecondary">Focused, private, fewer moving parts.</Text>
              </Box>
            </Flex>

            <Text fontSize="sm" color="kk.textSecondary" lineHeight="1.6">
              Choose how Vault gets Bitcoin data. You can change this any time in <b>Settings → Bitcoin node</b>.
            </Text>

            <OptionCard
              title="Pioneer" badge="Recommended"
              body="Fast, zero setup. Vault's hosted Bitcoin data — the default."
              action="Continue with Pioneer" onClick={onClose} primary
            />
            <OptionCard
              title="Self-host your node"
              body="Point Vault at your own Bitcoin Core node. Full sovereignty — your keys, your node, no third party."
              action="Set up my node" onClick={() => setView("selfhost")}
            />
            <OptionCard
              title="Offline mode"
              body="Airplane mode — no network at all. Read addresses, receive, and sign transactions air-gapped."
              action={busy ? "Enabling…" : "Go offline"} onClick={goOffline} disabled={busy}
            />

            <Text as="button" fontSize="xs" color="kk.textSecondary" textAlign="center" mt="1"
                  _hover={{ color: "kk.textPrimary" }} onClick={onClose}>
              Skip — decide later
            </Text>
          </Flex>
        ) : (
          <Flex direction="column" gap="4">
            <Flex align="center" gap="2">
              <Box as="button" onClick={() => setView("intro")} color="kk.textSecondary" _hover={{ color: "kk.textPrimary" }} fontSize="lg" lineHeight="1">←</Box>
              <Text fontSize="md" fontWeight="700" color="kk.textPrimary">Connect your own node</Text>
            </Flex>
            {settings
              ? <SelfHostNodePanel settings={settings} onChange={setSettings} />
              : <Text fontSize="sm" color="kk.textSecondary">Loading…</Text>}
            <Button size="sm" onClick={onClose} bg={ACCENT} color="kk.bg" _hover={{ opacity: 0.9 }}>Done</Button>
          </Flex>
        )}
      </Box>
    </Flex>
  )
}

function OptionCard({ title, badge, body, action, onClick, primary, disabled }: {
  title: string; badge?: string; body: string; action: string; onClick: () => void; primary?: boolean; disabled?: boolean
}) {
  return (
    <Box border="1px solid" borderColor={primary ? `${ACCENT}55` : "kk.border"} borderRadius="12px" p="3.5" bg={primary ? `${ACCENT}0D` : "kk.bg"}>
      <Flex align="center" gap="2" mb="1">
        <Text fontSize="sm" fontWeight="700" color="kk.textPrimary">{title}</Text>
        {badge && <Text fontSize="9px" color={ACCENT} bg={`${ACCENT}22`} px="1.5" py="0.5" borderRadius="sm" textTransform="uppercase" letterSpacing="0.05em">{badge}</Text>}
      </Flex>
      <Text fontSize="12px" color="kk.textSecondary" lineHeight="1.5" mb="2.5">{body}</Text>
      <Button size="xs" onClick={onClick} disabled={disabled}
              variant={primary ? "solid" : "outline"}
              bg={primary ? ACCENT : "transparent"} color={primary ? "kk.bg" : "kk.textPrimary"}
              borderColor="kk.border" _hover={primary ? { opacity: 0.9 } : { bg: "var(--ink-2)" }}>
        {action}
      </Button>
    </Box>
  )
}
