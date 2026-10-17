#!/usr/bin/env node
/**
 * fw-716/39 — certified Solana review (KKSOLSC1, delegate keyId 0x80) signs
 * with AdvancedMode off (FW 7.16 cap 18). 1 Desktop click + several presses.
 *
 * Relay Bridge depositNative of 0.001 SOL (catalog entry relayDepositNative),
 * legacy message, the device key as fee payer, depositor and refundTo, the
 * production vault and config accounts, random order id and random blockhash:
 * it can never land. Signs only. The suite sends NO schema: Desktop's signing
 * gate fetches the certified envelope from its ClearSign service and attaches
 * it, and the device verifies it against the production root.
 *
 * Pass: ed25519 verify(signature, message, device key), and the response's
 * clearSignReport says source 'certified', format 'KKSOLSC1'. A missing
 * clearSignReport is a FAIL. SKIP when the worker does not certify it.
 */
const crypto = require('node:crypto')
const { run, SOLANA_PATH, short, skip } = require('../_helpers')
const F = require('./_fw716')
const S = require('../fixtures/fw-716/solana-tron')

const PRODUCTION_ROOT_PREFIX = '027c1fde'
const LAMPORTS = 1_000_000

run('fw-716/39 certified Solana Relay depositNative (AdvancedMode off, Desktop attaches)', async (getSdk, assert) => {
  const what = `program ${S.RELAY.program} (Relay Bridge) instruction ${S.RELAY.instruction}`
  const status = await F.worker('/v1/status')
  const root = String(status.body?.trust?.rootPublicKey || '')
  console.log(`  worker ${F.WORKER}: ${status.body?.environment} root=${short(root)}`)
  if (status.body?.environment !== 'production' || !root.toLowerCase().startsWith(PRODUCTION_ROOT_PREFIX)) {
    skip(`the worker is not the production ClearSign service (environment ${status.body?.environment}, root ${short(root)})`)
  }

  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  // Desktop's own ClearSign lookup may miss even when the worker certifies the
  // tx: then its card asks for AdvancedMode up front. Never leave it on.
  F.guardAdvancedModeOff(sdk, assert)
  const { address: sol } = await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH, show_display: false })
  console.log(`  device SOL: ${sol}`)

  const orderId = crypto.randomBytes(32)
  const message = S.relayDepositNativeMessage(sol, LAMPORTS, orderId, crypto.randomBytes(32))
  const raw = S.unsignedWireTx(message)

  const decoded = await sdk.solana.decodeTransaction({ raw_tx: raw })
  const ix = decoded.solanaDecoded?.instructions?.[0]
  console.log(`  decode: ${ix?.programName}:${ix?.instructionName} consent=${decoded.requiresBlindSigningConsent} tier=${decoded.risk?.tier}${decoded.solanaDecodeError ? ` error=${decoded.solanaDecodeError}` : ''}`)

  const cert = await F.worker('/v1/solana/certify', { rawTx: raw, catalogKey: S.RELAY.catalogKey })
  console.log(`  worker /v1/solana/certify: ${cert.status} ${cert.body?.classification} keyId=${cert.body?.schema?.signerKeyId} alias=${cert.body?.alias} fingerprint=${cert.body?.fingerprint}`)
  if (cert.status !== 200 || cert.body?.classification !== 'VERIFIED' || cert.body?.schema?.signerKeyId !== F.CERTIFIED_KEY_ID) {
    skip(`the worker does not certify ${what} (${cert.status} ${cert.body?.classification || ''} ${cert.body?.error || ''})`)
  }

  console.log('\n  OWNER: the Desktop card shows "Relay Bridge — depositNative" from a KeepKey-certified description. Approve.')
  console.log('         On the device: the certified Relay Bridge depositNative review, signed by KeepKey ClearSign:')
  console.log(`           Amount 0.001 SOL, Order ${orderId.toString('hex').slice(0, 16)}…, Vault ${S.RELAY.vault}, then the fee and Sign.`)
  console.log('         Confirm each screen. A blind-sign or "Enable AdvancedMode" screen means FAIL: press Cancel.')
  console.log('         If the card offers Enable Advanced Mode instead, Desktop did not attach the certified review: click Reject (FAIL).')
  let out
  try {
    out = await sdk.solana.solanaSignTransaction({ raw_tx: raw, addressNList: SOLANA_PATH })
  } catch (e) {
    console.error(`  sign refused: ${e?.status ?? '-'} ${String(e?.message || e).slice(0, 300)}`)
    assert('device signed the certified Solana review', false)
    return
  }

  const sig = Buffer.from(String(out?.signature || ''), 'base64')
  console.log(`  signature: ${short(sig.toString('hex'))}`)
  assert('returns a 64-byte signature', sig.length === 64)
  if (sig.length === 64) assert('ed25519 signature over the message verifies with the device key', S.ed25519Verify(sig, message, sol))

  const r = out?.clearSignReport
  assert('response carries clearSignReport', !!r)
  if (!r) return
  console.log(`  signed report: ${F.describeReport(r)}${r.descriptor?.label ? ` label="${r.descriptor.label}"` : ''}`)
  assert("descriptor.source === 'certified'", r.descriptor?.source === 'certified')
  assert("descriptor.format === 'KKSOLSC1'", r.descriptor?.format === 'KKSOLSC1')
})
