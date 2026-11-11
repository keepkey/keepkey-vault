import { describe, expect, test } from 'bun:test'
import { gateDeviceRpc } from '../src/bun/device-rpc'
import { DeviceOperationError, type DeviceOperationOptions } from '../src/bun/device-operation'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture<T extends Record<string, any>>(handlers: T, wait?: Promise<void>) {
  const scope = { wallet: {}, epoch: 1, seed: 'standard' as string | null }
  const state = { locked: false, busy: false, acquisitionError: null as Error | null }
  const runs: DeviceOperationOptions[] = []
  const rpc = gateDeviceRpc(handlers, {
    scope: () => scope, locked: () => state.locked,
    run: async (action, options) => {
      runs.push(options)
      if (state.busy) throw new DeviceOperationError(409, 'KeepKey is busy with another request. Wait for it to finish, then try again.')
      if (state.acquisitionError) throw state.acquisitionError
      if (wait) await wait
      return await action()
    },
  })
  return { scope, state, runs, rpc }
}

describe('Desktop device intent and monitoring', () => {
  test('signing and explicit display use the shared foreground operation runner', async () => {
    const calls: string[] = []
    const f = fixture({ ethSignTx: async () => { calls.push('sign'); return 'signature' },
      btcGetAddress: async (_params: unknown) => { calls.push('display'); return 'btc-address' } })
    await f.rpc.ethSignTx()
    await f.rpc.btcGetAddress({ addressNList: [1], showDisplay: true })
    await f.rpc.btcGetAddress({ addressNList: [1], showDisplay: true })
    expect(calls).toEqual(['sign', 'display', 'display'])
    expect(f.runs.map(options => options.unlock)).toEqual([true, true, true])
  })

  test('Solana message signing cannot bypass the shared device runner', async () => {
    const f = fixture({ solanaSignMessage: async () => 'signature' })
    expect(await f.rpc.solanaSignMessage()).toBe('signature')
    expect(f.runs.map(options => options.unlock)).toEqual([true])
  })

  test('display requested inside a public-key batch is never answered from cache', async () => {
    let calls = 0
    const f = fixture({ getPublicKeys: async (_params: unknown) => { calls++; return [{ xpub: 'public' }] } })
    const params = { paths: [{ addressNList: [1, 2, 3], showDisplay: true }] }
    await f.rpc.getPublicKeys(params); await f.rpc.getPublicKeys(params)
    expect(calls).toBe(2)
    expect(f.runs.map(options => options.unlock)).toEqual([true, true])
  })

  test('a locked view uses a cloned warm public cache without device work', async () => {
    let reads = 0
    const f = fixture({ getPublicKeys: async (_params: unknown) => { reads++; return [{ xpub: 'public' }] } })
    const params = { paths: [{ addressNList: [1, 2, 3] }] }
    const first = await f.rpc.getPublicKeys(params)
    first[0].xpub = 'caller-mutated'
    f.state.locked = true
    expect(await f.rpc.getPublicKeys(params)).toEqual([{ xpub: 'public' }])
    expect(reads).toBe(1)
    expect(f.runs.map(options => options.unlock)).toEqual([false])
  })

  test('a locked cold public read fails without USB or an unlock attempt', async () => {
    let reads = 0
    const f = fixture({ ethGetAddress: async (_params: unknown) => { reads++; return 'address' } })
    f.state.locked = true
    await expect(f.rpc.ethGetAddress({ addressNList: [1] })).rejects.toMatchObject({ status: 423 })
    expect(reads).toBe(0); expect(f.runs).toEqual([])
  })

  test('PIN/passphrase answers, Cancel and the explicit unlock entry bypass the wrapper', async () => {
    const calls: string[] = []
    const f = fixture({ sendPin: async () => { calls.push('pin') }, sendPassphrase: async () => { calls.push('passphrase') },
      cancelDeviceSigning: async () => { calls.push('cancel') }, requestDeviceUnlock: async () => { calls.push('unlock-owner') } })
    f.state.locked = true
    await f.rpc.sendPin(); await f.rpc.sendPassphrase(); await f.rpc.cancelDeviceSigning(); await f.rpc.requestDeviceUnlock()
    expect(calls).toEqual(['pin', 'passphrase', 'cancel', 'unlock-owner'])
    expect(f.runs).toEqual([])
  })

  test('wallet handle, epoch and seed changes all retire public cache entries', async () => {
    for (const change of [
      (scope: { wallet: unknown }) => { scope.wallet = {} },
      (scope: { epoch: number }) => { scope.epoch++ },
      (scope: { seed: string | null }) => { scope.seed = 'hidden' },
    ]) {
      const f = fixture({ ethGetAddress: async (_params: unknown) => 'old-address' })
      await f.rpc.ethGetAddress({ addressNList: [1] })
      change(f.scope); f.state.locked = true
      await expect(f.rpc.ethGetAddress({ addressNList: [1] })).rejects.toMatchObject({ status: 423 })
    }
  })

  test('scope changes while waiting reject before the original handler can dispatch', async () => {
    const wait = deferred(), calls: string[] = []
    const f = fixture({ ethSignTx: async () => { calls.push('signed'); return 'signature' } }, wait.promise)
    const request = f.rpc.ethSignTx()
    f.scope.epoch++
    wait.resolve()
    await expect(request).rejects.toMatchObject({ status: 409 })
    expect(calls).toEqual([])
  })

  test('a public result arriving after a wallet change is dropped and cannot refill its cache', async () => {
    const result = deferred<string>()
    const f = fixture({ ethGetAddress: async (_params: unknown) => result.promise })
    const request = f.rpc.ethGetAddress({ addressNList: [1] })
    f.scope.seed = 'hidden'; f.scope.epoch++
    result.resolve('old-address')
    await expect(request).rejects.toMatchObject({ status: 409 })
    f.state.locked = true
    await expect(f.rpc.ethGetAddress({ addressNList: [1] })).rejects.toMatchObject({ status: 423 })
  })

  test('a failed signing call is never retried by the wrapper', async () => {
    let signs = 0
    const f = fixture({ ethSignTx: async () => { signs++; throw new Error('USB connection lost') } })
    await expect(f.rpc.ethSignTx()).rejects.toThrow('USB connection lost')
    expect(signs).toBe(1); expect(f.runs).toHaveLength(1)
  })

  test('locked portfolio polling ignores forceRefresh and preserves the last amounts as stale', async () => {
    let reads = 0
    const result = [{ chainId: 'bitcoin', balance: '1.25', balanceUsd: 100000, syncState: 'confirmed' }]
    const f = fixture({ getBalances: async (_params?: unknown) => { reads++; return result } })
    await f.rpc.getBalances({ forceRefresh: false })
    f.state.locked = true
    const cached = await f.rpc.getBalances({ forceRefresh: true })
    expect(cached).toEqual([{ chainId: 'bitcoin', balance: '1.25', balanceUsd: 100000, syncState: 'stale' }])
    expect(result[0].syncState).toBe('confirmed')
    expect(reads).toBe(1); expect(f.runs.map(options => options.unlock)).toEqual([false])
  })

  test('unlocked single-chain reads refresh, then locked polling returns the latest chain snapshot', async () => {
    let reads = 0
    const f = fixture({ getBalance: async (_params: unknown) => ({ chainId: 'ethereum', balance: String(++reads), balanceUsd: reads * 2500 }) })
    await f.rpc.getBalance({ chainId: 'ethereum', forceRefresh: false })
    await f.rpc.getBalance({ chainId: 'ethereum', forceRefresh: true })
    f.state.locked = true
    expect(await f.rpc.getBalance({ chainId: 'ethereum', forceRefresh: false })).toMatchObject({ balance: '2', balanceUsd: 5000, syncState: 'stale' })
    await expect(f.rpc.getBalance({ chainId: 'bitcoin', forceRefresh: false })).rejects.toMatchObject({ status: 423 })
    expect(reads).toBe(2)
  })

  test('a locked cold balance read never invokes device work or fabricates a zero balance', async () => {
    let reads = 0
    const f = fixture({ getBalances: async (_params?: unknown) => { reads++; return [] } })
    f.state.locked = true
    await expect(f.rpc.getBalances({ forceRefresh: true })).rejects.toMatchObject({ status: 423 })
    expect(reads).toBe(0); expect(f.runs).toEqual([])
    f.state.locked = false
    expect(await f.rpc.getBalances()).toEqual([])
    f.state.locked = true
    await expect(f.rpc.getBalances()).rejects.toMatchObject({ status: 423 })
  })

  test('a portfolio snapshot from a prior hidden-wallet scope is never returned after switching', async () => {
    const f = fixture({ getBalances: async (_params?: unknown) => [{ chainId: 'ethereum', balance: '7', balanceUsd: 17500 }] })
    f.scope.seed = 'hidden'
    await f.rpc.getBalances()
    f.scope.seed = 'standard'; f.scope.epoch++; f.state.locked = true
    await expect(f.rpc.getBalances({ forceRefresh: true })).rejects.toMatchObject({ status: 423 })
  })
})

test.each(['getBtcAccounts', 'getEvmAddresses'])('%s uses only its verified RAM snapshot when locked', async name => {
  let calls = 0
  const f = fixture({ [name]: async () => { calls++; return { accounts: [{ address: 'same-wallet' }] } } })
  await f.rpc[name]()
  f.state.locked = true
  expect(await f.rpc[name]()).toEqual({ accounts: [{ address: 'same-wallet' }], syncState: 'stale' })
  expect(calls).toBe(1)
  expect(f.runs.map(options => options.unlock)).toEqual([false])
  f.scope.epoch++
  await expect(f.rpc[name]()).rejects.toMatchObject({ status: 423 })
  expect(calls).toBe(1)
})

test.each(['addBtcAccount', 'addEvmAddressIndex', 'addUtxoAccount'])('%s is a deliberate foreground device action', async name => {
  const f = fixture({ [name]: async () => ({ added: true }) })
  expect(await f.rpc[name]({ index: 1 })).toEqual({ added: true })
  expect(f.runs.map(options => options.unlock)).toEqual([true])
})

describe('passive read contention', () => {
  test.each(['getBalances', 'getBalance', 'getBtcAccounts', 'getEvmAddresses', 'getPublicKeys', 'ethGetAddress'])('%s coalesces duplicate polls without another device acquisition', async name => {
    const wait = deferred()
    const value = name === 'getBalances' ? [{ chainId: 'bitcoin', balance: '1.25' }] : { balance: '1.25' }
    let calls = 0
    const f = fixture({ [name]: async (_params?: unknown) => { calls++; return value } }, wait.promise)
    const first = f.rpc[name]({ chainId: 'bitcoin', forceRefresh: true })
    f.state.busy = true // Another acquisition would fail while the first read owns the device.
    const second = f.rpc[name]({ chainId: 'bitcoin', forceRefresh: true })
    wait.resolve()
    const [one, two] = await Promise.all([first, second])
    expect(one).toEqual(value); expect(two).toEqual(value)
    expect(one).not.toBe(two)
    expect(calls).toBe(1); expect(f.runs).toHaveLength(1)
  })

  test('static address reads still use their warm cache while unlocked', async () => {
    let calls = 0
    const f = fixture({ ethGetAddress: async (_params: unknown) => { calls++; return 'same-address' } })
    await f.rpc.ethGetAddress({ addressNList: [1] })
    f.state.busy = true
    expect(await f.rpc.ethGetAddress({ addressNList: [1] })).toBe('same-address')
    expect(calls).toBe(1); expect(f.runs).toHaveLength(1)
  })

  test.each(['getBalances', 'getBalance'])('%s keeps forced refresh intent separate from an ordinary in-flight poll', async name => {
    const normalResult = deferred<unknown>()
    const observed: boolean[] = []
    const scope = { wallet: {}, epoch: 1, seed: 'standard' }
    let busy = false
    const value = (balance: string) => name === 'getBalances'
      ? [{ chainId: 'bitcoin', balance, syncState: 'confirmed' }]
      : { chainId: 'bitcoin', balance, syncState: 'confirmed' }
    const rpc = gateDeviceRpc({ [name]: async ({ forceRefresh = false }: { forceRefresh?: boolean }) => {
      observed.push(forceRefresh)
      return forceRefresh ? value('forced') : normalResult.promise
    } }, {
      scope: () => scope, locked: () => false,
      run: async action => {
        if (busy) throw new DeviceOperationError(409, 'KeepKey is busy with another request.')
        busy = true
        try { return await action() } finally { busy = false }
      },
    })
    const normal = rpc[name]({ chainId: 'bitcoin', forceRefresh: false })
    await expect(rpc[name]({ chainId: 'bitcoin', forceRefresh: true })).rejects.toMatchObject({ status: 409 })
    expect(observed).toEqual([false])
    normalResult.resolve(value('ordinary'))
    expect(await normal).toEqual(value('ordinary'))
    expect(await rpc[name]({ chainId: 'bitcoin', forceRefresh: true })).toEqual(value('forced'))
    expect(observed).toEqual([false, true])
  })

  test('a forced refresh blocked by an ordinary poll returns the shared warm cache explicitly as stale', async () => {
    const normalResult = deferred<Array<{ chainId: string; balance: string; syncState: string }>>()
    const scope = { wallet: {}, epoch: 1, seed: 'standard' }
    let busy = false, reads = 0
    const rpc = gateDeviceRpc({ getBalances: async (_params?: { forceRefresh?: boolean }) => ++reads === 1
      ? [{ chainId: 'bitcoin', balance: 'warm', syncState: 'confirmed' }]
      : normalResult.promise }, {
      scope: () => scope, locked: () => false,
      run: async action => {
        if (busy) throw new DeviceOperationError(409, 'KeepKey is busy with another request.')
        busy = true
        try { return await action() } finally { busy = false }
      },
    })
    await rpc.getBalances({ forceRefresh: false })
    const normal = rpc.getBalances({ forceRefresh: false })
    expect(await rpc.getBalances({ forceRefresh: true })).toEqual([{ chainId: 'bitcoin', balance: 'warm', syncState: 'stale' }])
    expect(reads).toBe(2)
    normalResult.resolve([{ chainId: 'bitcoin', balance: 'new', syncState: 'confirmed' }])
    expect(await normal).toEqual([{ chainId: 'bitcoin', balance: 'new', syncState: 'confirmed' }])
  })

  test('display requests retain independent foreground ownership during duplicate calls', async () => {
    const wait = deferred()
    const f = fixture({ btcGetAddress: async (_params: unknown) => 'displayed-address' }, wait.promise)
    const first = f.rpc.btcGetAddress({ addressNList: [1], showDisplay: true })
    f.state.busy = true
    await expect(f.rpc.btcGetAddress({ addressNList: [1], showDisplay: true })).rejects.toMatchObject({ status: 409 })
    wait.resolve()
    expect(await first).toBe('displayed-address')
    expect(f.runs.map(options => options.unlock)).toEqual([true, true])
  })

  test.each([409, 423])('a warm balance survives local acquisition failure %s as stale, then refreshes', async status => {
    let calls = 0
    const f = fixture({ getBalance: async (_params: unknown) => ({ chainId: 'bitcoin', balance: String(++calls), syncState: 'confirmed' }) })
    await f.rpc.getBalance({ chainId: 'bitcoin' })
    f.state.acquisitionError = new DeviceOperationError(status, status === 409 ? 'KeepKey is busy with device setup.' : 'KeepKey is locked')
    expect(await f.rpc.getBalance({ chainId: 'bitcoin', forceRefresh: true })).toEqual({ chainId: 'bitcoin', balance: '1', syncState: 'stale' })
    expect(calls).toBe(1)
    f.state.acquisitionError = null
    expect(await f.rpc.getBalance({ chainId: 'bitcoin', forceRefresh: true })).toEqual({ chainId: 'bitcoin', balance: '2', syncState: 'confirmed' })
    f.state.locked = true
    expect(await f.rpc.getBalance({ chainId: 'bitcoin' })).toMatchObject({ balance: '2', syncState: 'stale' })
  })

  test('busy portfolio fallback preserves all last known amounts without overwriting its fresh snapshot', async () => {
    const balances = [{ chainId: 'bitcoin', balance: '1.25', balanceUsd: 100000, syncState: 'confirmed' }]
    const f = fixture({ getBalances: async (_params?: unknown) => balances })
    await f.rpc.getBalances({ forceRefresh: false })
    f.state.busy = true
    const stale = await f.rpc.getBalances({ forceRefresh: true })
    expect(stale).toEqual([{ ...balances[0], syncState: 'stale' }])
    stale[0].balance = 'caller-mutated'
    expect(await f.rpc.getBalances({ forceRefresh: true })).toEqual([{ ...balances[0], syncState: 'stale' }])
    expect(balances[0].syncState).toBe('confirmed')
  })

  test('a cold busy read stays a local error and cannot poison the next successful read', async () => {
    let calls = 0
    const f = fixture({ getBalances: async (_params?: unknown) => { calls++; return [{ chainId: 'bitcoin', balance: '4' }] } })
    f.state.busy = true
    await expect(f.rpc.getBalances()).rejects.toMatchObject({ status: 409 })
    expect(calls).toBe(0)
    f.state.busy = false
    expect(await f.rpc.getBalances()).toEqual([{ chainId: 'bitcoin', balance: '4' }])
    expect(calls).toBe(1)
  })

  test.each([
    new DeviceOperationError(499, 'KeepKey request cancelled.'),
    new DeviceOperationError(409, 'The KeepKey wallet changed. Start the request again.'),
  ])('a warm snapshot never masks cancellation or wallet invalidation: %s', async failure => {
    const f = fixture({ getBalance: async (_params: unknown) => ({ chainId: 'bitcoin', balance: '4' }) })
    await f.rpc.getBalance({ chainId: 'bitcoin' })
    f.state.acquisitionError = failure
    await expect(f.rpc.getBalance({ chainId: 'bitcoin' })).rejects.toBe(failure)
  })

  test.each([
    new Error('Balance provider unavailable'),
    new DeviceOperationError(409, 'KeepKey is busy with another request.'),
    new DeviceOperationError(423, 'Provider access denied'),
  ])('an admitted read propagates provider failure instead of masking it with warm data: %s', async failure => {
    let fail = false
    const f = fixture({ getBalance: async (_params: unknown) => {
      if (fail) throw failure
      return { chainId: 'ethereum', balance: '7', syncState: 'confirmed' }
    } })
    await f.rpc.getBalance({ chainId: 'ethereum' })
    fail = true
    await expect(f.rpc.getBalance({ chainId: 'ethereum', forceRefresh: true })).rejects.toBe(failure)
    f.state.locked = true
    expect(await f.rpc.getBalance({ chainId: 'ethereum' })).toMatchObject({ balance: '7', syncState: 'stale' })
  })

  test('a wallet change during acquisition cannot return the previous wallet\'s busy fallback', async () => {
    const scope = { wallet: {}, epoch: 1, seed: 'standard' }
    let busy = false
    const rpc = gateDeviceRpc({ getBalance: async (_params: unknown) => ({ chainId: 'bitcoin', balance: '9' }) }, {
      scope: () => scope, locked: () => false,
      run: async action => {
        if (busy) { scope.epoch++; throw new DeviceOperationError(409, 'KeepKey is busy with another request.') }
        return action()
      },
    })
    await rpc.getBalance({ chainId: 'bitcoin' })
    busy = true
    await expect(rpc.getBalance({ chainId: 'bitcoin' })).rejects.toThrow('The wallet changed')
  })

  test('retired pending reads neither join nor erase the replacement wallet\'s read', async () => {
    const old = deferred<{ balance: string }>(), replacement = deferred<{ balance: string }>()
    let calls = 0
    const f = fixture({ getBalance: async (_params: unknown) => ++calls === 1 ? old.promise : replacement.promise })
    const first = f.rpc.getBalance({ chainId: 'bitcoin' })
    const duplicate = f.rpc.getBalance({ chainId: 'bitcoin' })
    const retired = Promise.allSettled([first, duplicate])
    f.scope.epoch++; f.scope.seed = 'hidden'
    const next = f.rpc.getBalance({ chainId: 'bitcoin' })
    old.resolve({ balance: 'old-wallet' })
    for (const result of await retired) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason.status).toBe(409)
    }
    f.state.busy = true
    const nextDuplicate = f.rpc.getBalance({ chainId: 'bitcoin' })
    replacement.resolve({ balance: 'hidden-wallet' })
    expect(await next).toEqual({ balance: 'hidden-wallet' })
    expect(await nextDuplicate).toEqual({ balance: 'hidden-wallet' })
    expect(calls).toBe(2); expect(f.runs).toHaveLength(2)
    f.state.locked = true
    expect(await f.rpc.getBalance({ chainId: 'bitcoin' })).toEqual({ balance: 'hidden-wallet', syncState: 'stale' })
  })
})

describe('mutable account manager snapshots', () => {
  test('BTC refresh sees added accounts, selection and balance changes while unlocked', async () => {
    const manager = { accounts: [{ accountIndex: 0 }], selectedXpub: { accountIndex: 0, scriptType: 'p2wpkh' }, totalBalance: '1' }
    let reads = 0
    const f = fixture({
      getBtcAccounts: async () => { reads++; return structuredClone(manager) },
      addBtcAccount: async () => { manager.accounts.push({ accountIndex: 1 }); return structuredClone(manager) },
      setBtcSelectedXpub: async (params: typeof manager.selectedXpub) => { manager.selectedXpub = params },
    })
    await f.rpc.getBtcAccounts()
    await f.rpc.addBtcAccount()
    await f.rpc.setBtcSelectedXpub({ accountIndex: 1, scriptType: 'p2tr' })
    manager.totalBalance = '3'
    expect(await f.rpc.getBtcAccounts()).toEqual(manager)
    expect(reads).toBe(2)
    f.state.busy = true
    expect(await f.rpc.getBtcAccounts()).toEqual({ ...manager, syncState: 'stale' })
    expect(reads).toBe(2)
  })

  test('EVM refresh sees added and removed indices, selection and balance changes while unlocked', async () => {
    const manager = { addresses: [{ addressIndex: 0 }, { addressIndex: 1 }], selectedIndex: 0, totalBalanceUsd: 100 }
    let reads = 0
    const f = fixture({
      getEvmAddresses: async () => { reads++; return structuredClone(manager) },
      addEvmAddressIndex: async ({ index }: { index: number }) => { manager.addresses.push({ addressIndex: index }); return structuredClone(manager) },
      removeEvmAddressIndex: async ({ index }: { index: number }) => { manager.addresses = manager.addresses.filter(address => address.addressIndex !== index) },
      setEvmSelectedIndex: async ({ index }: { index: number }) => { manager.selectedIndex = index },
    })
    await f.rpc.getEvmAddresses()
    await f.rpc.addEvmAddressIndex({ index: 2 })
    await f.rpc.removeEvmAddressIndex({ index: 1 })
    await f.rpc.setEvmSelectedIndex({ index: 2 })
    manager.totalBalanceUsd = 500
    expect(await f.rpc.getEvmAddresses()).toEqual(manager)
    expect(reads).toBe(2)
    f.state.busy = true
    expect(await f.rpc.getEvmAddresses()).toEqual({ ...manager, syncState: 'stale' })
    expect(reads).toBe(2)
  })
})
