/**
 * POST /api/pubkeys/batch while a KeepKey is being set up: the device runs the
 * bootloader, factory firmware, no wallet, or firmware so old that setup
 * updates the bootloader first (5.2.4 on bootloader 1.0.2, seen live). It
 * answers derivations with Failure "Unknown message", so the route refuses
 * with 503 before asking it. A device whose user skipped a firmware update
 * (needs_firmware, current bootloader) keeps working.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// engine-controller's USB adapter is not loadable outside the app bundle; the
// REST server only needs the engine object this test passes in.
mock.module('@keepkey/hdwallet-keepkey-nodehid', () => ({ HIDKeepKeyAdapter: class {} }))
const dir = mkdtempSync(join(tmpdir(), 'vault-batch-setup-'))
mock.module('electrobun/bun', () => ({ Utils: { paths: { userData: dir } } }))
const db = await import('./db')
const { startRestApi } = await import('./rest-api')
db.initDb()
afterAll(() => { db.closeDb(); rmSync(dir, { recursive: true, force: true }) })

const ETH_PATH = [0x8000002c, 0x8000003c, 0x80000000, 0, 0]

async function batch(state: Record<string, unknown>) {
  const calls: string[] = []
  const wallet = {
    getFeatures: async () => ({ majorVersion: 7, minorVersion: 14, patchVersion: 1 }),
    ethGetAddress: async () => { calls.push('ethGetAddress'); return '0x1111111111111111111111111111111111111111' },
    getPublicKeys: async () => { calls.push('getPublicKeys'); return [] },
  }
  const engine: any = Object.assign(new EventEmitter(), {
    isEmulator: false, isPassphraseWallet: false, wallet,
    getDeviceState: () => ({ state: 'ready', firmwareVersion: '7.14.1', bootloaderMode: false, needsInit: false, needsBootloaderUpdate: false, ...state }),
    getCachedFeaturesSnapshot: () => undefined,
  })
  const auth: any = {
    requireAuth: () => ({ name: 'dapp', url: 'https://dapp.example' }), extractBearerToken: () => 'test',
    validate: () => true, getAccount: () => undefined, saveAccount: () => {},
  }
  const server = startRestApi(engine, auth, 0, {
    onApiLog: () => {}, onPairRequest: () => {}, getVersion: () => 'test',
    onSigningRequest: async () => ({ approved: false }) as any, onSigningDismissed: () => {},
  } as any)
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pubkeys/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      body: JSON.stringify({ paths: [{ address_n: ETH_PATH, type: 'address', networks: ['eip155:1'] }] }),
    })
    return { status: res.status, calls }
  } finally {
    server.stop(true)
  }
}

describe('POST /api/pubkeys/batch during setup', () => {
  const setup: Array<[string, Record<string, unknown>]> = [
    ['bootloader mode', { state: 'bootloader', bootloaderMode: true }],
    ['factory firmware', { state: 'needs_firmware', firmwareVersion: '4.0.0', factoryFirmware: true }],
    ['no wallet', { state: 'needs_init', needsInit: true }],
    ['old firmware on an old bootloader (5.2.4 on 1.0.2)', { state: 'needs_firmware', firmwareVersion: '5.2.4', needsFirmwareUpdate: true, needsBootloaderUpdate: true }],
  ]
  for (const [name, state] of setup) {
    test(`${name}: 503, the device is never asked`, async () => {
      const r = await batch(state)
      expect(r.status).toBe(503)
      expect(r.calls).toEqual([])
    })
  }

  test('a ready device is asked', async () => {
    const r = await batch({})
    expect(r.status).toBe(200)
    expect(r.calls).toEqual(['ethGetAddress'])
  })

  test('a device whose user skipped the firmware update (bootloader current) is still asked', async () => {
    const r = await batch({ state: 'needs_firmware', needsFirmwareUpdate: true, firmwareVersion: '7.10.0' })
    expect(r.status).toBe(200)
    expect(r.calls).toEqual(['ethGetAddress'])
  })
})
