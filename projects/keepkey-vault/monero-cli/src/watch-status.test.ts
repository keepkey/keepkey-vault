import { describe, expect, test } from 'bun:test'
import { DigestWalletRpc } from './digest'
import { WATCH_NODE_UNREACHABLE, WATCH_SCANNING, validateKeyImageImport, validateWalletStatus } from './protocol'
import { refreshFailure, verifyDaemon } from './wallet'

// Loopback fakes only: no wallet-rpc, daemon or network beyond 127.0.0.1.
const ADDRESS = '44jKQv6ZKMd5ecLLmkNJGi7azgSptEq8ki7TFiat1TfLfdDQ1tQ7ZYa3cRh7X2uRwvLDjddWh97ajeyhR2seKSECQeDx1WR'

describe('a long scan is not an unreachable node', () => {
  test('a wallet-rpc call that runs out of time reports a timeout (it used to read as "unavailable")', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) })
    const rpc = new DigestWalletRpc(server.port, 'user', 'pass')
    try {
      const error = await rpc.call('refresh', {}, 150).catch(e => e)
      expect(error.message).toBe('Monero wallet RPC timed out')
      expect(refreshFailure(error)).toBe(WATCH_SCANNING)
    } finally { rpc.close(); server.stop(true) }
  })

  test('a refused connection or wallet-rpc failure is the node being unreachable', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = server.port; server.stop(true)
    const rpc = new DigestWalletRpc(port, 'user', 'pass')
    try {
      const error = await rpc.call('refresh', {}, 2000).catch(e => e)
      expect(error.message).toBe('The local Monero wallet RPC is unavailable')
      expect(refreshFailure(error)).toBe(WATCH_NODE_UNREACHABLE)
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
