#!/usr/bin/env node
/**
 * Offline clear-sign parity gate — NO device, NO vault.
 *
 * Proves the shared JS metadata serializer + sighash + RFC-6979 signer
 * (tests/_clearsign.js) reproduces python-keepkey's frozen reference blobs
 * (REFERENCE_BLOB_SNAPSHOTS) for all 51 catalog flows, byte-for-byte. Golden
 * input: fixtures/clearsign-golden.json (dumped from python-keepkey @1545299).
 *
 * Green here means the JS blob format, the legacy EIP-155 sighash, and the
 * deterministic signature all match python — the cheapest gate before any
 * device time. See docs/handoff-keepkey-sdk-clearsign-coverage.md.
 *
 * Run: node tests/clearsign-offline-parity.js
 */
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const { GOLDEN, buildFlowBlob, TEST_PRIV } = require('./_clearsign')

function main() {
  // Sanity: the CI test key's pubkey == firmware slot 3.
  const pub = Buffer.from(secp256k1.getPublicKey(TEST_PRIV, true)).toString('hex')
  if (pub !== GOLDEN.firmwareSlot3Pubkey) { console.error(`FATAL: test key pubkey ${pub} != slot3 ${GOLDEN.firmwareSlot3Pubkey}`); process.exit(1) }

  let pass = 0, fail = 0
  const fails = []
  for (const key of Object.keys(GOLDEN.flows)) {
    // buildFlowBlob throws if the JS sighash != golden tx_hash (the #1 device trap).
    let built
    try { built = buildFlowBlob(key) } catch (e) { fail++; fails.push({ key, err: String(e.message) }); continue }
    const blob = Buffer.from(built.blobHex, 'hex')
    const [wantSha, wantLen] = GOLDEN.snapshots[key]
    const gotSha = Buffer.from(sha256(blob)).toString('hex')
    if (blob.length === wantLen && gotSha === wantSha) pass++
    else { fail++; fails.push({ key, lenGot: blob.length, lenWant: wantLen, shaOk: gotSha === wantSha }) }
  }
  console.log(`\nclearsign offline parity: ${pass}/${pass + fail} flows match python @1545299 (blob sha256+len + JS sighash)`)
  if (fail) { console.error('\nFAILURES:'); for (const f of fails) console.error('  ' + JSON.stringify(f)) }
  process.exit(fail ? 1 : 0)
}
main()
