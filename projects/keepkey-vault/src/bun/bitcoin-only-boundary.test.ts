import { describe, expect, test } from 'bun:test'
import { bitcoinOnlyCoinAllowed, bitcoinOnlyCoinList, bitcoinOnlyRejection } from './bitcoin-only-boundary'
import { SIGNING_ROUTES } from './signing-routes'

describe('Bitcoin-only REST boundary', () => {
  test('allows only the firmware coin table', () => {
    for (const coin of [undefined, 'Bitcoin', 'Testnet']) {
      expect(bitcoinOnlyCoinAllowed(coin)).toBe(true)
    }
    for (const coin of ['Litecoin', 'BitcoinCash', 'Dogecoin', 'Zcash', '', 'bitcoin']) {
      expect(bitcoinOnlyCoinAllowed(coin)).toBe(false)
    }
  })

  test('fences every non-Bitcoin signing route', () => {
    for (const path of SIGNING_ROUTES) {
      const body = path === '/utxo/sign-transaction' ? { coin: 'Bitcoin' } : {}
      const rejected = bitcoinOnlyRejection('POST', path, body)
      if (path === '/utxo/sign-transaction') expect(rejected).toBeNull()
      else expect(rejected).not.toBeNull()
    }
  })

  test('fences every dedicated non-Bitcoin address route', () => {
    for (const path of [
      '/addresses/cosmos', '/addresses/osmosis', '/addresses/eth', '/addresses/tendermint',
      '/addresses/thorchain', '/addresses/mayachain', '/addresses/xrp', '/addresses/solana',
      '/addresses/tron', '/addresses/ton', '/addresses/hive',
    ]) {
      expect(bitcoinOnlyRejection('POST', path, {})).not.toBeNull()
    }
    expect(bitcoinOnlyRejection('POST', '/addresses/future-altcoin', {})).not.toBeNull()
  })

  test('fences ClearSign management and ceremony routes', () => {
    for (const path of ['/eth/clearsign/load-signer', '/eth/clearsign/sign-alpha-delegate-certificate']) {
      expect(bitcoinOnlyRejection('POST', path, {})).not.toBeNull()
    }
  })

  test('generic UTXO routes allow Bitcoin/Testnet and reject altcoins', () => {
    for (const path of ['/addresses/utxo', '/utxo/sign-transaction']) {
      expect(bitcoinOnlyRejection('POST', path, {})).toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { coin: 'Bitcoin' })).toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { coin: 'Testnet' })).toBeNull()
      expect(bitcoinOnlyRejection('POST', path, { coin: 'Litecoin' })).not.toBeNull()
    }
  })

  test('leaves malformed generic-route bodies to schema validation', () => {
    expect(bitcoinOnlyRejection('POST', '/addresses/utxo', { coin: null })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/utxo/sign-transaction', { coin: 42 })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/system/info/get-public-key', { coin_name: [] })).toBeNull()
  })

  test('generic public-key route rejects altcoin xpubs', () => {
    expect(bitcoinOnlyRejection('POST', '/system/info/get-public-key', { coin_name: 'Bitcoin' })).toBeNull()
    expect(bitcoinOnlyRejection('POST', '/system/info/get-public-key', { coin_name: 'Dogecoin' })).not.toBeNull()
  })

  test('does not affect non-POST requests', () => {
    expect(bitcoinOnlyRejection('GET', '/addresses/eth')).toBeNull()
  })

  test('filters coin listings to Bitcoin networks', () => {
    const visible = bitcoinOnlyCoinList([
      { coin: 'Bitcoin', id: 1 },
      { coin: 'Litecoin', id: 2 },
      { coin: 'Testnet', id: 3 },
    ])
    expect(visible.map(coin => coin.coin)).toEqual(['Bitcoin', 'Testnet'])
  })
})
