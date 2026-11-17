import { describe, expect, test } from 'bun:test'
import { bech32, bech32m } from '@scure/base'
import { sameAddress, validateAddress } from '../src/shared/address-validation'
import { CHAINS } from '../src/shared/chains'

const chain = (id: string) => CHAINS.find(value => value.id === id)!
const btc = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
const bch = 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'

describe('sameAddress compares encoding identities without weakening validation', () => {
  test('Bitcoin bech32 and BCH optional prefixes/case identify the same destination', () => {
    expect(sameAddress(btc, btc.toUpperCase(), chain('bitcoin'))).toBe(true)
    expect(sameAddress(btc, btc.toUpperCase())).toBe(false)
    for (const value of [bch, 'bitcoincash:' + bch, bch.toUpperCase(), ('bitcoincash:' + bch).toUpperCase()]) {
      expect(validateAddress(value, chain('bitcoincash')).valid).toBe(true)
      expect(sameAddress('bitcoincash:' + bch, value, chain('bitcoincash'))).toBe(true)
      expect(sameAddress('bitcoincash:' + bch, value)).toBe(true)
    }
  })

  test('bech32m and Cosmos case folding still requires an actual checksum and matching HRP', () => {
    const words = bech32m.toWords(new Uint8Array(32).fill(7))
    const taproot = bech32m.encode('bc', [1, ...words])
    const cosmos = bech32.encode('cosmos', bech32.toWords(new Uint8Array(20).fill(8)))
    expect(sameAddress(taproot, taproot.toUpperCase(), chain('bitcoin'))).toBe(true)
    expect(sameAddress(cosmos, cosmos.toUpperCase(), chain('cosmos'))).toBe(true)
    expect(sameAddress(taproot, taproot.toUpperCase(), chain('litecoin'))).toBe(false)
    const invalid = btc.slice(0, -1) + 'x'
    expect(validateAddress(invalid, chain('bitcoin')).valid).toBe(false)
    expect(sameAddress(invalid, invalid.toUpperCase())).toBe(false)
    expect(sameAddress(btc, 'BC1' + btc.slice(3))).toBe(false)
  })

  test('distinct valid Base58 wallets are never equated by a bech32-shaped string', () => {
    // Both spellings decode to distinct 32-byte Solana public keys. The old
    // /^[a-z]+1...$/i heuristic incorrectly returned true for this exact pair.
    const address = 'EESBWmGFWwLb1YSGnrg8KPzyLjLQpGnRQyCu7648VMzx'
    const other = address.toUpperCase()
    expect(validateAddress(address, chain('solana')).valid).toBe(true)
    expect(validateAddress(other, chain('solana')).valid).toBe(true)
    expect(sameAddress(address, other, chain('solana'))).toBe(false)
    expect(sameAddress(address, other)).toBe(false)
    expect(sameAddress(' ' + address + ' ', address, chain('solana'))).toBe(true)
    for (const id of ['solana', 'ripple', 'tron', 'ton', 'dogecoin']) expect(sameAddress(btc, btc.toUpperCase(), chain(id))).toBe(false)
    // This pair additionally has a valid bech32 checksum, but both spellings
    // are distinct Solana public keys. Only chain context disambiguates them.
    const overlap = 'maya1quvzjwjtt3kharaqk8pd8e84qctjsw22wqttrm'
    expect(validateAddress(overlap, chain('solana')).valid).toBe(true)
    expect(validateAddress(overlap.toUpperCase(), chain('solana')).valid).toBe(true)
    expect(bech32.decodeUnsafe(overlap)).toBeDefined()
    expect(sameAddress(overlap, overlap.toUpperCase())).toBe(false)
    expect(sameAddress(overlap, overlap.toUpperCase(), chain('solana'))).toBe(false)
    expect(sameAddress(overlap, overlap.toUpperCase(), chain('mayachain'))).toBe(true)
  })

  test('EVM identity comparison leaves checksum rejection and empty-address behavior intact', () => {
    const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    expect(sameAddress(address, address.toLowerCase(), chain('ethereum'))).toBe(true)
    const invalid = '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
    expect(validateAddress(invalid, chain('ethereum')).error).toBe('invalidEvmChecksum')
    expect(sameAddress(null, address)).toBe(false)
    expect(sameAddress('', '')).toBe(false)
    expect(sameAddress('bitcoincash:not-an-address', 'not-an-address')).toBe(false)
  })
})
