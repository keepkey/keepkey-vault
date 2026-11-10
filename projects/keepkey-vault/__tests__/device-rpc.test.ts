import { describe, expect, test } from 'bun:test'
import { gateDeviceRpc } from '../src/bun/device-rpc'
import type { DeviceOperationOptions } from '../src/bun/device-operation'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture<T extends Record<string, any>>(handlers: T, wait?: Promise<void>) {
  const scope = { wallet: {}, epoch: 1, seed: 'standard' as string | null }
  const state = { locked: false }
  const runs: DeviceOperationOptions[] = []
  const rpc = gateDeviceRpc(handlers, {
    scope: () => scope, locked: () => state.locked,
    run: async (action, options) => { runs.push(options); if (wait) await wait; return await action() },
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
  expect(await f.rpc[name]()).toEqual({ accounts: [{ address: 'same-wallet' }] })
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
