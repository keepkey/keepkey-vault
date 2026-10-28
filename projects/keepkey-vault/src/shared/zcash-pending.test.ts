import { expect, test } from 'bun:test'
import { inFlightShielded, EXPECTED_MAX_AGE_MS } from './zcash-pending'

const now = 1_000_000_000

test('a shield is pending until the scanned total reaches the expected total', () => {
  // 0.105 ZEC shielded from transparent; the scan has not found the note yet.
  expect(inFlightShielded({ total: 10537322, at: now }, 0, now)).toEqual({ pending: 10537322, expected: { total: 10537322, at: now } })
  expect(inFlightShielded({ total: 10537322, at: now }, 10537322, now)).toEqual({ pending: 0, expected: null })
})

test("a send's change is pending after its spent note is marked spent", () => {
  // 0.105 note spent, 0.02 paid + 0.0001 fee: 0.0852 change still to be found.
  expect(inFlightShielded({ total: 8527322, at: now }, 0, now).pending).toBe(8527322)
})

test('nothing in flight, or expired: no pending', () => {
  expect(inFlightShielded(null, 5, now)).toEqual({ pending: 0, expected: null })
  expect(inFlightShielded({ total: 9, at: now - EXPECTED_MAX_AGE_MS }, 0, now)).toEqual({ pending: 0, expected: null })
})
