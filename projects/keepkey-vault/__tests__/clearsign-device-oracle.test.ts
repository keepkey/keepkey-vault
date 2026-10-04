import { describe, expect, test } from 'bun:test'

import { runClearSignDeviceOracle } from '../src/bun/clearsign-device-oracle'
import { createClearSignFixturePlan } from '../src/bun/clearsign-fixture-plan'

function plan() {
  return createClearSignFixturePlan({
    chain: 'Ethereum', payloadHex: `0x12345678${'00'.repeat(31)}2a`, transactionFingerprint: '11'.repeat(32),
    selectorOrDiscriminator: '12345678', decodedFields: { amount: 42 }, effects: {}, provenance: 'operator-reproduction',
    context: { chainId: 1, contract: '0x1111111111111111111111111111111111111111' },
  })
}

describe('ClearSign real-device oracle evidence', () => {
  test('turns ordered device display/rejection evidence into a promotion-ready transcript', async () => {
    const result = await runClearSignDeviceOracle({
      plan: plan(), firmwareVersion: '7.16.0', artifactHash: 'aa'.repeat(32),
      execute: async vector => vector.kind === 'positive'
        ? { outcome: 'displayed', displayHash: '01'.repeat(32) }
        : vector.kind === 'field-boundary'
          ? { outcome: 'displayed', displayHash: '02'.repeat(32) }
          : { outcome: 'rejected' },
    })
    expect(result.deviceOracle.passed).toBe(true)
    expect(result.deviceOracle.transcriptHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.mutations.every(value => value.observed === value.expected)).toBe(true)
    expect(JSON.stringify(result.transcript)).not.toContain('0x12345678')
  })

  test('fails closed when a mutation displays the same screens or execution fails', async () => {
    const result = await runClearSignDeviceOracle({
      plan: plan(), firmwareVersion: '7.16.0', artifactHash: 'aa'.repeat(32),
      execute: async vector => vector.kind === 'selector-or-discriminator'
        ? { outcome: 'failed', errorClass: 'TRANSPORT_LOST' }
        : { outcome: 'displayed', displayHash: '01'.repeat(32) },
    })
    expect(result.deviceOracle.passed).toBe(false)
    expect(result.mutations.some(value => value.observed === 'unexpected-pass')).toBe(true)
  })
})
