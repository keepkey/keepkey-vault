#!/usr/bin/env node
/**
 * Offline acceptance for the separately sourced 2026 ClearSign expansion.
 * No Vault, device, network, or production signer is required.
 */
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const {
  GOLDEN, ALL_FLOWS, VENDORED_FLOWS, buildFlowBlob, sighashLegacy, TEST_PRIV,
} = require('./_clearsign')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function main() {
  const keys = Object.keys(VENDORED_FLOWS)
  if (keys.length !== 8) fail(`expected 8 vendored flows, got ${keys.length}`)

  const pubkey = secp256k1.getPublicKey(TEST_PRIV, true)
  if (Buffer.from(pubkey).toString('hex') !== GOLDEN.testPubKey) fail('test signer pubkey drifted')

  for (const key of keys) {
    if (GOLDEN.flows[key]) fail(`${key}: collides with frozen Python corpus`)
    const flow = ALL_FLOWS[key]
    if (!flow.sources?.length || flow.sources.some((source) => !source.startsWith('https://'))) {
      fail(`${key}: missing HTTPS provenance`)
    }
    if (flow.calldata.slice(0, 8) !== flow.selector) fail(`${key}: selector/calldata mismatch`)

    const expectedHash = Buffer.from(sighashLegacy(
      Buffer.from(flow.to, 'hex'), BigInt(flow.value), Buffer.from(flow.calldata, 'hex'), flow.chainId,
    )).toString('hex')
    if (flow.txHash !== expectedHash) fail(`${key}: transaction binding mismatch`)

    const built = buildFlowBlob(key)
    const blob = Buffer.from(built.blobHex, 'hex')
    const payload = blob.subarray(0, -65)
    const compactSignature = blob.subarray(-65, -1)
    if (!secp256k1.verify(compactSignature, sha256(payload), pubkey, { lowS: false })) {
      fail(`${key}: metadata signature does not verify`)
    }
    if (built.tx.data.slice(2) !== flow.calldata) fail(`${key}: signed tx calldata drifted`)
    console.log(`  ✅ ${key} — ${flow.method} ${blob.length}B`)
  }

  console.log(`\nvendored ClearSign offline: ${keys.length}/${keys.length} ABI/binding/signature/provenance checks passed`)
}

main()
