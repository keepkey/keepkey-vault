import { expect, test } from 'bun:test'
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto'
import { HDKey } from '@scure/bip32'
import type { CipherWallet } from '../src/bun/password-device'
import { deriveVolumePassword } from '../src/bun/volume-key'
import { makeVolumeKeyRecord, parseVolumeKeyRecord } from '../src/shared/volume-key'

const record = parseVolumeKeyRecord({ version: 1, id: '00000000000000000000000000000001' })
const device = { state: 'ready', firmwareVariant: 'KeepKey', isEmulator: false, isCurrent: () => true }
const expected = 'e1da6e6c4dd5f36077af7068b42f8a7336bc749431cdac6c495497817a784a7e'
const expectedCiphertext = '08ca01247b118f33aff6d16118ce32b3637706a2a9faff2fe754eba3a7bbef8f'

// Firmware-compatible model using the public BIP39 vector. This runs only in tests.
function restoredTestWallet(passphrase = ''): CipherWallet {
  const phrase = Array(11).fill('abandon').concat('about').join(' ')
  const seed = pbkdf2Sync(phrase, 'mnemonic' + passphrase, 2048, 64, 'sha512')
  return { cipherKeyValue: async params => {
    let node = HDKey.fromMasterSeed(new Uint8Array(seed))
    for (const index of params.addressNList) node = node.deriveChild(index)
    const flags = (params.askOnEncrypt ? 'E1' : 'E0') + (params.askOnDecrypt ? 'D1' : 'D0')
    const key = createHmac('sha512', node.privateKey!).update(params.key + flags).digest().subarray(0, 32)
    const cipher = createCipheriv('aes-256-cbc', new Uint8Array(key), params.iv)
    cipher.setAutoPadding(false)
    return Buffer.concat([new Uint8Array(cipher.update(params.value)), new Uint8Array(cipher.final())]).toString('base64')
  } }
}

test('public v1 fixture matches independent firmware calculation and reproduces on a restored device', async () => {
  let approvals = 0
  const wallet: CipherWallet = { cipherKeyValue: async params => {
    approvals++
    expect(params.addressNList).toEqual([0x80002720, 0x8000000c, 0x80000001])
    expect(params.key).toBe('KeepKey Volume v1 00000000000000000000000000000001')
    expect([params.askOnEncrypt, params.askOnDecrypt, params.encrypt]).toEqual([true, true, true])
    expect(params.value).toEqual(new Uint8Array(32))
    expect(params.iv).toEqual(new Uint8Array(16))
    const result = await restoredTestWallet().cipherKeyValue(params) as string
    expect(Buffer.from(result, 'base64').toString('hex')).toBe(expectedCiphertext)
    return result
  } }
  expect((await deriveVolumePassword(record, wallet, device)).toString('ascii')).toBe(expected)
  expect(approvals).toBe(1)
  const copy = parseVolumeKeyRecord(JSON.parse(JSON.stringify(record)))
  expect((await deriveVolumePassword(copy, restoredTestWallet(), device)).toString('ascii')).toBe(expected)
  expect((await deriveVolumePassword(copy, restoredTestWallet('other'), device)).toString('ascii')).not.toBe(expected)
  const other = { ...copy, id: '00000000000000000000000000000002' }
  expect((await deriveVolumePassword(other, restoredTestWallet(), device)).toString('ascii')).not.toBe(expected)
})

test('recovery records contain version and a fresh canonical 128-bit identifier', () => {
  const fresh = makeVolumeKeyRecord()
  expect(fresh).toEqual({ version: 1, id: expect.stringMatching(/^[0-9a-f]{32}$/) })
  expect(makeVolumeKeyRecord().id).not.toBe(fresh.id)
  for (const invalid of [undefined, record.id, { ...record, version: 2 }, { ...record, id: 'A'.repeat(32) },
    { ...record, id: record.id + '\n' }, { ...record, id: '' }]) {
    expect(() => parseVolumeKeyRecord(invalid)).toThrow('recovery record')
  }
})

test('refuses emulator, unsupported variant and stale sessions without contacting hardware', async () => {
  let approvals = 0
  const wallet = { cipherKeyValue: async () => { approvals++; return new Uint8Array(32) } }
  for (const change of [{ state: 'disconnected' }, { isEmulator: true }, { firmwareVariant: 'KeepKeyBTC' }, { isCurrent: () => false }]) {
    await expect(deriveVolumePassword(record, wallet, { ...device, ...change })).rejects.toThrow()
  }
  expect(approvals).toBe(0)
})

test('cancellation, malformed replies and switching wallets during confirmation yield no password', async () => {
  const cancelled = { cipherKeyValue: async () => { throw new Error('Action cancelled') } }
  await expect(deriveVolumePassword(record, cancelled, device)).rejects.toThrow('cancelled')
  for (const reply of [new Uint8Array(16), 'bad response']) {
    await expect(deriveVolumePassword(record, { cipherKeyValue: async () => reply }, device)).rejects.toThrow('Invalid volume key')
  }
  let current = true
  const reply = new Uint8Array(32).fill(1)
  const switched = { cipherKeyValue: async () => { current = false; return reply } }
  await expect(deriveVolumePassword(record, switched, { ...device, isCurrent: () => current })).rejects.toThrow('session changed')
  expect(reply).toEqual(new Uint8Array(32))
})
