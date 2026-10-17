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
  installedFromBootloader, latestFor, mergeManifests, needsFirmware, planInstall,
  type ChannelFirmware, type InstalledFirmware,
} from '../src/shared/firmware-install'
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
/** Firmware mode, as the engine builds it from Features. */
function inFirmware(version: string, bitcoinOnly: boolean, verified = true): InstalledFirmware {
  return { version, bitcoinOnly, verified, present: true, factory: version === '4.0.0' || undefined }
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
  test('factory firmware 4.0.0 in firmware mode needs firmware', () => {
    expect(needs(inFirmware('4.0.0', false), false)).toBe(true)
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

  test('in bootloader mode the factory hash is unknown, but the device stays "new" (seen on 4.0.0 first)', () => {
    const installed = inBootloader(UNKNOWN, { factorySeen: true })
    expect(installed).toEqual({ version: null, present: true, factory: true })
    expect(needs(installed, true)).toBe(true)
    for (const choice of ['multi', 'bitcoin-only'] as const) {
      const p = plan(installed, choice)
      expect(p.ok && p.wipeReason).toBeUndefined()
      expect(p.ok && p.bitcoinOnly).toBe(choice === 'bitcoin-only')
    }
  })

  test('no firmware on flash: nothing to wipe, multi-chain by default', () => {
    for (const hash of ['', '0'.repeat(64)]) {
      const installed = inBootloader(hash)
      expect(installed.present).toBe(false)
      expect(needs(installed, true)).toBe(true)
      expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: false, wipeReason: undefined })
      expect(plan(installed, 'bitcoin-only')).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: undefined })
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

describe("(d') Bitcoin-only in bootloader mode with a remembered snapshot", () => {
  test('a snapshot names firmware the table does not know', () => {
    const installed = inBootloader(UNKNOWN, { snapshot: { version: '7.14.3', bitcoinOnly: true } })
    expect(installed).toEqual({ version: '7.14.3', bitcoinOnly: true, present: true })
    expect(needs(installed, true)).toBe(false)
    expect(plan(installed)).toMatchObject({ ok: true, bitcoinOnly: true, wipeReason: undefined })
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
