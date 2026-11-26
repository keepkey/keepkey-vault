import { assertZcashNu7Support } from '../shared/zcash-nu7'

export function requiresNu7DeviceRpc(method: string, params: unknown): boolean {
  const request = params as Record<string, any> | null | undefined
  return method === 'btcSignTx' ? request?.coin === 'Zcash'
    : (method === 'buildTx' || method === 'auditSweepPath') ? request?.chainId === 'zcash'
    : (method === 'executeSwap' || method === 'previewSwapBuild')
      && (request?.fromChainId === 'zcash' || request?.quote?.fromChainId === 'zcash')
}

/** The audit sweep builder only supports the legacy Bitcoin-style format. */
export function rejectUnsupportedZcashSweep(chainId: unknown): void {
  if (chainId === 'zcash') throw new Error('Zcash audit sweeps are unavailable. Use the Send flow; sending Zcash needs KeepKey firmware 7.17 or later.')
}

/** Check before acquiring a device lease or asking for a PIN. */
export function preflightNu7DeviceRpc(
  method: string, params: unknown, firmwareVersion: string | undefined,
  builderAvailable: boolean, admittedAlphaWallet: boolean,
): void {
  if (method === 'auditSweepPath') rejectUnsupportedZcashSweep((params as Record<string, unknown> | null)?.chainId)
  if (requiresNu7DeviceRpc(method, params)) assertZcashNu7Support(firmwareVersion, builderAvailable, admittedAlphaWallet)
}
