#!/usr/bin/env node
/**
 * Replays REAL dApp signing requests (tests/fixtures/solana-live-session-2026-09-17.json)
 * through the vault so a human can check the risk panel against what each
 * request actually did on mainnet. Signs only — never broadcasts, and every
 * blockhash in the fixture expired long ago.
 *
 * For each case it prints the risk headline + sentences the approval window
 * must show, then:
 *   - "approve" cases: approve in the vault + on the device; the Ed25519
 *     signature is verified against the fixture signer here.
 *   - the "reject" case (a transaction disguised as a message, CRITICAL):
 *     press Reject in the vault; the call must fail.
 *
 * Needs a device with AdvancedMode enabled (raw message + opaque programs).
 *   make test-sdk filter=live-risk-replay
 */
const crypto = require('crypto')
const { run } = require('../_helpers')
const fixture = require('../fixtures/solana-live-session-2026-09-17.json')

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Decode(s) {
  let n = 0n
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c))
  const bytes = []
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n }
  return Buffer.from(bytes.length < 32 ? [...Buffer.alloc(32 - bytes.length), ...bytes] : bytes)
}

/** Bytes a Solana tx signature covers: the message after the signature slots. */
function txMessage(rawB64) {
  const tx = Buffer.from(rawB64, 'base64')
  if (tx[0] >= 0x80) throw new Error('fixture txs have <128 signatures')
  return tx.subarray(1 + 64 * tx[0])
}

function ed25519Verify(pubkey, message, signature) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubkey])
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' })
  return crypto.verify(null, message, key, signature)
}

function banner(c, level, lines) {
  console.log(`\n  ── ${c} ──`)
  console.log(`  EXPECT in vault window: ${level.toUpperCase()}`)
  for (const l of lines) console.log(`    • …${l}…`)
}

run('Solana live-session risk replay (human-verified)', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()
  const signer = base58Decode(fixture.signer)
  const address_n = fixture.addressN

  for (const c of fixture.cases) {
    banner(`${c.name} (api_log ${c.apiLogId}) — on-chain: ${c.onChain}`, c.expectLevel, c.expectText)
    if (c.kind === 'message') {
      const res = await sdk.solana.solanaSignMessage({ address_n, message: c.payload })
      const sig = Buffer.from(res.signature, 'base64')
      assert(`${c.name}: signed by fixture signer`, Buffer.from(res.publicKey, 'base64').equals(signer))
      assert(`${c.name}: signature verifies over the raw message`,
        ed25519Verify(signer, Buffer.from(c.payload, 'base64'), sig))
    } else {
      const res = await sdk.solana.solanaSignTransaction({ address_n, raw_tx: c.payload })
      const sig = Buffer.from(res.signature, 'base64')
      assert(`${c.name}: signature verifies over the tx message`,
        ed25519Verify(signer, txMessage(c.payload), sig))
    }
  }

  // A transaction's message bytes submitted as a "message": signing it would
  // authorize the transaction. The window must say CRITICAL; the tester rejects.
  const disguised = fixture.cases.find((c) => c.name === 'register-poker-tournament')
  banner('tx disguised as a message — PRESS REJECT', 'critical', ['is really a transaction'])
  let err = null
  try {
    await sdk.solana.solanaSignMessage({ address_n, message: txMessage(disguised.payload).toString('base64') })
  } catch (e) { err = e }
  assertThrows('disguised transaction is rejected', err, 'rejected')
})
