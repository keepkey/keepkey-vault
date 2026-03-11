/**
 * SwapTracker — floating bubble that shows when swaps are active.
 *
 * Click to open SwapHistoryDialog for full swap details + history.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Box, Text } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { SwapHistoryDialog } from "./SwapHistoryDialog"
import type { PendingSwap, SwapStatusUpdate } from "../../shared/types"

const TRACKER_CSS = `
  @keyframes kkTrackerPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(35,220,200,0.5); }
    50% { box-shadow: 0 0 0 8px rgba(35,220,200,0); }
  }
`

export function SwapTracker() {
  const { t } = useTranslation("swap")
  const [swaps, setSwaps] = useState<PendingSwap[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [hasNew, setHasNew] = useState(false)
  const lastCountRef = useRef(0)

  const fetchSwaps = useCallback(() => {
    rpcRequest<PendingSwap[]>('getPendingSwaps', undefined, 5000)
      .then((result) => {
        if (result) setSwaps(result)
      })
      .catch(() => {})
  }, [])

  // Fetch on mount
  useEffect(() => { fetchSwaps() }, [fetchSwaps])

  // Listen for swap-executed DOM event from SwapDialog
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
      // Trigger balance refresh for both chains when swap completes
      if (swap.status === 'completed' || swap.status === 'refunded') {
        window.dispatchEvent(new CustomEvent('keepkey-swap-completed', {
          detail: { fromChainId: swap.fromChainId, toChainId: swap.toChainId }
        }))
      }
    })

    return () => { unsub1(); unsub2() }
  }, [fetchSwaps])

  // Detect new swaps for pulse animation
  useEffect(() => {
    if (swaps.length > lastCountRef.current && !historyOpen) {
      setHasNew(true)
    }
    lastCountRef.current = swaps.length
  }, [swaps.length, historyOpen])

  // Poll while active swaps exist
  const activeSwaps = useMemo(() =>
    swaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'),
    [swaps]
  )

  useEffect(() => {
    if (swaps.length === 0) return
    const interval = setInterval(fetchSwaps, 15000)
    return () => clearInterval(interval)
  }, [swaps.length, fetchSwaps])

  const handleOpen = () => {
    setHistoryOpen(true)
    setHasNew(false)
  }

  // Don't render if no swaps
  if (swaps.length === 0) return null

  return (
    <>
      <style>{TRACKER_CSS}</style>

      {/* Floating bubble */}
      <Box position="fixed" bottom="20px" left="20px" zIndex={Z.nav + 1}>
        <Box
          as="button"
          display="flex"
          alignItems="center"
          gap="2"
          bg="rgba(35,220,200,0.15)"
          border="1px solid"
          borderColor="rgba(35,220,200,0.4)"
          borderRadius="full"
          px="3"
          py="1.5"
          cursor="pointer"
          _hover={{ bg: "rgba(35,220,200,0.25)", transform: "scale(1.05)" }}
          transition="all 0.2s"
          onClick={handleOpen}
          style={hasNew ? { animation: 'kkTrackerPulse 2s ease-in-out infinite' } : {}}
        >
          {activeSwaps.length > 0 ? (
            <Box w="8px" h="8px" borderRadius="full" bg="#23DCC8" style={{ animation: 'kkTrackerPulse 1.5s ease-in-out infinite' }} />
          ) : (
            <Text fontSize="xs">&#9889;</Text>
          )}
          <Text fontSize="xs" fontWeight="600" color="#23DCC8">
            {activeSwaps.length > 0 ? `${activeSwaps.length} swap${activeSwaps.length > 1 ? 's' : ''}` : t("activeSwaps")}
          </Text>
        </Box>
      </Box>

      {/* History dialog */}
      <SwapHistoryDialog open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  )
}
