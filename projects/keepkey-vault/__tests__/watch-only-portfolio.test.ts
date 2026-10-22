import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { CHAINS } from '../src/shared/chains'
import { utxoAccountScriptPaths, pathToBip32 } from '../src/bun/chain-scan'
import { migratePublicKeyCache } from '../src/bun/public-key-cache-migration'
import { watchOnlyPortfolioKeys, watchOnlyNativeBalances, watchOnlyNodeBalances, trackedUtxoScriptPaths } from '../src/bun/watch-only-portfolio'
import type { BtcBackend } from '../src/bun/btc-backend/types'
import type { ChainBalance } from '../src/shared/types'
const ltc = CHAINS.find(c => c.id === 'litecoin')!
const eth = CHAINS.find(c => c.id === 'ethereum')!
const base = CHAINS.find(c => c.id === 'base')!
const btc = CHAINS.find(c => c.id === 'bitcoin')!

test('node balances succeed when hosted pricing fails, with cached or explicitly unavailable fiat values', async () => {
  const { pubkeys } = watchOnlyPortfolioKeys([btc], [], [{ chainId: btc.id, xpub: 'xpub-test', path: "m/84'/0'/0'", scriptType: 'p2wpkh', address: '' }])
  let requests = 0
  const backend = { kind: 'core', listUnspent: async () => { requests++; return [{ value: 12345678 }] } } as unknown as BtcBackend
  const quote = async () => { throw new Error('Pioneer unavailable') }
  const cached = await watchOnlyNodeBalances(backend, pubkeys, quote, 100000)
  expect(cached.fiatValueState).toBe('stale')
  expect(cached.entries[0]).toMatchObject({ balance: '0.12345678', valueUsd: 12345.678 })
  const unavailable = await watchOnlyNodeBalances(backend, pubkeys, quote)
  expect(unavailable.fiatValueState).toBe('unavailable')
  expect(unavailable.entries[0]).toMatchObject({ balance: '0.12345678', valueUsd: 0 })
  const fresh = await watchOnlyNodeBalances(backend, pubkeys, async () => 50000)
  expect(fresh.fiatValueState).toBeUndefined()
  expect(fresh.entries[0].valueUsd).toBe(6172.839)
  expect(requests).toBe(3)
})

test('failed or malformed node results cannot confirm a partial account balance', async () => {
  const { pubkeys } = watchOnlyPortfolioKeys([btc], [], [{ chainId: btc.id, xpub: 'xpub-test', path: "m/84'/0'/0'", scriptType: 'p2wpkh', address: '' }])
  for (const value of [NaN, -1, 0.1, Number.MAX_SAFE_INTEGER]) {
    const backend = { listUnspent: async () => [{ value }] } as unknown as BtcBackend
    await expect(watchOnlyNodeBalances(backend, pubkeys, async () => 1)).rejects.toThrow(/invalid/)
  }
  const backend = { listUnspent: async () => { throw new Error('own node is down') } } as unknown as BtcBackend
  await expect(watchOnlyNodeBalances(backend, pubkeys, async () => 1)).rejects.toThrow('own node is down')
})

test('Core scans accounts serially and malformed fiat quotes do not discard node balances', async () => {
  const rows = [0, 1].map(i => ({ chainId: btc.id, xpub: `xpub-${i}`, path: `m/84'/0'/${i}'`, scriptType: 'p2wpkh', address: '' }))
  const { pubkeys } = watchOnlyPortfolioKeys([btc], [], rows)
  let active = false
  const backend = { listUnspent: async () => {
    if (active) throw new Error('Core scan already running')
    active = true
    await Promise.resolve()
    active = false
    return [{ value: 1 }]
  } } as unknown as BtcBackend
  for (const price of [NaN, -1, Infinity, Number.MAX_VALUE]) {
    const result = await watchOnlyNodeBalances(backend, pubkeys, async () => price)
    expect(result.fiatValueState).toBe('unavailable')
    expect(result.entries.map(e => e.balance)).toEqual(['0.00000001', '0.00000001'])
  }
})
const saved = (account = 0) => utxoAccountScriptPaths(ltc, account).map((sp, i) => ({
  chainId: ltc.id, path: pathToBip32(sp.path), scriptType: sp.scriptType, xpub: `key-${account}-${i}`, address: '',
}))
test('additive migration preserves rows, permits script collisions, and is idempotent', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE balances (device_id TEXT, balance TEXT); INSERT INTO balances VALUES ('device','0.0967');
    CREATE TABLE cached_pubkeys (device_id TEXT, chain_id TEXT, path TEXT, xpub TEXT, address TEXT, script_type TEXT, balance TEXT, balance_usd REAL, updated_at INTEGER, PRIMARY KEY(device_id,chain_id,path));
    INSERT INTO cached_pubkeys VALUES ('device','litecoin','path','legacy','','p2pkh','1',2,123);`)
  for (let i = 0; i < 2; i++) { migratePublicKeyCache(db, 'balances'); migratePublicKeyCache(db, 'pubkeys') }
  db.exec(`INSERT INTO cached_pubkeys VALUES ('device','litecoin','path','native','','p2wpkh','2',4,124)`)
  expect(db.query('SELECT balance FROM balances').get()).toEqual({ balance: '0.0967' })
  expect(db.query('SELECT xpub, balance, updated_at FROM cached_pubkeys ORDER BY xpub').all()).toEqual([
    { xpub: 'legacy', balance: '1', updated_at: 123 }, { xpub: 'native', balance: '2', updated_at: 124 },
  ])
  db.close()
})
test('all LTC account/script paths survive and dedup against persisted breakdown', () => {
  const rows = [...saved(), ...saved(1)]
  const balances = [{ chainId: ltc.id, address: 'receive-only', breakdown: rows.map(p => ({ ...p, balance: '0', balanceUsd: 0 })) }] as ChainBalance[]
  const { pubkeys, incomplete } = watchOnlyPortfolioKeys([ltc], balances, rows)
  expect(pubkeys).toHaveLength(8); expect(incomplete.size).toBe(0)
  expect(pubkeys.some(p => p.pubkey === 'receive-only')).toBe(false)
  const failed = new Set<string>()
  const totals = watchOnlyNativeBalances(pubkeys, pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey, balance: '0.01', valueUsd: 1 })), failed)
  expect(totals).toHaveLength(1); expect(Number(totals[0].balance)).toBeCloseTo(0.08)
  expect(totals[0].balanceUsd).toBe(8); expect(totals[0].breakdown).toHaveLength(8); expect(failed.size).toBe(0)
})
test('legacy receive-only and incomplete inventories cannot confirm an aggregate', () => {
  const balances = [{ chainId: ltc.id, address: 'Ltub-legacy' }] as ChainBalance[]
  for (const rows of [[], saved().slice(1), saved(1)]) expect(watchOnlyPortfolioKeys([ltc], balances, rows).incomplete.has(ltc.id)).toBe(true)
})
test('missing and invalid results cannot confirm; explicit zero can', () => {
  const { pubkeys } = watchOnlyPortfolioKeys([ltc], [], saved())
  const responses = pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey, balance: '0', valueUsd: 0 }))
  for (const entries of [responses.slice(1), responses.map((r, i) => i ? r : { ...r, balance: 'NaN' })]) {
    const failed = new Set<string>(); watchOnlyNativeBalances(pubkeys, entries, failed); expect(failed.has(ltc.id)).toBe(true)
  }
  const failed = new Set<string>(); expect(watchOnlyNativeBalances(pubkeys, responses, failed)[0].balance).toBe('0'); expect(failed.size).toBe(0)
  const degraded = new Set([ltc.id]); watchOnlyNativeBalances(pubkeys, responses, degraded); expect(degraded.has(ltc.id)).toBe(true)
})
test('EVM owners sum once per network, case insensitive with no cross-chain match', () => {
  const rows = [eth, base].flatMap(c => ['0xAbC', '0xdef'].map(address => ({ chainId: c.id, xpub: '', address, path: address, scriptType: '' })))
  const { pubkeys } = watchOnlyPortfolioKeys([eth, base], [{ chainId: eth.id, address: '0xabc' }] as ChainBalance[], rows)
  expect(pubkeys).toHaveLength(4)
  const failed = new Set<string>()
  const totals = watchOnlyNativeBalances(pubkeys, pubkeys.map(p => ({ caip: p.caip, pubkey: p.pubkey.toLowerCase(), balance: p.chainId === eth.id ? '1' : '3', valueUsd: 0 })), failed)
  expect(totals.map(r => r.balance)).toEqual(['2', '6']); expect(failed.size).toBe(0)
})
test('Taproot raw key matches descriptor; non-EVM keys stay case sensitive', () => {
  const btc = CHAINS.find(c => c.id === 'bitcoin')!
  const { pubkeys } = watchOnlyPortfolioKeys([btc], [], [{ chainId: btc.id, xpub: 'xpubCase', path: 'xpubCase', scriptType: 'p2tr', address: '' }])
  expect(pubkeys[0].pubkey).toBe('tr(xpubCase)')
  const failed = new Set<string>()
  expect(watchOnlyNativeBalances(pubkeys, [{ caip: btc.caip, pubkey: 'xpubCase', balance: '1' }], failed)[0].balance).toBe('1')
  watchOnlyNativeBalances(pubkeys, [{ caip: btc.caip, pubkey: 'xpubcase', balance: '1' }], failed); expect(failed.has(btc.id)).toBe(true)
})

test('reconnect repairs every script on tracked extra accounts', () => {
  const paths = trackedUtxoScriptPaths(ltc, saved(2).slice(1))
  expect(paths).toHaveLength(8)
  expect(paths.filter(p => p.path[2] === 0x80000002)).toHaveLength(4)
})
test('real DB save/read paths roundtrip breakdown and zero balances', () => {
  const result = Bun.spawnSync([process.execPath, `${import.meta.dir}/fixtures/public-key-cache-db.ts`])
  expect(result.stdout.toString() + result.stderr.toString()).toContain('DB integration passed')
  expect(result.exitCode).toBe(0)
})
