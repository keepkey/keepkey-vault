import { assertZcashNu7Support } from '../shared/zcash-nu7'

export function requiresNu7DeviceRpc(method: string, params: unknown): boolean {
  const request = params as Record<string, any> | null | undefined
  return method === 'btcSignTx' ? request?.coin === 'Zcash'
    : method === 'buildTx' ? request?.chainId === 'zcash'
    : (method === 'executeSwap' || method === 'previewSwapBuild')
      && (request?.fromChainId === 'zcash' || request?.quote?.fromChainId === 'zcash')
}

/** Check before acquiring a device lease or asking for a PIN. */
export function preflightNu7DeviceRpc(
  method: string, params: unknown, firmwareVersion: string | undefined,
  builderAvailable: boolean, qualifiedAlphaEmulator: boolean,
): void {
  if (requiresNu7DeviceRpc(method, params)) assertZcashNu7Support(firmwareVersion, builderAvailable, qualifiedAlphaEmulator)
}
