import { expect, test } from 'bun:test'
import { ownUtxoLabel } from './chains'

test('own UTXO keys are named by script type, Zcash as a transparent address', () => {
  expect(['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr'].map(s => ownUtxoLabel('LTC', 'litecoin', s)))
    .toEqual(['LTC Legacy', 'LTC SegWit', 'LTC Native SegWit', 'LTC Taproot'])
  expect(ownUtxoLabel('ZEC', 'zcash', 'p2pkh')).toBe('My ZEC transparent address')
  expect(ownUtxoLabel('DOGE', 'dogecoin')).toBe('DOGE (xpub)')
})
