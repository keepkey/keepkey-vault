import { describe, expect, test } from 'bun:test'
import { DigestWalletRpc } from './digest'
import { WATCH_NODE_UNREACHABLE, WATCH_SCANNING, parseTxLookup, validateKeyImageImport, validateWalletStatus } from './protocol'
import { MoneroWatchService, daemonRequest, lookupTransaction, nodeHeight, refreshFailure, verifyDaemon } from './wallet'

// Loopback fakes only: no wallet-rpc, daemon or network beyond 127.0.0.1.
const ADDRESS = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'

describe('a long scan is not an unreachable node', () => {
  test('a wallet-rpc call that runs out of time reports a timeout (it used to read as "unavailable")', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) })
    const rpc = new DigestWalletRpc(server.port, 'user', 'pass')
    try {
      const error = await rpc.call('refresh', {}, 150).catch(e => e)
      expect(error.message).toBe('Monero wallet RPC timed out')
      // A slow refresh is a scan only while the node itself still answers; a silent node is unreachable.
      expect(refreshFailure(error, true)).toBe(WATCH_SCANNING)
      expect(refreshFailure(error, false)).toBe(WATCH_NODE_UNREACHABLE)
    } finally { rpc.close(); server.stop(true) }
  })

  test('a refused connection or wallet-rpc failure is the node being unreachable', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = server.port; server.stop(true)
    const rpc = new DigestWalletRpc(port, 'user', 'pass')
    try {
      const error = await rpc.call('refresh', {}, 2000).catch(e => e)
      expect(error.message).toBe('The local Monero wallet RPC is unavailable')
      expect(refreshFailure(error, true)).toBe(WATCH_NODE_UNREACHABLE)
    } finally { rpc.close() }
  })
})

describe('node problems at connect have fixed, public messages', () => {
  test('an unreachable node', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = server.port; server.stop(true)
    await expect(verifyDaemon(`http://127.0.0.1:${port}`, 0)).rejects.toThrow('The Monero daemon is unavailable')
  })
  test('a node behind the chosen scan start', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ result:
      { nettype: 'mainnet', offline: false, synchronized: true, height: 200, testnet: false, stagenet: false } }) })
    try { await expect(verifyDaemon(`http://127.0.0.1:${server.port}`, 500)).rejects.toThrow('The selected Monero node is not synchronized on mainnet') }
    finally { server.stop(true) }
  })
})

describe('protocol', () => {
  test('wallet status carries the node height for scan progress', () => {
    const base = { network: 'mainnet', address: ADDRESS, balanceAtomic: '0', unlockedBalanceAtomic: '0', walletHeight: 10, transactions: [],
      monitorReady: false, updatedAt: new Date().toISOString(), canSend: false }
    expect(validateWalletStatus({ ...base, daemonHeight: 3_000_000 }).daemonHeight).toBe(3_000_000)
    expect(validateWalletStatus(base).daemonHeight).toBeUndefined()
    expect(() => validateWalletStatus({ ...base, daemonHeight: -1 })).toThrow()
  })
  test('key images import at multiples of 64, at most 64 per session, within 4096 outputs', () => {
    const image = { keyImage: 'aa'.repeat(32), signature: 'bb'.repeat(64) }
    expect(validateKeyImageImport({ offset: 64, signedKeyImages: [image] }).offset).toBe(64)
    for (const offset of [1, -64, 4096, 0.5]) expect(() => validateKeyImageImport({ offset, signedKeyImages: [image] })).toThrow()
    expect(() => validateKeyImageImport({ offset: 0, signedKeyImages: Array(65).fill(image) })).toThrow()
  })
})

describe('the node is asked directly (its own height, the pending tx)', () => {
  test('a node that stops answering after the first sync marks the session unreachable, keeping its balance', async () => {
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); const port = gone.port; gone.stop(true)
    const service = new MoneroWatchService('/nonexistent')
    const session: any = { daemonUrl: `http://127.0.0.1:${port}`, daemonFingerprint: undefined, daemonHeight: 3_300_000, nodeAnsweredAt: Date.now(),
      status: { network: 'mainnet', address: ADDRESS, balanceAtomic: '84653050000', unlockedBalanceAtomic: '84653050000', walletHeight: 3_300_000,
        transactions: [], monitorReady: true, updatedAt: new Date().toISOString(), canSend: false, daemonHeight: 3_300_000 } }
    ;(service as any).session = session
    await service.probeNode(session)
    expect(session.status).toMatchObject({ monitorReady: false, error: WATCH_NODE_UNREACHABLE, balanceAtomic: '84653050000' })
    // The node back: its own height (not the wallet's) is the target again, and the error clears.
    const node = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ height: 3_300_123, status: 'OK' }) })
    try {
      session.daemonUrl = `http://127.0.0.1:${node.port}`
      await service.probeNode(session)
      expect(session.status).toMatchObject({ daemonHeight: 3_300_123, error: undefined })
      expect(await nodeHeight(session.daemonUrl, undefined)).toBe(3_300_123)
    } finally { node.stop(true) }
  })

  test('tx lookup against replies recorded from monerod 0.18.5.4 on regtest: unknown, pool, mined', () => {
    const txid = 'd85fdcbada672603349c8d7011b525cc45443762a25bfc2441e91f42929d9c6c'
    const ok = (spent: number[]) => ({ status: 'OK', spent_status: spent })
    expect(parseTxLookup(txid, { status: 'OK', missed_tx: [txid] }, ok([0, 0]), 2)).toEqual({ state: 'unknown', keyImages: ['unspent', 'unspent'] })
    expect(parseTxLookup(txid, { status: 'OK', txs: [{ tx_hash: txid, in_pool: true }] }, ok([2, 2]), 2)).toEqual({ state: 'pool', keyImages: ['pool', 'pool'] })
    expect(parseTxLookup(txid, { status: 'OK', txs: [{ tx_hash: txid, in_pool: false, block_height: 81 }] }, ok([1, 1]), 2)).toEqual({ state: 'mined', height: 81, keyImages: ['spent', 'spent'] })
    // Anything else is unreadable, never "unknown" (which could allow a discard).
    expect(() => parseTxLookup(txid, { status: 'OK' }, ok([0]), 1)).toThrow('could not be read')
    expect(() => parseTxLookup(txid, { status: 'BUSY', missed_tx: [txid] }, ok([0]), 1)).toThrow('could not be read')
    expect(() => parseTxLookup(txid, { status: 'OK', missed_tx: [txid] }, ok([0, 0]), 1)).toThrow('could not be read')
  })

  test('lookup posts /get_transactions and /is_key_image_spent to the configured node', async () => {
    const paths: string[] = []
    const txid = 'ab'.repeat(32), image = 'cd'.repeat(32)
    const result = await lookupTransaction('http://127.0.0.1:18081', undefined, txid, [image], async (url, init) => {
      paths.push(new URL(url).pathname + ' ' + init.body)
      return url.endsWith('/get_transactions') ? Response.json({ status: 'OK', missed_tx: [txid] }) : Response.json({ status: 'OK', spent_status: [0] })
    })
    expect(result).toEqual({ state: 'unknown', keyImages: ['unspent'] })
    expect(paths).toEqual([`/get_transactions {"txs_hashes":["${txid}"]}`, `/is_key_image_spent {"key_images":["${image}"]}`])
  })

  test('an unreadable daemon reply is never treated as a rejection', async () => {
    for (const body of ['x'.repeat(70000), 'not json']) {
      await expect(daemonRequest('http://127.0.0.1:18081', undefined, '/send_raw_transaction', {}, async () => new Response(body))).rejects.toThrow('The daemon reply could not be read')
    }
  })
})
