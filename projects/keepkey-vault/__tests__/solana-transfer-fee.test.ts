import { describe, expect, test } from 'bun:test'
import { SOLANA_LAMPORTS_PER_SIGNATURE, solanaTransferLamportsForAmount } from '../src/bun/txbuilder/solana'

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
})
