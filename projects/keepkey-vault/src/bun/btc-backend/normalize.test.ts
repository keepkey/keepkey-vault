/**
 * Unit test for PioneerBackend's pure normalizers — the parsing that actually
 * breaks (response un-wrapping, sat/kB↔sat/vB, txid extraction). No network.
 * Run: bun src/bun/btc-backend/pioneer.test.ts
 */
import {
  assertPioneerSuccess,
  unwrapUtxos,
  normalizeUtxo,
  normalizeFeeRates,
  extractTxid,
  extractRawTxHex,
} from './normalize'

let pass = 0
function eq(a: any, b: any, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`FAIL ${msg}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)
  pass++
}
function throws(fn: () => unknown, msg: string) {
  try { fn() } catch { pass++; return }
  throw new Error(`FAIL ${msg}: expected throw`)
}

// unwrapUtxos — every wrapper shape Pioneer/Axios produces
eq(unwrapUtxos([{ v: 1 }]), [{ v: 1 }], 'unwrap: bare array')
eq(unwrapUtxos({ data: [{ v: 2 }] }), [{ v: 2 }], 'unwrap: {data:[]}')
eq(unwrapUtxos({ data: { data: [{ v: 3 }] } }), [{ v: 3 }], 'unwrap: {data:{data:[]}}')
eq(unwrapUtxos({ utxos: [{ v: 4 }] }), [{ v: 4 }], 'unwrap: {utxos:[]}')
throws(() => unwrapUtxos({ nope: 1 }), 'unwrap: unknown fails closed')
throws(() => assertPioneerSuccess({ data: { success: false, error: 'node down' } }, 'ListUnspent'), 'application error fails closed')

// normalizeUtxo — string value → int, hex from tx.hex or hex
eq(normalizeUtxo({ txid: 'a', vout: 0, value: '99705' }).value, 99705, 'utxo: string value → int')
eq(normalizeUtxo({ txid: 'a', vout: 1, value: 5, tx: { hex: 'deadbeef' } }).hex, 'deadbeef', 'utxo: hex from tx.hex')
eq(normalizeUtxo({ txid: 'a', vout: 1, value: 5, hex: 'cafe' }).hex, 'cafe', 'utxo: hex from hex')
eq(normalizeUtxo({ txid: 'a', vout: 1, value: 5, addr: 'bc1qtest' }).address, 'bc1qtest', 'utxo: address from addr')
throws(() => normalizeUtxo({ txid: 'a', vout: 1, value: '12oops' }), 'utxo: malformed value fails closed')
throws(() => normalizeUtxo({ txid: 'a', vout: -1, value: 12 }), 'utxo: invalid vout fails closed')

// normalizeFeeRates — sat/vB stays; sat/kB (>500) divides by 1000; picks fast/fastest
eq(normalizeFeeRates({ data: { slow: 3, average: 5, fast: 15 } }).fast, 15, 'fee: sat/vB fast')
eq(normalizeFeeRates({ data: { slow: 3000, average: 5000, fast: 15000 } }).fast, 15, 'fee: sat/kB → /1000')
eq(normalizeFeeRates({ data: { fastest: 22 } }).fast, 22, 'fee: fastest field')
throws(() => normalizeFeeRates({}), 'fee: empty fails closed')

// extractTxid — every id field a broadcast can return
eq(extractTxid({ data: { txid: 'x' } }), 'x', 'txid: .txid')
eq(extractTxid({ tx_hash: 'y' }), 'y', 'txid: .tx_hash')
eq(extractTxid({ hash: 'z' }), 'z', 'txid: .hash')
eq(extractTxid({ nope: 1 }), undefined, 'txid: none → undefined')

// LookupUtxoTx is double-wrapped by Axios + the server response.
eq(extractRawTxHex({ data: { data: { hex: '00cafe' } } }), '00cafe', 'raw tx: nested LookupUtxoTx')
eq(extractRawTxHex({ data: { tx: { hex: '00beef' } } }), '00beef', 'raw tx: legacy tx.hex')
eq(extractRawTxHex({ success: true }), undefined, 'raw tx: absent')

console.log(`[btc-backend] OK — ${pass} assertions passed`)
