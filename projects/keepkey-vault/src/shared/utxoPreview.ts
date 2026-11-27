/** Review only fields actually present in the UTXO signing request. A swap
 * memo describes claimed intent; it does not authenticate the vault/router. */
export interface UtxoPreview {
  coin: string
  /** `unverified`: marked as change, but with no KeepKey derivation path. */
  sends: { address: string; amount: string; unverified?: boolean }[]
  change: string[]
  fee?: string
  memo?: string
  swap?: { asset: string; destination: string; minimum: string; affiliate?: string }
  warning?: string
}

function sats(value: unknown): bigint | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const raw = String(value)
  return /^\d+$/.test(raw) ? BigInt(raw) : undefined
}
function display(value: bigint, unit: 'BTC'|'LTC'): string {
  return `${value / 100000000n}.${(value % 100000000n).toString().padStart(8, '0')} ${unit}`
}
function memoText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const bytes = atob(value)
    if (!/^[\x20-\x7e]+$/.test(bytes)) return undefined
    return bytes
  } catch { return undefined }
}
function minimum(raw: string, asset: string): string {
  if (!/^\d+$/.test(raw)) return `${raw} (${asset}, raw memo units)`
  const units = BigInt(raw)
  return `${units / 100000000n}.${(units % 100000000n).toString().padStart(8, '0')} ${asset}`
}

/**
 * Change is only change when the KeepKey derives its address (addressNList).
 * An `isChange` flag or `addressType: 'change'` alone is the caller's claim:
 * such an output may pay anyone, so it is reviewed as a send.
 */
export function isVerifiedChange(output: any): boolean {
  return !!(output?.isChange || output?.addressType === 'change')
    && Array.isArray(output?.addressNList) && output.addressNList.length > 0
}
function claimsChange(output: any): boolean {
  return !!(output?.isChange || output?.addressType === 'change')
}

export function utxoPreview(payload: unknown): UtxoPreview | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const tx = payload as Record<string, any>
  if (!['Bitcoin','Litecoin'].includes(tx.coin) || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) return undefined
  const unit: 'BTC'|'LTC' = tx.coin === 'Litecoin' ? 'LTC' : 'BTC'
  const sends: UtxoPreview['sends'] = []
  const change: string[] = []
  let totalOut = 0n
  let amountsComplete = true
  let memo: string | undefined
  let memoPresent = false
  let unverifiedChange = 0
  for (const output of tx.outputs) {
    const amount = sats(output?.amount)
    if (amount === undefined) amountsComplete = false
    else totalOut += amount
    if (output?.opReturnData !== undefined) {
      memoPresent = true
      memo = memoText(output.opReturnData)
    } else if (isVerifiedChange(output)) {
      change.push(amount === undefined ? `Unknown ${unit} amount` : display(amount,unit))
    } else {
      const unverified = claimsChange(output)
      if (unverified) unverifiedChange++
      sends.push({ address: typeof output?.address === 'string' ? output.address : 'Address not supplied',
        amount: amount === undefined ? `Unknown ${unit} amount` : display(amount,unit), ...(unverified ? { unverified } : {}) })
    }
  }
  const inputs = tx.inputs.map((input: any) => sats(input?.amount))
  const fee = amountsComplete && inputs.every((value: bigint | undefined) => value !== undefined)
    ? inputs.reduce((sum: bigint, value: bigint | undefined) => sum + value!, 0n) - totalOut : undefined
  const preview: UtxoPreview = { coin: tx.coin, sends, change,
    fee: fee !== undefined && fee >= 0n ? display(fee,unit) : undefined, memo }
  if (memo) {
    const parts = memo.split(':')
    const match = /^(?:=|SWAP)$/.test(parts[0]) && /^([A-Z0-9]+)\.([A-Z0-9]+)(?:-.+)?$/.exec(parts[1] || '')
    if (match && parts[2] && parts[3]) {
      preview.swap = { asset: parts[1], destination: parts[2], minimum: minimum(parts[3], match[2]),
        affiliate: parts[5] && /^\d+$/.test(parts[5]) ? `${(Number(parts[5]) / 100).toFixed(2)}%` : undefined }
      preview.warning = `Swap terms come from the signed memo. The ${unit} vault address and output outcome are not independently verified here.`
    }
  }
  if (memoPresent && !memo) preview.warning = 'OP_RETURN data is present but cannot be shown as readable text. Review the raw payload and device.'
  if (unverifiedChange) {
    const note = `${unverifiedChange === 1 ? 'An output is' : `${unverifiedChange} outputs are`} marked as change without a KeepKey path, so ${unverifiedChange === 1 ? 'it is' : 'they are'} listed as a send (unverified). Check the address before you sign.`
    preview.warning = preview.warning ? `${preview.warning} ${note}` : note
  }
  return preview
}
