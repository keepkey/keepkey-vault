import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Box, Flex, Text, VStack, HStack, Image, Spinner } from "@chakra-ui/react"
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { CHAINS } from "../../shared/chains"
import { caipToIcon } from "../../shared/assetLookup"
import type { RecentActivity, PendingSwap, ChainBalance, SwapStatusUpdate, ApiLogEntry } from "../../shared/types"
import {
  ActivityRow, SwapRow, TxDetailDialog,
  recentFirst, nativePriceByChain,
  type TxDetail, type ActivityTimelineItem,
} from "./ActivityPanel"
import { ReportDialog } from "./ReportDialog"

interface ActivityPageProps {
  defaultChainId?: string
  onBack?: () => void
  onResumeSwap?: (swap: PendingSwap) => void
}

const TYPE_COLORS: Record<string, string> = {
  send: 'var(--rose)',
  receive: 'var(--teal)',
  swap: 'var(--gold)',
  sign: 'var(--violet)',
  approve: 'var(--amber, #e9a86a)',
  message: 'var(--violet)',
}

function bucketByDate(items: ActivityTimelineItem[]): Array<{ label: string; items: ActivityTimelineItem[] }> {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const groups = new Map<string, ActivityTimelineItem[]>()
  for (const item of items) {
    const d = new Date(item.createdAt)
    let label: string
    if (d.toDateString() === today.toDateString()) label = 'Today'
    else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday'
    else {
      label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(item)
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }))
}

function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <Box
      bg="var(--ink-1)"
      border="1px solid var(--line)"
      borderRadius="var(--r-md)"
      px="5"
      py="4"
      flex="1"
      minW={0}
      transition="border-color 0.2s"
      _hover={{ borderColor: 'var(--line-2)' }}
    >
      <Text fontSize="10px" color="var(--text-3)" letterSpacing="0.1em" textTransform="uppercase" mb="3">
        {label}
      </Text>
      <Text fontSize="28px" fontWeight="500" letterSpacing="-0.02em" color={accent || 'var(--text-0)'} lineHeight="1" fontFamily="mono">
        {value}
      </Text>
      {sub && <Text fontSize="11px" color="var(--text-3)" mt="1.5">{sub}</Text>}
    </Box>
  )
}

function ChainFilterDropdown({
  chains,
  selected,
  onSelect,
}: {
  chains: Array<{ id: string; symbol: string; coin: string; caip: string; color: string }>
  selected: string
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [])

  const selectedDef = chains.find(c => c.id === selected)

  return (
    <Box position="relative" ref={ref as any}>
      <Flex
        as="button"
        align="center"
        gap="1.5"
        px="3"
        py="1.5"
        bg={selected ? 'rgba(139,227,196,0.12)' : 'var(--ink-1)'}
        border="1px solid"
        borderColor={selected ? 'rgba(139,227,196,0.3)' : 'var(--line)'}
        borderRadius="var(--r-sm)"
        cursor="pointer"
        fontSize="11px"
        fontWeight="500"
        color={selected ? 'var(--teal)' : 'var(--text-2)'}
        _hover={{ borderColor: 'var(--line-2)', color: 'var(--text-0)' }}
        transition="all 0.15s"
        onClick={() => setOpen(o => !o)}
        className="electrobun-webkit-app-region-no-drag"
      >
        {selectedDef ? (
          <>
            <Image src={caipToIcon(selectedDef.caip)} w="14px" h="14px" borderRadius="full"
              fallback={<Box w="14px" h="14px" borderRadius="full" bg={selectedDef.color} />} />
            {selectedDef.symbol}
          </>
        ) : (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
            All Networks
          </>
        )}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </Flex>

      {open && (
        <>
          <Box position="fixed" inset="0" zIndex={0} onClick={() => setOpen(false)} />
          <Box
            position="absolute"
            top="100%"
            left="0"
            mt="4px"
            zIndex={10}
            bg="var(--ink-2)"
            border="1px solid var(--line-2)"
            borderRadius="var(--r-md)"
            py="1"
            minW="200px"
            maxH="280px"
            overflowY="auto"
            boxShadow="0 8px 24px rgba(0,0,0,0.5)"
          >
            <Flex
              align="center" gap="2" px="3" py="1.5" cursor="pointer"
              bg={!selected ? 'rgba(139,227,196,0.08)' : 'transparent'}
              _hover={{ bg: 'rgba(255,255,255,0.05)' }}
              onClick={() => { onSelect(''); setOpen(false) }}
            >
              <Box w="14px" h="14px" borderRadius="full" bg="var(--ink-4)" display="flex" alignItems="center" justifyContent="center">
                <Text fontSize="8px" color="var(--text-3)">*</Text>
              </Box>
              <Text fontSize="11px" fontWeight={!selected ? '600' : '500'} color={!selected ? 'var(--teal)' : 'var(--text-1)'}>All Networks</Text>
            </Flex>
            {chains.map(c => (
              <Flex
                key={c.id}
                align="center" gap="2" px="3" py="1.5" cursor="pointer"
                bg={selected === c.id ? 'rgba(139,227,196,0.08)' : 'transparent'}
                _hover={{ bg: 'rgba(255,255,255,0.05)' }}
                onClick={() => { onSelect(c.id); setOpen(false) }}
              >
                <Image src={caipToIcon(c.caip)} w="14px" h="14px" borderRadius="full"
                  fallback={<Box w="14px" h="14px" borderRadius="full" bg={c.color} />} />
                <Text fontSize="11px" fontWeight={selected === c.id ? '600' : '500'} color={selected === c.id ? 'var(--teal)' : 'var(--text-1)'}>{c.symbol}</Text>
                <Text fontSize="10px" color="var(--text-3)" flex="1">{c.coin}</Text>
              </Flex>
            ))}
          </Box>
        </>
      )}
    </Box>
  )
}

export function ActivityPage({ defaultChainId, onBack, onResumeSwap }: ActivityPageProps) {
  const [activities, setActivities] = useState<RecentActivity[]>([])
  const [pendingSwaps, setPendingSwaps] = useState<PendingSwap[]>([])
  const [availableChains, setAvailableChains] = useState<ChainBalance[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<TxDetail | null>(null)
  const [showReports, setShowReports] = useState(false)

  // Filters
  const [chainFilter, setChainFilter] = useState(defaultChainId || '')
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'recent' | 'oldest'>('recent')

  const fetchActivities = useCallback(() => {
    rpcRequest<RecentActivity[]>('getRecentActivity', { limit: 200 }, 10000)
      .then(r => { if (r) setActivities(r) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const fetchSwaps = useCallback(() => {
    rpcRequest<PendingSwap[]>('getPendingSwaps', undefined, 5000)
      .then(r => { if (r) setPendingSwaps(r) })
      .catch(() => {})
  }, [])

  const fetchChains = useCallback(() => {
    rpcRequest<{ balances: ChainBalance[] } | null>('getCachedBalances')
      .then(r => { if (r?.balances) setAvailableChains(r.balances) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetchActivities()
    fetchSwaps()
    fetchChains()
  }, [fetchActivities, fetchSwaps, fetchChains])

  // Listen for new activity
  useEffect(() => {
    const u1 = onRpcMessage('api-log', (entry: ApiLogEntry) => {
      if (entry.activityType) fetchActivities()
    })
    const u2 = onRpcMessage('swap-update', (_u: SwapStatusUpdate) => { fetchSwaps() })
    const u3 = onRpcMessage('swap-complete', () => { fetchSwaps(); fetchActivities() })
    // Background history scans write rows directly via DB helpers (no api-log) —
    // refresh on the scan-complete signal so the timeline isn't stale until manual refresh.
    const u4 = onRpcMessage('activity-scan-complete', () => { fetchActivities() })
    return () => { u1(); u2(); u3(); u4() }
  }, [fetchActivities, fetchSwaps])

  const nativePrices = useMemo(() => nativePriceByChain(availableChains), [availableChains])

  // Chain options for filter dropdown — all supported chains, sorted by symbol
  const chainOptions = useMemo(() => {
    return [...CHAINS].sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [])

  // Merge + filter timeline
  const filteredTimeline = useMemo<ActivityTimelineItem[]>(() => {
    const swapTxids = new Set(pendingSwaps.map(s => s.txid))
    const activeSwaps = pendingSwaps.filter(
      s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'
    )

    // Filter activities
    let filteredActs = activities.filter(a => {
      if (typeFilters.size > 0 && !typeFilters.has(a.type)) return false
      if (chainFilter) {
        const chainDef = CHAINS.find(c => c.id === chainFilter)
        if (chainDef && !(a.chainId === chainDef.id || a.chain === chainDef.symbol || a.chain === chainDef.id)) return false
      }
      // Don't show activities that are also in activeSwaps (avoid double rendering)
      if (a.type === 'swap' && a.txid && swapTxids.has(a.txid)) return false
      if (search) {
        const q = search.toLowerCase()
        const hay = [a.txid, a.to, a.appName, a.asset, a.chain, a.chainId].filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })

    // Filter swaps (only include if type filter includes 'swap' or no type filter)
    let filteredSwaps: PendingSwap[] = []
    if (typeFilters.size === 0 || typeFilters.has('swap')) {
      filteredSwaps = activeSwaps.filter(s => {
        if (chainFilter) {
          const chainDef = CHAINS.find(c => c.id === chainFilter)
          if (chainDef && !(s.fromChainId === chainDef.id || s.toChainId === chainDef.id || s.fromSymbol === chainDef.symbol || s.toSymbol === chainDef.symbol)) return false
        }
        if (search) {
          const q = search.toLowerCase()
          const hay = [s.txid, s.fromSymbol, s.toSymbol, s.integration].filter(Boolean).join(' ').toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
    }

    const merged: ActivityTimelineItem[] = [
      ...filteredSwaps.map(s => ({ kind: 'swap' as const, id: `swap-${s.txid}`, createdAt: s.createdAt, swap: s })),
      ...filteredActs.map(a => ({ kind: 'activity' as const, id: `act-${a.id}`, createdAt: a.createdAt, activity: a })),
    ]

    return sort === 'oldest'
      ? [...merged].sort((a, b) => a.createdAt - b.createdAt)
      : recentFirst(merged)
  }, [activities, pendingSwaps, typeFilters, chainFilter, search, sort])

  // Stats
  const stats = useMemo(() => {
    const activeSwaps = pendingSwaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded')
    const total = activities.length + activeSwaps.length
    const sent = activities.filter(a => a.type === 'send').length
    const received = activities.filter(a => a.type === 'receive').length
    const swaps = activeSwaps.length
    return { total, sent, received, swaps }
  }, [activities, pendingSwaps])

  const dateGroups = useMemo(() => bucketByDate(filteredTimeline), [filteredTimeline])

  const toggleType = (t: string) => {
    setTypeFilters(prev => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t); else next.add(t)
      return next
    })
  }

  const scanningRef = useRef(false)
  const handleRescan = useCallback(async () => {
    if (scanningRef.current) return
    scanningRef.current = true
    setScanning(true)
    setScanResult(null)
    try {
      const chainsToScan = chainFilter ? [chainFilter] : CHAINS.map(c => c.id)
      let total = 0
      for (const chainId of chainsToScan) {
        try {
          const result = await rpcRequest<{ count: number }>('scanChainHistory', { chainId }, 60000)
          total += result?.count || 0
        } catch { /* skip failing chains */ }
      }
      setScanResult(total > 0 ? `+${total} tx${total > 1 ? 's' : ''}` : 'Up to date')
      fetchActivities()
    } catch (e: any) {
      setScanResult(e.message || 'Failed')
    } finally {
      scanningRef.current = false
      setScanning(false)
    }
  }, [chainFilter, fetchActivities])

  useEffect(() => { setScanResult(null) }, [chainFilter])

  const fetchingSwapRef = useRef(false)
  const handleSelectActivity = useCallback((a: RecentActivity) => {
    if (a.type === 'swap' && a.txid && onResumeSwap) {
      if (fetchingSwapRef.current) return
      fetchingSwapRef.current = true
      rpcRequest<PendingSwap | null>('getSwapByTxid', { txid: a.txid })
        .then(swap => {
          if (swap) onResumeSwap(swap)
          else setSelectedDetail({ kind: 'activity', activity: a })
        })
        .catch(() => setSelectedDetail({ kind: 'activity', activity: a }))
        .finally(() => { fetchingSwapRef.current = false })
    } else {
      setSelectedDetail({ kind: 'activity', activity: a })
    }
  }, [onResumeSwap])

  const TYPE_PILLS = [
    { id: 'send', label: 'Sent' },
    { id: 'receive', label: 'Received' },
    { id: 'swap', label: 'Swaps' },
    { id: 'sign', label: 'Signs' },
  ]

  const pending = useMemo(() =>
    pendingSwaps.filter(s => s.status === 'pending' || s.status === 'confirming' || s.status === 'signing' || s.status === 'output_confirming'),
    [pendingSwaps]
  )

  return (
    <Flex flex="1" direction="column" align="center" px={{ base: "3", md: "6" }} py={{ base: "5", md: "8" }} className="v3-page-enter">
      <Box w="100%" maxW={{ base: "100%", md: "960px" }}>

        {/* Header */}
        <Flex align="flex-start" justify="space-between" gap="4" mb="6">
          <Flex align="center" gap="3">
            {onBack && (
              <Box
                as="button"
                onClick={onBack}
                w="36px" h="36px" borderRadius="10px"
                bg="var(--ink-2)" border="1px solid var(--line)"
                color="var(--text-1)" display="grid" placeItems="center"
                cursor="pointer"
                _hover={{ bg: 'var(--ink-3)', color: 'var(--text-0)', borderColor: 'var(--line-2)' }}
                transition="all 0.18s"
                flexShrink={0}
                className="electrobun-webkit-app-region-no-drag"
                aria-label="Back"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
              </Box>
            )}
            <Box>
              <Text
                fontWeight="500" fontSize={{ base: "28px", md: "36px" }}
                letterSpacing="-0.02em" color="var(--text-0)" lineHeight="1"
              >
                Activity
              </Text>
              <Text fontSize="11px" color="var(--text-3)" mt="1" letterSpacing="0.04em" textTransform="uppercase">
                Every signature &amp; on-chain move
              </Text>
            </Box>
          </Flex>

          <HStack gap="2" flexShrink={0} mt="1">
            <Box
              as="button"
              onClick={() => setShowReports(true)}
              px="3" py="2" borderRadius="8px"
              bg="var(--ink-2)" border="1px solid var(--line)"
              fontSize="11px" fontWeight="500" color="var(--text-2)"
              cursor="pointer" display="flex" alignItems="center" gap="6px"
              _hover={{ bg: 'var(--ink-3)', color: 'var(--text-0)', borderColor: 'var(--line-2)' }}
              transition="all 0.15s"
              className="electrobun-webkit-app-region-no-drag"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
              Reports
            </Box>
            <Box
              as="button"
              onClick={handleRescan}
              disabled={scanning}
              px="3" py="2" borderRadius="8px"
              bg="var(--ink-2)" border="1px solid var(--line)"
              fontSize="11px" fontWeight="500"
              color={scanning ? 'var(--text-3)' : 'var(--text-2)'}
              cursor={scanning ? 'default' : 'pointer'}
              display="flex" alignItems="center" gap="6px"
              _hover={scanning ? {} : { bg: 'var(--ink-3)', color: 'var(--text-0)', borderColor: 'var(--line-2)' }}
              transition="all 0.15s"
              className="electrobun-webkit-app-region-no-drag"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={scanning ? { animation: 'spin 1s linear infinite' } : {}}>
                <path d="M13.65 2.35A7.96 7.96 0 0 0 8 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 8 14 6 6 0 1 1 8 2c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" fill="currentColor" />
              </svg>
              {scanning ? 'Scanning…' : 'Rescan'}
            </Box>
          </HStack>
        </Flex>

        {/* Pending banner */}
        {pending.length > 0 && (
          <Flex
            align="center" gap="3" px="4" py="3" mb="5"
            bg="linear-gradient(180deg, rgba(233,196,106,0.10), rgba(233,196,106,0.04))"
            border="1px solid rgba(233,196,106,0.25)" borderRadius="var(--r-md)"
          >
            <Box w="8px" h="8px" borderRadius="full" bg="var(--gold)" flexShrink={0}
              style={{ animation: 'kkActivityPulse 1.6s ease-in-out infinite' }} />
            <Text fontSize="12px" color="var(--text-0)" fontWeight="600">
              {pending.length} transaction{pending.length === 1 ? '' : 's'} broadcasting
            </Text>
            <Text fontSize="11px" color="var(--text-2)">
              {pending.map(s => `${s.fromSymbol} → ${s.toSymbol}`).join(' · ')}
            </Text>
          </Flex>
        )}

        {/* Scan result message */}
        {scanResult && (
          <Flex mb="3" px="4" py="2" borderRadius="var(--r-sm)"
            bg={scanResult.startsWith('+') ? 'rgba(139,227,196,0.08)' : 'rgba(255,255,255,0.04)'}
            border="1px solid"
            borderColor={scanResult.startsWith('+') ? 'rgba(139,227,196,0.2)' : 'var(--line)'}
            align="center" gap="2"
          >
            <Text fontSize="11px" color={scanResult.startsWith('+') ? 'var(--teal)' : 'var(--text-2)'}>{scanResult}</Text>
          </Flex>
        )}

        {/* Stat cards */}
        <Flex gap="3" mb="5" wrap={{ base: "wrap", md: "nowrap" }}>
          <StatCard label="Total Events" value={stats.total} sub={loading ? 'Loading…' : undefined} />
          <StatCard label="Sent" value={stats.sent} sub={stats.sent > 0 ? `${stats.sent} tx${stats.sent > 1 ? 's' : ''}` : 'None'} accent="var(--rose)" />
          <StatCard label="Received" value={stats.received} sub={stats.received > 0 ? `${stats.received} tx${stats.received > 1 ? 's' : ''}` : 'None'} accent="var(--teal)" />
          <StatCard label="Swaps" value={stats.swaps} sub={stats.swaps > 0 ? `${stats.swaps} total` : 'None'} accent="var(--gold)" />
        </Flex>

        {/* Filter toolbar */}
        <Flex gap="2" mb="4" align="center" wrap="wrap">
          {/* Search */}
          <Flex
            flex="1" minW="200px" maxW="320px"
            align="center" gap="2"
            bg="var(--ink-1)" border="1px solid var(--line)"
            borderRadius="10px" px="3" py="2"
            _focusWithin={{ borderColor: 'var(--line-2)' }}
            transition="border-color 0.15s"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <Box
              as="input"
              flex="1"
              bg="transparent"
              border="none"
              outline="none"
              color="var(--text-0)"
              fontSize="12px"
              fontFamily="var(--font-mono)"
              placeholder="Search tx, address, app…"
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              sx={{ '::placeholder': { color: 'var(--text-3)' } }}
            />
            {search && (
              <Box as="button" onClick={() => setSearch('')} color="var(--text-3)" _hover={{ color: 'var(--text-1)' }} lineHeight={1}>
                ×
              </Box>
            )}
          </Flex>

          {/* Type pills */}
          {TYPE_PILLS.map(p => (
            <Box
              key={p.id}
              as="button"
              px="3" py="1.5"
              bg={typeFilters.has(p.id) ? `${TYPE_COLORS[p.id]}18` : 'var(--ink-1)'}
              border="1px solid"
              borderColor={typeFilters.has(p.id) ? `${TYPE_COLORS[p.id]}40` : 'var(--line)'}
              borderRadius="999px"
              fontSize="11px" fontWeight="500"
              color={typeFilters.has(p.id) ? TYPE_COLORS[p.id] : 'var(--text-2)'}
              cursor="pointer"
              _hover={{ borderColor: 'var(--line-2)', color: 'var(--text-0)' }}
              transition="all 0.15s"
              onClick={() => toggleType(p.id)}
              className="electrobun-webkit-app-region-no-drag"
            >
              {p.label}
            </Box>
          ))}

          {/* Chain filter */}
          <ChainFilterDropdown
            chains={chainOptions.map(c => ({ id: c.id, symbol: c.symbol, coin: c.coin, caip: c.caip, color: c.color }))}
            selected={chainFilter}
            onSelect={setChainFilter}
          />

          {/* Sort toggle */}
          <Box
            as="button"
            px="3" py="1.5"
            bg="var(--ink-1)" border="1px solid var(--line)"
            borderRadius="var(--r-sm)"
            fontSize="11px" fontWeight="500" color="var(--text-2)"
            cursor="pointer" display="flex" alignItems="center" gap="6px"
            _hover={{ borderColor: 'var(--line-2)', color: 'var(--text-0)' }}
            transition="all 0.15s"
            onClick={() => setSort(s => s === 'recent' ? 'oldest' : 'recent')}
            className="electrobun-webkit-app-region-no-drag"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
            {sort === 'recent' ? 'Newest' : 'Oldest'}
          </Box>

          {/* Result count */}
          <Text fontSize="11px" color="var(--text-3)" ml="auto" flexShrink={0}>
            {filteredTimeline.length} of {activities.length + pendingSwaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded').length}
          </Text>
        </Flex>

        {/* Timeline */}
        {loading ? (
          <Flex justify="center" align="center" py="16" gap="3">
            <Spinner size="sm" color="var(--gold)" />
            <Text fontSize="12px" color="var(--text-3)">Loading activity…</Text>
          </Flex>
        ) : filteredTimeline.length === 0 ? (
          <Flex direction="column" align="center" justify="center" py="16" gap="3">
            <Text fontSize="24px" opacity={0.3}>⚡</Text>
            <Text fontSize="13px" color="var(--text-3)" textAlign="center">
              {typeFilters.size > 0 || chainFilter || search
                ? 'No activity matches your filters'
                : 'No activity yet — click Rescan to load history.'}
            </Text>
            {!chainFilter && !search && typeFilters.size === 0 && (
              <Box
                as="button"
                px="4" py="2" borderRadius="8px"
                bg="rgba(139,227,196,0.08)" border="1px solid rgba(139,227,196,0.2)"
                fontSize="12px" fontWeight="500" color="var(--teal)"
                cursor="pointer"
                _hover={{ bg: 'rgba(139,227,196,0.14)' }}
                transition="all 0.15s"
                onClick={handleRescan}
                className="electrobun-webkit-app-region-no-drag"
              >
                Scan all networks
              </Box>
            )}
          </Flex>
        ) : (
          <VStack gap="5" align="stretch">
            {dateGroups.map(group => (
              <Box key={group.label}>
                <Text
                  fontSize="10px" fontWeight="600" color="var(--text-3)"
                  letterSpacing="0.12em" textTransform="uppercase"
                  mb="2" px="1"
                >
                  {group.label}
                </Text>
                <VStack gap="1.5" align="stretch">
                  {group.items.map(item =>
                    item.kind === 'swap' ? (
                      <SwapRow
                        key={item.id}
                        swap={item.swap}
                        onSelect={s => {
                          if (onResumeSwap) onResumeSwap(s)
                          else setSelectedDetail({ kind: 'swap', swap: s })
                        }}
                      />
                    ) : (
                      <ActivityRow
                        key={item.id}
                        activity={item.activity}
                        nativePrices={nativePrices}
                        onSelect={handleSelectActivity}
                      />
                    )
                  )}
                </VStack>
              </Box>
            ))}
          </VStack>
        )}
      </Box>

      {/* TX Detail dialog */}
      {selectedDetail && (
        <TxDetailDialog
          detail={selectedDetail}
          nativePrices={nativePrices}
          onClose={() => setSelectedDetail(null)}
        />
      )}

      {showReports && <ReportDialog onClose={() => setShowReports(false)} />}
    </Flex>
  )
}
