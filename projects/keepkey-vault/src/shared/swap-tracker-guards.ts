export interface OutboundTxSelection {
  outboundTxid?: string
  /** True only when at least one candidate was a placeholder and no real hash won. */
  placeholderOnly: boolean
}

export interface SwapProgress { txid: string | null; step: number }

/** A temporarily missing confirmation/status must not erase a visited stage.
 * Scope the retained stage to one transaction so a new swap starts at zero. */
export function retainSwapProgress(previous: SwapProgress, txid: string | null, step: number): SwapProgress {
  const next = previous.txid === txid ? Math.max(previous.step, step) : step
  return previous.txid === txid && previous.step === next ? previous : { txid, step: next }
}

/** Providers use empty / zeroed strings while an outbound transaction is not
 * known yet. Normalize case and whitespace so every sentinel shape is rejected. */
export function isPlaceholderOutboundTxHash(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === '0x' || /^(?:0x)?0+$/.test(normalized)
}

/** Select the first real outbound id without letting an earlier placeholder
 * mask a later integration-specific candidate. */
export function selectOutboundTxid(candidates: unknown[]): OutboundTxSelection {
  let sawPlaceholder = false
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    if (isPlaceholderOutboundTxHash(candidate)) {
      sawPlaceholder = true
      continue
    }
    return { outboundTxid: candidate.trim(), placeholderOnly: false }
  }
  return { placeholderOnly: sawPlaceholder }
}

export const MAX_COMPLETED_METADATA_POLLS = 6

/** Completed swaps normally stop UI polling. Rows explicitly marked as having
 * placeholder metadata get a small bounded window to acquire the real values. */
export function shouldRetryCompletedSwapMetadata(
  status: string | undefined,
  metadataPending: boolean | undefined,
  attempts: number,
  maxAttempts = MAX_COMPLETED_METADATA_POLLS,
): boolean {
  return status === 'completed' && metadataPending === true && attempts < maxAttempts
}

export interface ThornodeSettlement { completed: boolean; refunded?: boolean; outboundTxid?: string; outboundAmount?: string }

/** Read THORNode /thorchain/tx/status/{hash}. Its out_txs often lead with the
 * RUNE affiliate leg, whose id is always all-zero (THOR-native sends have no
 * hash) — so match the leg paid to the swap destination instead of taking [0].
 * Only an OUT: leg on the destination chain is the payout; a REFUND: leg (back
 * to the sender, who may be the destination too) means refunded. */
export function settlementFromThornodeStatus(status: any, destination: string, destinationChain?: string): ThornodeSettlement {
  const legs: any[] = Array.isArray(status?.out_txs) ? status.out_txs : []
  const dest = destination.trim().toLowerCase()
  const chain = destinationChain?.trim().toUpperCase()
  const memo = (o: any) => typeof o?.memo === 'string' ? o.memo.trim().toUpperCase() : ''
  const toDest = legs.filter(o => typeof o?.to_address === 'string' && o.to_address.toLowerCase() === dest
    && memo(o).startsWith('OUT:') && (!chain || String(o.chain).toUpperCase() === chain))
  const real = toDest.find(o => !isPlaceholderOutboundTxHash(o.id))
  // THOR-native payouts never get a hash; the settled leg itself is the evidence.
  const leg = real || toDest.find(o => o.chain === 'THOR')
  if (!leg) return legs.some(o => memo(o).startsWith('REFUND:')) ? { completed: false, refunded: true } : { completed: false }
  const completed = status?.stages?.swap_finalised?.completed === true
    && status?.stages?.outbound_signed?.completed !== false
  if (!completed) return { completed: false }
  const amount = leg.coins?.[0]?.amount
  return { completed, ...(real ? { outboundTxid: real.id } : {}), ...(/^\d+$/.test(amount || '') ? { outboundAmount: amount } : {}) }
}
