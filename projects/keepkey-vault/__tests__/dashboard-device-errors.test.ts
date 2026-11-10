import { expect, test } from 'bun:test'

test('Dashboard retains balances for local device failures and still reports provider outages', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/dashboard-device-errors.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  const result = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
  expect(result.cachedBusy).toEqual({ outage: false, balance: true, refreshing: false })
  expect(result.cachedLocked).toEqual({ outage: false, balance: true, refreshing: false })
  expect(result.cachedCacheMiss).toEqual({ outage: false, balance: true, refreshing: false })
  expect(result.coldBusy).toEqual({ outage: false, hasUnknown: true, refreshing: false })
  expect(result.coldCacheMiss).toEqual({ outage: false, hasUnknown: true, refreshing: false })
  expect(result.provider).toEqual({ outage: true, message: true })
  expect(result.providerAfterLocalFailure).toBe(true)
  expect(result.staleFallback).toEqual({ outage: true, balance: true, agePreserved: true })
  expect(result.recovered).toEqual({ outage: false, balance: true })
  expect(result.localPush).toBe(false)
  expect(result.pushBeforeCache).toBe(true)
  expect(result.newerPushSurvivesCache).toBe(true)
  expect(result.confirmedZeroSurvivesCache).toBe(true)
  expect(result.completedReadSurvivesCache).toBe(true)
  expect(result.purgedCacheStaysEmpty).toBe(true)
  expect(result.deviceIntents).toEqual([])
})
