/**
 * ActivityTracker — floating bubble (bottom-left) showing recent transaction activity.
 *
 * Always visible. Queries api_log (with activity_type) + swap_history.
 * Captures: broadcasts, swaps, API signs, messages.
 */
import { useState, useEffect, useCallback, useRef } from "react"
import { Box, Text } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { ActivityPanel } from "./ActivityPanel"
import type { RecentActivity, PendingSwap, SwapStatusUpdate, ApiLogEntry } from "../../shared/types"

const TRACKER_CSS = `
  @keyframes kkActivityPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(35,220,200,0.5); }
    50% { box-shadow: 0 0 0 8px rgba(35,220,200,0); }
  }
`

export function ActivityTracker() {
  const [activities, setActivities] = useState<RecentActivity[]>([])
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  const [hasNew, setHasNew] = useState(false)
  const lastCountRef = useRef(0)

  // Fetch recent activities from api_log + swap_history (unified query)
  const fetchActivities = useCallback(() => {
    rpcRequest<RecentActivity[]>('getRecentActivity', { limit: 50 }, 5000)
      .then((result) => { if (result) setActivities(result) })
      .catch(() => {})
  }, [])

  // Fetch pending swaps (for live swap tracking)
  const fetchSwaps = useCallback(() => {
    rpcRequest<PendingSwap[]>('getPendingSwaps', undefined, 5000)
      .then((result) => { if (result) setPendingSwaps(result) })
      .catch(() => {})
  }, [])

  // Fetch on mount
  useEffect(() => { fetchActivities(); fetchSwaps() }, [fetchActivities, fetchSwaps])

  // Listen for new api-log entries — re-fetch if it's a sign/broadcast
  useEffect(() => {
    const unsub = onRpcMessage('api-log', (entry: ApiLogEntry) => {
      if (entry.activityType) {
        // New sign/broadcast logged — refresh activity list
        fetchActivities()
      }
    })
    return unsub
  }, [fetchActivities])

  // Listen for swap updates (keep swap awareness)
  useEffect(() => {
    const unsub1 = onRpcMessage('swap-update', (_update: SwapStatusUpdate) => {
      fetchSwaps()
    })
    const unsub2 = onRpcMessage('swap-complete', (swap: PendingSwap) => {
      fetchSwaps()
      fetchActivities()
      if (swap.status === 'completed' || swap.status === 'refunded') {
        window.dispatchEvent(new CustomEvent('keepkey-swap-completed', {
          detail: { fromChainId: swap.fromChainId, toChainId: swap.toChainId }
        }))
      }
    })
    return () => { unsub1(); unsub2() }
  }, [fetchSwaps, fetchActivities])

  // Listen for swap-executed DOM event from SwapDialog
  useEffect(() => {
    const handler = () => {
      fetchActivities()
      fetchSwaps()
      setTimeout(fetchActivities, 1000)
      setTimeout(fetchSwaps, 1000)
    }
    window.addEventListener('keepkey-swap-executed', handler)
    return () => window.removeEventListener('keepkey-swap-executed', handler)
  }, [fetchActivities, fetchSwaps])

  // Detect new items for pulse animation
  const activeSwapCount = pendingSwaps.filter(s =>
    s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'
  ).length
  const totalCount = activities.length + activeSwapCount
  useEffect(() => {
    if (totalCount > lastCountRef.current && !panelOpen) {
      setHasNew(true)
    }
    lastCountRef.current = totalCount
  }, [totalCount, panelOpen])

  const handleOpen = () => {
    setPanelOpen(true)
    setHasNew(false)
  }

  // Label
  const displayCount = activities.length + activeSwapCount
  let label: string
  if (displayCount === 0) {
    label = 'Activity'
  } else if (activeSwapCount > 0 && activities.length > 0) {
    label = `${displayCount} event${displayCount > 1 ? 's' : ''}`
  } else if (activeSwapCount > 0) {
    label = `${activeSwapCount} swap${activeSwapCount > 1 ? 's' : ''}`
  } else {
    label = `${activities.length} tx${activities.length > 1 ? 's' : ''}`
  }

  return (
    <>
      <style>{TRACKER_CSS}</style>

      {/* Floating bubble — always visible */}
      <Box position="fixed" bottom="20px" left="20px" zIndex={Z.nav + 1}>
        <Box
          as="button"
          display="flex"
          alignItems="center"
          gap="2"
          bg={displayCount > 0 ? "rgba(35,220,200,0.15)" : "rgba(255,255,255,0.05)"}
          border="1px solid"
          borderColor={displayCount > 0 ? "rgba(35,220,200,0.4)" : "rgba(255,255,255,0.1)"}
          borderRadius="full"
          px="3"
          py="1.5"
          cursor="pointer"
          _hover={{ bg: displayCount > 0 ? "rgba(35,220,200,0.25)" : "rgba(255,255,255,0.1)", transform: "scale(1.05)" }}
          transition="all 0.2s"
          onClick={handleOpen}
          style={hasNew ? { animation: 'kkActivityPulse 2s ease-in-out infinite' } : {}}
        >
          {activeSwapCount > 0 ? (
            <Box w="8px" h="8px" borderRadius="full" bg="#23DCC8" style={{ animation: 'kkActivityPulse 1.5s ease-in-out infinite' }} />
          ) : (
            <Text fontSize="xs" opacity={displayCount > 0 ? 1 : 0.5}>&#9889;</Text>
          )}
          <Text fontSize="xs" fontWeight="600" color={displayCount > 0 ? "#23DCC8" : "whiteAlpha.500"}>
            {label}
          </Text>
        </Box>
      </Box>

      {/* Activity panel */}
      <ActivityPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        activities={activities}
        pendingSwaps={pendingSwaps}
        onRefresh={() => { fetchActivities(); fetchSwaps() }}
      />
    </>
  )
}
