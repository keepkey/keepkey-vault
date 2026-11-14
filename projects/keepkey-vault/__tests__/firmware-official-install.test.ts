import { describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Run the real update operation with scripted wallet calls. Native adapters
// never load, and the controller is never started or connected to a device.
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('@keepkey/hdwallet-keepkey-nodewebusb', () => ({ NodeWebUSBKeepKeyAdapter: { useKeyring: () => ({}) } }))
mock.module('usb', () => ({ usb: new EventEmitter() }))
mock.module('electrobun/main', () => ({ Utils: { paths: { userData: '/tmp/kk-official-install-test-unused' } } }))
mock.module('electrobun/main/utils', () => ({ paths: { userData: '/tmp/kk-official-install-test-unused' } }))

const { EngineController } = await import('../src/bun/engine-controller')

const officialImage = () => Buffer.from(readFileSync(join(import.meta.dir, '../firmware-bundle/v7.14.2/firmware.keepkey.bin')))

function fixture(image: Buffer) {
  const engine = new EngineController()
  const internal = engine as any
  const operations: string[] = []
  let uploaded: Buffer | undefined
  // Pin each candidate's payload, including the corrupt fixture: the signature
  // guard must reject it even when its manifest hash and lineage both match.
  const entry = { version: 'v7.14.2', url: 'fixture.bin', hash: createHash('sha256').update(image.subarray(256)).digest('hex') }
  internal.getChannelEntry = () => ({ firmware: entry })
  internal.installedFirmware = () => ({ version: '7.14.2', verified: true, bitcoinOnly: false, present: true })
  internal.getDeviceState = () => ({ state: 'bootloader', updatePhase: internal.updatePhase })
  internal.loadBinary = async () => { operations.push('load'); return image }
  internal.clearWallet = () => { operations.push('clear') }
  internal.startRebootPoll = () => { operations.push('reboot-poll') }
  internal.wallet = {
    firmwareErase: async () => { operations.push('erase') },
    firmwareUpload: async (bytes: Buffer) => { operations.push('upload'); uploaded = bytes },
  }
  return { engine, internal, operations, uploaded: () => uploaded }
}

describe('official firmware install signature gate', () => {
  test('unsigned header is refused before erase or upload even when the pinned payload matches', async () => {
    const image = officialImage()
    image.fill(0, 64, 256)
    const { engine, internal, operations, uploaded } = fixture(image)
    await expect(engine.startFirmwareUpdate({ variant: 'multi', requireOfficialSignatures: true })).rejects.toThrow('valid KeepKey release signatures')
    expect(operations).toEqual(['load'])
    expect(uploaded()).toBeUndefined()
    expect(internal.updatePhase).toBe('idle')
  })

  test('corrupt code with a matching manifest hash is refused before erase or upload', async () => {
    const image = officialImage()
    image[256 + 1000] ^= 1
    const { engine, operations } = fixture(image)
    await expect(engine.startFirmwareUpdate({ variant: 'multi', requireOfficialSignatures: true })).rejects.toThrow('valid KeepKey release signatures')
    expect(operations).toEqual(['load'])
  })

  test('a KeepKey-signed image passes the gate and uploads the verified bytes', async () => {
    const image = officialImage()
    const { engine, operations, uploaded } = fixture(image)
    await engine.startFirmwareUpdate({ variant: 'multi', requireOfficialSignatures: true })
    expect(operations).toEqual(['load', 'erase', 'upload', 'clear', 'reboot-poll'])
    expect(uploaded()).toBe(image)
  })

  test('the existing update path retains its unsigned-image behavior when the new guard is omitted', async () => {
    const image = officialImage()
    image.fill(0, 64, 256)
    const { engine, operations } = fixture(image)
    await engine.startFirmwareUpdate({ variant: 'multi' })
    expect(operations).toEqual(['load', 'erase', 'upload', 'clear', 'reboot-poll'])
  })
})
