/**
 * Tests for decideRevertOutcome — the pure receipt → swap-status mapping
 * extracted from swap-tracker.ts:detectEvmRevert.
 *
 * The original detectEvmRevert mixed RPC fetches, in-memory mutation, DB writes,
 * and decision logic. Splitting the decision out lets us pin the exact boundary:
 * an EVM receipt with status=false must flip the swap to "failed" with a
 * user-facing error, but only when the swap isn't already terminal.
 *
 * Run: bun test __tests__/swap-revert.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { decideRevertOutcome } from '../src/shared/swap-revert'

describe('decideRevertOutcome', () => {
  const revertedReceipt = { status: false, blockNumber: 12345 }
  const successReceipt = { status: true, blockNumber: 12345 }

  test('reverted receipt + pending swap → failed decision', () => {
    const d = decideRevertOutcome('pending', revertedReceipt)
    expect(d).not.toBeNull()
    expect(d!.status).toBe('failed')
    expect(d!.blockNumber).toBe(12345)
    expect(d!.error).toMatch(/reverted on-chain/i)
  })

  test('reverted receipt + confirming swap → failed decision', () => {
    // The "lied to with waiting for confirmations" bug: tx was confirming
    // status from Pioneer perspective, but on-chain it reverted.
    const d = decideRevertOutcome('confirming', revertedReceipt)
    expect(d).not.toBeNull()
    expect(d!.status).toBe('failed')
  })

  test('successful receipt → null (let normal pipeline take over)', () => {
    expect(decideRevertOutcome('pending', successReceipt)).toBeNull()
    expect(decideRevertOutcome('confirming', successReceipt)).toBeNull()
  })

  test('null receipt (not mined yet) → null', () => {
    expect(decideRevertOutcome('pending', null)).toBeNull()
  })

  test('idempotent: already failed → null', () => {
    expect(decideRevertOutcome('failed', revertedReceipt)).toBeNull()
  })

  test('idempotent: already completed → null', () => {
    // Even an apparent revert receipt can't unset a completed swap — would be
    // a state regression, so the pure decision must refuse to act.
    expect(decideRevertOutcome('completed', revertedReceipt)).toBeNull()
  })

  test('idempotent: refunded → null', () => {
    expect(decideRevertOutcome('refunded', revertedReceipt)).toBeNull()
  })

  test('error message names the common causes', () => {
    // The user-facing copy is part of the contract — UX regressions here
    // (e.g. dropping the allowance/slippage hints) should be loud.
    const d = decideRevertOutcome('pending', revertedReceipt)
    expect(d!.error).toMatch(/allowance/i)
    expect(d!.error).toMatch(/slippage/i)
    expect(d!.error).toMatch(/gas spent/i)
  })
})
