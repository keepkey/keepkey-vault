import { expect, test } from 'bun:test'

test('Dashboard quietly keeps recent cache, shows actual errors and recovers within the checked scope', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/dashboard-balance-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  const stdout = run.stdout.toString()
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || stdout)
  const marker = 'DASHBOARD_BALANCE_UI_RESULT '
  const record = stdout.split(/\r?\n/).find(line => line.startsWith(marker))
  expect(record).toBeDefined()
  expect(JSON.parse(record!.slice(marker.length))).toEqual({
    freshCache: { refreshes: 0, notice: false, pulse: false }, ordinaryStaleQuiet: true, focusQuiet: true,
    actualFailureVisible: true, sameErrorStaysDismissed: true, newErrorReopens: true,
    partialRecoveryKeepsUnknownError: true, fullRecoveryClears: true, chainRecoveryClears: true,
    transactionIsQuietGlobally: true, transactionCanRefresh: true,
    purgeReset: { notice: false, retainedBalance: false, pulse: false },
    missingStructureQuiet: true, transactionAfterCacheRefreshes: true, pendingCacheRefreshes: true,
    oldCache: { pulse: true, notice: false, duplicateCta: false }, oldCacheAutomatic: true, manualRefreshWorks: true, manualRefreshShowsAge: true,
  })
}, 30_000)
