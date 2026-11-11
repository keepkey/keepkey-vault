import { describe, expect, test } from 'bun:test'
// @ts-ignore CJS
import bs58check from 'bs58check'
import emulatorManifest from '../emulator-bundle/manifest.json'
import { gateDeviceRpc } from '../src/bun/device-rpc'
import { preflightNu7DeviceRpc, ZCASH_MEMO_REFUSAL } from '../src/bun/zcash-nu7-admission'
import { isQualifiedNu7AlphaEmulator, type Nu7EmulatorSnapshot } from '../src/bun/zcash-nu7-emulator'
import { ZCASH_NU7_REFUSALS, zcashNu7Admission, type ZcashNu7Device } from '../src/shared/zcash-nu7'

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

const physical = (patch: Partial<ZcashNu7Device> = {}): ZcashNu7Device => ({
  transport: 'webusb', firmwareVersion: '7.16.0', firmwareVariant: 'KeepKey', bootloaderMode: false, initialized: true, ...patch,
})
const alphaEmulator: ZcashNu7Device = { transport: 'emulator', firmwareVersion: '7.17.0', firmwareVariant: 'Emulator', qualifiedAlphaEmulator: true }
const outcome = (device: ZcashNu7Device, builder = true) => {
  const result = zcashNu7Admission(device, builder)
  return 'route' in result ? result.route : result.refusal
}

describe('admission matrix: decided only from the KeepKey\'s own facts', () => {
  const matrix: Array<[string, ZcashNu7Device, string]> = [
    ['physical 7.14.2 (current stable)', physical({ firmwareVersion: '7.14.2' }), 'firmware'],
    ['physical 7.15.0', physical({ firmwareVersion: '7.15.0' }), 'firmware'],
    ['physical 7.15.9', physical({ firmwareVersion: '7.15.9' }), 'firmware'],
    ['physical 7.16.0 over WebUSB', physical(), 'physical'],
    ['physical 7.16.0 over HID', physical({ transport: 'hid' }), 'physical'],
    ['physical 7.16.1', physical({ firmwareVersion: '7.16.1' }), 'physical'],
    ['physical 7.17.0', physical({ firmwareVersion: '7.17.0' }), 'physical'],
    ['physical without a readable version', physical({ firmwareVersion: undefined }), 'firmware'],
    ['physical with a malformed version', physical({ firmwareVersion: '7.16' }), 'firmware'],
    ['physical in bootloader mode (reports the bootloader version)', physical({ bootloaderMode: true, firmwareVersion: '7.16.0' }), 'device'],
    ['physical without a wallet', physical({ initialized: false }), 'device'],
    ['physical Bitcoin-only 7.16.0', physical({ firmwareVariant: 'KeepKeyBTC' }), 'variant'],
    ['reviewed 7.17 alpha emulator', alphaEmulator, 'alpha-emulator'],
    ['emulator without reviewed provenance or opt-in', { ...alphaEmulator, qualifiedAlphaEmulator: false }, 'emulator'],
    ['emulator reporting 7.16.0', { ...alphaEmulator, firmwareVersion: '7.16.0' }, 'emulator'],
    ['no device', { transport: null, firmwareVersion: '7.16.0' }, 'device'],
    ['unknown transport', { transport: 'tcp', firmwareVersion: '7.16.0' }, 'device'],
  ]
  for (const [name, device, expected] of matrix) test(name, () => expect(outcome(device)).toBe(expected))

  test('an emulator flag cannot turn a physical KeepKey into the emulator route, or the reverse', () => {
    expect(outcome(physical({ qualifiedAlphaEmulator: true, firmwareVersion: '7.15.0' }))).toBe('firmware')
    expect(outcome({ ...alphaEmulator, transport: 'webusb', firmwareVersion: '7.15.9' })).toBe('firmware')
  })
  test('an admitted device without the verified builder is refused', () => {
    expect(outcome(physical(), false)).toBe('builder')
    expect(outcome(alphaEmulator, false)).toBe('builder')
    expect(outcome(physical({ firmwareVersion: '7.15.0' }), false)).toBe('firmware')
  })
  test('the old-firmware refusal is plain and follows the Safe update pattern', () => {
    const result = zcashNu7Admission(physical({ firmwareVersion: '7.15.0' }))
    expect(result).toEqual({ refusal: 'firmware', reason: 'Sending ZEC needs KeepKey firmware 7.16 or newer. Update it from Settings (opt in to new firmware).' })
    for (const reason of Object.values(ZCASH_NU7_REFUSALS)) expect(reason).not.toMatch(/0x|Nu7|NU7|PCZT|branch/)
  })
})

describe('refusals happen before device acquisition or a PIN prompt', () => {
  const scope = { wallet, epoch: 1, seed: 'public-fixture' }
  async function call(method: string, params: Record<string, unknown>, device: ZcashNu7Device) {
    let acquisitions = 0, dispatched = 0
    const rpc: any = gateDeviceRpc({ [method]: async () => { dispatched++; return 'admitted' } }, {
      scope: () => scope, locked: () => true,
      run: async action => { acquisitions++; return action() },
      preflight: (name, data) => preflightNu7DeviceRpc(name, data, () => zcashNu7Admission(device)),
    })
    let error: Error | undefined, result: unknown
    try { result = await rpc[method](params) } catch (e) { error = e as Error }
    return { error: error?.message, result, acquisitions, dispatched }
  }
  const H = 0x80000000
  const t1 = bs58check.encode(Buffer.from(`1cb8${'55'.repeat(20)}`, 'hex'))
  const plan = (patch: Record<string, unknown> = {}) => ({
    coin: 'Zcash', zcashTransparent: true, version: 6, versionGroupId: 0xd884b698, locktime: 0, expiry: 0,
    inputs: [{ txid: '11'.repeat(32), vout: 0, amount: '60000', addressNList: [H + 44, H + 133, H, 0, 0], scriptType: 'p2pkh', scriptPubkey: `76a914${'22'.repeat(20)}88ac` }],
    outputs: [{ address: t1, amount: '50000', addressType: 'spend' }],
    ...patch,
  })
  const zecRequests: Array<[string, Record<string, unknown>]> = [
    ['buildTx', { chainId: 'zcash', to: t1, amount: '0.0005' }],
    ['btcSignTx', plan()],
    ['executeSwap', { fromChainId: 'zcash', memo: '' }],
    ['previewSwapBuild', { fromChainId: 'zcash', memo: '' }],
  ]

  for (const version of ['7.14.2', '7.15.0', '7.15.9']) for (const [method, params] of zecRequests) test(`firmware ${version}: ${method} is refused with update copy, before PIN`, async () => {
    // Renderer/REST flags claiming support are ignored.
    const r = await call(method, { ...params, isEmulator: true, isAlphaEmulator: true, firmwareVersion: '7.17.0', route: 'physical' }, physical({ firmwareVersion: version }))
    expect(r.error).toBe(ZCASH_NU7_REFUSALS.firmware)
    expect([r.acquisitions, r.dispatched]).toEqual([0, 0])
  })

  for (const [method, params] of zecRequests) for (const [label, device] of [['physical 7.16.0', physical()], ['physical 7.16.0 HID', physical({ transport: 'hid' })], ['reviewed 7.17 alpha emulator', alphaEmulator]] as const) test(`${label}: ${method} reaches its ordinary device operation`, async () => {
    const r = await call(method, params, device)
    expect(r.error).toBeUndefined()
    expect([r.acquisitions, r.dispatched]).toEqual([1, 1])
  })

  test('unsupported scripts, paths, versions and memos are refused before PIN on an admitted device', async () => {
    const unsupported: Array<[string, Record<string, unknown>]> = [
      ['btcSignTx', plan({ inputs: [{ ...plan().inputs[0], scriptPubkey: `a914${'22'.repeat(20)}87` }] })], // P2SH input
      ['btcSignTx', plan({ inputs: [{ ...plan().inputs[0], scriptType: 'p2sh' }] })],
      ['btcSignTx', plan({ inputs: [{ ...plan().inputs[0], addressNList: [H + 44, H + 133, H, 3, 0] }] })],
      ['btcSignTx', plan({ version: 4, versionGroupId: 0x892f2085 })], // legacy v4
      ['btcSignTx', plan({ version: 5 })],
      ['btcSignTx', plan({ memo: 'invoice 42' })],
      ['btcSignTx', plan({ opReturnData: 'invoice 42' })],
      ['btcSignTx', plan({ outputs: [{ address: 'zs1notatransparentaddress', amount: '50000', addressType: 'spend' }] })],
    ]
    for (const [method, params] of unsupported) {
      const r = await call(method, params, physical())
      expect(r.error).toMatch(/^Zcash Nu7: /)
      expect([r.acquisitions, r.dispatched]).toEqual([0, 0])
    }
    for (const [method, params] of [
      ['buildTx', { chainId: 'zcash', memo: 'invoice 42' }],
      ['executeSwap', { fromChainId: 'zcash', memo: '=:ETH.ETH:0xabc' }],
      ['previewSwapBuild', { quote: { fromChainId: 'zcash', memo: '=:ETH.ETH:0xabc' } }],
    ] as const) {
      const r = await call(method, params, physical())
      expect(r.error).toBe(ZCASH_MEMO_REFUSAL)
      expect([r.acquisitions, r.dispatched]).toEqual([0, 0])
    }
  })

  test('Bitcoin, other swaps and balance reads never consult Zcash admission', async () => {
    for (const [method, params] of [['btcSignTx', { coin: 'Bitcoin' }], ['buildTx', { chainId: 'bitcoin', memo: 'x' }], ['executeSwap', { fromChainId: 'ethereum', memo: 'x' }]] as const) {
      const r = await call(method, params, physical({ firmwareVersion: '7.10.0' }))
      expect(r.error).toBeUndefined()
      expect(r.acquisitions).toBe(1)
    }
  })
})
