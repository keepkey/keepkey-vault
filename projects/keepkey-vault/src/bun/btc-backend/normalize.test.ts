/**
 * Unit test for PioneerBackend's pure normalizers — the parsing that actually
 * breaks (response un-wrapping, sat/kB↔sat/vB, txid extraction). No network.
 * Run: bun src/bun/btc-backend/pioneer.test.ts
 */
import { unwrapUtxos, normalizeUtxo, normalizeFeeRates, extractTxid } from './normalize'

let pass = 0
function eq(a: any, b: any, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`FAIL ${msg}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)
  pass++
}

// unwrapUtxos — every wrapper shape Pioneer/Axios produces
eq(unwrapUtxos([{ v: 1 }]), [{ v: 1 }], 'unwrap: bare array')
eq(unwrapUtxos({ data: [{ v: 2 }] }), [{ v: 2 }], 'unwrap: {data:[]}')
eq(unwrapUtxos({ data: { data: [{ v: 3 }] } }), [{ v: 3 }], 'unwrap: {data:{data:[]}}')
eq(unwrapUtxos({ utxos: [{ v: 4 }] }), [{ v: 4 }], 'unwrap: {utxos:[]}')
eq(unwrapUtxos({ nope: 1 }), [], 'unwrap: unknown → []')

// normalizeUtxo — string value → int, hex from tx.hex or hex
eq(normalizeUtxo({ txid: 'a', vout: 0, value: '99705' }).value, 99705, 'utxo: string value → int')
eq(normalizeUtxo({ txid: 'a', vout: 1, value: 5, tx: { hex: 'deadbeef' } }).hex, 'deadbeef', 'utxo: hex from tx.hex')
eq(normalizeUtxo({ txid: 'a', vout: 1, value: 5, hex: 'cafe' }).hex, 'cafe', 'utxo: hex from hex')

// normalizeFeeRates — sat/vB stays; sat/kB (>500) divides by 1000; picks fast/fastest
eq(normalizeFeeRates({ data: { slow: 3, average: 5, fast: 15 } }).fast, 15, 'fee: sat/vB fast')
eq(normalizeFeeRates({ data: { slow: 3000, average: 5000, fast: 15000 } }).fast, 15, 'fee: sat/kB → /1000')
eq(normalizeFeeRates({ data: { fastest: 22 } }).fast, 22, 'fee: fastest field')
eq(normalizeFeeRates({}).fast >= 1, true, 'fee: empty → floor 1')

// extractTxid — every id field a broadcast can return
eq(extractTxid({ data: { txid: 'x' } }), 'x', 'txid: .txid')
eq(extractTxid({ tx_hash: 'y' }), 'y', 'txid: .tx_hash')
eq(extractTxid({ hash: 'z' }), 'z', 'txid: .hash')
eq(extractTxid({ nope: 1 }), undefined, 'txid: none → undefined')

console.log(`[btc-backend] OK — ${pass} assertions passed`)
