import { describe, expect, test } from 'bun:test'
import { base58xrp, bech32, bech32m, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import { validateAddress } from '../src/shared/address-validation'
import { CHAINS } from '../src/shared/chains'

const chain = (id: string) => {
  const c = CHAINS.find(x => x.id === id)
  if (!c) throw new Error(`no chain ${id}`)
  return c
}
const ok = (id: string, addr: string) => expect(validateAddress(addr, chain(id))).toEqual({ valid: true })
const badChecksum = (id: string, addr: string) => expect(validateAddress(addr, chain(id))).toEqual({ valid: false, error: 'invalidChecksum' })
const invalid = (id: string, addr: string) => expect(validateAddress(addr, chain(id)).valid).toBe(false)

/** Change the last character to another one from the same alphabet (a one-character typo). */
const typo = (addr: string, alphabet: string) => {
  const last = addr[addr.length - 1]
  const lowerAlpha = alphabet.toLowerCase() === alphabet
  const next = alphabet[(alphabet.indexOf(lowerAlpha ? last.toLowerCase() : last) + 1) % alphabet.length]
  const upperLetter = /[A-Z]/.test(last)
  return addr.slice(0, -1) + (upperLetter && lowerAlpha ? next.toUpperCase() : next)
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const XRP58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'
const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

// Independent encoders for chains without published test vectors (fixed 20-byte hash).
const HASH20 = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff)
const b58c = createBase58check(sha256)
const b58addr = (version: number[]) => b58c.encode(Uint8Array.from([...version, ...HASH20]))
const segwit = (hrp: string, version: number, program: Uint8Array) =>
  (version === 0 ? bech32 : bech32m).encode(hrp, [version, ...(version === 0 ? bech32 : bech32m).toWords(program)])

describe('EVM: EIP-55', () => {
  // Test vectors from EIP-55.
  const valid = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]
  test('accepts correctly checksummed addresses on every EVM chain', () => {
    for (const a of valid) for (const id of ['ethereum', 'base', 'arbitrum', 'polygon']) ok(id, a)
  })
  test('accepts all-lowercase and all-uppercase hex (no checksum by spec)', () => {
    ok('base', valid[0].toLowerCase())
    ok('base', '0x' + valid[0].slice(2).toUpperCase())
  })
  test('rejects a mixed-case address whose casing does not match its checksum (the audit case)', () => {
    // EVM keeps its own message key (invalidEvmChecksum), as on develop.
    const badEvm = (id: string, addr: string) => expect(validateAddress(addr, chain(id))).toEqual({ valid: false, error: 'invalidEvmChecksum' })
    badEvm('base', '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed') // one letter lower-cased
    badEvm('ethereum', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')
    badEvm('ethereum', '0xFB6916095ca1df60bB79Ce92cE3Ea74c37c5d359')
  })
  test('still rejects malformed hex', () => {
    invalid('ethereum', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe')
    invalid('ethereum', '0xZZAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')
  })
})

describe('Bitcoin: bech32 / bech32m / base58check', () => {
  test('BIP-173 v0 vectors pass; a changed last character fails the checksum (the audit case)', () => {
    ok('bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    ok('bitcoin', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')
    ok('bitcoin', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3')
    badChecksum('bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')
    badChecksum('bitcoin', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv4')
  })
  test('BIP-350 taproot (bech32m) passes; wrong checksum algorithm per witness version fails', () => {
    const tr = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
    ok('bitcoin', tr)
    badChecksum('bitcoin', typo(tr, BECH))
    const program = Uint8Array.from({ length: 32 }, (_, i) => i)
    // v1 encoded with bech32 and v0 encoded with bech32m are invalid (BIP-350).
    badChecksum('bitcoin', bech32.encode('bc', [1, ...bech32.toWords(program)]))
    badChecksum('bitcoin', bech32m.encode('bc', [0, ...bech32m.toWords(HASH20)]))
  })
  test('mixed-case bech32 and wrong network hrp are rejected', () => {
    invalid('bitcoin', 'bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    invalid('bitcoin', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
  })
  test('base58check: genesis P2PKH and a P2SH pass; one changed character fails', () => {
    ok('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')
    ok('bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')
    badChecksum('bitcoin', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')
    badChecksum('bitcoin', typo('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', B58))
  })
  test('another coin’s base58 version byte is rejected', () => {
    invalid('bitcoin', b58addr([0x30])) // a Litecoin L-address
  })
})

describe('Other UTXO chains: base58check and bech32', () => {
  const cases: [string, number[]][] = [['litecoin', [0x30]], ['litecoin', [0x32]], ['dogecoin', [0x1e]], ['dash', [0x4c]], ['digibyte', [0x1e]], ['bitcoincash', [0x00]]]
  test.each(cases)('%s base58 version %p: valid passes, typo fails', (id, version) => {
    const addr = b58addr(version)
    ok(id, addr)
    badChecksum(id, typo(addr, B58))
  })
  test('Litecoin and DigiByte native segwit check their own hrp and checksum', () => {
    for (const [id, hrp] of [['litecoin', 'ltc'], ['digibyte', 'dgb']] as const) {
      const addr = segwit(hrp, 0, HASH20)
      ok(id, addr)
      badChecksum(id, typo(addr, BECH))
      invalid(id, segwit('bc', 0, HASH20))
    }
  })
  test('Zcash transparent t1/t3 (two-byte versions)', () => {
    for (const v of [[0x1c, 0xb8], [0x1c, 0xbd]]) {
      const addr = b58addr(v)
      expect(addr.startsWith('t')).toBe(true)
      ok('zcash', addr)
      badChecksum('zcash', typo(addr, B58))
    }
    invalid('zcash', 't1' + 'A'.repeat(33)) // shaped like a t-address, not one
  })
})

describe('Bitcoin Cash cashaddr', () => {
  // CashAddr spec vector (P2PKH for 1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu).
  const addr = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
  test('valid with and without the prefix, upper or lower case', () => {
    ok('bitcoincash', addr)
    ok('bitcoincash', addr.replace('bitcoincash:', ''))
    ok('bitcoincash', addr.toUpperCase())
  })
  test('one changed character fails the checksum', () => {
    badChecksum('bitcoincash', typo(addr, BECH))
    badChecksum('bitcoincash', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx7a')
  })
})

describe('Cosmos family bech32', () => {
  test.each([['cosmos', 'cosmos'], ['thorchain', 'thor'], ['mayachain', 'maya'], ['osmosis', 'osmo']])('%s', (id, hrp) => {
    const addr = bech32.encode(hrp, bech32.toWords(HASH20))
    ok(id, addr)
    badChecksum(id, typo(addr, BECH))
    invalid(id, bech32.encode('cosmos' === hrp ? 'osmo' : 'cosmos', bech32.toWords(HASH20)))
  })
})

describe('XRP, Tron, Solana', () => {
  test('XRP: genesis account passes; one changed character fails the checksum', () => {
    ok('ripple', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')
    badChecksum('ripple', typo('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', XRP58))
    // Built with the XRP alphabet independently of the validator.
    const payload = Uint8Array.from([0x00, ...HASH20])
    const addr = base58xrp.encode(Uint8Array.from([...payload, ...sha256(sha256(payload)).slice(0, 4)]))
    ok('ripple', addr)
  })
  test('Tron: USDT contract address passes; one changed character fails', () => {
    ok('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')
    badChecksum('tron', typo('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', B58))
  })
  test('Solana: a 32-byte key passes; base58 text that is not 32 bytes fails', () => {
    ok('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    invalid('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt')
    invalid('solana', '1'.repeat(32) + 'A'.repeat(12))
  })
})

describe('Zcash shielded', () => {
  test('Sapling (bech32) and unified (bech32m, longer than 90 chars) verify their checksums', () => {
    const sapling = bech32.encode('zs', bech32.toWords(Uint8Array.from({ length: 43 }, (_, i) => i)), false)
    ok('zcash-shielded', sapling)
    badChecksum('zcash-shielded', typo(sapling, BECH))
    const unified = bech32m.encode('u', bech32m.toWords(Uint8Array.from({ length: 107 }, (_, i) => (i * 7) & 0xff)), false)
    expect(unified.length).toBeGreaterThan(90)
    ok('zcash-shielded', unified)
    badChecksum('zcash-shielded', typo(unified, BECH))
  })
})
