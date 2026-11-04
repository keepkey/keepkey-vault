/**
 * Firmware 7.17 decodes a v0 message's instructions when the host sends the
 * lookup-table accounts it resolved (SolanaSignTx.lut_account, no signature).
 * Desktop resolves them at signing time and sends them only to 7.17.0+.
 *
 * Real data: a mainnet Jupiter swap (the firmware/python-keepkey 7.17 vector)
 * and its four lookup tables as fetched from mainnet. The expected list is the
 * transaction's own meta.loadedAddresses.
 *
 * Run: bun test __tests__/solana-host-lut.test.ts
 */
import { describe, expect, test } from 'bun:test'
import bs58 from 'bs58'
import fixture from './fixtures/solana/jupiter-v0-lookup-tables.json'
import { signSolanaWireTransaction } from '../src/bun/solana-signing'
import { parseSolanaMessage } from '../src/bun/solana-tx'
import type { AltAccountFetcher } from '../src/bun/solana-alt'

const PATH = [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]
const message = Buffer.from(fixture.messageHex, 'hex')
const payer = bs58.encode(message.subarray(5, 37)) // v0 prefix, header, key count
// Unsigned wire transaction: one empty signature slot, then the message.
const rawTx = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')

const realFetcher: AltAccountFetcher = async (keys) => keys.map((k) => {
  const t = fixture.tables.find((x) => x.key === k)
  return t ? { owner: t.owner, data: Buffer.from(t.dataBase64, 'base64') } : null
})

async function sign(firmwareVersion: string | undefined, opts: { fetcher?: AltAccountFetcher | null; tx?: any } = {}) {
  const sent: any[] = []
  const fetcher = opts.fetcher === null ? undefined : (opts.fetcher ?? realFetcher)
  await signSolanaWireTransaction(
    { addressNList: PATH, rawTx, ...(opts.tx || {}) },
    async (params) => { sent.push(params); return { signature: new Uint8Array(64) } },
    async () => payer,
    'test',
    () => firmwareVersion,
    fetcher,
  )
  expect(sent).toHaveLength(1)
  return sent[0]
}

const hex = (keys?: Uint8Array[]) => keys?.map((k) => Buffer.from(k).toString('hex'))

describe('Solana v0 lookup accounts sent to firmware 7.17+', () => {
  test('7.17.0 gets the 41 loaded accounts in runtime order (writable, then readonly)', async () => {
    const params = await sign('7.17.0')
    expect(hex(params.lutAccounts)).toEqual(fixture.loadedHex)
    expect(params.lutProof).toBeUndefined()
    expect(params.schema).toBeUndefined()
    expect(Buffer.from(params.rawTx, 'base64').equals(message)).toBe(true)
  })

  test('later firmware gets them too', async () => {
    expect(hex((await sign('7.18.2')).lutAccounts)).toEqual(fixture.loadedHex)
  })

  test('7.16.0 and unknown firmware get none (older firmware cannot take the list)', async () => {
    expect((await sign('7.16.0')).lutAccounts).toBeUndefined()
    expect((await sign('7.15.0')).lutAccounts).toBeUndefined()
    expect((await sign(undefined)).lutAccounts).toBeUndefined()
  })

  test('a caller-supplied list never reaches the device', async () => {
    const forged = [new Uint8Array(32).fill(7)]
    expect((await sign('7.16.0', { tx: { lutAccounts: forged } })).lutAccounts).toBeUndefined()
    expect(hex((await sign('7.17.0', { tx: { lutAccounts: forged } })).lutAccounts)).toEqual(fixture.loadedHex)
  })

  test('none next to a schema or a LUT proof (the device refuses that mix)', async () => {
    const schema = { payload: 'AA==', signature: Buffer.alloc(64).toString('base64'), signerKeyId: 0 }
    expect((await sign('7.17.0', { tx: { schema } })).lutAccounts).toBeUndefined()
    const lutProof = { accounts: [fixture.loadedHex[0]], signature: Buffer.alloc(64), signerKeyId: 0 }
    expect((await sign('7.17.0', { tx: { lutProof } })).lutAccounts).toBeUndefined()
  })

  test('an unresolvable table sends none and still signs (the device blind-signs as before)', async () => {
    const missingOne: AltAccountFetcher = async (keys) => (await realFetcher(keys)).map((a, i) => (i === 2 ? null : a))
    expect((await sign('7.17.0', { fetcher: missingOne })).lutAccounts).toBeUndefined()
    const rpcDown: AltAccountFetcher = async () => { throw new Error('HTTP 503') }
    expect((await sign('7.17.0', { fetcher: rpcDown })).lutAccounts).toBeUndefined()
    expect((await sign('7.17.0', { fetcher: null })).lutAccounts).toBeUndefined()
  })

  test('a table key equal to a static key is not sent (the device would refuse it)', async () => {
    const staticKey = message.subarray(5 + 32, 5 + 64) // second static account
    const index = parseSolanaMessage(message).altEntries[0].writableIndices[0]
    const poisoned: AltAccountFetcher = async (keys) => (await realFetcher(keys)).map((a, i) => {
      if (!a || i !== 0) return a
      const data = Buffer.from(a.data)
      staticKey.copy(data, 56 + 32 * index)
      return { ...a, data }
    })
    expect((await sign('7.17.0', { fetcher: poisoned })).lutAccounts).toBeUndefined()
  })

  test('a legacy message never asks for lookup tables', async () => {
    let called = false
    const spy: AltAccountFetcher = async (keys) => { called = true; return realFetcher(keys) }
    // Minimal legacy message: 1 signer, payer only, no instructions.
    const legacy = Buffer.concat([Buffer.from([1, 0, 0, 1]), message.subarray(5, 37), Buffer.alloc(32), Buffer.from([0])])
    const sent: any[] = []
    await signSolanaWireTransaction(
      { addressNList: PATH, rawTx: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), legacy]).toString('base64') },
      async (p) => { sent.push(p); return { signature: new Uint8Array(64) } },
      async () => payer, 'test', () => '7.17.0', spy,
    )
    expect(called).toBe(false)
    expect(sent[0].lutAccounts).toBeUndefined()
  })
})
