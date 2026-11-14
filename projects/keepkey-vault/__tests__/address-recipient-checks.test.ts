import { describe, expect, test } from 'bun:test'
import { bech32 } from '@scure/base'
import { isBurnAddress, knownTokenContract, validateAddress } from '../src/shared/address-validation'
import { CHAINS } from '../src/shared/chains'

const chain = (id: string) => {
  const c = CHAINS.find(x => x.id === id)
  if (!c) throw new Error(`no chain ${id}`)
  return c
}

describe('isBurnAddress', () => {
  test('EVM zero and well-known burn sinks, any case', () => {
    for (const a of [
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dEaD',
      '0x000000000000000000000000000000000000dead',
      '0xdead000000000000000000000000000000000000',
      '0xdEAD000000000000000042069420694206942069',
    ]) expect(isBurnAddress(a)).toBe(true)
  })

  test('per-chain zero-payload burn addresses', () => {
    expect(isBurnAddress('1111111111111111111114oLvT2')).toBe(true) // BTC hash160 = 0
    expect(isBurnAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')).toBe(true) // Tron 0x41 + 0
    expect(isBurnAddress('11111111111111111111111111111111')).toBe(true) // Solana system program
    expect(isBurnAddress('1nc1nerator11111111111111111111111111111111')).toBe(true) // Solana incinerator
    expect(isBurnAddress('rrrrrrrrrrrrrrrrrrrrrhoLvTp')).toBe(true) // XRP ACCOUNT_ZERO
    expect(isBurnAddress('rrrrrrrrrrrrrrrrrrrrBZbvji')).toBe(true) // XRP ACCOUNT_ONE
    expect(isBurnAddress(bech32.encode('thor', bech32.toWords(new Uint8Array(20))))).toBe(true)
    expect(isBurnAddress(bech32.encode('cosmos', bech32.toWords(new Uint8Array(20))))).toBe(true)
  })

  test('real addresses are not burn addresses', () => {
    for (const a of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      'So11111111111111111111111111111111111111112',
      'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      '',
      'vitalik.eth',
    ]) expect(isBurnAddress(a)).toBe(false)
  })
})

describe('knownTokenContract', () => {
  test('names a token contract from the local catalog on its own chain', () => {
    expect(knownTokenContract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chain('base'))?.symbol).toBe('USDC')
  })
  test('is chain-scoped and ignores wallets and non-EVM chains', () => {
    expect(knownTokenContract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chain('ethereum'))).toBeUndefined()
    expect(knownTokenContract('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', chain('base'))).toBeUndefined()
    expect(knownTokenContract('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', chain('bitcoin'))).toBeUndefined()
  })
})

describe('ENS names', () => {
  // No resolver exists: a .eth name must not look like a valid recipient.
  test.each(['vitalik.eth', 'VITALIK.ETH', 'sub.name.eth'])('%s is refused with ensNotSupported', (name) => {
    for (const id of ['ethereum', 'base']) expect(validateAddress(name, chain(id))).toEqual({ valid: false, error: 'ensNotSupported' })
  })
})
