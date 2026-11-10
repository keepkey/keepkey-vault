import { DeviceOperationError, type DeviceOperationOptions } from './device-operation'

const PUBLIC_READS = new Set(['getBtcAccounts', 'getEvmAddresses', 'getPublicKeys', 'btcGetAddress', 'ethGetAddress', 'cosmosGetAddress',
  'thorchainGetAddress', 'mayachainGetAddress', 'osmosisGetAddress', 'xrpGetAddress', 'solanaGetAddress', 'tronGetAddress', 'tonGetAddress'])
const BALANCE_READS = new Set(['getBalances', 'getBalance'])
const MANAGER_READS = new Set(['getBtcAccounts', 'getEvmAddresses'])
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
  const pendingReads = new Map<string, Promise<unknown>>()
  const changed = () => new DeviceOperationError(409, 'The wallet changed. Start the request again.')
  const cachedResult = (key: string, stale: boolean) => {
    const result = structuredClone(cache.get(key))
    if (!stale) return result
    // Preserve amounts and account selections, while exposing their age to callers.
    return Array.isArray(result) ? result.map(value => ({ ...value, syncState: 'stale' }))
      : { ...(result as object), syncState: 'stale' }
  }
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => {
    if (!PUBLIC_READS.has(name) && !BALANCE_READS.has(name) && !DEVICE_ACTIONS.has(name)) return [name, handler]
    return [name, async (...args: unknown[]) => {
      const current = { ...deps.scope() }
      if (!same(scope, current)) { cache.clear(); pendingReads.clear(); scope = current }
      const balanceRead = BALANCE_READS.has(name)
      const mutableRead = balanceRead || MANAGER_READS.has(name)
      const publicRead = PUBLIC_READS.has(name) || balanceRead
      const params = args[0] as { showDisplay?: boolean; show_display?: boolean; paths?: Array<{ showDisplay?: boolean; show_display?: boolean }>; chainId?: string; forceRefresh?: boolean } | undefined
      const display = params?.showDisplay === true || params?.show_display === true
        || (name === 'getPublicKeys' && Array.isArray(params?.paths) && params.paths.some(path => path?.showDisplay === true || path?.show_display === true))
      const key = name === 'getBalance' ? `${name}:${params?.chainId}`
        : name === 'getBalances' ? `${name}:${JSON.stringify(Object.fromEntries(Object.entries(params ?? {}).filter(([key]) => key !== 'forceRefresh')))}`
        : `${name}:${JSON.stringify(args)}`
      const locked = deps.locked()
      const passive = publicRead && !display
      if (passive && cache.has(key) && (!mutableRead || locked)) {
        return cachedResult(key, mutableRead)
      }
      if (passive && locked) throw new DeviceOperationError(423, 'Unlock KeepKey to load this account')
      const read = async () => {
        let dispatched = false
        let result: unknown
        try {
          result = await deps.run(async () => {
            if (!same(current, deps.scope())) throw changed()
            dispatched = true
            return handler(...args)
          }, { unlock: !publicRead || display })
        } catch (error) {
          if (!same(current, deps.scope())) throw changed()
          const failure = error as { status?: number; message?: string }
          // Only acquisition failures are local contention. Errors from an
          // admitted provider/device read must remain visible and never cache.
          const unavailable = failure?.status === 423
            || (failure?.status === 409 && /^KeepKey is busy\b/.test(failure.message ?? ''))
          if (passive && mutableRead && !dispatched && unavailable && cache.has(key)) return cachedResult(key, true)
          throw error
        }
        if (!same(current, deps.scope())) throw changed()
        const cacheable = !balanceRead || (name === 'getBalances' ? Array.isArray(result) && result.length > 0 : result !== null && typeof result === 'object')
        if (passive && cacheable) {
          if (cache.size >= 500) cache.delete(cache.keys().next().value!)
          cache.set(key, structuredClone(result))
        }
        return result
      }
      if (!passive) return read()
      // Duplicate polls share one acquisition; they cannot reject each other as
      // busy. A retired scope's completion cannot remove a newer pending read.
      // Warm snapshots serve either refresh intent, but a forced refresh must
      // acquire independently rather than silently joining an ordinary poll.
      const pendingKey = balanceRead ? `${key}:forceRefresh=${params?.forceRefresh === true}` : key
      let pending = pendingReads.get(pendingKey)
      if (!pending) {
        pending = read().finally(() => { if (pendingReads.get(pendingKey) === pending) pendingReads.delete(pendingKey) })
        pendingReads.set(pendingKey, pending)
      }
      const result = await pending
      if (!same(current, deps.scope())) throw changed()
      return structuredClone(result)
    }]
  })) as T
}
