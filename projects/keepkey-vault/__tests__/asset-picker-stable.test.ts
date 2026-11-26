import { expect, test } from 'bun:test'

test('asset picker: a balance poll with the same numbers never blanks or remounts the list; real changes update in place; keyboard moves between rows', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/asset-picker-stable.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  const line = run.stdout.toString().split('\n').find(l => l.startsWith('ASSET_PICKER_RESULT '))
  if (!line) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(line.slice('ASSET_PICKER_RESULT '.length))).toEqual({
    sameKeyForEqualInputs: true, listShown: true, pollKeepsRows: true, pollNeverLoading: true, pollNoRebuild: true,
    realChangeUpdatesInPlace: true, keyboardMoves: true, oneSurfaceNoIds: true,
  })
}, 35000)
