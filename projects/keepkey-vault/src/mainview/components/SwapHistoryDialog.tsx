/**
 * SwapHistoryDialog — Full dialog for viewing active + historical swaps.
 *
 * Shows live pending swaps at top, SQLite-persisted history below.
 * Supports filtering by status/date/asset and PDF/CSV export.
 */
import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, HStack, Button, Input } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { getExplorerTxUrl } from "../../shared/chains"
import type { PendingSwap, SwapStatusUpdate, SwapHistoryRecord, SwapHistoryStats, SwapTrackingStatus } from "../../shared/types"

const ExternalLinkIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

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

function formatDate(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
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

type TabId = 'active' | 'history'
type StatusFilter = SwapTrackingStatus | 'all'

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

// ── Active Swap Card (live polling) ─────────────────────────────────

function ActiveSwapCard({ swap, onDismiss, onResume }: { swap: PendingSwap; onDismiss: (txid: string) => void; onResume?: (swap: PendingSwap) => void }) {
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
      cursor={onResume ? "pointer" : undefined}
      transition="all 0.2s"
      _hover={{ borderColor: isFinal ? undefined : 'rgba(35,220,200,0.3)' }}
      onClick={() => onResume?.(swap)}
    >
      <Flex justify="space-between" align="center" mb="1.5">
        <HStack gap="2">
          <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{swap.fromSymbol}</Text>
          <Text fontSize="xs" color="kk.textMuted">&rarr;</Text>
          <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{swap.toSymbol}</Text>
        </HStack>
        <Text fontSize="10px" fontWeight="600" color={color} bg={`${color}15`} px="2" py="0.5" borderRadius="md">
          {statusLabel}
        </Text>
      </Flex>

      <Text fontSize="xs" color="kk.textSecondary" mb="1">
        {swap.fromAmount} {swap.fromSymbol} &rarr; ~{swap.expectedOutput} {swap.toSymbol}
      </Text>

      <StageIndicator stage={stage} status={swap.status} />

      <Flex justify="space-between" px="2" mb="1">
        <Text fontSize="9px" color={stage >= 1 ? color : 'kk.textMuted'}>{t("stageInput")}</Text>
        <Text fontSize="9px" color={stage >= 2 ? color : 'kk.textMuted'}>{t("stageProtocol")}</Text>
        <Text fontSize="9px" color={stage >= 3 ? color : 'kk.textMuted'}>{t("stageOutput")}</Text>
      </Flex>

      {swap.status === 'confirming' && swap.confirmations > 0 && (
        <Text fontSize="10px" color={color} mt="1">{swap.confirmations} {t("confirmations")}</Text>
      )}

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
              h="100%" bg={color}
              w={`${Math.min(100, (swap.outboundConfirmations / (swap.outboundRequiredConfirmations || 1)) * 100)}%`}
              transition="width 0.3s" borderRadius="full"
            />
          </Box>
        </Box>
      )}

      {swap.error && (
        <Text fontSize="10px" color="#EF4444" mt="2">{swap.error}</Text>
      )}

      <Flex justify="space-between" align="center" mt="3" pt="2" borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
        <Text fontSize="10px" color="kk.textMuted">
          {t("elapsed")}: {formatElapsed(elapsed)}
          {!isFinal && swap.estimatedTime > 0 && ` / ${t("estimated")} ${formatElapsed(swap.estimatedTime * 1000)}`}
        </Text>
        <HStack gap="1">
          <Button
            size="xs" variant="ghost" color="kk.textMuted" px="1.5" minW="auto" h="auto" py="0.5"
            fontSize="10px" onClick={(e) => { e.stopPropagation(); copyTxid() }}
            _hover={{ color: "#23DCC8" }}
          >
            {copied ? t("copied") : swap.txid.slice(0, 6) + '...' + swap.txid.slice(-4)}
          </Button>
          {(() => {
            const url = getExplorerTxUrl(swap.fromChainId, swap.txid)
            return url ? (
              <Button size="xs" variant="ghost" color="#23DCC8" px="1" minW="auto" h="auto" py="0.5"
                onClick={(e) => { e.stopPropagation(); rpcRequest('openUrl', { url }).catch(() => {}) }} title="View on explorer">
                <ExternalLinkIcon />
              </Button>
            ) : null
          })()}
          {swap.outboundTxid && (() => {
            const url = getExplorerTxUrl(swap.toChainId, swap.outboundTxid)
            return url ? (
              <Button size="xs" variant="ghost" color="#4ADE80" px="1" minW="auto" h="auto" py="0.5"
                onClick={(e) => { e.stopPropagation(); rpcRequest('openUrl', { url }).catch(() => {}) }} title="View outbound on explorer">
                <ExternalLinkIcon />
              </Button>
            ) : null
          })()}
          {isFinal && (
            <Button
              size="xs" variant="ghost" color="kk.textMuted" px="1.5" minW="auto" h="auto" py="0.5"
              fontSize="10px" onClick={(e) => { e.stopPropagation(); onDismiss(swap.txid) }}
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

// ── History Record Card (from SQLite) ───────────────────────────────

function HistoryCard({ record, onResume }: { record: SwapHistoryRecord; onResume?: (swap: PendingSwap) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const color = getStatusColor(record.status)
  const isFinal = record.status === 'completed' || record.status === 'failed' || record.status === 'refunded'

  const copyValue = (val: string, label: string) => {
    navigator.clipboard.writeText(val)
      .then(() => { setCopied(label); setTimeout(() => setCopied(null), 2000) })
      .catch(() => {})
  }

  // Calculate quote accuracy for completed swaps
  let quoteAccuracy: { diff: number; pct: string; positive: boolean } | null = null
  if (record.status === 'completed' && record.receivedOutput && record.quotedOutput) {
    const quoted = parseFloat(record.quotedOutput)
    const received = parseFloat(record.receivedOutput)
    if (quoted > 0 && received > 0) {
      const diff = received - quoted
      quoteAccuracy = { diff, pct: ((diff / quoted) * 100).toFixed(2), positive: diff >= 0 }
    }
  }

  const durationStr = record.actualTimeSeconds !== undefined
    ? (record.actualTimeSeconds < 60 ? `${record.actualTimeSeconds}s` : `${Math.floor(record.actualTimeSeconds / 60)}m ${record.actualTimeSeconds % 60}s`)
    : null

  return (
    <Box
      bg="rgba(255,255,255,0.03)"
      border="1px solid"
      borderColor={
        record.status === 'completed' ? 'rgba(74,222,128,0.15)'
        : record.status === 'failed' ? 'rgba(239,68,68,0.15)'
        : 'rgba(255,255,255,0.06)'
      }
      borderRadius="lg"
      p="3"
      cursor="pointer"
      onClick={() => setExpanded(!expanded)}
      transition="all 0.15s"
      _hover={{ borderColor: 'rgba(35,220,200,0.25)' }}
    >
      {/* Header row */}
      <Flex justify="space-between" align="center" mb="1">
        <HStack gap="2">
          <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
            {record.fromSymbol} &rarr; {record.toSymbol}
          </Text>
          <Text fontSize="10px" fontWeight="600" color={color} bg={`${color}15`} px="2" py="0.5" borderRadius="md">
            {record.status}
          </Text>
        </HStack>
        <Text fontSize="10px" color="kk.textMuted">{formatDate(record.createdAt)}</Text>
      </Flex>

      {/* Amounts row */}
      <Flex justify="space-between" align="center">
        <Text fontSize="xs" color="kk.textSecondary">
          {record.fromAmount} {record.fromSymbol}
          {record.receivedOutput
            ? <> &rarr; {record.receivedOutput} {record.toSymbol}</>
            : <> &rarr; ~{record.quotedOutput} {record.toSymbol} <Text as="span" color="kk.textMuted">(quoted)</Text></>
          }
        </Text>
        {durationStr && (
          <Text fontSize="10px" color="kk.textMuted">{durationStr}</Text>
        )}
      </Flex>

      {/* Quote accuracy badge */}
      {quoteAccuracy && (
        <HStack gap="1" mt="1">
          <Text fontSize="10px" color={quoteAccuracy.positive ? '#4ADE80' : '#EF4444'}>
            {quoteAccuracy.positive ? '+' : ''}{quoteAccuracy.pct}% vs quote
          </Text>
        </HStack>
      )}

      {record.error && (
        <Text fontSize="10px" color="#EF4444" mt="1" noOfLines={expanded ? undefined : 1}>{record.error}</Text>
      )}

      {/* Expanded details */}
      {expanded && (
        <Box mt="3" pt="3" borderTop="1px solid" borderColor="rgba(255,255,255,0.06)">
          <VStack gap="1.5" align="stretch">
            <DetailRow label="Integration" value={record.integration} />
            <DetailRow label="Slippage" value={`${record.slippageBps} bps (${(record.slippageBps / 100).toFixed(1)}%)`} />
            <DetailRow label="Fee" value={`${record.feeBps} bps`} />
            <DetailRow label="Outbound Fee" value={record.feeOutbound} />
            <DetailRow label="Quoted" value={`${record.quotedOutput} ${record.toSymbol}`} />
            <DetailRow label="Minimum" value={`${record.minimumOutput} ${record.toSymbol}`} />
            {record.receivedOutput && (
              <DetailRow label="Received" value={`${record.receivedOutput} ${record.toSymbol}`} />
            )}
            <DetailRow label="Est. Time" value={`${record.estimatedTimeSeconds}s`} />
            {record.actualTimeSeconds !== undefined && (
              <DetailRow label="Actual Time" value={`${record.actualTimeSeconds}s`} />
            )}

            {/* TX IDs with copy + explorer buttons */}
            <Flex justify="space-between" align="center">
              <Text fontSize="10px" color="kk.textMuted" minW="80px">Inbound TX</Text>
              <HStack gap="1">
                <Button
                  size="xs" variant="ghost" color="#23DCC8" px="1" minW="auto" h="auto" py="0.5"
                  fontSize="10px" onClick={(e) => { e.stopPropagation(); copyValue(record.txid, 'inbound') }}
                  _hover={{ color: "#4ADE80" }}
                >
                  {copied === 'inbound' ? 'Copied!' : record.txid.slice(0, 10) + '...' + record.txid.slice(-6)}
                </Button>
                {(() => {
                  const url = getExplorerTxUrl(record.fromChainId, record.txid)
                  return url ? (
                    <Button size="xs" variant="ghost" color="#23DCC8" px="1" minW="auto" h="auto" py="0.5"
                      onClick={(e) => { e.stopPropagation(); rpcRequest('openUrl', { url }).catch(() => {}) }} title="View on explorer">
                      <ExternalLinkIcon />
                    </Button>
                  ) : null
                })()}
              </HStack>
            </Flex>
            {record.outboundTxid && (
              <Flex justify="space-between" align="center">
                <Text fontSize="10px" color="kk.textMuted" minW="80px">Outbound TX</Text>
                <HStack gap="1">
                  <Button
                    size="xs" variant="ghost" color="#23DCC8" px="1" minW="auto" h="auto" py="0.5"
                    fontSize="10px" onClick={(e) => { e.stopPropagation(); copyValue(record.outboundTxid!, 'outbound') }}
                    _hover={{ color: "#4ADE80" }}
                  >
                    {copied === 'outbound' ? 'Copied!' : record.outboundTxid.slice(0, 10) + '...' + record.outboundTxid.slice(-6)}
                  </Button>
                  {(() => {
                    const url = getExplorerTxUrl(record.toChainId, record.outboundTxid)
                    return url ? (
                      <Button size="xs" variant="ghost" color="#4ADE80" px="1" minW="auto" h="auto" py="0.5"
                        onClick={(e) => { e.stopPropagation(); rpcRequest('openUrl', { url }).catch(() => {}) }} title="View on explorer">
                        <ExternalLinkIcon />
                      </Button>
                    ) : null
                  })()}
                </HStack>
              </Flex>
            )}
            {record.approvalTxid && (
              <Flex justify="space-between" align="center">
                <Text fontSize="10px" color="kk.textMuted" minW="80px">Approval TX</Text>
                <HStack gap="1">
                  <Button
                    size="xs" variant="ghost" color="#23DCC8" px="1" minW="auto" h="auto" py="0.5"
                    fontSize="10px" onClick={(e) => { e.stopPropagation(); copyValue(record.approvalTxid!, 'approval') }}
                    _hover={{ color: "#4ADE80" }}
                  >
                    {copied === 'approval' ? 'Copied!' : record.approvalTxid.slice(0, 10) + '...' + record.approvalTxid.slice(-6)}
                  </Button>
                  {(() => {
                    const url = getExplorerTxUrl(record.fromChainId, record.approvalTxid)
                    return url ? (
                      <Button size="xs" variant="ghost" color="#23DCC8" px="1" minW="auto" h="auto" py="0.5"
                        onClick={(e) => { e.stopPropagation(); rpcRequest('openUrl', { url }).catch(() => {}) }} title="View on explorer">
                        <ExternalLinkIcon />
                      </Button>
                    ) : null
                  })()}
                </HStack>
              </Flex>
            )}

            {/* Resume / view swap button */}
            {onResume && (
              <Button
                size="xs"
                mt="2"
                w="full"
                bg="rgba(35,220,200,0.12)"
                color="#23DCC8"
                fontWeight="600"
                fontSize="11px"
                _hover={{ bg: "rgba(35,220,200,0.2)" }}
                onClick={(e) => {
                  e.stopPropagation()
                  onResume({
                    txid: record.txid,
                    fromAsset: record.fromAsset,
                    toAsset: record.toAsset,
                    fromSymbol: record.fromSymbol,
                    toSymbol: record.toSymbol,
                    fromChainId: record.fromChainId,
                    toChainId: record.toChainId,
                    fromAmount: record.fromAmount,
                    expectedOutput: record.receivedOutput || record.quotedOutput,
                    memo: record.memo,
                    inboundAddress: record.inboundAddress,
                    router: record.router,
                    integration: record.integration,
                    status: record.status,
                    confirmations: 0,
                    outboundTxid: record.outboundTxid,
                    createdAt: record.createdAt,
                    updatedAt: record.updatedAt,
                    estimatedTime: record.estimatedTimeSeconds,
                    error: record.error,
                  })
                }}
              >
                View Swap
              </Button>
            )}
          </VStack>
        </Box>
      )}
    </Box>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex justify="space-between" align="center">
      <Text fontSize="10px" color="kk.textMuted" minW="80px">{label}</Text>
      <Text fontSize="10px" color="kk.textSecondary" textAlign="right">{value}</Text>
    </Flex>
  )
}

// ── Status Filter Pills ─────────────────────────────────────────────

const STATUS_OPTIONS: { id: StatusFilter; label: string; color: string }[] = [
  { id: 'all', label: 'All', color: '#9CA3AF' },
  { id: 'completed', label: 'Completed', color: '#4ADE80' },
  { id: 'failed', label: 'Failed', color: '#EF4444' },
  { id: 'refunded', label: 'Refunded', color: '#FB923C' },
  { id: 'pending', label: 'Pending', color: '#FBBF24' },
]

// ── Main SwapHistoryDialog ──────────────────────────────────────────

interface SwapHistoryDialogProps {
  open: boolean
  onClose: () => void
  onResumeSwap?: (swap: PendingSwap) => void
}

export function SwapHistoryDialog({ open, onClose, onResumeSwap }: SwapHistoryDialogProps) {
  const { t } = useTranslation("swap")
  const [tab, setTab] = useState<TabId>('active')
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([])
  const [history, setHistory] = useState<SwapHistoryRecord[]>([])
  const [stats, setStats] = useState<SwapHistoryStats | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [exporting, setExporting] = useState<'pdf' | 'csv' | null>(null)
  const [exportResult, setExportResult] = useState<string | null>(null)

  // Fetch active pending swaps
  const fetchPending = useCallback(() => {
    rpcRequest<PendingSwap[]>('getPendingSwaps', undefined, 5000)
      .then((result) => { if (result) setPendingSwaps(result) })
      .catch(() => {})
  }, [])

  // Fetch history from SQLite
  const fetchHistory = useCallback(() => {
    rpcRequest<SwapHistoryRecord[]>('getSwapHistory', {
      status: statusFilter === 'all' ? undefined : statusFilter,
      asset: searchQuery || undefined,
      limit: 200,
    }, 10000)
      .then((result) => { if (result) setHistory(result) })
      .catch(() => {})

    rpcRequest<SwapHistoryStats>('getSwapHistoryStats', undefined, 5000)
      .then((result) => { if (result) setStats(result) })
      .catch(() => {})
  }, [statusFilter, searchQuery])

  // Initial load
  useEffect(() => {
    if (!open) return
    fetchPending()
    fetchHistory()
  }, [open, fetchPending, fetchHistory])

  // Listen for DOM events from SwapDialog
  useEffect(() => {
    const handler = () => {
      fetchPending()
      fetchHistory()
      setTimeout(fetchPending, 1000)
      setTimeout(fetchHistory, 2000)
    }
    window.addEventListener('keepkey-swap-executed', handler)
    return () => window.removeEventListener('keepkey-swap-executed', handler)
  }, [fetchPending, fetchHistory])

  // Listen for RPC push updates
  useEffect(() => {
    const unsub1 = onRpcMessage('swap-update', (update: SwapStatusUpdate) => {
      setPendingSwaps(prev => {
        const idx = prev.findIndex(s => s.txid === update.txid)
        if (idx === -1) { fetchPending(); return prev }
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
      // Also refresh history on terminal status
      if (update.status === 'completed' || update.status === 'failed' || update.status === 'refunded') {
        setTimeout(fetchHistory, 500)
      }
    })

    const unsub2 = onRpcMessage('swap-complete', () => {
      fetchPending()
      setTimeout(fetchHistory, 500)
    })

    return () => { unsub1(); unsub2() }
  }, [fetchPending, fetchHistory])

  // Poll active swaps
  const activeSwaps = useMemo(() =>
    pendingSwaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'),
    [pendingSwaps]
  )

  useEffect(() => {
    if (!open || activeSwaps.length === 0) return
    const interval = setInterval(fetchPending, 15000)
    return () => clearInterval(interval)
  }, [open, activeSwaps.length, fetchPending])

  const handleDismiss = useCallback((txid: string) => {
    rpcRequest('dismissSwap', { txid }).catch(() => {})
    setPendingSwaps(prev => prev.filter(s => s.txid !== txid))
  }, [])

  const handleExport = useCallback(async (format: 'pdf' | 'csv') => {
    setExporting(format)
    setExportResult(null)
    try {
      const result = await rpcRequest<{ filePath: string }>('exportSwapReport', { format }, 30000)
      if (result?.filePath) {
        setExportResult(result.filePath)
      }
    } catch (e: any) {
      setExportResult(`Error: ${e.message || 'Export failed'}`)
    } finally {
      setExporting(null)
    }
  }, [])

  if (!open) return null

  const hasActive = activeSwaps.length > 0 || pendingSwaps.some(s => s.status === 'completed' || s.status === 'failed' || s.status === 'refunded')

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
        w="620px"
        maxW="95vw"
        maxH="85vh"
        display="flex"
        flexDirection="column"
        overflow="hidden"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'kkHistoryFadeIn 0.2s ease-out' }}
      >
        {/* Header */}
        <Flex px="5" py="3" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between" flexShrink={0}>
          <HStack gap="3">
            <Text fontSize="md" fontWeight="600" color="kk.textPrimary">{t("swapHistory")}</Text>
            {stats && (
              <HStack gap="1.5">
                <Text fontSize="10px" color="#4ADE80" bg="rgba(74,222,128,0.1)" px="1.5" py="0.5" borderRadius="md">
                  {stats.completed}
                </Text>
                {stats.failed > 0 && (
                  <Text fontSize="10px" color="#EF4444" bg="rgba(239,68,68,0.1)" px="1.5" py="0.5" borderRadius="md">
                    {stats.failed}
                  </Text>
                )}
                <Text fontSize="10px" color="kk.textMuted" bg="rgba(255,255,255,0.06)" px="1.5" py="0.5" borderRadius="md">
                  {stats.totalSwaps} total
                </Text>
              </HStack>
            )}
          </HStack>
          <Button size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto" _hover={{ color: "kk.textPrimary" }} onClick={onClose}>
            &times;
          </Button>
        </Flex>

        {/* Tabs */}
        <Flex px="5" pt="3" pb="2" gap="2" flexShrink={0}>
          <Button
            size="xs" variant={tab === 'active' ? 'solid' : 'ghost'}
            bg={tab === 'active' ? 'rgba(35,220,200,0.15)' : undefined}
            color={tab === 'active' ? '#23DCC8' : 'kk.textMuted'}
            _hover={{ bg: 'rgba(35,220,200,0.1)' }}
            onClick={() => setTab('active')}
          >
            Active {activeSwaps.length > 0 && `(${activeSwaps.length})`}
          </Button>
          <Button
            size="xs" variant={tab === 'history' ? 'solid' : 'ghost'}
            bg={tab === 'history' ? 'rgba(35,220,200,0.15)' : undefined}
            color={tab === 'history' ? '#23DCC8' : 'kk.textMuted'}
            _hover={{ bg: 'rgba(35,220,200,0.1)' }}
            onClick={() => setTab('history')}
          >
            History {stats ? `(${stats.totalSwaps})` : ''}
          </Button>

          {/* Export buttons */}
          {tab === 'history' && (
            <HStack gap="1" ml="auto">
              <Button
                size="xs" variant="ghost" color="kk.textMuted" fontSize="10px"
                onClick={() => handleExport('csv')}
                disabled={!!exporting}
                _hover={{ color: '#23DCC8' }}
              >
                {exporting === 'csv' ? 'Exporting...' : 'CSV'}
              </Button>
              <Button
                size="xs" variant="ghost" color="kk.textMuted" fontSize="10px"
                onClick={() => handleExport('pdf')}
                disabled={!!exporting}
                _hover={{ color: '#23DCC8' }}
              >
                {exporting === 'pdf' ? 'Exporting...' : 'PDF'}
              </Button>
            </HStack>
          )}
        </Flex>

        {/* Export result notification */}
        {exportResult && (
          <Box mx="5" mb="2" px="3" py="2" bg={exportResult.startsWith('Error') ? 'rgba(239,68,68,0.1)' : 'rgba(74,222,128,0.1)'}
            border="1px solid" borderColor={exportResult.startsWith('Error') ? 'rgba(239,68,68,0.2)' : 'rgba(74,222,128,0.2)'}
            borderRadius="md" flexShrink={0}
          >
            <Flex justify="space-between" align="center">
              <Text fontSize="11px" color={exportResult.startsWith('Error') ? '#EF4444' : '#4ADE80'}>
                {exportResult.startsWith('Error') ? exportResult : `Saved to ${exportResult}`}
              </Text>
              <Button size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto"
                onClick={() => setExportResult(null)} fontSize="10px">
                &times;
              </Button>
            </Flex>
          </Box>
        )}

        {/* Body */}
        <Box flex="1" overflow="auto" px="5" py="3">
          {tab === 'active' ? (
            /* Active swaps tab */
            pendingSwaps.length === 0 ? (
              <Flex justify="center" align="center" py="12" direction="column" gap="2">
                <Text fontSize="2xl" color="kk.textMuted" opacity={0.3}>&#9889;</Text>
                <Text fontSize="sm" color="kk.textMuted">No active swaps</Text>
                <Text fontSize="xs" color="kk.textMuted" opacity={0.5}>
                  Completed swaps are in the History tab
                </Text>
              </Flex>
            ) : (
              <VStack gap="3" align="stretch">
                {activeSwaps.length > 0 && (
                  <>
                    <HStack gap="2" mb="1">
                      <Box w="6px" h="6px" borderRadius="full" bg="#23DCC8" style={{ animation: 'kkSwapPulse 1.5s ease-in-out infinite' }} />
                      <Text fontSize="xs" fontWeight="600" color="#23DCC8" textTransform="uppercase" letterSpacing="0.05em">
                        {t("activeSwaps")} ({activeSwaps.length})
                      </Text>
                    </HStack>
                    {activeSwaps.map(swap => (
                      <ActiveSwapCard key={swap.txid} swap={swap} onDismiss={handleDismiss} onResume={onResumeSwap} />
                    ))}
                  </>
                )}
                {/* Recently completed in active tab */}
                {pendingSwaps.filter(s => s.status === 'completed' || s.status === 'failed' || s.status === 'refunded').length > 0 && (
                  <>
                    {activeSwaps.length > 0 && <Box h="2px" bg="rgba(255,255,255,0.06)" my="2" />}
                    <Text fontSize="xs" fontWeight="600" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.05em" mb="1">
                      Recently Finished
                    </Text>
                    {pendingSwaps
                      .filter(s => s.status === 'completed' || s.status === 'failed' || s.status === 'refunded')
                      .map(swap => (
                        <ActiveSwapCard key={swap.txid} swap={swap} onDismiss={handleDismiss} onResume={onResumeSwap} />
                      ))
                    }
                  </>
                )}
              </VStack>
            )
          ) : (
            /* History tab */
            <VStack gap="3" align="stretch">
              {/* Filters */}
              <HStack gap="2" flexWrap="wrap">
                {STATUS_OPTIONS.map(opt => (
                  <Button
                    key={opt.id}
                    size="xs"
                    variant={statusFilter === opt.id ? 'solid' : 'ghost'}
                    bg={statusFilter === opt.id ? `${opt.color}20` : undefined}
                    color={statusFilter === opt.id ? opt.color : 'kk.textMuted'}
                    borderRadius="full"
                    fontSize="10px"
                    px="3"
                    onClick={() => setStatusFilter(opt.id)}
                    _hover={{ bg: `${opt.color}15` }}
                  >
                    {opt.label}
                    {opt.id === 'completed' && stats ? ` (${stats.completed})` : ''}
                    {opt.id === 'failed' && stats ? ` (${stats.failed})` : ''}
                    {opt.id === 'refunded' && stats ? ` (${stats.refunded})` : ''}
                    {opt.id === 'pending' && stats ? ` (${stats.pending})` : ''}
                  </Button>
                ))}
              </HStack>

              {/* Search */}
              <Input
                placeholder="Search by asset (BTC, ETH, USDT...)"
                size="sm"
                bg="rgba(255,255,255,0.04)"
                border="1px solid"
                borderColor="kk.border"
                borderRadius="md"
                color="kk.textPrimary"
                fontSize="xs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                _placeholder={{ color: 'kk.textMuted' }}
                _focus={{ borderColor: 'rgba(35,220,200,0.4)' }}
              />

              {/* History records */}
              {history.length === 0 ? (
                <Flex justify="center" align="center" py="10" direction="column" gap="2">
                  <Text fontSize="sm" color="kk.textMuted">No swap history found</Text>
                  {statusFilter !== 'all' && (
                    <Button size="xs" variant="ghost" color="#23DCC8" onClick={() => setStatusFilter('all')}>
                      Clear filter
                    </Button>
                  )}
                </Flex>
              ) : (
                history.map(record => (
                  <HistoryCard key={record.id} record={record} onResume={onResumeSwap} />
                ))
              )}
            </VStack>
          )}
        </Box>
      </Box>
    </Box>
  )
}
