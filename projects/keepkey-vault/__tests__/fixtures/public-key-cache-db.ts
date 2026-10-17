import { mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'vault-db-test-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const { initDb, getDb, saveCachedPubkey, getCachedPubkeys, setCachedBalances, getCachedBalances, updateCachedBalance } = await import('../../src/bun/db')
initDb()
if (!getDb()) throw new Error('database initialization failed')
const breakdown = [{ xpub: 'Ltub-test', path: "m/44'/2'/0'", scriptType: 'p2pkh', balance: '1', balanceUsd: 2 }]
const row = { chainId: 'litecoin', symbol: 'LTC', address: 'receive', balance: '1', balanceUsd: 2, breakdown }
setCachedBalances('test', [row], new Set(['litecoin']))
if (JSON.stringify(getCachedBalances('test')?.balances[0].breakdown) !== JSON.stringify(breakdown)) throw new Error('breakdown roundtrip failed')
updateCachedBalance('test', { ...row, balance: '0', balanceUsd: 0, breakdown: breakdown.map(p => ({ ...p, balance: '0', balanceUsd: 0 })) }, true)
if (getCachedBalances('test')?.balances[0].breakdown?.[0].balance !== '0') throw new Error('confirmed zero not persisted')
for (const script of ['p2pkh', 'p2wpkh']) saveCachedPubkey('test', 'litecoin', "m/44'/2'/0'", script, '', script)
if (getCachedPubkeys('test').length !== 2) throw new Error('key collision')
console.log('DB integration passed: migrations, balance roundtrip, confirmed zero, same-path script keys')

getDb()!.close()
rmSync(dir, { recursive: true })
