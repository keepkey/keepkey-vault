/**
 * getEvmBalance must never report an RPC failure as a zero balance — that is
 * what produced "Build preview failed: Insufficient ETH: need 1.650208, have 0"
 * on funded accounts when the public RPC hiccuped.
 *
 * Run: bun test __tests__/evm-balance-fetch.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { getEvmBalance } from '../src/bun/evm-rpc'
import { buildEvmTx } from '../src/bun/txbuilder/evm'
import { CHAINS } from '../src/shared/chains'

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

// The unit above only covers the RPC leaf. These drive the builder's whole
// RPC → Pioneer → throw ladder, which is where the misleading "have 0" came
// from. No rpcUrl is passed, so the Pioneer branch is the one under test.
const ethereum = CHAINS.find(c => c.id === 'ethereum')!
const TO = '0x000000000000000000000000000000000000dEaD'

const pioneer = (balanceResponse: any) => ({
  GetGasPriceByNetwork: async () => ({ data: '1' }),
  GetNonceByNetwork: async () => ({ data: { nonce: 7 } }),
  GetBalanceAddressByNetwork: async () => balanceResponse,
})

describe('buildEvmTx balance fallback', () => {
  test('a malformed Pioneer response is unverifiable, not zero', async () => {
    // HTTP 200 with no balance field. `|| '0'` used to turn this into an
    // empty wallet and produce "Insufficient funds: balance 0".
    await expect(buildEvmTx(pioneer({ data: {} }), ethereum, {
      to: TO, amount: '0.01', fromAddress: ADDR,
    })).rejects.toThrow('Unable to verify')
  })

  test('an empty-string balance is unverifiable too', async () => {
    await expect(buildEvmTx(pioneer({ data: { balance: '  ' } }), ethereum, {
      to: TO, amount: '0.01', fromAddress: ADDR,
    })).rejects.toThrow('Unable to verify')
  })

  test('a thrown Pioneer call is unverifiable', async () => {
    const throwing = {
      GetGasPriceByNetwork: async () => ({ data: '1' }),
      GetNonceByNetwork: async () => ({ data: { nonce: 7 } }),
      GetBalanceAddressByNetwork: async () => { throw new Error('502 bad gateway') },
    }
    await expect(buildEvmTx(throwing, ethereum, {
      to: TO, amount: '0.01', fromAddress: ADDR,
    })).rejects.toThrow('Unable to verify')
  })

  test('a VERIFIED zero balance fails the insufficient-funds check', async () => {
    // Distinct from the cases above: Pioneer answered, the account really is
    // empty. The old `&& nativeBalance > 0n` guard let this build a send.
    await expect(buildEvmTx(pioneer({ data: { balance: '0' } }), ethereum, {
      to: TO, amount: '0.01', fromAddress: ADDR,
    })).rejects.toThrow('Insufficient funds')
  })

  test('a verified balance that covers the send still builds', async () => {
    const tx = await buildEvmTx(pioneer({ data: { balance: '1' } }), ethereum, {
      to: TO, amount: '0.01', fromAddress: ADDR,
    })
    expect(BigInt(tx.value)).toBe(10_000_000_000_000_000n)
  })
})
