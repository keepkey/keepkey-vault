import { expect, test } from 'bun:test'

test('Dashboard retains balances for local device failures and still reports provider outages', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/dashboard-device-errors.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  const stdout = run.stdout.toString()
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || stdout)
  const marker = 'DASHBOARD_DEVICE_ERRORS_RESULT '
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
  if (records.length !== 1) throw new Error(`Expected one dashboard fixture result, received ${records.length}\n${stdout}`)
  const result = JSON.parse(records[0].slice(marker.length))
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
}, 30_000) // the child renders under jsdom and is allowed 30 s; Bun's 5 s test default failed under load
