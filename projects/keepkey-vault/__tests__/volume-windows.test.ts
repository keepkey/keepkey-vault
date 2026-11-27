import { describe, expect, test } from 'bun:test'
import { getWindowsVolumeInventory, openWindowsExternalVolume } from '../src/bun/volume-windows'

const id = '2/1'
// Volume GUIDs can encode disk signature/offset instead of an RFC UUID version.
const uuid = 'a80a790c-0000-0000-0000-100000000000'
const volume = {
  id, uuid, name: 'Practice', format: 'NTFS', mountPoint: 'F:\\', locked: null, encrypted: null,
  writable: true, availableBytes: 215_000_000_000,
}
const result = {
  edition: 'Professional', engine: true, adminAccount: true, scanFailed: false, local: { name: 'Windows', totalBytes: 5e11, availableBytes: 1e11, fileVault: 'unknown' },
  drives: [{ id: '2', name: 'Practice SSD', sizeBytes: 256e9, volumes: [volume] }],
}

describe('Windows volume inventory', () => {
  test('recognizes native storage support and keeps storage visible on unsupported editions', async () => {
    const inventory = await getWindowsVolumeInventory(async () => result)
    expect(inventory.local?.availableBytes).toBe(1e11)
    expect(inventory.drives[0].volumes).toEqual([volume])
    expect(inventory.unavailableReason).toBeUndefined()
    const normalAccount = await getWindowsVolumeInventory(async () => ({ ...result, adminAccount: false }))
    expect(normalAccount.unavailableReason).toContain('administrator account')
    const missingModule = await getWindowsVolumeInventory(async () => ({ ...result, engine: false }))
    expect(missingModule.unavailableReason).toContain('PowerShell modules')
    const home = await getWindowsVolumeInventory(async () => ({ ...result, edition: 'CoreSingleLanguage' }))
    expect(home.unavailableReason).toContain('Windows Home')
  })

  test('scan failures stay distinct from an empty drive list', async () => {
    const inventory = await getWindowsVolumeInventory(async () => ({ ...result, scanFailed: true, drives: [] }))
    expect(inventory.unavailableReason).toContain('could not scan')
    expect(inventory.local?.name).toBe('Windows')
  })

  test('rechecks the selected volume before opening its drive letter', async () => {
    const opened: string[] = []
    const launch = async (path: string) => { opened.push(path) }
    const inventory = () => getWindowsVolumeInventory(async () => result)
    await openWindowsExternalVolume({ id, uuid }, inventory, launch)
    await expect(openWindowsExternalVolume({ id, uuid: null }, inventory, launch)).rejects.toThrow('no longer mounted')
    await expect(openWindowsExternalVolume({ id: '9/1', uuid }, inventory, launch)).rejects.toThrow('no longer mounted')
    expect(opened).toEqual(['F:\\'])
  })
})

describe('Windows KeepKey VHDX actions', () => {
  test('binds every credential operation to the volume recovery ID and uses a password-free lock', async () => {
    const { createWindowsVolumeBackend } = await import('../src/bun/volume-windows-actions')
    const password = Buffer.from('a'.repeat(64))
    const recordId = 'f'.repeat(32)
    const seen: { action: string; record?: string; secret: boolean }[] = []
    const backend = createWindowsVolumeBackend(
      async () => ({ state: 'locked', mount: null }),
      async (action, _path, options, credential) => {
        seen.push({ action, record: options.recordId, secret: credential === password })
      }, async () => {},
    )
    expect(backend.filename).toBe('payload.vhdx')
    await backend.create('target', 'Practice', 256, password, recordId)
    await backend.unlock('target', password, recordId)
    await backend.lock('target')
    expect(seen).toEqual([
      { action: 'create', record: recordId, secret: true },
      { action: 'unlock', record: recordId, secret: true },
      { action: 'lock', record: undefined, secret: false },
    ])
    password.fill(0)
  })

  test('state and Explorer use unprivileged discovery only', async () => {
    const { createWindowsVolumeBackend } = await import('../src/bun/volume-windows-actions')
    const opened: string[] = []
    let mount = 'Q:\\'
    const backend = createWindowsVolumeBackend(
      async () => ({ state: 'mounted', mount }), async () => { throw new Error('Unnecessary UAC request') },
      async value => { opened.push(value) },
    )
    expect(await backend.state('image')).toBe('mounted')
    await backend.open('image')
    mount = '\\\\server\\share'
    await expect(backend.open('image')).rejects.toThrow('Unlock')
    expect(opened).toEqual(['Q:\\'])
  })

  test('uses the detached-file check for deletion without a storage action or credential', async () => {
    const { createWindowsVolumeBackend } = await import('../src/bun/volume-windows-actions')
    const modes: boolean[] = []
    let attached = false
    const backend = createWindowsVolumeBackend(async (_path, checkDetachment) => {
      modes.push(!!checkDetachment)
      return { state: attached ? 'attached' : (checkDetachment ? 'locked' : 'unavailable'), mount: null }
    }, async () => { throw new Error('Unexpected storage action') }, async () => {})
    expect(await backend.state('image')).toBe('unavailable')
    expect(await backend.isDetached('image')).toBe(true)
    attached = true
    expect(await backend.isDetached('image')).toBe(false)
    expect(modes).toEqual([false, true, true])
  })
})
