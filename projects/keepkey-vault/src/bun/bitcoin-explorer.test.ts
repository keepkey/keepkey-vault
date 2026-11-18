import { expect, test } from 'bun:test'
import { BitcoinExplorer, BITCOIN_MAINNET, publicBitcoinTxDetail } from './bitcoin-explorer'
import { buildFlowTx } from './report-btc-flow'

const txid = 'ab'.repeat(32)
const own = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
const other = '1XPTgDRhN8RFnzniWCddobD9iKZatrvH4'
const transaction = () => ({ kind: 'tx', id: txid, asOf: '2026-11-17T00:00:00Z',
  url: `https://www.bitcoin.com/explorer/btc/tx/${txid}/`, explanation: 'This transaction moved 0.0049 BTC.',
  data: { txid, value: '490000', valueIn: '500000', fees: '10000', confirmations: 3,
    vin: [{ addresses: [own], value: '500000' }],
    vout: [{ addresses: [other], value: '100000' }, { addresses: [own], value: '390000' }] } })
const json = (body: object) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
function client(reply: (url: string) => Response = () => json(transaction())) {
  let now = 100_000, calls = 0
  const explorer = new BitcoinExplorer((async (url: string, init?: RequestInit) => {
    calls++
    expect(url).toContain('https://www.bitcoin.com/explorer/btc/')
    expect(url).toEndWith('/?format=json')
    expect(init?.headers).toEqual({ Accept: 'application/json' })
    expect(init?.redirect).toBe('error')
    return reply(url)
  }) as typeof fetch, () => now)
  return { explorer, get calls() { return calls }, advance: (ms: number) => { now += ms } }
}
test('deduplicates concurrent reads, caches for thirty seconds and isolates callers from mutation', async () => {
  const c = client()
  const [a, b] = await Promise.all([c.explorer.record('tx', txid), c.explorer.record('tx', txid)])
  expect(c.calls).toBe(1)
  a.data.vout[0].value = '1'
  expect(b.data.vout[0].value).toBe('100000')
  expect((await c.explorer.record('tx', txid)).data.vout[0].value).toBe('100000')
  c.advance(30_001)
  await c.explorer.record('tx', txid)
  expect(c.calls).toBe(2)
})
test('respects Retry-After seconds and HTTP dates across all record kinds', async () => {
  for (const retry of ['120', new Date(220_000).toUTCString()]) {
    const c = client(() => new Response(null, { status: 429, headers: { 'Retry-After': retry } }))
    await expect(c.explorer.record('tx', txid)).rejects.toMatchObject({ status: 429, retryAt: 220_000 })
    await expect(c.explorer.record('address', own)).rejects.toMatchObject({ status: 429 })
    expect(c.calls).toBe(1)
    c.advance(120_001)
    await expect(c.explorer.record('tx', txid)).rejects.toMatchObject({ status: 429 })
    expect(c.calls).toBe(2)
  }
})
test('caps uncached traffic locally while serving cached records without another request', async () => {
  const c = client(url => {
    const record = transaction(), id = new URL(url).pathname.split('/').at(-2)!
    record.id = id; record.data.txid = id; record.url = `https://www.bitcoin.com/explorer/btc/tx/${id}/`
    return json(record)
  })
  const hash = (i: number) => i.toString(16).padStart(64, '0')
  for (let i = 0; i < 55; i++) await c.explorer.record('tx', hash(i))
  await expect(c.explorer.record('tx', hash(55))).rejects.toMatchObject({ status: 429 })
  expect((await c.explorer.record('tx', hash(0))).id).toBe(hash(0))
  expect(c.calls).toBe(55)
  c.advance(60_001)
  await c.explorer.record('tx', hash(55))
  expect(c.calls).toBe(56)
})
test('rejects substituted records and floating point amounts before they reach wallet reports', async () => {
  for (const mutate of [
    (r: any) => { r.data.txid = 'cd'.repeat(32) }, (r: any) => { r.kind = 'address' },
    (r: any) => { r.url = 'https://attacker.invalid/' }, (r: any) => { r.data.fees = 0.0001 },
    (r: any) => { r.data.vout[0].value = '0.001' }, (r: any) => { r.data.confirmations = -1 },
  ]) {
    const record = transaction(); mutate(record)
    await expect(client(() => json(record)).explorer.record('tx', txid)).rejects.toThrow()
  }
})
test('individual addresses and block records retain exact satoshi strings and record provenance', async () => {
  const address = { kind: 'address', id: own, asOf: '2026-11-17T00:00:00Z',
    url: `https://www.bitcoin.com/explorer/btc/address/${own}/`, explanation: 'Address summary',
    data: { address: own, balance: '10772368093', totalReceived: '10772368093', totalSent: '0', unconfirmedBalance: '-1', unconfirmedTxs: 1, txs: 12, utxoCount: 10 } }
  expect((await client(() => json(address)).explorer.record('address', own)).data.balance).toBe('10772368093')
  const block = { kind: 'block', id: '840000', asOf: address.asOf,
    url: 'https://www.bitcoin.com/explorer/btc/block/840000/', explanation: 'Block summary',
    data: { hash: 'cd'.repeat(32), height: 840000, nTx: 3050, totalFees: '3762561499' } }
  expect((await client(() => json(block)).explorer.record('block', '840000')).data.height).toBe(840000)
})
test('never sends extended public keys, non-mainnet identifiers or URL path injection', async () => {
  const c = client()
  for (const id of ['xpub' + 'a'.repeat(108), 'tb1qexample', '../address/', 'https://attacker.invalid'])
    await expect(c.explorer.record('address', id)).rejects.toThrow()
  await expect(c.explorer.record('tx', '../block/840000')).rejects.toThrow()
  expect(c.calls).toBe(0)
})
test('public Bitcoin reports use the record but compute wallet movement themselves', async () => {
  const c = client(); let fallbackCalls = 0
  const tx = await publicBitcoinTxDetail(BITCOIN_MAINNET, txid, async () => { fallbackCalls++; return {} }, c.explorer)
  const flow = buildFlowTx(tx, new Map([[own, "m/84'/0'/0'/0/0"]]))
  expect(flow).toMatchObject({ dir: 'sent', amount: 100000, net: -110000, fee: 10000 })
  expect(fallbackCalls).toBe(0)
  expect(c.calls).toBe(1)
  expect(tx.explorer).toMatchObject({ provider: 'bitcoin.com', explanation: transaction().explanation })
})
test('alternate chains never query Bitcoin.com, and unavailable or invalid Bitcoin records use the existing provider', async () => {
  const c = client(() => new Response(null, { status: 503 })); let fallbackCalls = 0
  const fallback = async () => { fallbackCalls++; return { source: 'existing' } }
  expect(await publicBitcoinTxDetail('bip122:other-chain', txid, fallback, c.explorer)).toEqual({ source: 'existing' })
  expect(c.calls).toBe(0)
  expect(await publicBitcoinTxDetail(BITCOIN_MAINNET, txid, fallback, c.explorer)).toEqual({ source: 'existing' })
  expect(fallbackCalls).toBe(2)
})
