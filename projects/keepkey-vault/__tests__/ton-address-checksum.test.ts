// Jasper audit v5 V7: friendly TON recipients require their CRC16-XMODEM checksum.
// Pure fixtures: no wallet, device or network access.
import { describe, expect, test } from 'bun:test'
import { Address, crc16 } from '@ton/core'
import { validateAddress } from '../src/shared/address-validation'
import { CHAINS } from '../src/shared/chains'

const ton = CHAINS.find(c => c.id === 'ton')!
const hash = Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff)

// Use the independent TON SDK checksum to construct invalid tag/workchain cases.
function friendly(tag: number, workchain: number): string {
  const body = Buffer.from([tag, workchain, ...hash])
  return Buffer.concat([body, crc16(body)]).toString('base64url')
}

describe('TON address checksum (V7)', () => {
  test('real bounceable and non-bounceable addresses pass', () => {
    expect(validateAddress('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', ton)).toEqual({ valid: true })
    expect(validateAddress('UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI', ton)).toEqual({ valid: true })
  })

  test('TON SDK addresses pass for both workchains, tags and base64 alphabets', () => {
    for (const workchain of [0, -1]) for (const bounceable of [true, false]) for (const urlSafe of [true, false]) {
      const address = new Address(workchain, Buffer.from(hash)).toString({ bounceable, urlSafe })
      expect(Address.parseFriendly(address).isTestOnly).toBe(false)
      expect(validateAddress(address, ton)).toEqual({ valid: true })
    }
  })

  test('TON SDK testnet-only addresses are refused for both tags', () => {
    for (const bounceable of [true, false]) {
      const address = new Address(0, Buffer.from(hash)).toString({ bounceable, testOnly: true })
      expect(Address.parseFriendly(address).isTestOnly).toBe(true)
      expect(validateAddress(address, ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
    }
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
    expect(validateAddress(friendly(0x11, 0x00).slice(0, 46), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
    expect(validateAddress(friendly(0x22, 0x00), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
    expect(validateAddress(friendly(0x91, 0x00), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
    expect(validateAddress(friendly(0x11, 0x05), ton)).toEqual({ valid: false, error: 'invalidTonAddress' })
  })

  test('the raw 0:<64 hex> form still passes', () => {
    expect(validateAddress('0:' + '83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8', ton)).toEqual({ valid: true })
    expect(validateAddress('0:' + 'ab'.repeat(31), ton).valid).toBe(false)
  })
})
