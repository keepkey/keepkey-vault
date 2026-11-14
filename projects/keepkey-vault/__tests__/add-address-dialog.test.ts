import { expect, test } from 'bun:test'

test('Add address refuses bad checksum, .eth, zero/burn and own addresses, and offers co-signer only for a valid contact', () => {
  const run = Bun.spawnSync([process.execPath, new URL('./support/add-address-dialog.tsx', import.meta.url).pathname], {
    cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 30000,
  })
  if (run.exitCode) throw new Error(run.stderr.toString() || run.stdout.toString())
  const blocked = (error: string) => ({ canAdd: false, cosigner: false, error })
  expect(JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)).toEqual({
    badChecksum: blocked('invalidEvmChecksum'),
    ens: blocked('ensNotSupported'),
    zero: blocked('burnAddress'),
    burn: blocked('burnAddress'),
    own: blocked('contactIsOwnAddress'),
    valid: { canAdd: true, cosigner: true, error: null },
    saved: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  })
}, 35000)
