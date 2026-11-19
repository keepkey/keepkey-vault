import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const runSupport = (script: string) => {
  const run = Bun.spawnSync([process.execPath, fileURLToPath(new URL(`./support/${script}`, import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  return JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)
}

test('BTC receive hides the path editor so the QR and the device check share one path (audit v6 U1)', () => {
  expect(runSupport('btc-receive-path.tsx')).toEqual({
    bitcoin: 'false',
    litecoin: 'true',
    ethereum: 'true',
  })
}, 35000)

test('an edited path the device cannot derive never shows the saved default-path address (audit v6 U1)', () => {
  const result = runSupport('receive-edited-path.tsx')
  // Default path: the saved address may stand in while the device is busy.
  expect(result.defaultPath).toMatchObject({ address: 'cosmos1savedaddress', error: false })
  // Edited path: Verify would check that path, so the QR must not keep the saved one.
  expect(result.editedPath.path).toBe(result.editedPath.expectedPath)
  expect(result.editedPath.address).toBeNull()
  expect(result.editedPath.error).toBe(true)
}, 35000)
