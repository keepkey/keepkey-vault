/**
 * evm-tx-1559/find-preimage.js
 *
 * The vault diagnostic captured the actual hash the firmware signed:
 *   device-signed:  0x385868e52dadf5efc378d12eaf596c61ed94a675474e73c2076da9b8c1eba2c4
 *   canonical(1559): 0xe93917b6c4da282868f167999f09f5d5f082bdf19f5ffb5dfbf2f19b9441f147
 *
 * They differ. So the firmware either uses a different RLP layout or different
 * field semantics. This script tries a battery of pre-image variants against
 * the captured fixture and reports which (if any) produces the device hash.
 *
 * NO device required.
 */
const fs = require('fs')
const path = require('path')
const { keccak256, encodeRlp, toBeArray, getBytes, hexlify } = require('ethers')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'evm-tx-1559-regression.json')
const TARGET = '0x385868e52dadf5efc378d12eaf596c61ed94a675474e73c2076da9b8c1eba2c4'

const blobs = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const fix = blobs[Object.keys(blobs).filter(k => !k.startsWith('_'))[0]]
const inp = fix.input

// Mirror hdwallet's arrayify (left-pad odd hex) and stripLeadingZeroes.
function arrayify(value) {
  const m = value.match(/^(0x)?([0-9a-fA-F]*)$/)
  if (!m || m[1] !== '0x') throw new Error(`bad hex: ${value}`)
  let s = m[2]
  if (s.length % 2) s = '0' + s
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < s.length; i += 2) out[i / 2] = parseInt(s.substr(i, 2), 16)
  return out
}
function stripLeadingZeroes(buf) {
  let i = 0; while (i < buf.length && buf[i] === 0) i++; return buf.slice(i)
}
const u8 = a => Uint8Array.from(a)
const concat = (...arrs) => {
  const t = arrs.reduce((s, a) => s + a.length, 0)
  const o = new Uint8Array(t); let off = 0
  for (const a of arrs) { o.set(a, off); off += a.length }
  return o
}

// Bytes the firmware actually receives (per hdwallet ethereum.ts:301-329):
const NONCE = stripLeadingZeroes(arrayify(inp.nonce))                    // [0x01,0xef]
const GAS_LIMIT = arrayify(inp.gas || inp.gasLimit)                      // [0x06,0xc8,0xb8]
const MAX_FEE = arrayify(inp.maxFeePerGas)                               // [0x02,0x91,0xd5,0x74,0x0f]
const MAX_PRI = arrayify(inp.maxPriorityFeePerGas)                       // [0x02,0x18,0x71,0x1a,0x00]
const TO = arrayify(inp.to)                                              // 20 bytes
const VALUE_OMITTED = /^0x0*$/.test(inp.value || '0x0')
const VALUE_BYTES = VALUE_OMITTED ? new Uint8Array(0) : arrayify(inp.value)
const DATA = arrayify(inp.data)
const CHAIN_ID = inp.chainId
const CHAIN_ID_BYTES = (() => {
  if (CHAIN_ID === 0) return new Uint8Array(0)
  const buf = [(CHAIN_ID>>>24)&0xff, (CHAIN_ID>>>16)&0xff, (CHAIN_ID>>>8)&0xff, CHAIN_ID&0xff]
  let i = 0; while (i < 4 && buf[i] === 0) i++
  return Uint8Array.from(buf.slice(i))
})()

// Helpers — RLP via ethers' canonical encoder (handles length prefixes).
const rlpInt = (bytes) => {
  if (bytes.length === 0) return '0x'
  return hexlify(bytes)
}
// Even-pad an odd hex string for ethers' strict RLP encoder.
const evenHex = (h) => {
  if (!h || h === '0x') return '0x'
  const s = h.replace(/^0x/, '')
  return '0x' + (s.length % 2 ? '0' + s : s)
}

console.log(`\n=== Hunt for firmware pre-image ===`)
console.log(`target:     ${TARGET}`)
console.log()

const variants = []

// Field bytes ready for ethers' encodeRlp (it accepts hex strings).
// Note: arrayify already left-pads odd-length hex, so these are even.
const NONCE_HEX = rlpInt(NONCE)
const GAS_HEX   = rlpInt(GAS_LIMIT)
const MAXF_HEX  = rlpInt(MAX_FEE)
const MAXP_HEX  = rlpInt(MAX_PRI)
const TO_HEX    = evenHex(inp.to)
const VAL_HEX   = '0x'
const DATA_HEX  = evenHex(inp.data)
const CID_HEX   = evenHex('0x' + CHAIN_ID.toString(16))
const ZERO      = '0x'

function add(label, prefixHex, listItems) {
  const rlp = encodeRlp(listItems)
  const bytes = prefixHex ? concat(arrayify(prefixHex), arrayify(rlp)) : arrayify(rlp)
  const h = keccak256(bytes)
  variants.push({ label, hash: h })
}

// ── Variants ────────────────────────────────────────────────────────

// 1) Canonical EIP-1559 (control)
add('1559 canonical [chainId,nonce,maxPri,maxFee,gas,to,val,data,[]]',
    '0x02', [CID_HEX, NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, []])

// 2) 1559 with fees swapped (maxFee BEFORE maxPri)
add('1559 swapped [chainId,nonce,maxFee,maxPri,gas,to,val,data,[]]',
    '0x02', [CID_HEX, NONCE_HEX, MAXF_HEX, MAXP_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, []])

// 3) 1559 NO type prefix
add('no-prefix [chainId,nonce,maxPri,maxFee,gas,to,val,data,[]]',
    null, [CID_HEX, NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, []])

// 4) 1559 NO access list (8 elements)
add('1559 no-AL [chainId,nonce,maxPri,maxFee,gas,to,val,data]',
    '0x02', [CID_HEX, NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX])

// 5) Legacy EIP-155 with gasPrice = maxFeePerGas
add('legacy155 (gasPrice=maxFee) [n,gp,gl,to,v,d,cid,0,0]',
    null, [NONCE_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, CID_HEX, ZERO, ZERO])

// 6) Legacy EIP-155 with gasPrice = maxPriorityFeePerGas
add('legacy155 (gasPrice=maxPri) [n,gp,gl,to,v,d,cid,0,0]',
    null, [NONCE_HEX, MAXP_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, CID_HEX, ZERO, ZERO])

// 7) Pre-EIP-155 legacy (6 elements) gasPrice=maxFee
add('pre155 (gasPrice=maxFee) [n,gp,gl,to,v,d]',
    null, [NONCE_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX])

// 8) Pre-EIP-155 legacy (6 elements) gasPrice=maxPri
add('pre155 (gasPrice=maxPri) [n,gp,gl,to,v,d]',
    null, [NONCE_HEX, MAXP_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX])

// 9) Firmware 1559 layout BUT chain_id encoded as 4-byte LE (the (uint8_t*)&chain_id bug
//    only takes 1 byte, but maybe the length calculator allocated 4 bytes and gets uninit)
//    Try chainId=0
add('1559 chainId=0 [0,nonce,maxPri,maxFee,gas,to,val,data,[]]',
    '0x02', [ZERO, NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, []])

// 10) 1559 with extra leading-zero variants
add('1559 chainId-bytes [0x0001] [chainId,nonce,maxPri,maxFee,gas,to,val,data,[]]',
    '0x02', ['0x0001', NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, []])

// 11) Legacy 9-element with type+1559 layout but no 0x02 prefix and no AL
add('1559-no-prefix-no-AL [chainId,nonce,maxPri,maxFee,gas,to,val,data]',
    null, [CID_HEX, NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX])

// 12) Hash data only (sanity)
add('keccak(data)', null, [DATA_HEX])

// 13) Maybe the firmware's "fallback to legacy" path: when has_max_fee_per_gas is
//     true but ethereum_tx_type stays LEGACY, fields are:
//       hash_rlp_field(nonce)
//       hash_rlp_field(max_priority_fee_per_gas)   (because has_max_fee_per_gas branch)
//       hash_rlp_field(max_fee_per_gas)
//       hash_rlp_field(gas_limit)
//       hash_rlp_field(to)
//       hash_rlp_field(value)
//       hash_rlp_length(data) + data
//       hash_rlp_number(chain_id)
//       hash_rlp_length(0) (zero r)
//       hash_rlp_length(0) (zero s)
//     i.e. 10 elements, no 0x02 prefix
add('legacy-leak [n,maxPri,maxFee,gl,to,v,d,cid,0,0]',
    null, [NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, CID_HEX, ZERO, ZERO])

// 14) Same as 13 but pre-155 (no chainId, 7 elements)
add('legacy-leak-pre155 [n,maxPri,maxFee,gl,to,v,d]',
    null, [NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX])

// 15) 1559 but with value=0x80 instead of 0x — i.e. value byte was a non-zero something
//     (sanity check on omitted-value handling)
add('1559 val=0x00 [chainId,nonce,maxPri,maxFee,gas,to,0x00,data,[]]',
    '0x02', [CID_HEX, NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, '0x00', DATA_HEX, []])

// 16) 1559 with chain_id BEFORE 0x02 (some weird firmware order)
add('chainId-then-prefix [(0x02)] reversed: not sensible', null,
    [CID_HEX, NONCE_HEX, MAXP_HEX, MAXF_HEX, GAS_HEX, TO_HEX, VAL_HEX, DATA_HEX, []])

// 17) THE BUG: firmware hashes 0xC0 access-list byte AFTER data_initial_chunk
//     (first 1024 bytes) but BEFORE the remaining data chunks (ethereum.c:891).
//     Build that exact stream manually.
{
  const CHUNK = 1024
  const dataInitial = DATA.slice(0, CHUNK)
  const dataRest = DATA.slice(CHUNK)
  // Reproduce the firmware's outer structure (matches my replica).
  const rlpLength = 1596
  const parts = []
  parts.push(u8([0x02]))                                             // type
  // list length 0xf9 0x06 0x3c (1596 → 0x63c). 0x63c, not 0x67f.
  // 0xf9 = 0xf7 + 2 (2-byte length)
  parts.push(u8([0xf9, (rlpLength >> 8) & 0xff, rlpLength & 0xff]))
  // Each field with its RLP prefix:
  parts.push(u8([0x01]))                                             // chainId 1, no prefix
  parts.push(u8([0x82, 0x01, 0xef]))                                 // nonce
  parts.push(u8([0x85, 0x02, 0x18, 0x71, 0x1a, 0x00]))               // maxPriorityFeePerGas
  parts.push(u8([0x85, 0x02, 0x91, 0xd5, 0x74, 0x0f]))               // maxFeePerGas
  parts.push(u8([0x83, 0x06, 0xc8, 0xb8]))                           // gasLimit
  parts.push(u8([0x94])); parts.push(TO)                             // to (20 bytes)
  parts.push(u8([0x80]))                                             // value=0
  // data length prefix: 1550 = 0x060e → 0xb9 0x06 0x0e
  parts.push(u8([0xb9, (DATA.length >> 8) & 0xff, DATA.length & 0xff]))
  parts.push(dataInitial)                                            // first 1024 bytes
  parts.push(u8([0xC0]))                                             // BUG: access list inserted here
  parts.push(dataRest)                                               // remaining bytes
  const stream = concat(...parts)
  const h = keccak256(stream)
  variants.push({ label: 'BUG: 0xC0 inserted between data chunks (after 1024 bytes)', hash: h })
}

// 18) Sanity: same as 17 but 0xC0 is at the END (canonical)
{
  const rlpLength = 1596
  const parts = []
  parts.push(u8([0x02]))
  parts.push(u8([0xf9, (rlpLength >> 8) & 0xff, rlpLength & 0xff]))
  parts.push(u8([0x01]))
  parts.push(u8([0x82, 0x01, 0xef]))
  parts.push(u8([0x85, 0x02, 0x18, 0x71, 0x1a, 0x00]))
  parts.push(u8([0x85, 0x02, 0x91, 0xd5, 0x74, 0x0f]))
  parts.push(u8([0x83, 0x06, 0xc8, 0xb8]))
  parts.push(u8([0x94])); parts.push(TO)
  parts.push(u8([0x80]))
  parts.push(u8([0xb9, (DATA.length >> 8) & 0xff, DATA.length & 0xff]))
  parts.push(DATA)
  parts.push(u8([0xC0]))
  const stream = concat(...parts)
  variants.push({ label: 'Sanity: 0xC0 at end (canonical, manual build)', hash: keccak256(stream) })
}

// ── Print ──────────────────────────────────────────────────────────
let hit = false
for (const v of variants) {
  const match = v.hash.toLowerCase() === TARGET.toLowerCase()
  if (match) hit = true
  console.log(`${match ? '✅✅✅ MATCH' : '         '}  ${v.label}`)
  console.log(`           ${v.hash}`)
}

if (!hit) {
  console.log(`\nNo variant matched. The firmware is hashing something this script doesn't model.`)
  console.log(`Next step: instrument the firmware (or read the keccak buffer state) to see exact bytes.`)
} else {
  console.log(`\n>>> Firmware pre-image identified above. <<<`)
}
