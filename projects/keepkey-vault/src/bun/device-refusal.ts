export interface DeviceFailure { code?: number; message?: string; at: number }

/**
 * Firmware sends Failure code 4 (ActionCancelled) both when the user rejects on
 * the button ("Signing cancelled by user") and when the device itself refuses
 * ("Arbitrary contract data signing disabled by policy"). hdwallet turns every
 * code 4 into a bare ActionCancelled, so the device's own text is the only way
 * to tell them apart. Returns that text for a refusal, null for a real cancel.
 */
export function deviceRefusalText(failure: DeviceFailure | null, since: number): string | null {
  if (!failure || failure.at < since || failure.code !== 4 || !failure.message) return null
  return /cancel/i.test(failure.message) ? null : failure.message
}
