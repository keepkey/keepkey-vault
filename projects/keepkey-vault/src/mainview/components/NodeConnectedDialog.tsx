import { useEffect, useRef, useState } from "react"
import { Box, Flex, Text, Button } from "@chakra-ui/react"
import { Z } from "../lib/z-index"
import { useBtcNodeStatus } from "../hooks/useBtcNodeStatus"

const ACCENT = "#F7931A" // bitcoin orange

function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "almost done"
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60)
  if (h >= 24) return `~${Math.round(h / 24)} day${h >= 48 ? "s" : ""}`
  if (h >= 1) return `~${h}h ${m}m`
  if (m >= 1) return `~${m} min`
  return "under a minute"
}

/** Rough sync ETA from two status samples: Δblocks/Δt → remaining/rate. Best-effort
 *  (IBD rate is bursty), labelled approximate. Uses Date.now — webview, allowed. */
function useEta(height?: number, headers?: number, syncing?: boolean): string | null {
  const prev = useRef<{ h: number; t: number } | null>(null)
  const [eta, setEta] = useState<string | null>(null)
  useEffect(() => {
    if (!syncing || !height || !headers) { prev.current = null; setEta(null); return }
    const now = Date.now()
    const p = prev.current
    if (p && height > p.h) {
      const rate = (height - p.h) / ((now - p.t) / 1000) // blocks/sec
      if (rate > 0) setEta(fmtDuration((headers - height) / rate))
    }
    prev.current = { h: height, t: now }
  }, [height, headers, syncing])
  return eta
}

/** Shown after a self-host node is connected (tested OK + saved). Confirms it,
 *  states the limitations, and — if the node is still syncing — shows a live
 *  progress + rough ETA so the user knows how long before balances are complete. */
export function NodeConnectedDialog({ onClose }: { onClose: () => void }) {
  const status = useBtcNodeStatus(true)
  const kind = status?.kind === "core" ? "Bitcoin Core" : "Blockbook"
  const isCore = status?.kind === "core"
  const failing = status?.ok === false
  const syncing = !!status?.ok && status?.syncing === true
  const pct = typeof status?.progress === "number" ? Math.floor(status.progress * 100) : undefined
  const behind = (status?.headers && status?.height) ? Math.max(0, status.headers - status.height) : undefined
  const eta = useEta(status?.height, status?.headers, syncing)

  const limitations = isCore
    ? [
        "Balances, receiving, and sending work from your node.",
        "No transaction history unless your node is archival with txindex=1.",
        "Spending legacy (1…) inputs needs txindex=1.",
        "Prices still come from KeepKey (your node doesn't serve USD).",
      ]
    : [
        "Full balances, history, receiving, and sending from your node.",
        "Prices still come from KeepKey (your node doesn't serve USD).",
      ]

  return (
    <Flex position="fixed" top={0} left={0} w="100vw" h="100vh" bg="rgba(0,0,0,0.5)"
          align="center" justify="center" zIndex={Z.dialog} backdropFilter="blur(3px)">
      <Box bg="kk.cardBg" borderRadius="2xl" border="1px solid" borderColor={`${ACCENT}55`}
           p="7" maxW="460px" w="92%" position="relative" overflow="hidden"
           boxShadow={`0 4px 24px ${ACCENT}33, 0 8px 32px rgba(0,0,0,0.6)`}>
        <Box position="absolute" top="-50px" right="-50px" w="160px" h="160px" borderRadius="full" bg={`${ACCENT}18`} filter="blur(40px)" pointerEvents="none" />

        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            <Flex align="center" justify="center" w="44px" h="44px" borderRadius="full" bg={`${ACCENT}1A`} flexShrink={0}>
              <Text fontSize="24px" fontWeight="800" color={ACCENT} lineHeight="1">₿</Text>
            </Flex>
            <Box>
              <Text fontSize="lg" fontWeight="800" color="kk.textPrimary" letterSpacing="-0.02em">Connected to your node</Text>
              <Text fontSize="xs" color="kk.textSecondary">{kind}{status?.height ? ` · height ${status.height.toLocaleString()}` : ""}</Text>
            </Box>
          </Flex>

          {failing ? (
            <Box p="3" borderRadius="10px" bg="rgba(224,140,123,0.10)" border="1px solid rgba(224,140,123,0.30)">
              <Text fontSize="sm" color="var(--rose)" wordBreak="break-word">Node unreachable — {status?.error}</Text>
            </Box>
          ) : syncing ? (
            <Box p="3.5" borderRadius="12px" bg="rgba(233,196,106,0.08)" border="1px solid rgba(233,196,106,0.30)">
              <Flex justify="space-between" align="baseline" mb="2">
                <Text fontSize="sm" fontWeight="700" color="var(--gold)">Node is syncing{pct !== undefined ? ` · ${pct}%` : ""}</Text>
                <Text fontSize="11px" color="kk.textSecondary">{eta ? `${eta} left` : "estimating…"}</Text>
              </Flex>
              <Box h="6px" borderRadius="full" bg="rgba(255,255,255,0.08)" overflow="hidden">
                <Box h="100%" borderRadius="full" bg="var(--gold)" w={`${pct ?? 0}%`} transition="width 0.6s" />
              </Box>
              <Text fontSize="11px" color="kk.textSecondary" mt="2">
                {behind !== undefined ? `${behind.toLocaleString()} blocks behind. ` : ""}Balances may be incomplete until it catches up — you can keep using Vault; this keeps running in the background.
              </Text>
            </Box>
          ) : (
            <Box p="3" borderRadius="10px" bg="rgba(139,227,196,0.08)" border="1px solid rgba(139,227,196,0.30)">
              <Text fontSize="sm" color="var(--teal)" fontWeight="600">Synced — your Bitcoin balances now come from your own node.</Text>
            </Box>
          )}

          <Box>
            <Text fontSize="11px" color="kk.textSecondary" textTransform="uppercase" letterSpacing="0.05em" mb="1.5">What to expect</Text>
            <Flex direction="column" gap="1">
              {limitations.map((l, i) => (
                <Flex key={i} gap="2" align="flex-start">
                  <Text fontSize="12px" color={ACCENT} lineHeight="1.5">•</Text>
                  <Text fontSize="12px" color="kk.textSecondary" lineHeight="1.5">{l}</Text>
                </Flex>
              ))}
            </Flex>
          </Box>

          <Button size="sm" onClick={onClose} bg={ACCENT} color="kk.bg" _hover={{ opacity: 0.9 }}>Done</Button>
        </Flex>
      </Box>
    </Flex>
  )
}
