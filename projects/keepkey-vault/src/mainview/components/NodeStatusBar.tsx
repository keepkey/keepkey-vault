import { Flex, Text, Box } from "@chakra-ui/react"
import { Z } from "../lib/z-index"
import type { BtcNodeStatus } from "../hooks/useBtcNodeStatus"

/** Bottom strip shown when a self-host node is active — confirms it's connected
 *  and reports sync state (or the verbose error if it's failing, since we never
 *  fall back to Pioneer). Green = synced, gold = syncing/error. */
export function NodeStatusBar({ status }: { status: BtcNodeStatus }) {
  const kind = status.kind === "core" ? "Bitcoin Core" : "Blockbook"
  const failing = status.ok === false
  const syncing = status.ok && status.syncing === true
  const pct = typeof status.progress === "number" ? Math.floor(status.progress * 100) : undefined
  const accent = failing ? "var(--rose)" : syncing ? "var(--gold)" : "var(--teal)"
  const bg = failing ? "rgba(224,140,123,0.14)" : syncing ? "rgba(233,196,106,0.12)" : "rgba(139,227,196,0.10)"

  const label = failing
    ? `Self-host node error — ${status.error || "unreachable"}. Fix your node; Vault won't fall back to Pioneer.`
    : syncing
      ? `${kind} node syncing${pct !== undefined ? ` · ${pct}%` : ""} — balances may be incomplete until caught up.`
      : `${kind} node connected${status.height ? ` · height ${status.height.toLocaleString()}` : ""} · synced`

  return (
    <Flex position="fixed" bottom={0} left={0} right={0} h="30px" align="center" justify="center" gap="2" px="4"
          bg={bg} borderTop={`1px solid ${accent}`} backdropFilter="blur(12px)" zIndex={Z.nav} color={accent}>
      <Box w="6px" h="6px" borderRadius="full" bg={accent} flexShrink={0}
           css={syncing ? { animation: "kkpulse 1.4s ease-in-out infinite" } : undefined} />
      <style>{`@keyframes kkpulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      <Text fontSize="11px" fontWeight="600" letterSpacing="0.01em" textAlign="center" truncate>{label}</Text>
    </Flex>
  )
}
