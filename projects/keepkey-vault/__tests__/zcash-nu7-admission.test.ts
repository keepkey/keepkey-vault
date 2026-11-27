import { describe, expect, test } from 'bun:test'
import emulatorManifest from '../emulator-bundle/manifest.json'
import { gateDeviceRpc } from '../src/bun/device-rpc'
import { preflightNu7DeviceRpc } from '../src/bun/zcash-nu7-admission'
import { isQualifiedNu7AlphaEmulator, type Nu7EmulatorSnapshot } from '../src/bun/zcash-nu7-emulator'

const wallet = {}
const eligible: Nu7EmulatorSnapshot = {
  wallet, isEmulator: true, running: true, alphaFirmware: true,
  firmwareVersion: '7.17.0', librarySha256: emulatorManifest.files['libkkemu.dylib'].sha256,
}

test('Nu7 qualification binds the active wallet, transport, boot, opt-in and actual reviewed library bytes', () => {
  expect(isQualifiedNu7AlphaEmulator(wallet, eligible)).toBe(true)
  for (const changed of [
    { wallet: {} }, { isEmulator: false }, { running: false }, { alphaFirmware: false },
    { firmwareVersion: '7.16.0' }, { firmwareVersion: undefined },
    { librarySha256: null }, { librarySha256: 'f'.repeat(64) },
  ]) expect(isQualifiedNu7AlphaEmulator(wallet, { ...eligible, ...changed })).toBe(false)
  expect(isQualifiedNu7AlphaEmulator(null, { ...eligible, wallet: null })).toBe(false)
  // An installed or picker-labelled build is not a loaded, reviewed instance.
  expect(isQualifiedNu7AlphaEmulator(wallet, { ...eligible, librarySha256: '7.17.0' })).toBe(false)
})

describe('Nu7 admission precedes device acquisition', () => {
  const requests = [
    ['buildTx', { chainId: 'zcash' }],
    ['btcSignTx', { coin: 'Zcash' }],
    ['executeSwap', { quote: { fromChainId: 'zcash' } }],
    ['previewSwapBuild', { fromChainId: 'zcash' }],
    ['auditSweepPath', { chainId: 'zcash' }],
  ] as const
  for (const [method, params] of requests) test(`${method} cannot request a PIN or use forged renderer emulator flags`, async () => {
    let acquisitions = 0, dispatched = 0
    const scope = { wallet, epoch: 1, seed: 'public-fixture' }
    const rpc = gateDeviceRpc({ [method]: async () => { dispatched++; return 'signed' } }, {
      scope: () => scope, locked: () => true,
      run: async action => { acquisitions++; return action() },
      preflight: (name, data) => preflightNu7DeviceRpc(name, data, '7.17.0', true, false),
    })
    await expect(rpc[method]({ ...params, isEmulator: true, isAlphaEmulator: true, firmwareVersion: '7.17.0' })).rejects.toThrow(/firmware 7\.17/i)
    expect(acquisitions).toBe(0)
    expect(dispatched).toBe(0)
  })

  test('a qualified emulator can enter its ordinary operation; BTC and reads stay independent', async () => {
    let acquisitions = 0
    const rpc = gateDeviceRpc({ btcSignTx: async () => 'ok', buildTx: async () => 'built', getBalance: async () => ({ balance: '1' }) }, {
      scope: () => ({ wallet, epoch: 1, seed: null }), locked: () => false,
      run: async action => { acquisitions++; return action() },
      preflight: (name, data) => preflightNu7DeviceRpc(name, data, '7.17.0', true, true),
    })
    expect(await rpc.buildTx({ chainId: 'zcash' })).toBe('built')
    expect(await rpc.btcSignTx({ coin: 'Bitcoin' })).toBe('ok')
    expect(await rpc.getBalance({ chainId: 'zcash' })).toEqual({ balance: '1' })
    expect(acquisitions).toBe(3)
  })

  test('even a qualified emulator cannot use the legacy audit sweep builder; other UTXO sweeps still enter', async () => {
    let acquisitions = 0, derives = 0, network = 0, approvals = 0
    const rpc = gateDeviceRpc({ auditSweepPath: async () => { derives++; network++; approvals++; return 'swept' } }, {
      scope: () => ({ wallet, epoch: 1, seed: null }), locked: () => false,
      run: async action => { acquisitions++; return action() },
      preflight: (name, data) => preflightNu7DeviceRpc(name, data, '7.17.0', true, true),
    })
    await expect(rpc.auditSweepPath({ chainId: 'zcash', dryRun: true })).rejects.toThrow('audit sweeps are unavailable')
    await expect(rpc.auditSweepPath({ chainId: 'zcash', dryRun: false })).rejects.toThrow('audit sweeps are unavailable')
    expect({ acquisitions, derives, network, approvals }).toEqual({ acquisitions: 0, derives: 0, network: 0, approvals: 0 })
    expect(await rpc.auditSweepPath({ chainId: 'litecoin' })).toBe('swept')
    expect({ acquisitions, derives, network, approvals }).toEqual({ acquisitions: 1, derives: 1, network: 1, approvals: 1 })
  })
})
