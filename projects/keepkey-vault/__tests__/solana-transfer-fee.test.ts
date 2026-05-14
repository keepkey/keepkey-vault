import { describe, expect, test } from 'bun:test'
import { buildTx } from '../src/bun/txbuilder'
import { SOLANA_LAMPORTS_PER_SIGNATURE, solanaTransferLamportsForAmount } from '../src/bun/txbuilder/solana'
import { CHAINS } from '../src/shared/chains'

const solana = CHAINS.find(c => c.id === 'solana')!
const solanaAddress = '11111111111111111111111111111111'

describe('solanaTransferLamportsForAmount', () => {
  test('converts native SOL amount to lamports without max adjustment', () => {
    expect(solanaTransferLamportsForAmount('0.23438859')).toBe(234388590n)
  })

  test('reserves the signature fee for native SOL max swaps', () => {
    expect(solanaTransferLamportsForAmount('0.23438859', true)).toBe(234388590n - SOLANA_LAMPORTS_PER_SIGNATURE)
  })

  test('rejects max swaps that cannot cover the Solana fee', () => {
    expect(() => solanaTransferLamportsForAmount('0.000005', true)).toThrow(/network fee/i)
  })

  test('truncates to Solana native precision', () => {
    expect(solanaTransferLamportsForAmount('1.1234567899')).toBe(1123456789n)
  })

  test('regular native SOL max send uses live balance instead of stale cached balance', async () => {
    let transferParams: any
    const pioneer = {
      GetBalanceAddressByNetwork: async () => ({ data: { balance: '0.23438859' } }),
      BuildSolanaTransfer: async (params: any) => {
        transferParams = params
        return { data: { serialized: 'solana-max-transfer' } }
      },
    }

    const result = await buildTx(pioneer, solana, {
      chainId: 'solana',
      to: solanaAddress,
      amount: '0',
      isMax: true,
      fromAddress: solanaAddress,
      nativeBalance: '999',
    })

    expect(transferParams.amount).toBe('234383590')
    expect(result.fee).toBe('0.000005')
  })
})
