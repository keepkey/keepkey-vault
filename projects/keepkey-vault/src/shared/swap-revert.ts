/**
 * Pure receipt → swap-status decision used by the EVM revert detector.
 *
 * Lives here (shared/, no I/O imports) instead of in swap-tracker.ts so the
 * decision is unit-testable without dragging the whole bun + sqlite stack
 * into the test runner. swap-tracker.ts re-exports for the runtime path.
 */
import type { SwapTrackingStatus } from './types'

export type RevertDecision = { status: 'failed'; error: string; blockNumber: number }

/** Given the current swap status and a one-shot receipt result, decide whether
 *  the swap should now be marked failed (and what the user-facing error says).
 *
 *  - Already-terminal swaps return null (idempotent).
 *  - No receipt yet (null) returns null — caller should keep polling.
 *  - Successful receipt (status === true) returns null — let normal pipeline take over.
 *  - Reverted receipt (status === false) returns the failure decision. */
export function decideRevertOutcome(
  currentStatus: SwapTrackingStatus,
  receipt: { status: boolean; blockNumber: number } | null,
): RevertDecision | null {
  if (currentStatus === 'failed' || currentStatus === 'completed' || currentStatus === 'refunded') return null
  if (!receipt) return null
  if (receipt.status !== false) return null
  return {
    status: 'failed',
    error: 'Transaction reverted on-chain — gas spent, asset NOT delivered. Common causes: insufficient allowance, slippage tripped, or contract reverted.',
    blockNumber: receipt.blockNumber,
  }
}
