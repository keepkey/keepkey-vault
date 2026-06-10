/**
 * Pins the SPL-token build contract that the swap path depends on.
 *
 * Pioneer's /swap/available-assets carries NO SPL tokens (verified live: the
 * only Solana entry is native SOL.SOL). So when a user swaps USDT-on-Solana the
 * backend decimals lookup (`getSwapAssets().find(a => a.caip === fromCaip)`)
 * misses, and the only source of truth is the picker asset's `decimals`, which
 * swap.ts now forwards as `params.tokenDecimals`. Without it buildTx throws
 * "tokenDecimals required for SPL token transfers" and the preview dead-ends.
 *
 * Run: bun test __tests__/solana-spl-decimals.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { buildTx } from '../src/bun/txbuilder'
import { CHAINS } from '../src/shared/chains'

const solana = CHAINS.find(c => c.id === 'solana')!
const fromAddress = 'GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ'
const toAddress = '11111111111111111111111111111111'
// USDT mint on Solana (6 decimals).
const usdtMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const usdtCaip = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${usdtMint}`

describe('Solana SPL token build', () => {
  test('encodes the amount in token base units and forwards decimals to Pioneer', async () => {
    let tokenParams: any
    const pioneer = {
      BuildSolanaTransferToken: async (params: any) => {
        tokenParams = params
        return { data: { serialized: 'spl-transfer-raw' } }
      },
    }

    const result = await buildTx(pioneer, solana, {
      chainId: 'solana',
      to: toAddress,
      amount: '100',
      fromAddress,
      caip: usdtCaip,
      tokenDecimals: 6,
    })

    // 100 USDT at 6 decimals = 100_000_000 base units — not 100 * 10^9 (SOL).
    expect(tokenParams.amount).toBe('100000000')
    expect(tokenParams.decimals).toBe(6)
    expect(tokenParams.token).toBe(usdtMint)
    expect(result.unsignedTx.rawTx).toBe('spl-transfer-raw')
  })

  test('throws when decimals are absent — never guesses the scale', async () => {
    const pioneer = {
      BuildSolanaTransferToken: async () => ({ data: { serialized: 'unreachable' } }),
    }

    await expect(
      buildTx(pioneer, solana, {
        chainId: 'solana',
        to: toAddress,
        amount: '100',
        fromAddress,
        caip: usdtCaip,
        // tokenDecimals intentionally omitted — reproduces the original dead-end.
      }),
    ).rejects.toThrow(/tokenDecimals required for SPL token transfers/)
  })
})
