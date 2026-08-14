/**
 * getEvmBalance must never report an RPC failure as a zero balance — that is
 * what produced "Build preview failed: Insufficient ETH: need 1.650208, have 0"
 * on funded accounts when the public RPC hiccuped.
 *
 * Run: bun test __tests__/evm-balance-fetch.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { getEvmBalance } from '../src/bun/evm-rpc'

const ORIG_FETCH = globalThis.fetch
const ADDR = '0x1111111111111111111111111111111111111111'
const URL = 'https://rpc.example/'

function mockFetch(jsonResponse: any) {
  globalThis.fetch = (async () => new Response(JSON.stringify(jsonResponse), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as any
}

describe('getEvmBalance', () => {
  afterEach(() => { globalThis.fetch = ORIG_FETCH })

  test('decodes a real balance', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, result: '0x16e6b76ecd820000' })
    expect(await getEvmBalance(URL, ADDR)).toBe(1650208000000000000n)
  })

  test('a genuinely empty account is still 0', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, result: '0x0' })
    expect(await getEvmBalance(URL, ADDR)).toBe(0n)
  })

  test('throws (does NOT return 0) when the RPC omits the result', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, result: null })
    expect(getEvmBalance(URL, ADDR)).rejects.toThrow('returned no result')
  })

  test('throws when the RPC returns an error', async () => {
    mockFetch({ jsonrpc: '2.0', id: 1, error: { message: 'rate limit exceeded' } })
    expect(getEvmBalance(URL, ADDR)).rejects.toThrow('rate limit exceeded')
  })
})
