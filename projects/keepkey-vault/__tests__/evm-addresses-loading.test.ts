import { beforeAll, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

let results: Record<string, any>
beforeAll(() => {
  const child = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./support/evm-addresses-loading.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  })
  if (child.exitCode) throw new Error(child.stderr.toString() || child.stdout.toString())
  results = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!)
})

test('disabled non-EVM views do not load or expose another owner snapshot', () => {
  expect(results.disabled).toEqual({ reads: 0, loaded: false, address: null })
  expect(results.disabledAgain).toEqual({ loaded: false, address: null })
  expect(results.disabledMutationCalls).toBe(0)
})
test('initial owner loading is distinct from a settled missing balance', () => {
  expect(results.initialPending).toEqual({ reads: 1, loaded: false, address: null })
  expect(results.initialSettled).toEqual({ loaded: true, address: 'owner-a' })
})
test('duplicate refreshes coalesce and an intervening push beats their old result', () => {
  expect(results.coalesced).toBe(2)
  expect(results.pushWins).toEqual({ loaded: true, address: 'owner-newer-push' })
})
test('a re-enabled scope rejects an earlier generation response', () => {
  expect(results.generationWins).toEqual({ loaded: true, address: 'owner-reenabled' })
})
test('explicit wallet purge clears old owner data despite an in-flight read', () => {
  expect(results.purged).toEqual({ loaded: true, address: null })
})
test('a failed refresh retains the known owner snapshot and unmount drains safely', () => {
  expect(results.failureKeepsSnapshot).toEqual({ loaded: true, address: 'owner-current', failure: 'Synthetic device busy' })
  expect(results.unmounted).toBe(true)
  expect(results.unmountedErrors).toEqual(['[useEvmAddresses] addIndex failed: Current add failure'])
})
test('purge retires a pending add spinner and both old mutation replies', () => {
  expect(results.addPending).toBe(true)
  expect(results.purgedMutationPending).toEqual({ loaded: true, address: null, loading: false })
  expect(results.purgedMutations).toEqual({ loaded: true, address: null, loading: false })
})
test('a newer backend push beats old add and remove responses', () => {
  expect(results.pushBeatsMutations).toEqual({ loaded: true, address: 'owner-newer-mutation-push', loading: false })
})
test('disabled mutations cannot leak into a re-enabled owner or clear its active spinner', () => {
  expect(results.disabledMutationPending).toEqual({ loaded: false, address: null, loading: false })
  expect(results.disabledSelectionCalls).toBe(1)
  expect(results.reenabledMutations).toEqual({ loaded: true, address: 'owner-after-mutation-reenable', loading: true, errors: [] })
  expect(results.currentMutation).toEqual({ loaded: true, address: 'owner-current-add', loading: false })
})
test('retired mutation failures are silent while a current failure releases loading', () => {
  expect(results.retiredErrors).toEqual({ loaded: true, address: null, loading: false, errors: [] })
  expect(results.currentError).toEqual({ loading: false, errors: ['[useEvmAddresses] addIndex failed: Current add failure'] })
})
