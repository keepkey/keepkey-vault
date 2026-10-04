import { describe, expect, test } from 'bun:test'

import { replayLegacyClearSignRows } from '../src/bun/clearsign-legacy-replay'

// Minimal legacy Solana transaction: one signature plus a valid message with
// one signer/account and no instructions.
const solana = Buffer.concat([
  Buffer.from([1]), Buffer.alloc(64), Buffer.from([1, 0, 0, 1]), Buffer.alloc(32), Buffer.alloc(32), Buffer.from([0]),
]).toString('base64')

describe('legacy ClearSign acceptance replay', () => {
  test('classifies historical envelopes without returning their raw values', () => {
    const secretAmount = 'feed'.repeat(32)
    const report = replayLegacyClearSignRows([
      { id: 1, timestamp: 1000, route: '/eth/sign-transaction', status: 200, requestBody: JSON.stringify({
        chainId: 1, to: '0x1111111111111111111111111111111111111111', data: `0xa9059cbb${secretAmount}`,
      }) },
      { id: 2, timestamp: 2000, route: '/solana/sign-transaction', status: 408, requestBody: JSON.stringify({ raw_tx: solana }) },
      { id: 3, timestamp: 3000, route: '/unknown', status: 200, requestBody: '{}' },
    ])
    expect(report.classifiedRows).toBe(2)
    expect(report.coverage.totalRequests).toBe(2)
    expect(report.coverage.byOutcome.signed).toBe(1)
    expect(report.coverage.byOutcome['timed-out']).toBe(1)
    expect(report.skippedByReason['unsupported-route']).toBe(1)
    expect(JSON.stringify(report)).not.toContain(secretAmount)
    expect(JSON.stringify(report)).not.toContain(solana)
  })
})
