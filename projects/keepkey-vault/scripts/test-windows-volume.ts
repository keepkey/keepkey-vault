// Opt-in Windows 10/11 VHDX/BitLocker test. Run this as the signed-in user,
// with Vault closed. Windows will ask for administrator consent for each action.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createVolumeImageStore } from '../src/bun/volume-images'
import { readWindowsVolumeImage, windowsVolumeBackend } from '../src/bun/volume-windows-actions'

if (process.platform !== 'win32' || !process.argv.includes('--run')) {
  console.error('Run bun scripts/test-windows-volume.ts --run on a Windows 10/11 test machine.')
  process.exit(1)
}

const inventory = await windowsVolumeBackend.inventory()
assert.ok(inventory.supported && !inventory.unavailableReason, inventory.unavailableReason)
const root = join(homedir(), 'KeepKey Volumes')
const name = 'Vault smoke ' + randomUUID()
const target = { id: name + '.kkvolume' }
const folder = join(root, target.id)
const image = join(folder, windowsVolumeBackend.filename)
const randomCredential = Buffer.from(randomBytes(32).toString('hex'), 'ascii')
let wrong = false
const store = createVolumeImageStore(root, undefined, undefined, undefined,
  async () => wrong ? Buffer.alloc(64, '0') : Buffer.from(randomCredential), windowsVolumeBackend)

console.log('Testing a new 256 MiB image in ' + folder)
console.log('Windows prompts authorize initialization and encryption of the disposable image.')
try {
  await store.createVolumeImage({ name, sizeMiB: 256 })
  assert.equal(await windowsVolumeBackend.state(image), 'locked')
  const listed = async () => (await store.listVolumeImages(inventory)).find(item => item.id === target.id && !item.destination)
  const beforeUnlock = await listed()
  assert.ok(beforeUnlock?.deleteToken)

  wrong = true
  await assert.rejects(store.unlockVolumeImage(target))
  assert.equal(await windowsVolumeBackend.state(image), 'locked', 'A rejected unlock must leave the image detached')
  wrong = false

  await store.unlockVolumeImage(target)
  const first = await readWindowsVolumeImage(image)
  assert.ok(first.state === 'mounted' && first.mount)
  await assert.rejects(store.deleteVolumeImage({ ...target, deleteToken: beforeUnlock.deleteToken }))
  const content = randomUUID()
  const marker = 'vault-smoke-' + randomUUID() + '.txt'
  await writeFile(join(first.mount, marker), content, { flag: 'wx' })
  await store.lockVolumeImage(target)
  assert.equal(await windowsVolumeBackend.state(image), 'locked')

  await store.unlockVolumeImage(target)
  const again = await readWindowsVolumeImage(image)
  assert.ok(again.state === 'mounted' && again.mount)
  assert.equal(await readFile(join(again.mount, marker), 'utf8'), content)
  await store.lockVolumeImage(target)
  assert.equal(await windowsVolumeBackend.state(image), 'locked')
  const beforeDelete = await listed()
  assert.ok(beforeDelete?.deleteToken)
  await store.deleteVolumeImage({ ...target, deleteToken: beforeDelete.deleteToken })
  assert.equal(await listed(), undefined)
  console.log('Passed. Removed the disposable test package.')
} catch (error) {
  console.error('Test stopped. Inspect the disposable package in ' + folder)
  throw error
} finally { randomCredential.fill(0) }
