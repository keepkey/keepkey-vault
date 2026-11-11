import type { ZcashNu7Admission } from '../shared/zcash-nu7'
import { validateZcashTransparentPlan } from './txbuilder/zcash-transparent'

export const ZCASH_MEMO_REFUSAL = 'Zcash transparent sends cannot include a memo yet. Clear the memo, or choose a swap route without one.'

export function requiresNu7DeviceRpc(method: string, params: unknown): boolean {
  const request = params as Record<string, any> | null | undefined
  return method === 'btcSignTx' ? request?.coin === 'Zcash'
    : method === 'buildTx' ? request?.chainId === 'zcash'
    : (method === 'executeSwap' || method === 'previewSwapBuild')
      && (request?.fromChainId === 'zcash' || request?.quote?.fromChainId === 'zcash')
}

/** Check before acquiring a device lease or asking for a PIN: first what the
 *  host read from the KeepKey, then the audited scope of the request itself
 *  (transparent P2PKH inputs to t-address/TEX outputs, no memo). */
export function preflightNu7DeviceRpc(method: string, params: unknown, admission: () => ZcashNu7Admission): void {
  if (!requiresNu7DeviceRpc(method, params)) return
  const result = admission()
  if ('refusal' in result) throw new Error(result.reason)
  const request = params as Record<string, any>
  if (method === 'btcSignTx') return validateZcashTransparentPlan(request)
  const memo = request?.memo ?? request?.quote?.memo
  if (typeof memo === 'string' && memo.trim()) throw new Error(ZCASH_MEMO_REFUSAL)
}
