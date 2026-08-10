import { describe, expect, test } from 'bun:test'
import { getSolanaTokenBalance } from '../src/bun/solana-token'

const owner = '7RmhMArQM9E67YgYJX4vXuA5SydYV2NUWQwnRg14Q2kF'
const usdtMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'

describe('direct Solana token balance reconciliation', () => {
  test('sums every token account owned for the mint', async () => {
    const calls: any[] = []
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({
        result: {
          value: [
            { account: { data: { parsed: { info: { tokenAmount: { amount: '1000000', decimals: 6 } } } } } },
            { account: { data: { parsed: { info: { tokenAmount: { amount: '2500000', decimals: 6 } } } } } },
          ],
        },
      }), { status: 200 })
    }) as typeof fetch

    const result = await getSolanaTokenBalance(owner, usdtMint, 'https://solana.invalid', fetchMock)

    expect(result).toEqual({ amount: '3.5', decimals: 6 })
    expect(calls[0].method).toBe('getTokenAccountsByOwner')
    expect(calls[0].params[1]).toEqual({ mint: usdtMint })
  })
})
