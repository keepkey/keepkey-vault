/**
 * evm-tx-1559/firmware-hash-replica.js
 *
 * Byte-for-byte JS port of the EIP-1559 hashing in keepkey-firmware
 * lib/firmware/ethereum.c (lines ~800-895), then recovers the signer using
 * that hash + the captured r/s/v.
 *
 * Decision tree:
 *   - If recovered == expectedSigner → the firmware's RLP stream matches
 *     what we replicate here, AND it is non-canonical relative to what
 *     ethers.Transaction.from() reconstructs. The bug is in the firmware
 *     RLP construction (or in what fields the SDK sends to it).
 *   - If recovered != expectedSigner → the firmware does something this
 *     replica doesn't capture; instrument the live device path next.
 *
 * NO device required. Pure offline analysis.
 */
const fs = require('fs')
const path = require('path')
const { keccak256, recoverAddress, Signature, getBytes } = require('ethers')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'evm-tx-1559-regression.json')

// Mirror hdwallet's core.arrayify exactly (left-pads odd-length hex).
function arrayify(value) {
  const m = value.match(/^(0x)?([0-9a-fA-F]*)$/)
  if (!m || m[1] !== '0x') throw new Error(`bad hex: ${value}`)
  let s = m[2]
  if (s.length % 2) s = '0' + s
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < s.length; i += 2) out[i / 2] = parseInt(s.substr(i, 2), 16)
  return out
}

// Mirror hdwallet's stripLeadingZeroes.
function stripLeadingZeroes(buf) {
  let i = 0
  while (i < buf.length && buf[i] === 0) i++
  return buf.slice(i)
}

// ── Replica of firmware/ethereum.c primitives ─────────────────────────
// These are the EXACT byte streams the firmware feeds into keccak256.
// Each helper returns Uint8Array of bytes pushed to the hash.

function rlpLengthBytes(length, firstbyte) {
  if (length === 1 && firstbyte <= 0x7f) return new Uint8Array(0)
  if (length <= 55) return new Uint8Array([0x80 + length])
  if (length <= 0xff) return new Uint8Array([0xb7 + 1, length])
  if (length <= 0xffff) return new Uint8Array([0xb7 + 2, (length >> 8) & 0xff, length & 0xff])
  return new Uint8Array([0xb7 + 3, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
}

function rlpListLengthBytes(length) {
  if (length <= 55) return new Uint8Array([0xc0 + length])
  if (length <= 0xff) return new Uint8Array([0xf7 + 1, length])
  if (length <= 0xffff) return new Uint8Array([0xf7 + 2, (length >> 8) & 0xff, length & 0xff])
  return new Uint8Array([0xf7 + 3, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
}

function rlpFieldBytes(buf) {
  const lenHdr = rlpLengthBytes(buf.length, buf.length > 0 ? buf[0] : 0)
  return concat(lenHdr, buf)
}

function rlpCalcLength(length, firstbyte) {
  if (length === 1 && firstbyte <= 0x7f) return 1
  if (length <= 55) return 1 + length
  if (length <= 0xff) return 2 + length
  if (length <= 0xffff) return 3 + length
  return 4 + length
}

function rlpCalcNumberLength(n) {
  if (n <= 0x7f) return 1
  if (n <= 0xff) return 2
  if (n <= 0xffff) return 3
  if (n <= 0xffffff) return 4
  return 5
}

function concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) { out.set(a, off); off += a.length }
  return out
}

// Build the firmware's exact pre-image for an EIP-1559 tx.
//
// chainIdMode controls how chain_id is hashed:
//   'firmware-1byte' — what the firmware actually does:
//      hash_rlp_field((uint8_t*)&chain_id, sizeof(uint8_t))
//      i.e. the LOW byte of the uint32_t (little-endian → low order byte)
//   'canonical'      — proper RLP of the integer
function buildFirmwarePreimage(input, opts = {}) {
  const chainIdMode = opts.chainIdMode || 'firmware-1byte'

  // Replicate what hdwallet sends to firmware (ethereum.ts:301-344).
  const nonceBytes = stripLeadingZeroes(arrayify(input.nonce))   // SDK strips
  const gasLimitBytes = arrayify(input.gas || input.gasLimit)
  const maxFeeBytes = arrayify(input.maxFeePerGas)
  const maxPriBytes = arrayify(input.maxPriorityFeePerGas)
  const toBytes = arrayify(input.to)
  // value: SDK omits if value matches /^0x0*$/ — firmware sees size=0
  const valueOmitted = /^0x0*$/.test(input.value || '0x0')
  const valueBytes = valueOmitted ? new Uint8Array(0) : arrayify(input.value)
  const dataBytes = input.data ? arrayify(input.data) : new Uint8Array(0)

  const chainId = input.chainId

  // Compute rlp_length per firmware (ethereum.c:800-832).
  let rlpLength = 0
  // chain_id length (firmware uses rlp_calculate_number_length which is
  // canonical, even though the actual hash uses 1-byte truncation).
  if (chainIdMode === 'firmware-1byte') {
    rlpLength += rlpCalcNumberLength(chainId)
  } else {
    rlpLength += rlpCalcNumberLength(chainId)
  }
  rlpLength += rlpCalcLength(nonceBytes.length, nonceBytes[0] || 0)
  rlpLength += rlpCalcLength(maxPriBytes.length, maxPriBytes[0] || 0)
  rlpLength += rlpCalcLength(maxFeeBytes.length, maxFeeBytes[0] || 0)
  rlpLength += rlpCalcLength(gasLimitBytes.length, gasLimitBytes[0] || 0)
  rlpLength += rlpCalcLength(toBytes.length, toBytes[0] || 0)
  rlpLength += rlpCalcLength(valueBytes.length, valueBytes[0] || 0)
  rlpLength += rlpCalcLength(dataBytes.length, dataBytes[0] || 0)
  rlpLength += 1   // 0xC0 empty access list

  // Now build the actual hash stream.
  const parts = []
  parts.push(new Uint8Array([0x02]))                          // type byte
  parts.push(rlpListLengthBytes(rlpLength))                   // list header

  // chain_id field
  if (chainIdMode === 'firmware-1byte') {
    // Firmware: hash_rlp_field((uint8_t*)&chain_id, 1) — only low byte
    const lowByte = chainId & 0xff
    parts.push(rlpFieldBytes(new Uint8Array([lowByte])))
  } else {
    // Canonical: integer RLP (strip leading zeros)
    const ciBuf = new Uint8Array(4)
    ciBuf[0] = (chainId >> 24) & 0xff
    ciBuf[1] = (chainId >> 16) & 0xff
    ciBuf[2] = (chainId >> 8) & 0xff
    ciBuf[3] = chainId & 0xff
    let off = 0
    while (off < 4 && ciBuf[off] === 0) off++
    parts.push(rlpFieldBytes(ciBuf.slice(off)))
  }

  parts.push(rlpFieldBytes(nonceBytes))
  parts.push(rlpFieldBytes(maxPriBytes))
  parts.push(rlpFieldBytes(maxFeeBytes))
  parts.push(rlpFieldBytes(gasLimitBytes))
  parts.push(rlpFieldBytes(toBytes))
  parts.push(rlpFieldBytes(valueBytes))
  // Data: length prefix uses data_total + first byte of initial chunk.
  parts.push(rlpLengthBytes(dataBytes.length, dataBytes[0] || 0))
  parts.push(dataBytes)
  // Empty access list
  parts.push(new Uint8Array([0xc0]))

  return { stream: concat(...parts), rlpLength }
}

const blobs = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const names = Object.keys(blobs).filter(k => !k.startsWith('_'))

const norm = a => (a || '').toLowerCase()

console.log('\n=== Firmware EIP-1559 hash replica ===\n')

for (const name of names) {
  const fix = blobs[name]
  console.log(`── ${name} ──`)
  console.log(`  expected: ${fix.expectedSigner}`)
  console.log(`  captured r: ${fix.output.r}`)
  console.log(`  captured s: ${fix.output.s}`)
  console.log(`  captured v: ${fix.output.v}`)

  // Sanity: print canonical hash for reference.
  const { Transaction } = require('ethers')
  const parsed = Transaction.from(fix.output.serialized)
  console.log(`  canonical hash (ethers.unsignedHash): ${parsed.unsignedHash}`)

  for (const mode of ['firmware-1byte', 'canonical']) {
    const { stream, rlpLength } = buildFirmwarePreimage(fix.input, { chainIdMode: mode })
    const hash = keccak256(stream)
    console.log(`\n  [${mode}] rlpLength=${rlpLength} streamLen=${stream.length}`)
    console.log(`     hash: ${hash}`)

    for (const yParity of [0, 1]) {
      const sig = Signature.from({ r: fix.output.r, s: fix.output.s, yParity })
      const r = recoverAddress(hash, sig)
      const match = norm(r) === norm(fix.expectedSigner) ? '  ✅✅✅ MATCHES expectedSigner' : ''
      console.log(`     v=${yParity} → recovered: ${r}${match}`)
    }
  }
  console.log()
}
