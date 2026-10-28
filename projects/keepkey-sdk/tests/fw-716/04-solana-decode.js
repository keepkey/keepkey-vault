#!/usr/bin/env node
/**
 * fw-716/04 — Desktop's Solana risk preview against released 7.16.0. No
 * presses: /solana/decode-transaction runs no device signing and opens no card.
 *
 * Four legacy messages, each with a random blockhash:
 *   (a) SystemProgram transfer of 1 lamport, device to itself. Expect no
 *       consent and the green tier. Desktop returns green only when its
 *       requiresAdvancedMode for the connected firmware is false (it is not
 *       returned as its own field; clearsign-risk.ts assessSigningRisk).
 *   (b) (a) plus an instruction to a random, unknown program id. Expect the
 *       one-shot consent and an elevated (red) risk.
 *   (c) The certified catalog shape 39 signs: Relay Bridge depositNative.
 *       SKIPs when the production worker does not certify it. decode never
 *       runs the certified lookup (rest-api.ts: "a decode must not promise
 *       it"), so its consent flag is printed, not asserted; 39 proves the
 *       signing gate drops the consent.
 *   (d) (a) with 31 extra read-only accounts: 33 static keys. Every firmware
 *       release reviews more than 32 keys as OPAQUE (AdvancedMode); only more
 *       than 32 signers is MALFORMED (solana.c). So the tier must not be
 *       green: green would mean Desktop expects the device to show it.
 */
const crypto = require('node:crypto')
const { run, SOLANA_PATH, skip } = require('../_helpers')
const F = require('./_fw716')
const S = require('../fixtures/fw-716/solana-tron')

function describe(d) {
  const r = d.risk || {}
  const ixs = (d.solanaDecoded?.instructions || []).map((i) => `${i.programName}:${i.instructionName || '?'}(${i.status})`)
  return `consent=${d.requiresBlindSigningConsent} level=${r.level} tier=${r.tier} "${r.headline}" [${ixs.join(', ')}]${d.solanaDecodeError ? ` error=${d.solanaDecodeError}` : ''}`
}

run('fw-716/04 Desktop Solana risk preview (no presses)', async (getSdk, assert) => {
  const sdk = await getSdk()
  const f = await sdk.system.info.getFeatures()
  console.log(`  firmware ${f.major_version}.${f.minor_version}.${f.patch_version} (Desktop judges requiresAdvancedMode against this version)`)
  const { address: sol } = await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH, show_display: false })
  console.log(`  device SOL: ${sol}\n`)
  const blockhash = crypto.randomBytes(32)

  const a = await sdk.solana.decodeTransaction({ raw_tx: S.unsignedWireTx(S.solTransferMessage(sol, sol, 1, blockhash)) })
  console.log(`  (a) self-transfer: ${describe(a)}`)
  assert('(a) Desktop decodes it', !a.solanaDecodeError)
  assert('(a) requiresBlindSigningConsent === false', a.requiresBlindSigningConsent === false)
  assert("(a) risk tier 'green' (requiresAdvancedMode false for this firmware)", a.risk?.tier === 'green')

  const unknown = crypto.randomBytes(32)
  const b = await sdk.solana.decodeTransaction({ raw_tx: S.unsignedWireTx(S.solTransferPlusUnknownMessage(sol, unknown, blockhash)) })
  console.log(`\n  (b) + unknown program ${S.b58encode(unknown)}: ${describe(b)}`)
  assert('(b) requiresBlindSigningConsent === true', b.requiresBlindSigningConsent === true)
  assert("(b) risk is elevated: tier 'red', level above 'low'", b.risk?.tier === 'red' && b.risk?.level !== 'low')

  const extra = Array.from({ length: 31 }, () => crypto.randomBytes(32))
  const d = await sdk.solana.decodeTransaction({ raw_tx: S.unsignedWireTx(S.legacyMessage({
    header: [1, 0, 32], keys: [S.b58decode(sol, 32), ...extra, S.b58decode(S.SYSTEM_PROGRAM, 32)], blockhash,
    instructions: [{ program: 32, accounts: [0, 0], data: S.systemTransferData(1) }],
  })) })
  console.log(`\n  (d) self-transfer with 33 static keys: ${describe(d)}`)
  assert('(d) Desktop decodes it', !d.solanaDecodeError)
  assert("(d) not green: 33 static keys need AdvancedMode on the device", d.risk?.tier !== 'green')

  const what = `${S.RELAY.program} (Relay Bridge) instruction ${S.RELAY.instruction}`
  const raw = S.unsignedWireTx(S.relayDepositNativeMessage(sol, 1_000_000, crypto.randomBytes(32), blockhash))
  const c = await sdk.solana.decodeTransaction({ raw_tx: raw })
  console.log(`\n  (c) ${what}: ${describe(c)}`)
  const ix = c.solanaDecoded?.instructions?.[0]
  assert('(c) Desktop decodes Relay Bridge depositNative', ix?.programId === S.RELAY.program && ix?.instructionName === S.RELAY.instruction)

  const cert = await F.worker('/v1/solana/certify', { rawTx: raw, catalogKey: S.RELAY.catalogKey })
  console.log(`  worker /v1/solana/certify: ${cert.status} ${cert.body?.classification} keyId=${cert.body?.schema?.signerKeyId} fingerprint=${cert.body?.fingerprint}${cert.body?.error ? ` error=${cert.body.error}` : ''}`)
  if (cert.status !== 200 || cert.body?.classification !== 'VERIFIED' || cert.body?.schema?.signerKeyId !== F.CERTIFIED_KEY_ID) {
    skip(`(c) the worker does not certify program ${what} (${cert.status} ${cert.body?.classification || ''}); (a) and (b) results are above`)
  }
  assert('(c) the worker certifies it (VERIFIED, keyId 0x80)', true)
  for (const arg of ix?.args || []) console.log(`    ${arg.name}: ${typeof arg.value === 'object' ? JSON.stringify(arg.value) : arg.value}`)
  for (const acct of ix?.accounts || []) console.log(`    ${acct.label}: ${acct.pubkey}`)
  console.log(`  (c) decode consent flag: ${c.requiresBlindSigningConsent}. decode-transaction does not run the certified lookup;`)
  console.log('      the signing gate does, and drops the consent for a certified envelope (proved by fw-716/39).')
})
