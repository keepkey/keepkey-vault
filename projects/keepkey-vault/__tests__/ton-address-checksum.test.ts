// Jasper audit v5 V7: TON accepted any 46–48 character base64url string.
// User-friendly addresses must decode to 36 bytes with a CRC16-XMODEM checksum.
import { describe, expect, test } from 'bun:test'
import { validateAddress } from '../src/shared/address-validation'
import { CHAINS } from '../src/shared/chains'

const ton = CHAINS.find(c => c.id === 'ton')!

// Independent encoder for the test: tag + workchain + hash + CRC16-XMODEM, base64url.
function crc16(bytes: number[]): number {
  let crc = 0
  for (const b of bytes) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff
  }
  return crc
}
function friendly(tag: number, workchain: number, hash: number[]): string {
  const body = [tag, workchain, ...hash]
  const crc = crc16(body)
  const bytes = [...body, crc >> 8, crc & 0xff]
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
}
const hash = Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff)

describe('TON address checksum (V7)', () => {
  test('real bounceable and non-bounceable addresses pass', () => {
    expect(validateAddress('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', ton)).toEqual({ valid: true })
    expect(validateAddress('UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI', ton)).toEqual({ valid: true })
  })

  test('addresses built independently pass, in base64url and standard base64', () => {
    const bounceable = friendly(0x11, 0x00, hash)
    expect(validateAddress(bounceable, ton).valid).toBe(true)
    expect(validateAddress(friendly(0x51, 0x00, hash), ton).valid).toBe(true)
    expect(validateAddress(friendly(0x11, 0xff, hash), ton).valid).toBe(true) // masterchain
    expect(validateAddress(bounceable.replace(/-/g, '+').replace(/_/g, '/'), ton).valid).toBe(true)
  })

  test("Jasper's repro strings are rejected", () => {
    expect(validateAddress('EQ' + 'A'.repeat(46), ton).valid).toBe(false)
    expect(validateAddress('hello_world_this_is_not_a_ton_address_at_all__', ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
  })

  test('one changed character fails the checksum', () => {
    const addr = 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N'
    const typo = addr.slice(0, 20) + (addr[20] === 'a' ? 'b' : 'a') + addr.slice(21)
    expect(validateAddress(typo, ton)).toEqual({ valid: false, error: 'invalidChecksum' })
  })

  test('wrong length, unknown tag, testnet tag and unknown workchain are rejected', () => {
    expect(validateAddress(friendly(0x11, 0x00, hash).slice(0, 46), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
    expect(validateAddress(friendly(0x22, 0x00, hash), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
    expect(validateAddress(friendly(0x91, 0x00, hash), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
    expect(validateAddress(friendly(0x11, 0x05, hash), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
  })

  test('the raw 0:<64 hex> form still passes', () => {
    expect(validateAddress('0:' + '83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8', ton)).toEqual({ valid: true })
    expect(validateAddress('0:' + 'ab'.repeat(31), ton).valid).toBe(false)
  })
})
