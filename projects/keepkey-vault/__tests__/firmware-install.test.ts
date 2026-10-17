/**
 * Bitcoin-only / multi-chain install decisions, against the real module the
 * engine uses (src/shared/firmware-install.ts) and the bundled manifest.
 *
 * Desktop's emulator has no bootloader mode and no bitcoin-only build, so the
 * bootloader-mode journeys are covered here with the hashes real devices report.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  assertInstallAllowed, installedFromBootloader, installedInFirmwareMode, isBitcoinOnlyImage, latestFor,
  mergeManifests, needsFirmware, planInstall, wizardCoinMode,
  type ChannelFirmware, type InstalledFirmware,
} from '../src/shared/firmware-install'
import type { WipeReason } from '../src/shared/flash-wipe'
import { resolveOndeviceFirmwareVersion } from '../src/shared/firmware-versions'
import type { FirmwareManifest } from '../src/shared/types'

const manifest: FirmwareManifest = JSON.parse(readFileSync(join(import.meta.dir, '../firmware-bundle/releases.json'), 'utf8'))
const channel = manifest.latest

// Full-file hashes, as the device reports them.
const BTC_7143 = '74b6b2d03e38aa8fe646fb8c8016cb4e7be1793d1ce9493c2bbe5759a85ecbec'
const MULTI_7141 = 'f40fe1b74949a9e091269536b27cd53bbb8a5c1c428a6c36ff7d5c6bf6845f46'
const MULTI_7142 = 'caa53bd48e7a6c1f01dcf20ac434cefad0d72ea93a7b0ca688072f36a19d68df'
const MULTI_7160 = '99ebac75902b285678c235ec3cb0a9de2d2bc1181c0d47db6a9ae14cf035879c'
const ZCASH_UNSIGNED = '8ed86d578019f127998215268b75165b92c52948647a8b31949e4f311d695d3d'
const UNKNOWN = 'ab'.repeat(32) // factory 4.0.0 or any build not in the table

const LATEST_MULTI = latestFor(channel, false)!
const LATEST_BTC = latestFor(channel, true)!

function inBootloader(hash: string, opts: { snapshot?: { version: string | null; bitcoinOnly: boolean }; factorySeen?: boolean } = {}): InstalledFirmware {
  return installedFromBootloader({ hashHex: hash, release: resolveOndeviceFirmwareVersion(hash), snapshot: opts.snapshot ?? null, factorySeen: opts.factorySeen })
}
/** Firmware mode: the same helper the engine builds it with from Features. */
function inFirmware(version: string, bitcoinOnly: boolean, verified: boolean | 'unknown' = true, initialized = version !== '4.0.0'): InstalledFirmware {
  return installedInFirmwareMode({ version, bitcoinOnly, verified: verified === 'unknown' ? undefined : verified, initialized })
}
function needs(installed: InstalledFirmware, bootloaderMode: boolean, ch: ChannelFirmware | null = channel, latestMulti = LATEST_MULTI) {
  return needsFirmware({ bootloaderMode, fwVersion: bootloaderMode ? '2.1.4' : installed.version ?? undefined, installed, latestMulti, latestBitcoinOnly: latestFor(ch, true) })
}
function plan(installed: InstalledFirmware, choice?: 'multi' | 'bitcoin-only', ch: ChannelFirmware | null = channel) {
  return planInstall({ installed, choice, channel: ch, fallbackMulti: LATEST_MULTI })
}

describe('bundled manifest', () => {
  test('multi-chain latest is 7.14.2, bitcoin-only is 7.14.3', () => {
    expect(LATEST_MULTI).toBe('7.14.2')
    expect(LATEST_BTC).toBe('7.14.3')
    expect(latestFor(manifest.beta, true)).toBe('7.14.3')
  })
})

describe('(a)/(b) new KeepKey: choose Bitcoin-only or multi-chain, nothing to wipe', () => {
  test('factory firmware 4.0.0 in firmware mode needs firmware, even with no latest to compare to', () => {
    expect(needs(inFirmware('4.0.0', false), false)).toBe(true)
    const installed = inFirmware('4.0.0', false)
    expect(needsFirmware({ bootloaderMode: false, fwVersion: '4.0.0', installed, latestMulti: undefined, latestBitcoinOnly: undefined })).toBe(true)
  })

  test('only an uninitialized 4.0.0 is factory: one holding a wallet is not "new"', () => {
    expect(inFirmware('4.0.0', false).factory).toBe(true)
    expect(inFirmware('4.0.0', false, 'unknown', true).factory).toBeUndefined()
    expect(inFirmware('5.2.4', false, 'unknown', true)).toEqual({ version: '5.2.4', verified: undefined, bitcoinOnly: false, present: true, factory: undefined })
  })

  test('an old official firmware that holds a wallet (5.2.4, no hash reported) updates to either lineage with no wipe', () => {
    const installed = inFirmware('5.2.4', false, 'unknown', true)
    expect(needs(installed, false)).toBe(true)
    expect(plan(installed, 'multi')).toMatchObject({ ok: true, bitcoinOnly: false, version: '7.14.2', wipeReason: undefined })
    // bitcoin-only firmware keeps a migrated multi-chain wallet portable (storage.c storage_stampBitcoinOnlySeed)
    expect(plan(installed, 'bitcoin-only')).toMatchObject({ ok: true, bitcoinOnly: true, version: '7.14.3', wipeReason: undefined })
  })

  test('Bitcoin-only installs the bundled bitcoin-only build with no wipe warning', () => {
    const p = plan(inFirmware('4.0.0', false), 'bitcoin-only')
    expect(p).toEqual({ ok: true, bitcoinOnly: true, version: '7.14.3', entry: channel.firmwareBitcoinOnly, wipeReason: undefined })
    expect(p.ok && p.entry?.url).toBe('v7.14.3/firmware.keepkey.bitcoin-only.bin')
  })

  test('multi-chain is the default and installs 7.14.2', () => {
    const p = plan(inFirmware('4.0.0', false))
    expect(p).toEqual({ ok: true, bitcoinOnly: false, version: '7.14.2', entry: channel.firmware, wipeReason: undefined })
  })

  test('in bootloader mode the factory hash is unknown: the device stays "new" for the UI, but the install still warns', () => {
    // factorySeen is session memory, not tied to the device: another KeepKey
    // plugged in now would read the same, so it never removes the warning.
    const installed = inBootloader(UNKNOWN, { factorySeen: true })
    expect(installed).toEqual({ version: null, present: true, factory: true })
    expect(needs(installed, true)).toBe(true)
    expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: false, wipeReason: 'unknown-installed' })
    for (const choice of ['multi', 'bitcoin-only'] as const) {
      expect(plan(installed, choice)).toMatchObject({ ok: true, bitcoinOnly: choice === 'bitcoin-only', wipeReason: 'unknown-installed' })
    }
  })

  test('no firmware on flash: multi-chain by default, and any wallet still in storage is warned about', () => {
    for (const hash of ['', '0'.repeat(64)]) {
      const installed = inBootloader(hash)
      expect(installed.present).toBe(false)
      expect(needs(installed, true)).toBe(true)
      expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: false, wipeReason: 'no-firmware' })
      expect(plan(installed, 'bitcoin-only')).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: 'no-firmware' })
    }
  })

  test('Bitcoin-only is refused, not substituted, when the build has no bitcoin-only firmware', () => {
    const noBtc: ChannelFirmware = { firmware: channel.firmware }
    expect(plan(inFirmware('4.0.0', false), 'bitcoin-only', noBtc)).toMatchObject({ ok: false })
  })
})

describe('(c) Bitcoin-only 7.14.3 in firmware mode', () => {
  test('is current, and compared to the bitcoin-only build only', () => {
    const installed = inFirmware('7.14.3', true)
    expect(needs(installed, false)).toBe(false)
    // A newer multi-chain release is never an update for it.
    expect(needs(installed, false, channel, '7.16.0')).toBe(false)
    expect(needs(installed, false, { ...channel, firmwareBitcoinOnly: { ...channel.firmwareBitcoinOnly!, version: 'v7.14.4' } })).toBe(true)
    // No bitcoin-only build to offer: leave it alone.
    expect(needs(installed, false, { firmware: channel.firmware }, '7.16.0')).toBe(false)
  })

  test('the default install keeps it Bitcoin-only; multi-chain needs a wipe acknowledgement', () => {
    const installed = inFirmware('7.14.3', true)
    expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: true, version: '7.14.3', wipeReason: undefined })
    // 7.14.2 predates the bitcoin-only storage band: it erases the wallet.
    expect(plan(installed, 'multi')).toMatchObject({ ok: true, bitcoinOnly: false, wipeReason: 'downgrade' })
  })
})

describe('(d) Bitcoin-only 7.14.3 in bootloader mode, no snapshot', () => {
  const installed = inBootloader(BTC_7143)

  test('is recognised from its hash alone, as an official Bitcoin-only release', () => {
    expect(resolveOndeviceFirmwareVersion(BTC_7143)).toBe('v7.14.3-bitcoin-only')
    expect(installed).toEqual({ version: '7.14.3', verified: true, bitcoinOnly: true, present: true })
  })

  test('is not sent to the update (no "7.14.3-bitcoin-only" < 7.14.2 suffix bug)', () => {
    expect(needs(installed, true)).toBe(false)
  })

  test('is never silently flashed with multi-chain 7.14.2', () => {
    expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: undefined })
    expect(plan(installed, 'multi')).toMatchObject({ ok: true, bitcoinOnly: false, version: '7.14.2', wipeReason: 'downgrade' })
  })
})

describe("(d') bootloader mode with a remembered snapshot of firmware the table does not know", () => {
  test('the snapshot names version and variant, but the build is not official', () => {
    const installed = inBootloader(UNKNOWN, { snapshot: { version: '7.14.3', bitcoinOnly: true } })
    expect(installed).toEqual({ version: '7.14.3', verified: false, bitcoinOnly: true, present: true })
    expect(needs(installed, true)).toBe(false)
    // Official firmware over an unofficial build: the bootloader does not restore storage.
    expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: 'unsigned-to-signed' })
  })

  test('a snapshot never makes Desktop less careful than no snapshot, and matches firmware mode', () => {
    const withSnapshot = inBootloader(UNKNOWN, { snapshot: { version: '7.14.1', bitcoinOnly: false } })
    expect(plan(withSnapshot, 'multi')).toMatchObject({ ok: true, wipeReason: 'unsigned-to-signed' })
    expect(plan(inFirmware('7.14.1', false, false), 'multi')).toMatchObject({ ok: true, wipeReason: 'unsigned-to-signed' })
    expect(plan(inBootloader(UNKNOWN), 'multi')).toMatchObject({ ok: true, wipeReason: 'unknown-installed' })
  })

  test('the release table wins over a snapshot', () => {
    expect(inBootloader(BTC_7143, { snapshot: { version: '7.14.2', bitcoinOnly: false } }).bitcoinOnly).toBe(true)
  })
})

describe('bootloader mode, unknown firmware, no snapshot, not a new device', () => {
  const installed = inBootloader(UNKNOWN)

  test('the variant is unknown, never assumed multi-chain', () => {
    expect(installed).toEqual({ version: null, present: true, factory: undefined })
    expect(needs(installed, true)).toBe(true)
  })

  test('nothing is installed without an explicit choice, and either choice warns', () => {
    expect(plan(installed)).toMatchObject({ ok: false })
    expect(plan(installed, 'multi')).toMatchObject({ ok: true, bitcoinOnly: false, wipeReason: 'unknown-installed' })
    expect(plan(installed, 'bitcoin-only')).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: 'unknown-installed' })
  })

  test('a recognised unofficial build warns that official firmware wipes it', () => {
    const zcash = inBootloader(ZCASH_UNSIGNED)
    expect(zcash).toMatchObject({ version: '7.14.0', verified: false, bitcoinOnly: false })
    expect(plan(zcash)).toMatchObject({ ok: true, wipeReason: 'unsigned-to-signed' })
  })
})

describe('(e) multi-chain behaviour unchanged', () => {
  test('7.14.1 updates to 7.14.2 in both modes, without a wipe warning', () => {
    for (const [installed, bl] of [[inFirmware('7.14.1', false), false], [inBootloader(MULTI_7141), true]] as const) {
      expect(needs(installed, bl)).toBe(true)
      expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: false, version: '7.14.2', wipeReason: undefined })
    }
  })

  test('7.14.2 is current in both modes', () => {
    expect(needs(inFirmware('7.14.2', false), false)).toBe(false)
    expect(needs(inBootloader(MULTI_7142), true)).toBe(false)
  })

  test('7.16.0 is recognised, never offered, and installing 7.14.2 over it needs a wipe acknowledgement', () => {
    for (const [installed, bl] of [[inFirmware('7.16.0', false), false], [inBootloader(MULTI_7160), true]] as const) {
      expect(needs(installed, bl)).toBe(false)
      expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: false, version: '7.14.2', wipeReason: 'downgrade' })
      // 7.14.3 cannot read 7.16 storage either.
      expect(plan(installed, 'bitcoin-only')).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: 'downgrade' })
    }
  })

  test('multi-chain 7.14.2 to Bitcoin-only 7.14.3 keeps the wallet (no wipe reason)', () => {
    expect(plan(inBootloader(MULTI_7142), 'bitcoin-only')).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: undefined })
  })
})

describe('mergeManifests keeps the bitcoin-only build', () => {
  const ref = (v: string, h = v) => ({ version: v, url: `${v}/fw.bin`, hash: h })
  const entry = (fw: string, btc?: string) => ({ firmware: ref(fw), bootloader: ref('v2.1.4'), ...(btc ? { firmwareBitcoinOnly: ref(btc) } : {}) })
  const m = (latest: any): FirmwareManifest => ({ latest, beta: latest, hashes: { bootloader: {}, firmware: {} } })

  test('a remote-only bitcoin-only entry survives the bundled multi-chain entry winning', () => {
    const merged = mergeManifests(m(entry('v7.14.2')), m(entry('v7.10.0', 'v7.14.4')))!
    expect(merged.latest.firmware.version).toBe('v7.14.2')
    expect(merged.latest.firmwareBitcoinOnly?.version).toBe('v7.14.4')
  })

  test('a bundled bitcoin-only entry survives a newer remote multi-chain entry', () => {
    const merged = mergeManifests(m(entry('v7.14.2', 'v7.14.3')), m(entry('v7.16.0')))!
    expect(merged.latest.firmware.version).toBe('v7.16.0')
    expect(merged.latest.firmwareBitcoinOnly?.version).toBe('v7.14.3')
  })

  test('bundled wins ties; the newer bitcoin-only build wins otherwise', () => {
    const bundled = m(entry('v7.14.2', 'v7.14.3'))
    const tie = mergeManifests(bundled, m({ ...entry('v7.14.2'), firmwareBitcoinOnly: ref('v7.14.3', 'remote-hash') }))!
    expect(tie.latest.firmwareBitcoinOnly?.hash).toBe('v7.14.3')
    expect(mergeManifests(bundled, m(entry('v7.14.2', 'v7.15.0')))!.latest.firmwareBitcoinOnly?.version).toBe('v7.15.0')
  })

  test('the real bundled manifest merged with the current remote shape keeps 7.14.3', () => {
    const remote = m(entry('v7.10.0'))
    expect(mergeManifests(manifest, remote)!.latest.firmwareBitcoinOnly).toEqual(channel.firmwareBitcoinOnly)
    expect(mergeManifests(manifest, null)).toBe(manifest)
  })
})

describe('engine gate before anything is erased', () => {
  const REASONS: WipeReason[] = ['downgrade', 'signed-to-unsigned', 'unsigned-to-signed', 'bitcoin-only-lock', 'unknown-installed', 'no-firmware']

  test('a plan with no wipe reason needs no acknowledgement', () => {
    expect(() => assertInstallAllowed(plan(inFirmware('7.14.1', false)))).not.toThrow()
  })

  test('each wipe reason needs an acknowledgement of exactly that reason', () => {
    for (const reason of REASONS) {
      const p = { ok: true as const, bitcoinOnly: false, version: '7.14.2', wipeReason: reason }
      expect(() => assertInstallAllowed(p)).toThrow(`WIPE_ACK_REQUIRED:${reason}`)
      expect(() => assertInstallAllowed(p, reason)).not.toThrow()
      for (const other of REASONS.filter((r) => r !== reason)) {
        expect(() => assertInstallAllowed(p, other)).toThrow(`WIPE_ACK_REQUIRED:${reason}`)
      }
    }
  })

  test('a refused plan throws its own error', () => {
    expect(() => assertInstallAllowed(plan(inBootloader(UNKNOWN)))).toThrow('cannot tell which firmware')
  })
})

describe('image variant marker on the bundled binaries', () => {
  const bin = (dir: string, name = 'firmware.keepkey.bin') => new Uint8Array(readFileSync(join(import.meta.dir, '../firmware-bundle', dir, name)))

  test('the bitcoin-only build is bitcoin-only', () => {
    expect(isBitcoinOnlyImage(bin('v7.14.3', 'firmware.keepkey.bitcoin-only.bin'))).toBe(true)
  })

  test('every multi-chain build is not', () => {
    for (const dir of ['v7.10.0', 'v7.14.0', 'v7.14.1', 'v7.14.2']) expect(isBitcoinOnlyImage(bin(dir))).toBe(false)
  })

  test('the manifest lists each build under its own variant', () => {
    expect(isBitcoinOnlyImage(bin(channel.firmwareBitcoinOnly!.url.split('/')[0], channel.firmwareBitcoinOnly!.url.split('/')[1]))).toBe(true)
    expect(isBitcoinOnlyImage(bin(channel.firmware.url.split('/')[0], channel.firmware.url.split('/')[1]))).toBe(false)
  })
})

describe('setup wizard: Bitcoin-only / Multi-chain choice', () => {
  const base = { enabled: true, bitcoinOnlyAvailable: true, newDevice: false, needsBootloaderUpdate: false, remembered: null }

  test('a new KeepKey gets the picker with Multi-chain preselected', () => {
    expect(wizardCoinMode({ ...base, newDevice: true, installedBitcoinOnly: false })).toEqual({ coinMode: 'multi', showPicker: true, variantUnknown: false })
    expect(wizardCoinMode({ ...base, newDevice: true })).toEqual({ coinMode: 'multi', showPicker: true, variantUnknown: false })
  })

  test('the choice made on the bootloader page carries through the replugs', () => {
    // after the bootloader update the device is replugged: the wizard may remount, firmware unknown in bootloader mode
    expect(wizardCoinMode({ ...base, newDevice: true, remembered: 'bitcoin-only' }).coinMode).toBe('bitcoin-only')
    expect(wizardCoinMode({ ...base, remembered: 'bitcoin-only' })).toEqual({ coinMode: 'bitcoin-only', showPicker: true, variantUnknown: true })
    expect(wizardCoinMode({ ...base, installedBitcoinOnly: false, remembered: 'bitcoin-only' })).toEqual({ coinMode: 'bitcoin-only', showPicker: true, variantUnknown: false })
  })

  test('an old multi-chain KeepKey going through the bootloader update (5.2.4 on 1.0.2) gets the picker on the first page', () => {
    expect(wizardCoinMode({ ...base, installedBitcoinOnly: false, needsBootloaderUpdate: true })).toEqual({ coinMode: 'multi', showPicker: true, variantUnknown: false })
  })

  test('other multi-chain devices update as before: no picker, multi-chain', () => {
    expect(wizardCoinMode({ ...base, installedBitcoinOnly: false })).toEqual({ coinMode: 'multi', showPicker: false, variantUnknown: false })
  })

  test('a Bitcoin-only device stays Bitcoin-only, whatever was remembered', () => {
    for (const remembered of [null, 'multi', 'bitcoin-only'] as const) {
      expect(wizardCoinMode({ ...base, installedBitcoinOnly: true, needsBootloaderUpdate: true, remembered })).toMatchObject({ coinMode: 'bitcoin-only', showPicker: false })
    }
  })

  test('unidentified firmware: picker with nothing preselected', () => {
    expect(wizardCoinMode(base)).toEqual({ coinMode: null, showPicker: true, variantUnknown: true })
  })

  test('no bitcoin-only build, or the flag off: no picker, multi-chain', () => {
    expect(wizardCoinMode({ ...base, newDevice: true, bitcoinOnlyAvailable: false, remembered: 'bitcoin-only' })).toMatchObject({ coinMode: 'multi', showPicker: false })
    expect(wizardCoinMode({ ...base, newDevice: true, enabled: false, remembered: 'bitcoin-only' })).toMatchObject({ coinMode: 'multi', showPicker: false })
  })
})
