/**
 * ActivityPanel — drawer showing recent transaction activity across all chains.
 *
 * Shows: txids, chain, type (send/swap/sign), timestamp, status.
 * Click txid to copy or open in explorer.
 */
import { useState, useMemo } from "react"
import { Box, Text, Flex, VStack, HStack } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { CHAINS } from "../../shared/chains"
import type { RecentActivity, PendingSwap } from "../../shared/types"

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
  send: { label: 'Send', color: '#23DCC8' },
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

function getExplorerUrl(chainId: string | undefined, txid: string): string | null {
  if (!chainId || !txid) return null
  const chain = CHAINS.find(c => c.id === chainId)
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

  const explorerUrl = (() => {
    const chain = CHAINS.find(c => c.id === swap.fromChainId)
    if (!chain?.explorerTxUrl) return null
    return chain.explorerTxUrl.replace('{{txid}}', swap.txid)
  })()

  const statusColor = swap.status === 'completed' ? '#23DCC8'
    : swap.status === 'failed' ? '#E53E3E'
    : swap.status === 'refunded' ? '#F7931A'
    : '#627EEA'

  return (
    <Box
      bg="rgba(255,255,255,0.03)"
      border="1px solid"
      borderColor="rgba(255,255,255,0.06)"
      borderRadius="lg"
      p="3"
      _hover={{ bg: "rgba(255,255,255,0.06)" }}
      transition="background 0.15s"
    >
      <Flex justify="space-between" align="center" mb="1">
        <HStack gap="2">
          <Box
            w="6px" h="6px" borderRadius="full"
            bg={CHAIN_COLORS[swap.fromSymbol] || '#888'}
          />
          <Text fontSize="xs" fontWeight="600" color="white">
            {swap.fromSymbol} → {swap.toSymbol}
          </Text>
          <Box
            px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600"
            bg="rgba(247,147,26,0.15)" color="#F7931A"
          >
            Swap
          </Box>
        </HStack>
        <Box
          px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600"
          bg={`${statusColor}22`} color={statusColor}
        >
          {swap.status}
        </Box>
      </Flex>

      {swap.fromAmount && (
        <Text fontSize="2xs" color="whiteAlpha.500" mb="1">
          {swap.fromAmount} {swap.fromSymbol}
          {swap.expectedOutput ? ` → ${swap.expectedOutput} ${swap.toSymbol}` : ''}
        </Text>
      )}

      <Flex justify="space-between" align="center">
        <Text
          fontSize="2xs"
          color="whiteAlpha.600"
          fontFamily="mono"
          cursor="pointer"
          _hover={{ color: "#23DCC8" }}
          onClick={() => handleCopy(swap.txid)}
          title={copied ? 'Copied!' : 'Click to copy'}
        >
          {copied ? 'Copied!' : truncateTxid(swap.txid)}
        </Text>
        <HStack gap="2">
          {explorerUrl && (
            <Text
              as="button"
              fontSize="2xs"
              color="whiteAlpha.400"
              _hover={{ color: "#23DCC8" }}
              onClick={() => rpcRequest('openUrl', { url: explorerUrl })}
            >
              Explorer
            </Text>
          )}
          <Text fontSize="2xs" color="whiteAlpha.300">
            {timeAgo(swap.createdAt)}
          </Text>
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

  const explorerUrl = activity.txid ? getExplorerUrl(activity.chainId, activity.txid) : null

  return (
    <Box
      bg="rgba(255,255,255,0.03)"
      border="1px solid"
      borderColor="rgba(255,255,255,0.06)"
      borderRadius="lg"
      p="3"
      _hover={{ bg: "rgba(255,255,255,0.06)" }}
      transition="background 0.15s"
    >
      <Flex justify="space-between" align="center" mb="1">
        <HStack gap="2">
          <Box
            w="6px" h="6px" borderRadius="full"
            bg={CHAIN_COLORS[activity.chain] || '#888'}
          />
          <Text fontSize="xs" fontWeight="600" color="white">
            {activity.chain}
          </Text>
          <Box
            px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600"
            bg={`${typeConf.color}22`} color={typeConf.color}
          >
            {typeConf.label}
          </Box>
          {activity.source === 'api' && (
            <Box
              px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600"
              bg="rgba(130,71,229,0.15)" color="#8247E5"
            >
              API
            </Box>
          )}
        </HStack>
        <Box
          px="1.5" py="0.5" borderRadius="sm" fontSize="2xs" fontWeight="600"
          bg={`${statusConf.color}22`} color={statusConf.color}
        >
          {statusConf.label}
        </Box>
      </Flex>

      {/* Details line */}
      {(activity.amount || activity.to || activity.appName) && (
        <Text fontSize="2xs" color="whiteAlpha.500" mb="1" truncate>
          {activity.amount && `${activity.amount} ${activity.asset || activity.chain}`}
          {activity.to && ` → ${activity.to.slice(0, 12)}...`}
          {activity.appName && activity.source === 'api' && ` via ${activity.appName}`}
        </Text>
      )}

      {/* TXID line */}
      <Flex justify="space-between" align="center">
        {activity.txid ? (
          <Text
            fontSize="2xs"
            color="whiteAlpha.600"
            fontFamily="mono"
            cursor="pointer"
            _hover={{ color: "#23DCC8" }}
            onClick={() => handleCopy(activity.txid!)}
            title={copied ? 'Copied!' : 'Click to copy'}
          >
            {copied ? 'Copied!' : truncateTxid(activity.txid)}
          </Text>
        ) : (
          <Text fontSize="2xs" color="whiteAlpha.400" fontStyle="italic">
            no txid
          </Text>
        )}
        <HStack gap="2">
          {explorerUrl && (
            <Text
              as="button"
              fontSize="2xs"
              color="whiteAlpha.400"
              _hover={{ color: "#23DCC8" }}
              onClick={() => rpcRequest('openUrl', { url: explorerUrl })}
            >
              Explorer
            </Text>
          )}
          <Text fontSize="2xs" color="whiteAlpha.300">
            {timeAgo(activity.createdAt)}
          </Text>
        </HStack>
      </Flex>
    </Box>
  )
}

export function ActivityPanel({ open, onClose, activities, pendingSwaps, onRefresh }: ActivityPanelProps) {
  const [tab, setTab] = useState<'all' | 'swaps'>('all')

  // Merge activities + active swaps into unified timeline
  const activeSwaps = useMemo(() =>
    pendingSwaps.filter(s => s.status !== 'completed' && s.status !== 'failed' && s.status !== 'refunded'),
    [pendingSwaps]
  )

  // Filter out swap-type activities that duplicate pending swaps
  const nonSwapActivities = useMemo(() => {
    const swapTxids = new Set(pendingSwaps.map(s => s.txid))
    return activities.filter(a => !(a.type === 'swap' && a.txid && swapTxids.has(a.txid)))
  }, [activities, pendingSwaps])

  const handleClearAll = () => {
    rpcRequest('clearRecentActivity').then(onRefresh).catch(() => {})
  }

  const handleDismiss = (id: string) => {
    rpcRequest('dismissActivity', { id }).then(onRefresh).catch(() => {})
  }

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <Box
        position="fixed" inset="0" bg="blackAlpha.600"
        zIndex={Z.drawerBackdrop}
        onClick={onClose}
      />

      {/* Panel */}
      <Box
        position="fixed"
        bottom="0" left="0"
        w="400px" maxW="100vw"
        h="70vh" maxH="600px"
        bg="kk.bg"
        border="1px solid"
        borderColor="kk.border"
        borderTopRightRadius="xl"
        zIndex={Z.drawerPanel}
        display="flex"
        flexDirection="column"
        overflow="hidden"
      >
        {/* Header */}
        <Flex px="4" pt="4" pb="2" justify="space-between" align="center" flexShrink={0}>
          <Text fontSize="sm" fontWeight="700" color="white">Recent Activity</Text>
          <HStack gap="2">
            <Text
              as="button" fontSize="2xs" color="whiteAlpha.500"
              _hover={{ color: "whiteAlpha.800" }}
              onClick={onRefresh}
            >
              Refresh
            </Text>
            {activities.length > 0 && (
              <Text
                as="button" fontSize="2xs" color="whiteAlpha.400"
                _hover={{ color: "#E53E3E" }}
                onClick={handleClearAll}
              >
                Clear
              </Text>
            )}
            <Text
              as="button" fontSize="sm" color="whiteAlpha.500"
              _hover={{ color: "white" }}
              onClick={onClose}
              fontWeight="600"
            >
              &times;
            </Text>
          </HStack>
        </Flex>

        {/* Tabs */}
        <Flex px="4" pb="2" gap="3" flexShrink={0}>
          <Text
            as="button"
            fontSize="xs"
            fontWeight={tab === 'all' ? '700' : '500'}
            color={tab === 'all' ? '#23DCC8' : 'whiteAlpha.500'}
            borderBottom={tab === 'all' ? '2px solid #23DCC8' : '2px solid transparent'}
            pb="1"
            onClick={() => setTab('all')}
          >
            All ({nonSwapActivities.length + activeSwaps.length})
          </Text>
          {pendingSwaps.length > 0 && (
            <Text
              as="button"
              fontSize="xs"
              fontWeight={tab === 'swaps' ? '700' : '500'}
              color={tab === 'swaps' ? '#F7931A' : 'whiteAlpha.500'}
              borderBottom={tab === 'swaps' ? '2px solid #F7931A' : '2px solid transparent'}
              pb="1"
              onClick={() => setTab('swaps')}
            >
              Swaps ({pendingSwaps.length})
            </Text>
          )}
        </Flex>

        {/* Content */}
        <Box flex="1" overflowY="auto" px="4" pb="4">
          <VStack gap="2" align="stretch">
            {tab === 'all' && (
              <>
                {/* Active swaps first */}
                {activeSwaps.map(swap => (
                  <SwapRow key={`swap-${swap.txid}`} swap={swap} />
                ))}
                {/* Then recent activities (sorted by time, newest first) */}
                {nonSwapActivities.map(activity => (
                  <ActivityRow key={activity.id} activity={activity} />
                ))}
                {nonSwapActivities.length === 0 && activeSwaps.length === 0 && (
                  <Text fontSize="xs" color="whiteAlpha.400" textAlign="center" py="8">
                    No recent activity
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
                  <Text fontSize="xs" color="whiteAlpha.400" textAlign="center" py="8">
                    No swaps
                  </Text>
                )}
              </>
            )}
          </VStack>
        </Box>
      </Box>
    </>
  )
}
