import type { SwapTrackingStatus } from './types'

export interface RelayExecutionStatus {
  status?: string | null
  details?: string | null
  inTxHashes?: string[]
  txHashes?: string[]
  time?: number | null
  originChainId?: number | null
  destinationChainId?: number | null
}

const STATUS_RANK: Record<SwapTrackingStatus, number> = {
  signing: 0,
  pending: 1,
  confirming: 2,
  output_detected: 3,
  output_confirming: 4,
  output_confirmed: 5,
  completed: 6,
  failed: 6,
  refunded: 6,
}

export function mapRelayExecutionStatus(status: string | null | undefined): SwapTrackingStatus | null {
  switch ((status || '').toLowerCase()) {
    case 'success':
      return 'completed'
    case 'fallback':
    case 'refund':
    case 'refunded':
      return 'refunded'
    case 'failure':
    case 'failed':
      return 'failed'
    case 'received':
    case 'depositing':
    case 'pending':
    case 'delayed':
      return 'confirming'
    case 'submitted':
      return 'output_confirming'
    case 'waiting':
      return 'pending'
    default:
      return null
  }
}

export function isTerminalSwapStatus(status: SwapTrackingStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'refunded'
}

export function shouldApplyRelayStatus(currentStatus: SwapTrackingStatus, relayStatus: SwapTrackingStatus, hasMetadataUpdate = false): boolean {
  if (relayStatus === currentStatus) return hasMetadataUpdate
  if (isTerminalSwapStatus(relayStatus)) return true
  if (isTerminalSwapStatus(currentStatus)) return false
  return STATUS_RANK[relayStatus] > STATUS_RANK[currentStatus]
}

// ── 1Click / NEAR Intents ─────────────────────────────────────────────────────

export interface OneClickStatus {
  status?: string | null
  swapDetails?: {
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[]
    amountOutFormatted?: string
    refundReason?: string | null
  } | null
}

export function map1ClickStatus(status: string | null | undefined): SwapTrackingStatus | null {
  switch ((status || '').toUpperCase()) {
    case 'SUCCESS':
      return 'completed'
    case 'REFUNDED':
      return 'refunded'
    case 'FAILED':
    case 'INCOMPLETE_DEPOSIT':
      return 'failed'
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
      return 'confirming'
    case 'PENDING_DEPOSIT':
      return 'pending'
    default:
      return null
  }
}

export function oneClickOutboundTxid(status: OneClickStatus): string | undefined {
  return status.swapDetails?.destinationChainTxHashes?.find(t => t.hash)?.hash
}

// ─────────────────────────────────────────────────────────────────────────────

export function relayOutboundTxid(status: RelayExecutionStatus, fallbackTxid: string): string | undefined {
  const explicit = status.txHashes?.find(Boolean)
  if (explicit) return explicit
  const sameChain = status.originChainId !== undefined
    && status.originChainId !== null
    && status.destinationChainId !== undefined
    && status.destinationChainId !== null
    && status.originChainId === status.destinationChainId
  const inbound = status.inTxHashes?.find(Boolean)
  return sameChain && mapRelayExecutionStatus(status.status) === 'completed'
    ? (inbound || fallbackTxid)
    : undefined
}
