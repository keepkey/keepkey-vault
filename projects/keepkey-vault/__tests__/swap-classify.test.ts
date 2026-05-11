/**
 * Tests for classifySwapOutcome — the pure function that translates a Midgard
 * /v2/actions response into a truthful status + outbound chain.
 *
 * Fixtures are real captured responses from mainnet midgard (Maya & THORChain).
 * Replay tests pin behavior so future regressions to "refund displayed as
 * completed" or "explorer URL keyed on toAsset" surface immediately.
 *
 * Run: bun test __tests__/swap-classify.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { classifySwapOutcome } from '../src/bun/swap/classify'
import refundEthToZec from './fixtures/swap/maya-refund-eth-to-zec-7ce1.json'
import completedZecToUsdc from './fixtures/swap/maya-completed-zec-to-usdc-a926.json'

describe('classifySwapOutcome', () => {
  // ── Failure 2: ETH→ZEC refund (the live in-flight swap our UI mis-rendered)
  test('Maya refund (ETH→ZEC quote, refunded as ETH) is classified as refunded with source-chain outbound', () => {
    const result = classifySwapOutcome(refundEthToZec as any)

    expect(result.status).toBe('refunded')
    // The "outbound" of a refund is the source asset returning home.
    expect(result.outboundAsset).toBe('ETH.ETH')
    expect(result.outboundChainId).toBe('ethereum')   // ← keys explorer URL
    // The hash users see in our UI as "ZEC outbound" is actually an ETH refund tx.
    expect(result.outboundTxid?.toUpperCase()).toBe('633F6EF365333E51CA5D315DAF787507663F6C8FC371C511C99D4B9266E5F6DD')
    // 4218210 base units = 0.0421821 ETH (= 0.0429321 quoted minus 0.00075 fee)
    expect(result.outboundAmount).toBe('4218210')
    expect(result.inboundTxid?.toUpperCase()).toBe('7CE15ACD233EA4DFEC386B45BBB347906E41E366D9C4DB95E735ED88F87BD42D')
    // Reason is captured even when Midgard mangles the encoding.
    expect(result.refundReason).not.toBeNull()
  })

  // ── Known-good: ZEC→USDC native swap with a real on-chain outbound. Proves
  // (a) status='completed', (b) outbound chain id is derived from the action's
  // out asset (ETH for the USDC delivery) — NOT from a stale toAsset hint.
  test('Maya completed swap routes outbound chain to the action.out asset', () => {
    const result = classifySwapOutcome(completedZecToUsdc as any)

    expect(result.status).toBe('completed')
    expect(result.outboundAsset).toBe('ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48')
    expect(result.outboundChainId).toBe('ethereum')
    expect(result.refundReason).toBeNull()
    expect(result.outboundTxid).toBeTruthy()
    expect(result.inboundTxid).toBeTruthy()
  })

  // ── Edge cases ────────────────────────────────────────────────
  test('empty response classifies as unknown', () => {
    expect(classifySwapOutcome(null).status).toBe('unknown')
    expect(classifySwapOutcome(undefined).status).toBe('unknown')
    expect(classifySwapOutcome({ actions: [] }).status).toBe('unknown')
  })

  test('pending swap (no outbound leg) classifies as pending without an explorer link', () => {
    const result = classifySwapOutcome({
      actions: [{
        type: 'swap',
        status: 'pending',
        in: [{ txID: 'AABBCC', coins: [{ amount: '100000000', asset: 'BTC.BTC' }] }],
        out: [],
      }],
    })
    expect(result.status).toBe('pending')
    expect(result.outboundTxid).toBeNull()
    expect(result.outboundChainId).toBeNull()
  })

  test('swap action with success status but no outbound leg falls back to pending', () => {
    // Defensive — Midgard occasionally lags between 'pending' and emitting
    // the out leg. Better to render "pending" than a broken empty completion.
    const result = classifySwapOutcome({
      actions: [{
        type: 'swap',
        status: 'success',
        in: [{ txID: 'AA', coins: [{ amount: '1', asset: 'BTC.BTC' }] }],
      }],
    })
    expect(result.status).toBe('pending')
  })

  test('outbound chain id is null when asset prefix is unknown — caller suppresses explorer link', () => {
    const result = classifySwapOutcome({
      actions: [{
        type: 'swap',
        status: 'success',
        in: [{ txID: 'IN', coins: [{ amount: '1', asset: 'UNKNOWN.X' }] }],
        out: [{ txID: 'OUT', coins: [{ amount: '1', asset: 'NEWCHAIN.NEWASSET' }] }],
      }],
    })
    expect(result.status).toBe('completed')
    expect(result.outboundAsset).toBe('NEWCHAIN.NEWASSET')
    expect(result.outboundChainId).toBeNull()
  })
})
