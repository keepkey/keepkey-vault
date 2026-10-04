import { describe, expect, test } from 'bun:test'

import { createClearSignFixturePlan } from '../src/bun/clearsign-fixture-plan'

const fingerprint = '11'.repeat(32)

describe('ClearSign promotion fixture plans', () => {
  test('generates complete deterministic EVM oracle vectors without copying decoded values into retained evidence', () => {
    const input = {
      chain: 'Ethereum' as const,
      payloadHex: `0x12345678${'00'.repeat(31)}2a`,
      transactionFingerprint: fingerprint,
      selectorOrDiscriminator: '0x12345678',
      decodedFields: { amount: 'super-secret-value' },
      effects: { recipient: 'private-recipient' },
      provenance: 'user-opt-in' as const,
      context: { chainId: 1, contract: '0x1111111111111111111111111111111111111111' },
    }
    const first = createClearSignFixturePlan(input)
    const second = createClearSignFixturePlan(input)
    expect(first).toEqual(second)
    expect(first.mutations.map(value => value.kind)).toEqual([
      'truncation', 'selector-or-discriminator', 'field-boundary', 'chain-or-contract',
    ])
    expect(JSON.stringify(first.positiveFixture)).not.toContain('super-secret-value')
    expect(JSON.stringify(first.positiveFixture)).not.toContain('private-recipient')
    expect(first.mutations[0].payloadHex.length).toBe(input.payloadHex.length - 2)
    expect(first.mutations[3].context.contract).not.toBe(input.context.contract)
  })

  test('generates a Solana privilege mutation and rejects a mismatched discriminator', () => {
    const plan = createClearSignFixturePlan({
      chain: 'Solana', payloadHex: `0x0102030405060708${'00'.repeat(8)}`,
      transactionFingerprint: fingerprint, selectorOrDiscriminator: '0102030405060708',
      decodedFields: { amount: 0 }, effects: {}, provenance: 'operator-reproduction',
      context: { accountPrivileges: [{ index: 0, signer: true, writable: true }] },
    })
    expect(plan.mutations.map(value => value.kind)).toContain('account-privilege')
    expect((plan.mutations[3].context.accountPrivileges as any[])[0].writable).toBe(false)
    expect(() => createClearSignFixturePlan({
      chain: 'Solana', payloadHex: '0x01020304ff', transactionFingerprint: fingerprint,
      selectorOrDiscriminator: 'deadbeef', decodedFields: {}, effects: {}, provenance: 'public-chain',
      context: { accountPrivileges: [{ writable: true }] },
    })).toThrow('does not begin')
  })
})
