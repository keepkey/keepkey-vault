/** Pure native-policy tests: no device, network, wallet profile or signing. */
import { expect, test } from 'bun:test'
import { isAdmittedNu7PhysicalAlpha, type Nu7PhysicalSnapshot } from '../src/bun/zcash-nu7-physical'

const wallet = {}
const admitted: Nu7PhysicalSnapshot = {
  wallet, isEmulator: false, activeTransport: 'hid', state: 'ready',
  initialized: true, bootloaderMode: false, firmwareVersion: '7.17.0',
  firmwareHash: 'a'.repeat(64),
}

test('physical Nu7 admission admits any firmware >= 7.17.0 (any image hash) over a native physical transport', () => {
  expect(isAdmittedNu7PhysicalAlpha(wallet, admitted)).toBe(true)
  expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, activeTransport: 'webusb' })).toBe(true)
  expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, firmwareVersion: 'v7.17.0', firmwareHash: admitted.firmwareHash!.toUpperCase() })).toBe(true)
  expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, firmwareVersion: '7.18.0' })).toBe(true)
  for (const firmwareHash of ['f'.repeat(64), '0'.repeat(64), undefined]) {
    expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, firmwareHash })).toBe(true)
  }
  for (const changed of [
    { wallet: {} }, { isEmulator: true }, { activeTransport: 'emulator' },
    { activeTransport: 'unknown' }, { activeTransport: undefined }, { activeTransport: null },
    { state: 'disconnected' }, { state: 'initializing' }, { state: 'error' },
    { state: 'bootloader' }, { state: 'needs_init' }, { bootloaderMode: true },
    { initialized: false }, { initialized: undefined }, { firmwareVersion: '7.16.0' },
    { firmwareVersion: '7.17.0-alpha' }, { firmwareVersion: '7.17' },
    { firmwareVersion: undefined }, { firmwareVersion: '7.16.1' }, { firmwareVersion: '7.15.0' },
  ]) expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, ...changed })).toBe(false)
  expect(isAdmittedNu7PhysicalAlpha(null, { ...admitted, wallet: null })).toBe(false)
})

test('legitimate cached-wallet PIN transitions preserve admission without a firmware-picker toggle', () => {
  for (const state of ['ready', 'needs_pin', 'needs_passphrase']) {
    expect(isAdmittedNu7PhysicalAlpha(wallet, { ...admitted, state })).toBe(true)
  }
  // Caller flags cannot substitute for the engine's firmware version.
  const forged = { ...admitted, firmwareVersion: '7.16.0', alphaFirmware: true, isAlphaEmulator: true }
  expect(isAdmittedNu7PhysicalAlpha(wallet, forged)).toBe(false)
})
