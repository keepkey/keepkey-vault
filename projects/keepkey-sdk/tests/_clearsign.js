/**
 * Shared EVM clear-sign blob builder for the keepkey-sdk tests.
 *
 * Reproduces python-keepkey @1545299's signed-metadata format byte-for-byte
 * (verified by clearsign-offline-parity.js against REFERENCE_BLOB_SNAPSHOTS).
 * Given a catalog flow, builds the fixed deterministic tx + the metadata blob
 * bound to that tx's real legacy sighash, signed by the CI test key (slot 3).
 *
 * Used by:
 *   - clearsign-offline-parity.js  (offline sha256+len parity gate, no device)
 *   - evm-clearsign/_loadsigner-and-sign.js (on-device: load signer → sign flow)
 *
 * Golden input: fixtures/clearsign-golden.json (dumped from python-keepkey).
 */
const fs = require('fs')
const path = require('path')
const { keccak_256 } = require('@noble/hashes/sha3')
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/clearsign-golden.json'), 'utf8'))

// Fixed tx params — every catalog flow signs the same deterministic tx, so the
// firmware recomputes the identical sighash the blob is bound to.
const NONCE = 0n, GAS_PRICE = 20000000000n, GAS_LIMIT = 250000n
const CLASSIFICATION_VERIFIED = 1

const CI_TEST_PUBKEY = GOLDEN.testPubKey        // == firmware METADATA_PUBKEYS[3]
const CI_SIGNER_ALIAS = 'CI Test'
const TEST_KEY_ID = GOLDEN.keyId                // slot 3
const TEST_PRIV = hex(GOLDEN.testPrivKey)

function hex(h) { return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex')) }
function be(n, len) { const b = new Uint8Array(len); const v = new DataView(b.buffer); if (len === 4) v.setUint32(0, n); else if (len === 2) v.setUint16(0, n); return b }
function concat(arrs) { const n = arrs.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let off = 0; for (const a of arrs) { o.set(a, off); off += a.length } return o }

// ── minimal RLP (mirrors python signed_metadata._rlp_*) ──
function intMinBE(v) { if (v === 0n) return new Uint8Array(0); const o = []; while (v > 0n) { o.unshift(Number(v & 0xffn)); v >>= 8n } return Uint8Array.from(o) }
function rlpStr(b) {
  if (b.length === 1 && b[0] < 0x80) return b
  if (b.length <= 55) return concat([Uint8Array.from([0x80 + b.length]), b])
  const le = intMinBE(BigInt(b.length)); return concat([Uint8Array.from([0xb7 + le.length]), le, b])
}
function rlpList(items) {
  const body = concat(items)
  if (body.length <= 55) return concat([Uint8Array.from([0xc0 + body.length]), body])
  const le = intMinBE(BigInt(body.length)); return concat([Uint8Array.from([0xf7 + le.length]), le, body])
}

/** keccak256(rlp([nonce,gasPrice,gasLimit,to,value,data,chainId,0,0])) — EIP-155 legacy sighash */
function sighashLegacy(to, value, data, chainId) {
  const items = [
    rlpStr(intMinBE(NONCE)), rlpStr(intMinBE(GAS_PRICE)), rlpStr(intMinBE(GAS_LIMIT)),
    rlpStr(to), rlpStr(intMinBE(BigInt(value))), rlpStr(data),
  ]
  if (chainId) items.push(rlpStr(intMinBE(BigInt(chainId))), rlpStr(new Uint8Array(0)), rlpStr(new Uint8Array(0)))
  return keccak_256(rlpList(items))
}

function serializeMetadata(f) {
  const name = new TextEncoder().encode(f.methodName)
  const parts = [Uint8Array.from([0x01]), be(f.chainId, 4), f.contractAddress, f.selector, f.txHash,
    be(name.length, 2), name, Uint8Array.from([f.args.length])]
  for (const a of f.args) {
    const an = new TextEncoder().encode(a.name)
    parts.push(Uint8Array.from([an.length]), an, Uint8Array.from([a.format]), be(a.value.length, 2), a.value)
  }
  parts.push(Uint8Array.from([f.classification]), be(f.timestamp, 4), Uint8Array.from([f.keyId]))
  return concat(parts)
}

function signBlob(payload, priv) {
  const digest = sha256(payload)
  // lowS:false — python-ecdsa does NOT normalize; noble defaults to lowS:true.
  const sig = secp256k1.sign(digest, priv, { lowS: false })
  return concat([payload, sig.toCompactRawBytes(), Uint8Array.from([27 + sig.recovery])])
}

/**
 * Build the deterministic tx + CI-signed metadata blob for a catalog flow.
 * Returns { tx, blobHex, keyId, flow } — POST tx (with txMetadata) to
 * /eth/sign-transaction; the device recomputes the same sighash the blob binds.
 */
function buildFlowBlob(key) {
  const flow = GOLDEN.flows[key]
  if (!flow) throw new Error(`unknown flow: ${key}`)
  const to = hex(flow.to), data = hex(flow.calldata)
  const jsHash = sighashLegacy(to, flow.value, data, flow.chainId)
  const jsHashHex = Buffer.from(jsHash).toString('hex')
  if (jsHashHex !== flow.txHash) throw new Error(`${key}: JS sighash ${jsHashHex} != golden ${flow.txHash}`)
  const payload = serializeMetadata({
    chainId: flow.chainId, contractAddress: to, selector: hex(flow.selector),
    txHash: jsHash, methodName: flow.method,
    args: flow.args.map(a => ({ name: a.name, format: a.format, value: hex(a.value) })),
    classification: CLASSIFICATION_VERIFIED, timestamp: GOLDEN.timestamp, keyId: GOLDEN.keyId,
  })
  const blob = signBlob(payload, TEST_PRIV)
  return {
    flow,
    keyId: GOLDEN.keyId,
    blobHex: Buffer.from(blob).toString('hex'),
    tx: {
      to: '0x' + flow.to,
      value: '0x' + BigInt(flow.value).toString(16),
      data: '0x' + flow.calldata,
      nonce: '0x0',
      gasLimit: '0x' + GAS_LIMIT.toString(16),
      gasPrice: '0x' + GAS_PRICE.toString(16),
      chainId: flow.chainId,
    },
  }
}

module.exports = {
  GOLDEN, buildFlowBlob, sighashLegacy, serializeMetadata, signBlob,
  CI_TEST_PUBKEY, CI_SIGNER_ALIAS, TEST_KEY_ID, TEST_PRIV,
}
