/**
 * evm-tx-1559/recover-fixture.js — offline regression suite
 *
 * Walks every entry in fixtures/evm-tx-1559-regression.json and asserts the
 * recovered signer (from the captured serialized bytes) equals the
 * expectedSigner. NO device required — pure offline check.
 *
 * Why this exists: in 2026-04-28 we discovered that production
 * `sdk.eth.ethSignTransaction` was returning serialized type-2 envelopes
 * whose signature recovers to a wrong-but-deterministic address (not the
 * device's). The malformed-hex bug lives somewhere in the SDK ↔ firmware
 * signing chain — see RETRO_evm_tx_1559_signing_chain.md in keepkey-client.
 *
 * This test catches regressions of that class. It does not, by itself,
 * pinpoint the bug — it just trips the alarm. To bisect, see
 * sign-and-recover.js (live signing + local rebuild of the type-2 hash).
 */
const fs = require('fs')
const path = require('path')
const { Transaction, recoverAddress, Signature, keccak256, encodeRlp, toBeArray, hexlify } = require('ethers')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'evm-tx-1559-regression.json')

let passed = 0, failed = 0
const fail = (label, info) => { console.error(`  ❌ ${label}\n     ${info}`); failed++ }
const ok = (label) => { console.log(`  ✅ ${label}`); passed++ }
const norm = a => (a || '').toLowerCase()

const blobs = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const fixtureNames = Object.keys(blobs).filter(k => !k.startsWith('_'))

console.log(`\n=== EVM type-2 (EIP-1559) signing-chain regression — ${fixtureNames.length} fixture(s) ===\n`)

const toRlpInt = (n) => {
  if (n === 0n || n === 0 || n == null) return '0x'
  return hexlify(toBeArray(BigInt(n)))
}

for (const name of fixtureNames) {
  const fix = blobs[name]
  console.log(`  ── ${name} ──`)
  console.log(`     ${fix.context}`)

  const expected = fix.expectedSigner
  const serialized = fix.output.serialized

  // 1) Parse via ethers and recover.
  let parsed
  try {
    parsed = Transaction.from(serialized)
  } catch (e) {
    fail(`${name}: ethers.Transaction.from parse`, `${e.message}`)
    continue
  }
  const recovered = parsed.from
  const txHash = parsed.hash

  console.log(`     expected:  ${expected}`)
  console.log(`     recovered: ${recovered}`)
  console.log(`     txHash:    ${txHash}`)

  if (norm(recovered) === norm(expected)) {
    ok(`${name}: serialized envelope recovers to expected signer`)
  } else {
    fail(`${name}: serialized envelope recovers to WRONG signer`,
         `(known regression — keep this fixture failing until the SDK/firmware bug is fixed)`)
  }

  // 2) Sanity: r/s in the captured fixture matches what ethers parses.
  const sig = parsed.signature
  if (norm(sig.r) === norm(fix.output.r) && norm(sig.s) === norm(fix.output.s)) {
    ok(`${name}: captured r/s match parsed envelope`)
  } else {
    fail(`${name}: captured r/s do NOT match parsed envelope`,
         `parsed r=${sig.r}\n     parsed s=${sig.s}\n     fixture r=${fix.output.r}\n     fixture s=${fix.output.s}`)
  }

  // 3) Try the OTHER v parity to confirm the bug is *not* a simple parity flip.
  const flippedSig = Signature.from({ r: sig.r, s: sig.s, yParity: sig.yParity === 0 ? 1 : 0 })
  const flippedTx = Transaction.from(serialized)
  flippedTx.signature = flippedSig
  const flippedRecovered = flippedTx.from
  if (norm(flippedRecovered) === norm(expected)) {
    fail(`${name}: v-parity FLIP recovers to expected — bug is a simple parity inversion`,
         `try setting yParity=${sig.yParity === 0 ? 1 : 0} in the SDK envelope serializer`)
  } else {
    ok(`${name}: v-parity flip ≠ expected (rules out simple parity inversion)`)
    console.log(`     (flipped v=${flippedSig.yParity} recovers to: ${flippedRecovered})`)
  }

  // 4) Try a battery of common malformed-hash hypotheses with the SAME r/s.
  const hypotheses = []
  const rlpCorrect = encodeRlp([
    toRlpInt(parsed.chainId), toRlpInt(parsed.nonce),
    toRlpInt(parsed.maxPriorityFeePerGas), toRlpInt(parsed.maxFeePerGas),
    toRlpInt(parsed.gasLimit), parsed.to, toRlpInt(parsed.value),
    parsed.data, [],
  ])
  hypotheses.push({ label: 'type-2 RLP without 0x02 prefix', hash: keccak256(rlpCorrect) })

  const rlpSwapped = encodeRlp([
    toRlpInt(parsed.chainId), toRlpInt(parsed.nonce),
    toRlpInt(parsed.maxFeePerGas), toRlpInt(parsed.maxPriorityFeePerGas),
    toRlpInt(parsed.gasLimit), parsed.to, toRlpInt(parsed.value),
    parsed.data, [],
  ])
  hypotheses.push({ label: 'type-2 maxFee/maxPriority swapped', hash: keccak256('0x02' + rlpSwapped.slice(2)) })

  const rlpLegacy155 = encodeRlp([
    toRlpInt(parsed.nonce), toRlpInt(parsed.maxFeePerGas), toRlpInt(parsed.gasLimit),
    parsed.to, toRlpInt(parsed.value), parsed.data,
    toRlpInt(parsed.chainId), '0x', '0x',
  ])
  hypotheses.push({ label: 'legacy EIP-155 (gasPrice = maxFeePerGas)', hash: keccak256(rlpLegacy155) })

  for (const h of hypotheses) {
    for (const yParity of [0, 1]) {
      const r = recoverAddress(h.hash, Signature.from({ r: sig.r, s: sig.s, yParity }))
      if (norm(r) === norm(expected)) {
        console.log(`  >>> diagnostic match: signing pre-image is "${h.label}" with v=${yParity}`)
      }
    }
  }
}

console.log(`\n  Result: ${passed} passed, ${failed} failed`)
console.log(`\n  Notes for triage:`)
console.log(`  - Failures here are expected today (the regression is open).`)
console.log(`  - The ">>> diagnostic match" line, if it appears, names which non-canonical pre-image the firmware/SDK is hashing — that's the bug.`)
console.log(`  - If no diagnostic match prints, the bug is in a field encoding not yet hypothesized; instrument the SDK directly to log the exact bytes sent to firmware.\n`)

process.exit(failed > 0 ? 1 : 0)
