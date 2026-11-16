// Jasper audit v5 V10: XRP X-addresses were reported as invalid, and valid Zcash
// TEX addresses got a false "invalid checksum". Both now say "not supported".
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { base58xrp, bech32m } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { validateAddress } from '../src/shared/address-validation'
import { CHAINS } from '../src/shared/chains'

const xrp = CHAINS.find(c => c.id === 'ripple')!
const zcash = CHAINS.find(c => c.id === 'zcash')!
const flip = (s: string, i: number, a: string, b: string) => s.slice(0, i) + (s[i] === a ? b : a) + s.slice(i + 1)

// X-address built independently: prefix + account + flag + 8-byte tag + checksum.
function xAddress(prefix: number[], account: number[], tag: number): string {
  const tagBytes = Array.from({ length: 8 }, (_, i) => (i < 4 ? (tag >>> (8 * i)) & 0xff : 0))
  const body = Uint8Array.from([...prefix, ...account, 1, ...tagBytes])
  return base58xrp.encode(Uint8Array.from([...body, ...sha256(sha256(body)).slice(0, 4)]))
}
const account = Array.from({ length: 20 }, (_, i) => (i * 13 + 5) & 0xff)

describe('XRP X-addresses (V10)', () => {
  test("Jasper's X-address gets the 'not supported' message, not 'invalid'", () => {
    expect(validateAddress('XVLhHMPHU98es4dbozjVtdWzVrDjtV18pX8yuPT7y4xaEHi', xrp)).toEqual({ valid: false, error: 'xrpXAddressNotSupported' })
  })

  test('mainnet and testnet X-addresses are recognised; a typo is just invalid', () => {
    const main = xAddress([0x05, 0x44], account, 12345)
    expect(main.startsWith('X')).toBe(true)
    expect(validateAddress(main, xrp).error).toBe('xrpXAddressNotSupported')
    expect(validateAddress(xAddress([0x04, 0x93], account, 7), xrp).error).toBe('xrpXAddressNotSupported')
    expect(validateAddress(flip(main, 10, 'a', 'b'), xrp)).toEqual({ valid: false, error: 'invalidXrpAddress' })
  })

  test('classic r-addresses are unchanged', () => {
    expect(validateAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', xrp)).toEqual({ valid: true })
  })
})

describe('Zcash TEX addresses (V10)', () => {
  const tex = bech32m.encode('tex', bech32m.toWords(Uint8Array.from(account)))

  test("a valid tex1 address gets 'TEX not supported yet', not 'invalid checksum'", () => {
    expect(validateAddress(tex, zcash)).toEqual({ valid: false, error: 'zcashTexNotSupported' })
    expect(validateAddress(tex.toUpperCase(), zcash).error).toBe('zcashTexNotSupported')
  })

  test('a tex1 typo still reports the checksum; a wrong payload length is invalid', () => {
    expect(validateAddress(flip(tex, 12, 'q', 'p'), zcash)).toEqual({ valid: false, error: 'invalidChecksum' })
    const short = bech32m.encode('tex', bech32m.toWords(new Uint8Array(19).fill(3)))
    expect(validateAddress(short, zcash)).toEqual({ valid: false, error: 'invalidZecAddress' })
  })

  test('transparent t1 addresses are unchanged', () => {
    expect(validateAddress('t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs', zcash).valid).toBe(true)
  })
})

describe('the new messages exist in every locale', () => {
  const dir = join(import.meta.dir, '../src/mainview/i18n/locales')
  for (const locale of readdirSync(dir)) {
    test(locale, () => {
      const send = JSON.parse(readFileSync(join(dir, locale, 'send.json'), 'utf8'))
      expect(typeof send.xrpXAddressNotSupported).toBe('string')
      expect(typeof send.zcashTexNotSupported).toBe('string')
    })
  }
})
