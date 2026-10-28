/** The shielded total this wallet will have once its broadcast shields,
 *  sends and unshields land. Until a scan catches up, the gap is shown as
 *  pending: a shield's coins are already spent from transparent, and a send's
 *  spent notes are marked spent before its change note is mined. */
export interface ExpectedShielded { total: number; at: number }

// ponytail: wall-clock expiry; a transaction unmined after 2 h has passed its
// expiry height (~40 blocks) and its inputs are spendable again.
export const EXPECTED_MAX_AGE_MS = 2 * 60 * 60 * 1000

/** Zatoshis still in flight, and the expectation if it still holds (null once
 *  the scanned total reached it, or it expired). */
export function inFlightShielded(expected: ExpectedShielded | null | undefined, scannedTotal: number, now: number): { pending: number; expected: ExpectedShielded | null } {
  if (!expected || now - expected.at >= EXPECTED_MAX_AGE_MS || scannedTotal >= expected.total) return { pending: 0, expected: null }
  return { pending: expected.total - scannedTotal, expected }
}
