// Jasper audit v5 V8: "Add address" could not save a shielded Zcash contact.
import { expect, test } from 'bun:test'

test('Add address on Zcash saves transparent, Sapling and unified contacts, and refuses typos', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/add-address-dialog-zcash.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    transparent: { canAdd: true, error: null },
    sapling: { canAdd: true, error: null },
    unified: { canAdd: true, error: null },
    saplingTypo: { canAdd: false, error: 'invalidChecksum' },
    garbage: { canAdd: false, error: 'invalidChecksum' },
    // Saved under the shared Zcash networkId, as the backend expects.
    saved: [{ networkId: 'bip122:00040fe8ec8471911baa1db1266ea15d', shielded: true }],
  })
}, 35000)
