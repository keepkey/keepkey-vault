/** Pure native-policy tests: no device, network, wallet profile or signing. */
import { expect, test } from 'bun:test'
import { isAdmittedNu7PhysicalAlpha, ZCASH_NU7_PHYSICAL_ALPHA_SHA256, type Nu7PhysicalSnapshot } from '../src/bun/zcash-nu7-physical'

const wallet = {}
const admitted: Nu7PhysicalSnapshot = {
  wallet, isEmulator: false, activeTransport: 'hid', state: 'ready',
  initialized: true, bootloaderMode: false, firmwareVersion: '7.17.0',
  firmwareHash: ZCASH_NU7_PHYSICAL_ALPHA_SHA256,
}

test('physical Nu7 admission requires the exact current alpha image and a native physical transport', () => {
  expect(isAdmittedNu7PhysicalAlpha(wallet, admitted)).toBe(true)
  expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, activeTransport: 'webusb' })).toBe(true)
  expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, firmwareVersion: 'v7.17.0', firmwareHash: admitted.firmwareHash!.toUpperCase() })).toBe(true)
  expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, firmwareVersion: '7.18.0' })).toBe(true)
  for (const changed of [
    { wallet: {} }, { isEmulator: true }, { activeTransport: 'emulator' },
    { activeTransport: 'unknown' }, { activeTransport: undefined }, { activeTransport: null },
    { state: 'disconnected' }, { state: 'initializing' }, { state: 'error' },
    { state: 'bootloader' }, { state: 'needs_init' }, { bootloaderMode: true },
    { initialized: false }, { initialized: undefined }, { firmwareVersion: '7.16.0' },
    { firmwareVersion: '7.17.0-alpha' }, { firmwareVersion: '7.17' },
    { firmwareVersion: undefined }, { firmwareHash: undefined },
    { firmwareHash: '7.17.0' }, { firmwareHash: ` ${ZCASH_NU7_PHYSICAL_ALPHA_SHA256}` },
    { firmwareHash: ZCASH_NU7_PHYSICAL_ALPHA_SHA256.slice(0, -1) + '9' },
    { firmwareVersion: '99.0.0', firmwareHash: 'f'.repeat(64) },
  ]) expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, ...changed })).toBe(false)
  expect(isAdmittedNu7PhysicalAlpha(null, { ...admitted, wallet: null })).toBe(false)
})

test('legitimate cached-wallet PIN transitions preserve admission without a firmware-picker toggle', () => {
  for (const state of ['ready', 'needs_pin', 'needs_passphrase']) {
    expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, state })).toBe(true)
  }
  // Caller flags cannot substitute for the engine's current physical image.
  const forged = { ...admitted, firmwareHash: 'f'.repeat(64), alphaFirmware: true, isAlphaEmulator: true }
  expect(isAdmittedNu7PhysicalAlpha(wallet, forged)).toBe(false)
})
