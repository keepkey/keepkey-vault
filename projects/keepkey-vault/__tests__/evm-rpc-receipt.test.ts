/**
 * Tests for getTxReceiptOnce — the single-shot EVM receipt poll used by
 * swap-tracker's revert detection. Because the function intentionally swallows
 * all errors as null (so transient RPC failures stay in the "still pending"
 * state instead of mis-flagging swaps as failed), the boundary between
 * "no receipt yet", "success", "revert", and "RPC threw" is exactly what we
 * want to lock in tests.
 *
 * Run: bun test __tests__/evm-rpc-receipt.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { getTxReceiptOnce } from '../src/bun/evm-rpc'

const ORIG_FETCH = globalThis.fetch
const TX = '0xabc'
const URL = 'https://rpc.example/'

function mockFetch(jsonResponse: any, opts?: { rejectWith?: Error }) {
  globalThis.fetch = (async () => {
    if (opts?.rejectWith) throw opts.rejectWith
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
}

describe('getTxReceiptOnce', () => {
  beforeEach(() => { /* reset between tests */ })
  afterEach(() => { globalThis.fetch = ORIG_FETCH })

  test('returns null when the receipt is not yet available (RPC returns null)', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, result: null })
    const r = await getTxReceiptOnce(URL, TX)
    expect(r).toBeNull()
  })

  test('decodes a successful receipt (status 0x1)', async () => {
    mockFetch({
      jsonrpc: '2.0', id: 1,
      result: { status: '0x1', gasUsed: '0x5208', blockNumber: '0x1f4' },
    })
    const r = await getTxReceiptOnce(URL, TX)
    expect(r).not.toBeNull()
    expect(r!.status).toBe(true)
    expect(r!.gasUsed).toBe(21000n)
    expect(r!.blockNumber).toBe(500)
  })

  test('decodes a reverted receipt (status 0x0) — the case driving revert detection', async () => {
    mockFetch({
      jsonrpc: '2.0', id: 1,
      result: { status: '0x0', gasUsed: '0x5208', blockNumber: '0x2710' },
    })
    const r = await getTxReceiptOnce(URL, TX)
    expect(r).not.toBeNull()
    expect(r!.status).toBe(false)
    expect(r!.blockNumber).toBe(10000)
  })

  test('returns null when the RPC throws (transient — caller will poll again)', async () => {
    mockFetch(undefined, { rejectWith: new Error('connect ECONNRESET') })
    const r = await getTxReceiptOnce(URL, TX)
    // Critical: a thrown fetch must NOT be propagated. The contract is
    // "null until we have a definitive answer" so the swap stays pending
    // through transient outages instead of being mis-marked failed.
    expect(r).toBeNull()
  })

  test('returns null on JSON-RPC error (e.g. RPC method not supported)', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, error: { message: 'method not found', code: -32601 } })
    const r = await getTxReceiptOnce(URL, TX)
    expect(r).toBeNull()
  })

  test('handles missing gasUsed/blockNumber gracefully (defensive)', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, result: { status: '0x1' } })
    const r = await getTxReceiptOnce(URL, TX)
    expect(r).not.toBeNull()
    expect(r!.status).toBe(true)
    expect(r!.gasUsed).toBe(0n)
    expect(r!.blockNumber).toBe(0)
  })
})
