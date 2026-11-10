import { DeviceOperationError, type DeviceOperationOptions } from './device-operation'

const PUBLIC_READS = new Set(['getBtcAccounts', 'getEvmAddresses', 'getPublicKeys', 'btcGetAddress', 'ethGetAddress', 'cosmosGetAddress',
  'thorchainGetAddress', 'mayachainGetAddress', 'osmosisGetAddress', 'xrpGetAddress', 'solanaGetAddress', 'tronGetAddress', 'tonGetAddress'])
const BALANCE_READS = new Set(['getBalances', 'getBalance'])
const DEVICE_ACTIONS = new Set(['btcSignTx', 'btcPsbtSign', 'ethSignTx', 'ethSignMessage', 'ethSignTypedData',
  'cosmosSignTx', 'thorchainSignTx', 'mayachainSignTx', 'osmosisSignTx', 'xrpSignTx', 'solanaSignTx',
  'solanaSignMessage', 'solanaSignOffchainMessage', 'tronSignTx', 'tronSignMessage', 'tronSignTypedHash', 'tonSignTx', 'tonSignMessage', 'hiveSignTx',
  'addBtcAccount', 'addEvmAddressIndex', 'addUtxoAccount', 'buildTx', 'previewSwapBuild', 'executeSwap', 'btcWatchOnlyShowAddress'])
interface Scope { wallet: unknown; epoch: number; seed: string | null }
const same = (a: Scope, b: Scope) => a.wallet === b.wallet && a.epoch === b.epoch && a.seed === b.seed

/** Desktop's deliberate device actions share the REST device queue. Public read
 * results stay RAM-only and tied to the verified live wallet, including hidden
 * wallets; a passive locked view never starts an unlock. PIN answers and Cancel
 * intentionally bypass this wrapper so they can finish the current owner. */
export function gateDeviceRpc<T extends Record<string, any>>(handlers: T, deps: {
  scope: () => Scope; locked: () => boolean
  run: <R>(action: () => Promise<R>, options: DeviceOperationOptions) => Promise<R>
}): T {
  let scope = { ...deps.scope() }
  const cache = new Map<string, unknown>()
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => {
    if (!PUBLIC_READS.has(name) && !BALANCE_READS.has(name) && !DEVICE_ACTIONS.has(name)) return [name, handler]
    return [name, async (...args: unknown[]) => {
      const current = { ...deps.scope() }
      if (!same(scope, current)) { cache.clear(); scope = current }
      const balanceRead = BALANCE_READS.has(name)
      const publicRead = PUBLIC_READS.has(name) || balanceRead
      const params = args[0] as { showDisplay?: boolean; show_display?: boolean; paths?: Array<{ showDisplay?: boolean; show_display?: boolean }>; chainId?: string } | undefined
      const display = params?.showDisplay === true || params?.show_display === true
        || (name === 'getPublicKeys' && Array.isArray(params?.paths) && params.paths.some(path => path?.showDisplay === true || path?.show_display === true))
      const key = name === 'getBalance' ? `${name}:${params?.chainId}`
        : name === 'getBalances' ? `${name}:${JSON.stringify(Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => key !== 'forceRefresh')))}`
        : `${name}:${JSON.stringify(args)}`
      const locked = deps.locked()
      if (publicRead && !display && cache.has(key) && (!balanceRead || locked)) {
        const result = structuredClone(cache.get(key))
        if (!balanceRead) return result
        // Cached monitoring data stays visibly stale, never reset to a
        // fabricated zero and never mistaken for a fresh on-device read.
        return Array.isArray(result) ? result.map(balance => ({ ...balance, syncState: 'stale' }))
          : { ...(result as object), syncState: 'stale' }
      }
      if (publicRead && !display && locked) throw new DeviceOperationError(423, 'Unlock KeepKey to load this account')
      const result = await deps.run(async () => {
        if (!same(current, deps.scope())) throw new DeviceOperationError(409, 'The wallet changed. Start the request again.')
        return handler(...args)
      }, { unlock: !publicRead || display })
      if (!same(current, deps.scope())) throw new DeviceOperationError(409, 'The wallet changed. Start the request again.')
      const cacheable = !balanceRead || (name === 'getBalances' ? Array.isArray(result) && result.length > 0 : result !== null && typeof result === 'object')
      if (publicRead && !display && cacheable) {
        if (cache.size >= 500) cache.delete(cache.keys().next().value!)
        cache.set(key, structuredClone(result))
      }
      return result
    }]
  })) as T
}
