import { describe, expect, it } from 'bun:test'

import { permit2Spender, permit2SpenderNameMetadata } from '../src/bun/permit2-spender-name'

// Uniswap's request from the owner's Vault log (2026-04-10).
const UNISWAP = {
  primaryType: 'PermitSingle',
  domain: { name: 'Permit2', chainId: '1', verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' },
  message: {
    details: { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', amount: '1461501637330902918203684832716283019655932542975', expiration: '1778393946', nonce: '0' },
    spender: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
    sigDeadline: '1775803746',
  },
}

describe('Permit2 spender names', () => {
  it('recognizes only a canonical Permit2 PermitSingle', () => {
    expect(permit2Spender(UNISWAP)).toEqual({ chainId: 1, spender: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' })
    expect(permit2Spender({ ...UNISWAP, primaryType: 'PermitBatch' })).toBeUndefined()
    expect(permit2Spender({ ...UNISWAP, domain: { ...UNISWAP.domain, verifyingContract: '0x1111111111111111111111111111111111111111' } })).toBeUndefined()
    expect(permit2Spender({ ...UNISWAP, message: { ...UNISWAP.message, spender: 'nope' } })).toBeUndefined()
  })

  it('never asks the service before 7.16 or about an address outside the reviewed catalog', async () => {
    // Both return before any network call: there is nothing to look up.
    expect(await permit2SpenderNameMetadata(UNISWAP, '7.15.0')).toBeUndefined()
    const unknown = { ...UNISWAP, message: { ...UNISWAP.message, spender: '0x2222222222222222222222222222222222222222' } }
    expect(await permit2SpenderNameMetadata(unknown, '7.16.0')).toBeUndefined()
  })
})
