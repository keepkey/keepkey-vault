import { expect, test } from 'bun:test'

test('Add address saves every supported Zcash contact format on the shared network while refusing checksum errors and own addresses', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/add-address-dialog-zcash.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    transparent: { canAdd: true, error: null },
    sapling: { canAdd: true, error: null },
    unified: { canAdd: true, error: null },
    saplingTypo: { canAdd: false, error: 'invalidChecksum' },
    unifiedTypo: { canAdd: false, error: 'invalidChecksum' },
    garbage: { canAdd: false, error: 'invalidChecksum' },
    own: { canAdd: false, error: 'contactIsOwnAddress' },
    visibleZcashNetworks: 1,
    saved: ['transparent', 'sapling', 'unified'].map(format => ({
      networkId: 'bip122:00040fe8ec8471911baa1db1266ea15d', format, cosigner: false,
    })),
    closedAfterSave: 3,
  })
}, 35_000)
