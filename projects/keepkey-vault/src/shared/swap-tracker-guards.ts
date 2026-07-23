export interface OutboundTxSelection {
  outboundTxid?: string
  /** True only when at least one candidate was a placeholder and no real hash won. */
  placeholderOnly: boolean
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
