import { expect, test } from 'bun:test'
import { pairingOrigin } from '../src/shared/pairing-origin'

test('pairing origin: extensions, sites, localhost, none', () => {
  expect(pairingOrigin('chrome-extension://iilbclbaojnjbeokklgbakballmfppnm/')).toEqual({ kind: 'extension', label: 'iilbclbaojnjbeokklgbakballmfppnm', extensionId: 'iilbclbaojnjbeokklgbakballmfppnm' })
  expect(pairingOrigin('https://swaps.pro/app')).toEqual({ kind: 'web', label: 'swaps.pro' })
  expect(pairingOrigin('http://localhost:3000')).toMatchObject({ kind: 'local' })
  expect(pairingOrigin('')).toEqual({ kind: 'none', label: '' })
})

test('pairing dialog on the preflight console: claims shown as claims, raw origin in Technical details, Enter/Esc kept', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/pairing-approval-ui.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  const line = run.stdout.toString().split('\n').find(l => l.startsWith('PAIRING_RESULT '))
  if (!line) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(line.slice('PAIRING_RESULT '.length))).toEqual({
    extensionWarned: true, rawOriginOnlyInDetails: true, glyphNotDisc: true, actionsPinned: true, noOldCopy: true,
    enterConnects: true, escDeclines: true, webNotWarned: true, iconShown: true,
  })
}, 35000)
