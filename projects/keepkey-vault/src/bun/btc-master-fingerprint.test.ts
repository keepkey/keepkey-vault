/**
 * Master fingerprint capture: m/84' rides in account 0's getPublicKeys batch, its
 * parent fingerprint is read from the returned depth-1 key, and the snapshot keeps
 * it across the snapshot re-save every ready does. The wallet below derives real
 * keys from the public BIP-39 test mnemonic (never real funds); no device is used.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync } from 'bip39'
import { formatPath, toSlip132 } from './btc-psbt/codec'

const dir = mkdtempSync(join(tmpdir(), 'vault-master-fp-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
const { BtcAccountManager } = await import('./btc-accounts')
db.initDb()
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const MASTER = HDKey.fromMasterSeed(new Uint8Array(mnemonicToSeedSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')))
const H = 0x80000000

/** Answers like the firmware: SLIP-132 version by script type, parent fingerprint in the key. */
function testWallet(opts: { dropDepth1?: boolean } = {}) {
  const requests: any[][] = []
  return {
    requests,
    getPublicKeys: async (paths: any[]) => {
      requests.push(paths)
      return paths.map((p) => {
        if (opts.dropDepth1 && p.addressNList.length === 1) return null
        const xpub = MASTER.derive(formatPath(p.addressNList)).publicExtendedKey
        return { xpub: p.scriptType === 'p2pkh' ? xpub : toSlip132(xpub, p.scriptType) }
      })
    },
  }
}

describe('BtcAccountManager master fingerprint', () => {
  test('account 0 batch carries m/84\' (no display) and yields the test-mnemonic fingerprint', async () => {
    const wallet = testWallet()
    const mgr = new BtcAccountManager()
    await mgr.initialize(wallet)
    expect(wallet.requests).toHaveLength(1)
    const extra = wallet.requests[0].at(-1)
    expect(extra).toMatchObject({ addressNList: [84 + H], coin: 'Bitcoin', scriptType: 'p2wpkh', showDisplay: false })
    expect(mgr.masterFingerprint).toBe('73c5da0a')
    // The depth-1 key never becomes an account xpub.
    expect(mgr.getAllXpubMeta().map((x) => x.path.length)).toEqual([3, 3, 3])

    await mgr.addAccount(wallet)
    expect(wallet.requests[1].some((p: any) => p.addressNList.length === 1)).toBe(false)
    expect(mgr.masterFingerprint).toBe('73c5da0a')
    mgr.reset()
    expect(mgr.masterFingerprint).toBeNull()
  })

  test('a missing depth-1 key leaves the fingerprint unknown and the accounts intact', async () => {
    const mgr = new BtcAccountManager()
    await mgr.initialize(testWallet({ dropDepth1: true }))
    expect(mgr.masterFingerprint).toBeNull()
    expect(mgr.getAllXpubMeta()).toHaveLength(3)
  })
})

describe('device_snapshot master_fp', () => {
  test('survives the snapshot re-save and never creates a snapshot row', () => {
    db.setDeviceMasterFingerprint('nodevice', '73c5da0a')
    expect(db.getDeviceSnapshotById('nodevice')).toBeNull()

    db.saveDeviceSnapshot('dev1', 'KeepKey', '7.14.2', '{}')
    expect(db.getDeviceSnapshotById('dev1')?.masterFp).toBeNull()
    db.setDeviceMasterFingerprint('dev1', '73c5da0a')
    db.saveDeviceSnapshot('dev1', 'Renamed', '7.15.0', '{"x":1}')
    expect(db.getDeviceSnapshotById('dev1')).toMatchObject({ label: 'Renamed', firmwareVer: '7.15.0', featuresJson: '{"x":1}', masterFp: '73c5da0a' })
  })
})
