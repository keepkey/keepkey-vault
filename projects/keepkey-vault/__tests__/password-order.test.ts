import { expect, test } from 'bun:test'
import { orderedPasswordProfiles } from '../src/shared/password-inventory'

test('new passwords and staged replacements sit above older passwords', () => {
  const older = { account: 'Old account', slot: 3 }
  const newest = { account: 'New account', slot: 6 }
  const previouslyRevised = { account: 'Reviewed account', slot: 5 }
  const profiles = [older, previouslyRevised, newest]
  expect(orderedPasswordProfiles(profiles)).toEqual([newest, previouslyRevised, older])
  expect(profiles).toEqual([older, previouslyRevised, newest])

  const nextReplacement = { ...older, pendingSlot: 7 }
  expect(orderedPasswordProfiles([newest, previouslyRevised, nextReplacement])[0]).toBe(nextReplacement)
  const verified = { ...older, slot: 7 }
  expect(orderedPasswordProfiles([newest, previouslyRevised, verified])[0]).toBe(verified)
})
