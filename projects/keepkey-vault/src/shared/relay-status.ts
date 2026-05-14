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

export function shouldApplyRelayStatus(currentStatus: SwapTrackingStatus, relayStatus: SwapTrackingStatus): boolean {
  if (relayStatus === currentStatus) return false
  if (isTerminalSwapStatus(relayStatus)) return true
  if (isTerminalSwapStatus(currentStatus)) return false
  return STATUS_RANK[relayStatus] > STATUS_RANK[currentStatus]
}

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
