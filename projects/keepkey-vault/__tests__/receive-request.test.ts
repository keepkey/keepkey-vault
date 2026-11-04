import { expect, test } from 'bun:test'
import { createLatestReceiveRequest, selectedReceiveScriptType } from '../src/shared/receive-request'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('Litecoin selected script replaces the chain default for receive details and device review', () => {
  for (const selected of ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh']) {
    expect(selectedReceiveScriptType('p2wpkh', undefined, selected)).toBe(selected)
  }
  expect(selectedReceiveScriptType('p2wpkh', 'p2tr')).toBe('p2tr')
  expect(selectedReceiveScriptType('p2pkh')).toBe('p2pkh')
})

test('a previous account address cannot appear while the selected account is still deriving', async () => {
  const requests = createLatestReceiveRequest(), legacy = deferred<string>(), native = deferred<string>()
  const ui = { address: null as string | null, error: null as unknown, loading: false }
  const handlers = { pending: () => { ui.address = null; ui.loading = true }, resolved: (address: string) => { ui.address = address },
    rejected: (error: unknown) => { ui.error = error }, settled: () => { ui.loading = false } }
  const old = requests.run(() => legacy.promise, handlers)
  const current = requests.run(() => native.promise, handlers)
  legacy.resolve('L-old-account-address')
  await old
  expect(ui).toEqual({ address: null, error: null, loading: true })
  native.resolve('ltc1-current-account-address')
  await current
  expect(ui).toEqual({ address: 'ltc1-current-account-address', error: null, loading: false })
})

test('late errors or xpub results from a previous script cannot replace a newer success', async () => {
  for (const staleOutcome of ['success', 'failure']) {
    const requests = createLatestReceiveRequest(), old = deferred<string>(), current = deferred<string>()
    const applied: string[] = []
    const handlers = { resolved: (key: string) => applied.push(key), rejected: () => applied.push('error'), settled: () => applied.push('settled') }
    const previous = requests.run(() => old.promise, handlers)
    const next = requests.run(() => current.promise, handlers)
    current.resolve('zpub-current-native-account')
    await next
    if (staleOutcome === 'success') old.resolve('Mtub-old-segwit-account')
    else old.reject(new Error('Old request timed out'))
    await previous
    expect(applied).toEqual(['zpub-current-native-account', 'settled'])
  }
})

test('unmount or wallet-mode changes invalidate pending address results', async () => {
  const requests = createLatestReceiveRequest(), pending = deferred<string>(), applied: string[] = []
  const run = requests.run(() => pending.promise, { resolved: address => applied.push(address), rejected: () => applied.push('error'), settled: () => applied.push('settled') })
  requests.invalidate()
  pending.resolve('address-from-previous-wallet')
  await run
  expect(applied).toEqual([])
})
