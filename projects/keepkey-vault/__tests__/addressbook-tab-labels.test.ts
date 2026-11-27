// Address Book tabs (KEEPKEY-180): "Saved recipients" is never cut, whatever the language;
// a long device name is cut at 140px and its full name is in the tooltip.
import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test('the Saved recipients tab is whole in Portuguese, a long device name is cut with a tooltip', () => {
  const run = Bun.spawnSync([process.execPath, fileURLToPath(new URL('./support/addressbook-tab-labels.tsx', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    // Fixed copy: no width limit, no ellipsis, and no tooltip (the whole label is already shown).
    savedTab: { maxWidth: '', textOverflow: '', title: '' },
    deviceTab: { maxWidth: '140px', textOverflow: 'ellipsis', title: 'KeepKey do escritório com nome comprido' },
  })
}, 35000)
