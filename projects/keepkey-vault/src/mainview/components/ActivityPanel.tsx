/**
 * ActivityPanel — drawer showing recent transaction activity across all chains.
 *
 * Network selector with chain icons + "Scan" button fetches history from Pioneer.
 * Shows: txids, chain, type (send/receive/swap/sign), timestamp, status.
 */
import { useState, useEffect, useMemo, useCallback } from "react"
import { Box, Text, Flex, VStack, HStack, Image } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { CHAINS } from "../../shared/chains"
import { caipToIcon } from "../../shared/assetLookup"
import type { RecentActivity, PendingSwap, ChainBalance } from "../../shared/types"

interface ActivityPanelProps {
  open: boolean
  onClose: () => void
  activities: RecentActivity[]
  pendingSwaps: PendingSwap[]
  onRefresh: () => void
}

// Chain color lookup
const CHAIN_COLORS: Record<string, string> = {}
CHAINS.forEach(c => { CHAIN_COLORS[c.symbol] = c.color; CHAIN_COLORS[c.id] = c.color })

// Type labels and colors
const TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  send: { label: 'Sent', color: '#E53E3E' },
  receive: { label: 'Received', color: '#23DCC8' },
  swap: { label: 'Swap', color: '#F7931A' },
  sign: { label: 'Signed', color: '#627EEA' },
  message: { label: 'Message', color: '#8247E5' },
  approve: { label: 'Approve', color: '#FF0420' },
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  broadcast: { label: 'Broadcast', color: '#23DCC8' },
  signed: { label: 'Signed', color: '#F7931A' },
  failed: { label: 'Failed', color: '#E53E3E' },
}

function getExplorerUrl(chainSymbol: string, txid: string): string | null {
  if (!chainSymbol || !txid) return null
  const chain = CHAINS.find(c => c.symbol === chainSymbol || c.id === chainSymbol)
  if (!chain?.explorerTxUrl) return null
  return chain.explorerTxUrl.replace('{{txid}}', txid)
}

function truncateTxid(txid: string): string {
  if (txid.length <= 16) return txid
  return txid.slice(0, 8) + '...' + txid.slice(-8)
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

function SwapRow({ swap }: { swap: PendingSwap }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const explorerUrl = getExplorerUrl(swap.fromSymbol, swap.txid)

  const statusColor = swap.status === 'completed' ? '#23DCC8'
    : swap.status === 'failed' ? '#E53E3E'
    : swap.status === 'refunded' ? '#F7931A'
    : '#627EEA'

  return (
    <Box bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="rgba(255,255,255,0.06)" borderRadius="lg" p="3" _hover={{ bg: "rgba(255,255,255,0.06)" }} transition="background 0.15s">
      <Flex justify="space-between" align="center" mb="1">
        <HStack gap="2">
          <Box w="6px" h="6px" borderRadius="full" bg={CHAIN_COLORS[swap.fromSymbol] || '#888'} />
          <Text fontSize="xs" fontWeight="600" color="white">{swap.fromSymbol} → {swap.toSymbol}</Text>
          <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600" bg="rgba(247,147,26,0.15)" color="#F7931A">Swap</Box>
        </HStack>
        <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600" bg={`${statusColor}22`} color={statusColor}>{swap.status}</Box>
      </Flex>
      {swap.fromAmount && (
        <Text fontSize="2xs" color="whiteAlpha.500" mb="1">
          {swap.fromAmount} {swap.fromSymbol}{swap.expectedOutput ? ` → ${swap.expectedOutput} ${swap.toSymbol}` : ''}
        </Text>
      )}
      <Flex justify="space-between" align="center">
        <Text fontSize="2xs" color="whiteAlpha.600" fontFamily="mono" cursor="pointer" _hover={{ color: "#23DCC8" }} onClick={() => handleCopy(swap.txid)} title={copied ? 'Copied!' : 'Click to copy'}>
          {copied ? 'Copied!' : truncateTxid(swap.txid)}
        </Text>
        <HStack gap="2">
          {explorerUrl && <Text as="button" fontSize="2xs" color="whiteAlpha.400" _hover={{ color: "#23DCC8" }} onClick={() => rpcRequest('openUrl', { url: explorerUrl })}>Explorer</Text>}
          <Text fontSize="2xs" color="whiteAlpha.300">{timeAgo(swap.createdAt)}</Text>
        </HStack>
      </Flex>
    </Box>
  )
}

function ActivityRow({ activity }: { activity: RecentActivity }) {
  const [copied, setCopied] = useState(false)
  const typeConf = TYPE_CONFIG[activity.type] || TYPE_CONFIG.sign
  const statusConf = STATUS_CONFIG[activity.status] || STATUS_CONFIG.signed

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const explorerUrl = activity.txid ? getExplorerUrl(activity.chain, activity.txid) : null

  return (
    <Box bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="rgba(255,255,255,0.06)" borderRadius="lg" p="3" _hover={{ bg: "rgba(255,255,255,0.06)" }} transition="background 0.15s">
      <Flex justify="space-between" align="center" mb="1">
        <HStack gap="2">
          <Box w="6px" h="6px" borderRadius="full" bg={CHAIN_COLORS[activity.chain] || '#888'} />
          <Text fontSize="xs" fontWeight="600" color="white">{activity.chain}</Text>
          <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600" bg={`${typeConf.color}22`} color={typeConf.color}>{typeConf.label}</Box>
          {activity.source === 'api' && (
            <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600" bg="rgba(130,71,229,0.15)" color="#8247E5">API</Box>
          )}
        </HStack>
        <Box px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600" bg={`${statusConf.color}22`} color={statusConf.color}>{statusConf.label}</Box>
      </Flex>
      {(activity.amount || activity.to || activity.appName) && (
        <Text fontSize="2xs" color="whiteAlpha.500" mb="1" truncate>
          {activity.amount && `${activity.amount} ${activity.asset || activity.chain}`}
          {activity.to && ` → ${activity.to.slice(0, 12)}...`}
          {activity.appName && activity.source === 'api' && ` via ${activity.appName}`}
        </Text>
      )}
      <Flex justify="space-between" align="center">
        {activity.txid ? (
          <Text fontSize="2xs" color="whiteAlpha.600" fontFamily="mono" cursor="pointer" _hover={{ color: "#23DCC8" }} onClick={() => handleCopy(activity.txid!)} title={copied ? 'Copied!' : 'Click to copy'}>
            {copied ? 'Copied!' : truncateTxid(activity.txid)}
          </Text>
        ) : (
          <Text fontSize="2xs" color="whiteAlpha.400" fontStyle="italic">no txid</Text>
        )}
        <HStack gap="2">
          {explorerUrl && <Text as="button" fontSize="2xs" color="whiteAlpha.400" _hover={{ color: "#23DCC8" }} onClick={() => rpcRequest('openUrl', { url: explorerUrl })}>Explorer</Text>}
          <Text fontSize="2xs" color="whiteAlpha.300">{timeAgo(activity.createdAt)}</Text>
        </HStack>
      </Flex>
    </Box>
  )
}

/** Network selector pill */
function ChainPill({ chain, selected, onClick }: { chain: { id: string; symbol: string; caip: string; color: string }; selected: boolean; onClick: () => void }) {
  return (
    <Box
      as="button"
      display="flex"
      alignItems="center"
      gap="1.5"
      px="2.5"
      py="1"
      borderRadius="full"
      border="1px solid"
      borderColor={selected ? chain.color : 'rgba(255,255,255,0.1)'}
      bg={selected ? `${chain.color}22` : 'transparent'}
      cursor="pointer"
      _hover={{ bg: `${chain.color}15`, borderColor: chain.color }}
      transition="all 0.15s"
      onClick={onClick}
      flexShrink={0}
    >
      <Image src={caipToIcon(chain.caip)} w="14px" h="14px" borderRadius="full" fallback={<Box w="14px" h="14px" borderRadius="full" bg={chain.color} />} />
      <Text fontSize="2xs" fontWeight="600" color={selected ? 'white' : 'whiteAlpha.600'}>{chain.symbol}</Text>
    </Box>
  )
}

export function ActivityPanel({ open, onClose, activities, pendingSwaps, onRefresh }: ActivityPanelProps) {
  const [tab, setTab] = useState<'activity' | 'swaps'>('activity')
  const [selectedChain, setSelectedChain] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [availableChains, setAvailableChains] = useState<ChainBalance[]>([])

  // Load chains that have balances (these are the ones worth scanning)
  useEffect(() => {
    if (!open) return
    rpcRequest<{ balances: ChainBalance[]; updatedAt: number } | null>('getCachedBalances')
      .then(result => {
        if (result?.balances) setAvailableChains(result.balances)
      })
      .catch(() => {})
  }, [open])

  // Map available chains to their CHAINS config for icons/colors
  const chainOptions = useMemo(() => {
    return availableChains
      .map(b => {
        const def = CHAINS.find(c => c.id === b.chainId)
        if (!def) return null
        return { id: def.id, symbol: def.symbol, caip: def.caip, color: def.color, balanceUsd: b.balanceUsd }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.balanceUsd - a.balanceUsd)
  }, [availableChains])

  // Filtered activities by selected chain
  const filteredActivities = useMemo(() => {
    if (!selectedChain) return activities
    const chainDef = CHAINS.find(c => c.id === selectedChain)
    if (!chainDef) return activities
    return activities.filter(a => a.chain === chainDef.symbol)
  }, [activities, selectedChain])

  // Filtered swaps
  const activeSwaps = useMemo(() =>
    pendingSwaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'),
    [pendingSwaps]
  )

  // Dedupe swaps from activity list
  const nonSwapActivities = useMemo(() => {
    const swapTxids = new Set(pendingSwaps.map(s => s.txid))
    return filteredActivities.filter(a => !(a.type === 'swap' && a.txid && swapTxids.has(a.txid)))
  }, [filteredActivities, pendingSwaps])

  const handleScan = useCallback(async () => {
    if (!selectedChain || scanning) return
    setScanning(true)
    setScanResult(null)
    try {
      const result = await rpcRequest<{ count: number }>('scanChainHistory', { chainId: selectedChain }, 60000)
      const chainDef = CHAINS.find(c => c.id === selectedChain)
      setScanResult(result.count > 0 ? `Found ${result.count} new tx${result.count > 1 ? 's' : ''}` : `No new transactions for ${chainDef?.symbol || selectedChain}`)
      onRefresh()
    } catch (e: any) {
      setScanResult(`Scan failed: ${e.message || 'unknown error'}`)
    } finally {
      setScanning(false)
    }
  }, [selectedChain, scanning, onRefresh])

  // Clear scan result when chain changes
  useEffect(() => { setScanResult(null) }, [selectedChain])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <Box position="fixed" inset="0" bg="blackAlpha.600" zIndex={Z.drawerBackdrop} onClick={onClose} />

      {/* Panel */}
      <Box
        position="fixed" bottom="0" left="0"
        w="420px" maxW="100vw" h="75vh" maxH="650px"
        bg="kk.bg" border="1px solid" borderColor="kk.border" borderTopRightRadius="xl"
        zIndex={Z.drawerPanel} display="flex" flexDirection="column" overflow="hidden"
      >
        {/* Header */}
        <Flex px="4" pt="4" pb="2" justify="space-between" align="center" flexShrink={0}>
          <Text fontSize="sm" fontWeight="700" color="white">Recent Activity</Text>
          <HStack gap="2">
            <Text as="button" fontSize="sm" color="whiteAlpha.500" _hover={{ color: "white" }} onClick={onClose} fontWeight="600">&times;</Text>
          </HStack>
        </Flex>

        {/* Tabs */}
        <Flex px="4" pb="2" gap="3" flexShrink={0}>
          <Text
            as="button" fontSize="xs"
            fontWeight={tab === 'activity' ? '700' : '500'}
            color={tab === 'activity' ? '#23DCC8' : 'whiteAlpha.500'}
            borderBottom={tab === 'activity' ? '2px solid #23DCC8' : '2px solid transparent'}
            pb="1" onClick={() => setTab('activity')}
          >
            History
          </Text>
          {pendingSwaps.length > 0 && (
            <Text
              as="button" fontSize="xs"
              fontWeight={tab === 'swaps' ? '700' : '500'}
              color={tab === 'swaps' ? '#F7931A' : 'whiteAlpha.500'}
              borderBottom={tab === 'swaps' ? '2px solid #F7931A' : '2px solid transparent'}
              pb="1" onClick={() => setTab('swaps')}
            >
              Swaps ({pendingSwaps.length})
            </Text>
          )}
        </Flex>

        {/* Network selector (activity tab only) */}
        {tab === 'activity' && (
          <Box px="4" pb="2" flexShrink={0}>
            <Flex gap="1.5" overflowX="auto" pb="1" css={{ '&::-webkit-scrollbar': { display: 'none' } }}>
              <ChainPill
                chain={{ id: '', symbol: 'All', caip: '', color: '#23DCC8' }}
                selected={selectedChain === null}
                onClick={() => setSelectedChain(null)}
              />
              {chainOptions.map(c => (
                <ChainPill key={c.id} chain={c} selected={selectedChain === c.id} onClick={() => setSelectedChain(c.id)} />
              ))}
            </Flex>

            {/* Scan button — only when a specific chain is selected */}
            {selectedChain && (
              <Flex mt="2" gap="2" align="center">
                <Box
                  as="button"
                  px="3" py="1" borderRadius="md" fontSize="xs" fontWeight="600"
                  bg={scanning ? 'rgba(255,255,255,0.05)' : 'rgba(35,220,200,0.15)'}
                  color={scanning ? 'whiteAlpha.400' : '#23DCC8'}
                  border="1px solid"
                  borderColor={scanning ? 'rgba(255,255,255,0.05)' : 'rgba(35,220,200,0.3)'}
                  cursor={scanning ? 'not-allowed' : 'pointer'}
                  _hover={scanning ? {} : { bg: 'rgba(35,220,200,0.25)' }}
                  transition="all 0.15s"
                  onClick={handleScan}
                >
                  {scanning ? 'Scanning...' : `Scan ${CHAINS.find(c => c.id === selectedChain)?.symbol || ''} History`}
                </Box>
                {scanResult && (
                  <Text fontSize="2xs" color={scanResult.startsWith('Found') ? '#23DCC8' : scanResult.startsWith('Scan failed') ? '#E53E3E' : 'whiteAlpha.500'}>
                    {scanResult}
                  </Text>
                )}
              </Flex>
            )}
          </Box>
        )}

        {/* Content */}
        <Box flex="1" overflowY="auto" px="4" pb="4">
          <VStack gap="2" align="stretch">
            {tab === 'activity' && (
              <>
                {activeSwaps.filter(s => !selectedChain || CHAINS.find(c => c.id === selectedChain)?.symbol === s.fromSymbol).map(swap => (
                  <SwapRow key={`swap-${swap.txid}`} swap={swap} />
                ))}
                {nonSwapActivities.map(activity => (
                  <ActivityRow key={activity.id} activity={activity} />
                ))}
                {nonSwapActivities.length === 0 && activeSwaps.length === 0 && (
                  <Text fontSize="xs" color="whiteAlpha.400" textAlign="center" py="8">
                    {selectedChain ? `No activity for ${CHAINS.find(c => c.id === selectedChain)?.symbol || selectedChain} — try scanning` : 'No recent activity'}
                  </Text>
                )}
              </>
            )}
            {tab === 'swaps' && (
              <>
                {pendingSwaps.map(swap => (
                  <SwapRow key={`swap-${swap.txid}`} swap={swap} />
                ))}
                {pendingSwaps.length === 0 && (
                  <Text fontSize="xs" color="whiteAlpha.400" textAlign="center" py="8">No swaps</Text>
                )}
              </>
            )}
          </VStack>
        </Box>
      </Box>
    </>
  )
}
