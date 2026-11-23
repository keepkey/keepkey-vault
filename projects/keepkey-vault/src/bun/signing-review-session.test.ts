import { expect, test } from 'bun:test'
import { SigningReviewSessions } from './signing-review-session'

test('only the same sole emulator request and wallet epoch can read captured pixels', () => {
  const sessions = new SigningReviewSessions(); let reads = 0
  const frame = () => { reads++; return 'actual pixels' }
  sessions.begin('a', 'device', 1, true)
  expect(sessions.read('a', 'device', 1, true, frame)).toBe('actual pixels')
  for (const args of [['other', 'device', 1, true], ['a', 'other', 1, true], ['a', 'device', 2, true], ['a', 'device', 1, false]] as const) {
    expect(sessions.read(args[0], args[1], args[2], args[3], frame)).toBeNull()
  }
  expect(reads).toBe(1)
  sessions.end('a'); expect(sessions.read('a', 'device', 1, true, frame)).toBeNull()
})
test('concurrent requests suppress ambiguous frames until only one remains', () => {
  const sessions = new SigningReviewSessions()
  sessions.begin('a', 'device', 1, true); sessions.begin('b', 'device', 1, true)
  const forbidden = () => { throw new Error('must not capture an ambiguous frame') }
  expect(sessions.read('a', 'device', 1, true, forbidden)).toBeNull()
  expect(sessions.read('b', 'device', 1, true, forbidden)).toBeNull()
  sessions.end('a'); expect(sessions.read('b', 'device', 1, true, () => 'b frame')).toBe('b frame')
})
test('a new wallet epoch retires old sessions and hardware never opens frame access', () => {
  const sessions = new SigningReviewSessions()
  sessions.begin('old', 'same', 1, true); sessions.begin('new', 'same', 2, true)
  expect(sessions.read('old', 'same', 1, true, () => 'old')).toBeNull()
  expect(sessions.read('new', 'same', 2, true, () => 'new')).toBe('new')
  sessions.begin('hardware', 'physical', 3, false)
  expect(sessions.read('hardware', 'physical', 3, false, () => 'secret')).toBeNull()
})
