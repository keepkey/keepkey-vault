import { expect, test } from 'bun:test'
import { unresolvedShields, PENDING_SHIELD_MAX_AGE_MS } from './zcash-pending'

const now = 1_000_000_000
const shield = (amountZat: number, afterHeight = 100, at = now) => ({ txid: `t${amountZat}`, amountZat, afterHeight, at })

test('a shield stays pending until a later note of its exact value appears', () => {
  const pending = [shield(10537322)]
  expect(unresolvedShields(pending, [], now)).toEqual(pending)
  // Same value but in a block before the broadcast: an older note, not this shield.
  expect(unresolvedShields(pending, [{ value: 10537322, block_height: 100 }], now)).toEqual(pending)
  expect(unresolvedShields(pending, [{ value: 10537321, block_height: 101 }], now)).toEqual(pending)
  expect(unresolvedShields(pending, [{ value: '10537322', block_height: '101' }], now)).toEqual([])
})

test('one note settles one shield, and old shields expire', () => {
  const twins = [shield(5000), shield(5000)]
  expect(unresolvedShields(twins, [{ value: 5000, block_height: 101 }], now)).toHaveLength(1)
  expect(unresolvedShields([shield(5000, 100, now - PENDING_SHIELD_MAX_AGE_MS)], [], now)).toEqual([])
})
