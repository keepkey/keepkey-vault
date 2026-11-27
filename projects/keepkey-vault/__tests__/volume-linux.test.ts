import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { linuxVolumeBackend } from '../src/bun/volume-linux'

// Run the same Python helper packaged by the native backend with a simulated UDisks2 daemon.
test.skipIf(process.platform === 'win32')('Linux loop lifecycle, busy lock and rollback on disposable sparse files', () => {
  const result = spawnSync('/usr/bin/python3', ['-IB', import.meta.dir + '/volume-linux.py'], { encoding: 'utf8' })
  expect(result.stderr).toContain('OK')
  expect(result.status).toBe(0)
})

test.skipIf(process.platform !== 'darwin')('missing UDisks dependencies report unavailable on a non-Linux host', async () => {
  const inventory = await linuxVolumeBackend.inventory()
  expect(inventory.supported).toBe(false)
  expect(inventory.unavailableReason).toContain('UDisks2')
})
