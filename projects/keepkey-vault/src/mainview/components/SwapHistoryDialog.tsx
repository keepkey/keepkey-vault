/**
 * SwapHistoryDialog — Full dialog for viewing active + historical swaps.
 *
 * Opened from the SwapTracker floating bubble.
 * Shows active swaps at top, completed/failed below.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, HStack, Button } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import type { PendingSwap, SwapStatusUpdate } from "../../shared/types"

// ── Stage helpers ───────────────────────────────────────────────────

function getStage(status: string): 1 | 2 | 3 {
  switch (status) {
    case 'signing':
    case 'pending':
    case 'confirming':
      return 1
    case 'output_detected':
    case 'output_confirming':
      return 2
    default:
      return 3
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'signing': return '#A78BFA'
    case 'pending': return '#FBBF24'
    case 'confirming': return '#3B82F6'
    case 'output_detected': return '#23DCC8'
    case 'output_confirming': return '#3B82F6'
    case 'output_confirmed':
    case 'completed': return '#4ADE80'
    case 'failed': return '#EF4444'
    case 'refunded': return '#FB923C'
    default: return '#9CA3AF'
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`
}

const HISTORY_CSS = `
  @keyframes kkHistoryFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes kkSwapPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(35,220,200,0.5); }
    50% { box-shadow: 0 0 0 6px rgba(35,220,200,0); }
  }
`

// ── Stage indicator ─────────────────────────────────────────────────

function StageIndicator({ stage, status }: { stage: 1 | 2 | 3; status: string }) {
  const color = getStatusColor(status)
  const isFinal = status === 'completed' || status === 'failed' || status === 'refunded'

  return (
    <HStack gap="0" justify="center" my="2">
      {[1, 2, 3].map((s) => {
        const isActive = s === stage
        const isDone = s < stage || isFinal
        const dotColor = isDone ? '#4ADE80' : isActive ? color : 'rgba(255,255,255,0.15)'
        return (
          <HStack key={s} gap="0">
            <Box
              w={isActive ? "10px" : "8px"}
              h={isActive ? "10px" : "8px"}
              borderRadius="full"
              bg={dotColor}
              transition="all 0.3s"
              boxShadow={isActive ? `0 0 8px ${color}` : 'none'}
            />
            {s < 3 && (
              <Box w="28px" h="2px" bg={isDone ? '#4ADE80' : 'rgba(255,255,255,0.1)'} transition="background 0.3s" />
            )}
          </HStack>
        )
      })}
    </HStack>
  )
}

// ── Swap card ───────────────────────────────────────────────────────

function SwapCard({ swap, onDismiss }: { swap: PendingSwap; onDismiss: (txid: string) => void }) {
  const { t } = useTranslation("swap")
  const stage = getStage(swap.status)
  const color = getStatusColor(swap.status)
  const isFinal = swap.status === 'completed' || swap.status === 'failed' || swap.status === 'refunded'
  const [copied, setCopied] = useState(false)

  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (isFinal) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [isFinal])
  const elapsed = now - swap.createdAt

  const statusLabel = t(`status${swap.status.charAt(0).toUpperCase()}${swap.status.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase())}` as any, swap.status)

  const copyTxid = () => {
    navigator.clipboard.writeText(swap.txid)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
      .catch(() => {})
  }

  return (
    <Box
      bg="rgba(255,255,255,0.04)"
      border="1px solid"
      borderColor={
        isFinal
          ? swap.status === 'completed' ? 'rgba(74,222,128,0.3)' : 'rgba(239,68,68,0.3)'
          : 'kk.border'
      }
      borderRadius="lg"
      p="4"
      transition="all 0.2s"
      _hover={{ borderColor: isFinal ? undefined : 'rgba(35,220,200,0.3)' }}
    >
      {/* Header: asset pair + status */}
      <Flex justify="space-between" align="center" mb="1.5">
        <HStack gap="2">
          <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
            {swap.fromSymbol}
          </Text>
          <Text fontSize="xs" color="kk.textMuted">&rarr;</Text>
          <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
            {swap.toSymbol}
          </Text>
        </HStack>
        <Text fontSize="10px" fontWeight="600" color={color} bg={`${color}15`} px="2" py="0.5" borderRadius="md">
          {statusLabel}
        </Text>
      </Flex>

      {/* Amounts */}
      <Text fontSize="xs" color="kk.textSecondary" mb="1">
        {swap.fromAmount} {swap.fromSymbol} &rarr; ~{swap.expectedOutput} {swap.toSymbol}
      </Text>

      {/* Stage indicator */}
      <StageIndicator stage={stage} status={swap.status} />

      {/* Stage labels */}
      <Flex justify="space-between" px="2" mb="1">
        <Text fontSize="9px" color={stage >= 1 ? color : 'kk.textMuted'}>{t("stageInput")}</Text>
        <Text fontSize="9px" color={stage >= 2 ? color : 'kk.textMuted'}>{t("stageProtocol")}</Text>
        <Text fontSize="9px" color={stage >= 3 ? color : 'kk.textMuted'}>{t("stageOutput")}</Text>
      </Flex>

      {/* Confirmations */}
      {swap.status === 'confirming' && swap.confirmations > 0 && (
        <Text fontSize="10px" color={color} mt="1">
          {swap.confirmations} {t("confirmations")}
        </Text>
      )}

      {/* Output confirmations progress */}
      {swap.outboundConfirmations !== undefined && swap.outboundRequiredConfirmations !== undefined && (
        <Box mt="2">
          <Flex justify="space-between" mb="1">
            <Text fontSize="10px" color="kk.textMuted">{t("outputConfirmations")}</Text>
            <Text fontSize="10px" color={color} fontWeight="600">
              {swap.outboundConfirmations} / {swap.outboundRequiredConfirmations}
            </Text>
          </Flex>
          <Box h="4px" bg="rgba(255,255,255,0.08)" borderRadius="full" overflow="hidden">
            <Box
              h="100%"
              bg={color}
              w={`${Math.min(100, (swap.outboundConfirmations / (swap.outboundRequiredConfirmations || 1)) * 100)}%`}
              transition="width 0.3s"
              borderRadius="full"
            />
          </Box>
        </Box>
      )}

      {/* Error message */}
      {swap.error && (
        <Text fontSize="10px" color="#EF4444" mt="2">{swap.error}</Text>
      )}

      {/* Footer */}
      <Flex justify="space-between" align="center" mt="3" pt="2" borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
        <Text fontSize="10px" color="kk.textMuted">
          {t("elapsed")}: {formatElapsed(elapsed)}
          {!isFinal && swap.estimatedTime > 0 && ` / ${t("estimated")} ${formatElapsed(swap.estimatedTime * 1000)}`}
        </Text>
        <HStack gap="1.5">
          <Button
            size="xs" variant="ghost" color="kk.textMuted" px="1.5" minW="auto" h="auto" py="0.5"
            fontSize="10px" onClick={copyTxid}
            _hover={{ color: "#23DCC8" }}
          >
            {copied ? t("copied") : swap.txid.slice(0, 6) + '...' + swap.txid.slice(-4)}
          </Button>
          {isFinal && (
            <Button
              size="xs" variant="ghost" color="kk.textMuted" px="1.5" minW="auto" h="auto" py="0.5"
              fontSize="10px" onClick={() => onDismiss(swap.txid)}
              _hover={{ color: "kk.error" }}
            >
              {t("dismiss")}
            </Button>
          )}
        </HStack>
      </Flex>
    </Box>
  )
}

// ── Main SwapHistoryDialog ──────────────────────────────────────────

interface SwapHistoryDialogProps {
  open: boolean
  onClose: () => void
}

export function SwapHistoryDialog({ open, onClose }: SwapHistoryDialogProps) {
  const { t } = useTranslation("swap")
  const [swaps, setSwaps] = useState<PendingSwap[]>([])

  const fetchSwaps = useCallback(() => {
    rpcRequest<PendingSwap[]>('getPendingSwaps', undefined, 5000)
      .then((result) => {
        if (result) setSwaps(result)
      })
      .catch(() => {})
  }, [])

  // Fetch on open
  useEffect(() => {
    if (open) fetchSwaps()
  }, [open, fetchSwaps])

  // Listen for DOM events from SwapDialog
  useEffect(() => {
    const handler = () => {
      fetchSwaps()
      setTimeout(fetchSwaps, 1000)
      setTimeout(fetchSwaps, 3000)
    }
    window.addEventListener('keepkey-swap-executed', handler)
    return () => window.removeEventListener('keepkey-swap-executed', handler)
  }, [fetchSwaps])

  // Listen for RPC push updates
  useEffect(() => {
    const unsub1 = onRpcMessage('swap-update', (update: SwapStatusUpdate) => {
      setSwaps(prev => {
        const idx = prev.findIndex(s => s.txid === update.txid)
        if (idx === -1) {
          fetchSwaps()
          return prev
        }
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          status: update.status,
          updatedAt: Date.now(),
          ...(update.confirmations !== undefined ? { confirmations: update.confirmations } : {}),
          ...(update.outboundConfirmations !== undefined ? { outboundConfirmations: update.outboundConfirmations } : {}),
          ...(update.outboundRequiredConfirmations !== undefined ? { outboundRequiredConfirmations: update.outboundRequiredConfirmations } : {}),
          ...(update.outboundTxid ? { outboundTxid: update.outboundTxid } : {}),
          ...(update.error ? { error: update.error } : {}),
        }
        return updated
      })
    })

    const unsub2 = onRpcMessage('swap-complete', (swap: PendingSwap) => {
      setSwaps(prev => {
        const idx = prev.findIndex(s => s.txid === swap.txid)
        if (idx === -1) return [...prev, swap]
        const updated = [...prev]
        updated[idx] = swap
        return updated
      })
    })

    return () => { unsub1(); unsub2() }
  }, [fetchSwaps])

  // Poll while open and there are active swaps
  const activeSwaps = useMemo(() =>
    swaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'),
    [swaps]
  )

  const completedSwaps = useMemo(() =>
    swaps.filter(s => s.status === 'completed' || s.status === 'failed' || s.status === 'refunded'),
    [swaps]
  )

  useEffect(() => {
    if (!open || activeSwaps.length === 0) return
    const interval = setInterval(fetchSwaps, 15000)
    return () => clearInterval(interval)
  }, [open, activeSwaps.length, fetchSwaps])

  const handleDismiss = useCallback((txid: string) => {
    rpcRequest('dismissSwap', { txid }).catch(() => {})
    setSwaps(prev => prev.filter(s => s.txid !== txid))
  }, [])

  if (!open) return null

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={onClose}>
      <style>{HISTORY_CSS}</style>
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box
        position="relative"
        bg="kk.cardBg"
        border="1px solid"
        borderColor={activeSwaps.length > 0 ? 'rgba(35,220,200,0.3)' : 'kk.border'}
        borderRadius="xl"
        w="520px"
        maxW="90vw"
        maxH="80vh"
        display="flex"
        flexDirection="column"
        overflow="hidden"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'kkHistoryFadeIn 0.2s ease-out' }}
      >
        {/* Header */}
        <Flex px="5" py="3" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between" flexShrink={0}>
          <HStack gap="2">
            <Text fontSize="md" fontWeight="600" color="kk.textPrimary">{t("swapHistory")}</Text>
            {swaps.length > 0 && (
              <Text fontSize="10px" color="kk.textMuted" bg="rgba(255,255,255,0.06)" px="2" py="0.5" borderRadius="md">
                {swaps.length}
              </Text>
            )}
          </HStack>
          <Button size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto" _hover={{ color: "kk.textPrimary" }} onClick={onClose}>
            &times;
          </Button>
        </Flex>

        {/* Body */}
        <Box flex="1" overflow="auto" px="5" py="4">
          {swaps.length === 0 ? (
            <Flex justify="center" align="center" py="12" direction="column" gap="2">
              <Text fontSize="2xl" color="kk.textMuted" opacity={0.3}>&#9889;</Text>
              <Text fontSize="sm" color="kk.textMuted">{t("noSwapHistory")}</Text>
            </Flex>
          ) : (
            <VStack gap="3" align="stretch">
              {/* Active swaps */}
              {activeSwaps.length > 0 && (
                <>
                  <HStack gap="2" mb="1">
                    <Box w="6px" h="6px" borderRadius="full" bg="#23DCC8" style={{ animation: 'kkSwapPulse 1.5s ease-in-out infinite' }} />
                    <Text fontSize="xs" fontWeight="600" color="#23DCC8" textTransform="uppercase" letterSpacing="0.05em">
                      {t("activeSwaps")} ({activeSwaps.length})
                    </Text>
                  </HStack>
                  {activeSwaps.map(swap => (
                    <SwapCard key={swap.txid} swap={swap} onDismiss={handleDismiss} />
                  ))}
                </>
              )}

              {/* Completed swaps */}
              {completedSwaps.length > 0 && (
                <>
                  {activeSwaps.length > 0 && <Box h="2px" bg="rgba(255,255,255,0.06)" my="2" />}
                  <Text fontSize="xs" fontWeight="600" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em" mb="1">
                    {t("completedSwaps")} ({completedSwaps.length})
                  </Text>
                  {completedSwaps.map(swap => (
                    <SwapCard key={swap.txid} swap={swap} onDismiss={handleDismiss} />
                  ))}
                </>
              )}
            </VStack>
          )}
        </Box>
      </Box>
    </Box>
  )
}
