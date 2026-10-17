#!/usr/bin/env node
/**
 * fw-716/20 — one AdvancedMode session. Covers:
 *   - cap 17 (CAPABILITY_SESSION_TRUST_LIFETIME): AdvancedMode is session
 *     state; ClearSession turns it off without an ApplyPolicies(false).
 *   - SRS R-1.4: a certified claim is honoured or refused, never downgraded.
 *     With AdvancedMode ON, a certified-shaped envelope that does not fit the
 *     tx is still refused before any screen (ethereum.c, the
 *     signed_metadata_certified_claimed() check).
 *   - F-715-1: an OPAQUE Solana tx (33 static accounts) that the device key
 *     does not sign is refused, not blind-signed.
 *
 * Cost: 1 device press ('Enable Policy') + the PIN (ApplyPolicies is
 * CHECK_PIN_UNCACHED); 3 Desktop cards (Approve; grant the one-shot consent on
 * (c)); 0 signing presses. The lock at the end means the next device operation
 * asks for the PIN again. Run with KEEPKEY_SUITE_TIMEOUT_MS=600000.
 *
 * Signs nothing. Every refusal must come back with no signature. The EVM tx
 * uses SENTINEL_NONCE anyway. AdvancedMode is left OFF: clearSession, and
 * applyPolicies(false) only if it still reads on, or the suite FAILs loudly.
 *
 * Expected screens: device 'Enable Policy' + PIN once. Then NO device screen.
 * If one appears during (a), (b) or (c), press Cancel on Desktop: FAIL.
 */
const { run, atEnd, skip, short, ETH_PATH, SOLANA_PATH } = require('../_helpers')
const F = require('./_fw716')
const { randomBytes } = require('crypto')
const { decodeBase58, toBeHex } = require('ethers')

const BRIDGE_DEPOSIT = '0x49290c1c'
const EVM_REFUSAL = 'Certified description invalid or not for this tx'
const SOL_REFUSAL_DEVICE = 'Derived key is not a signer for this tx'          // fsm_msg_solana.h
const SOL_REFUSAL_DESKTOP = 'is not a required transaction signer'             // solana-signing.ts
const MIN_BUDGET_MS = 600_000
const DROP_POLL_MS = 120_000

/** A dropped connection, an SDK timeout or a network error: not an HTTP answer.
 *  Desktop gives /system/apply-policies no idle-timeout exemption, so a press
 *  plus a PIN can outlast the socket while the device carries on. */
const dropped = (err) => typeof err?.status !== 'number'

/** Read AdvancedMode after the features cache expires; keep reading up to
 *  `maxMs` until it reads `want`. Returns the last value read. */
async function readAdvancedMode(sdk, want, maxMs = 0) {
  const end = Date.now() + maxMs
  for (;;) {
    const on = F.advancedMode(await F.waitFeatures(sdk))
    if (on === want || Date.now() >= end) return on
    console.log(`  AdvancedMode reads ${on}; reading again`)
  }
}

/** applyPolicies; returns 'ok', 'dropped' (state unknown: read it), or the error. */
async function applyAdvancedMode(sdk, enabled) {
  try {
    await sdk.system.device.applyPolicies({ policyName: 'AdvancedMode', enabled })
    return 'ok'
  } catch (err) {
    if (dropped(err)) {
      console.log(`  applyPolicies: no HTTP answer (${err.name}: ${err.message}). Reading the device state instead.`)
      return 'dropped'
    }
    return err
  }
}

/** Legacy message with 33 static accounts (> SOL_MAX_ACCOUNTS 32), so the
 *  firmware classifies it OPAQUE. One required signer, a random fee payer; an
 *  unknown program; a random blockhash; one zero signature in the wrapper. */
function opaqueSolanaTx() {
  const keys = Array.from({ length: 33 }, () => randomBytes(32))
  const instruction = Buffer.concat([
    Buffer.from([32, 2, 0, 1, 8]), // program index 32, accounts [0, 1], 8 data bytes
    randomBytes(8),
  ])
  const message = Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 signer, 0 read-only signed, 1 read-only unsigned (the program)
    Buffer.from([33]), ...keys,
    randomBytes(32), // recent blockhash
    Buffer.from([1]), instruction,
  ])
  const wire = Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message])
  return { rawTx: wire.toString('base64'), message, bytes: wire.length }
}

run('fw-716/20 AdvancedMode session: cap 17 + certified refusals (R-1.4, F-715-1)', async (getSdk, assert) => {
  const budget = Number(process.env.KEEPKEY_SUITE_TIMEOUT_MS) || 180_000
  if (budget < MIN_BUDGET_MS) {
    skip(`needs KEEPKEY_SUITE_TIMEOUT_MS=${MIN_BUDGET_MS}: run-all.js would kill it at ${budget} ms mid-session`)
  }

  // Worker first (no device): the production bridgeDeposit envelope for (a)/(b).
  let envelope = null
  const entry = await F.findEvmEntry({ kind: 'schema', chainId: 1, selector: BRIDGE_DEPOSIT, method: 'bridgeDeposit' })
  if (!entry) {
    console.log("  SKIPPED (a)(b): no catalog entry 'Relay bridgeDeposit chain 1'")
  } else {
    const { status, body } = await F.evmSchema(1, entry.contract, BRIDGE_DEPOSIT, 68)
    console.log(`  worker /v1/evm/schema: ${status} ${body?.classification} keyId=${body?.keyId} fingerprint=${body?.fingerprint}`)
    if (F.isProductionEnvelope(body)) envelope = body.signedPayload
    else console.log(`  SKIPPED (a)(b): 'Relay bridgeDeposit chain 1' is not a VERIFIED production envelope (expected fingerprint ${F.EXPECT_FINGERPRINT})`)
  }
  let second = null
  if (envelope) {
    const alpha = process.env.KK716_ALPHA_ENVELOPE
    if (alpha) {
      second = { label: 'alpha root', payload: alpha.startsWith('0x') ? alpha : `0x${alpha}` }
    } else {
      // Flip the last byte of the delegate signature: the envelope ends with
      // signature(64) || recovery(1), so that byte is at length - 2.
      const b = Buffer.from(envelope.slice(2), 'hex')
      b[b.length - 2] ^= 0x01
      second = { label: 'tampered', payload: `0x${b.toString('hex')}` }
    }
  }

  const sdk = await getSdk()

  // 1) Start from AdvancedMode off.
  const before = await sdk.system.info.getFeatures()
  console.log(`  firmware ${before.major_version}.${before.minor_version}.${before.patch_version}, capabilities ${JSON.stringify(before.capabilities ?? 'not reported by this Desktop')}`)
  if (Array.isArray(before.capabilities)) {
    assert('device advertises cap 17 (session trust lifetime)', before.capabilities.includes(17))
  }
  await F.requireAdvancedModeOff(sdk, assert)

  // finally: leave AdvancedMode off, or FAIL loudly.
  atEnd(async () => {
    let on = F.advancedMode(await F.waitFeatures(sdk))
    if (on !== false) {
      console.log('  cleanup: AdvancedMode reads on. clearSession again.')
      await sdk.system.device.clearSession()
      on = F.advancedMode(await F.waitFeatures(sdk))
    }
    if (on !== false) {
      console.log("  cleanup: still on. OWNER: confirm 'Disable Policy' on the device and enter the PIN.")
      const r = await applyAdvancedMode(sdk, false)
      if (r !== 'ok' && r !== 'dropped') console.error(`  applyPolicies(false): ${r.status} ${r.message}`)
      on = await readAdvancedMode(sdk, false, r === 'dropped' ? DROP_POLL_MS : 0)
    }
    assert('cleanup: AdvancedMode is off at the end', on === false)
    if (on !== false) console.error('\n  !!! AdvancedMode is STILL ON. Lock or unplug the device now. !!!\n')
  })

  // 2) Turn it on for this session.
  console.log("\n  [2] OWNER: approve 'Enable Policy' (AdvancedMode) on the device, then enter the PIN on Desktop.")
  const applied = await applyAdvancedMode(sdk, true)
  if (applied !== 'ok' && applied !== 'dropped') {
    const msg = String(applied.message || applied)
    console.error(`  applyPolicies(true): ${applied.status} ${msg.slice(0, 200)}`)
    assert(msg.includes('Apply policies cancelled') ? 'policy prompt was cancelled' : 'applyPolicies(true) succeeds', false)
    return
  }

  // 3) The device reports it.
  const on = await readAdvancedMode(sdk, true, applied === 'dropped' ? DROP_POLL_MS : 0)
  console.log(`  [3] AdvancedMode: ${on}`)
  assert('AdvancedMode enabled === true', on === true)
  if (on !== true) return

  const eth = (await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })).address
  const sol = (await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH, show_display: false })).address
  console.log(`  device: eth ${eth}  sol ${sol}`)

  // 4) Refusals. Every one must return no signature.
  const tx = F.evmTx({ from: eth, to: F.randomAddress(), data: '0xdeadbeef' + F.word(F.randomHex(32)), value: '0x0', chainId: 1 })
  console.log(`  EVM tx: chain 1, to ${tx.to} (random), data ${tx.data.slice(0, 10)}+32 bytes, nonce ${tx.nonce}`)

  const refusal = async (label, call, expect) => {
    console.log(`\n  [4${label}] OWNER: Approve the card. If ANY device screen appears, press Desktop Cancel.`)
    let out, err
    try { out = await call() } catch (e) { err = e }
    if (out) {
      console.error(`  ${label}: SIGNED ${short(out.serialized || out.serializedTx || out.signature)}`)
      assert(`${label}: refused, no signature`, false)
      return
    }
    const msg = String(err?.message || err)
    console.log(`  ${label}: ${err?.status ?? '-'} ${msg.slice(0, 240)}`)
    const hit = expect.find((x) => msg.includes(x.text))
    if (hit) {
      assert(`${label}: refused before any screen by the ${hit.layer} ('${hit.text}')`, true)
      return hit
    }
    if (/cancel/i.test(msg)) {
      assert(`${label}: refused before any screen (a screen appeared and was cancelled: the claim was downgraded)`, false)
    } else if (/Signing rejected by user|blind-signing consent required/.test(msg)) {
      assert(`${label}: INCONCLUSIVE (card rejected or consent withheld; the device was never asked)`, false)
    } else {
      assert(`${label}: refused with ${expect.map((x) => `'${x.text}'`).join(' or ')}`, false)
    }
  }

  if (envelope) {
    await refusal('(a) live production bridgeDeposit envelope on a random contract',
      () => sdk.eth.ethSignTransaction({ ...tx, txMetadata: { signedPayload: envelope, keyId: F.CERTIFIED_KEY_ID } }),
      [{ text: EVM_REFUSAL, layer: 'device' }])
    await refusal(`(b) ${second.label} envelope`,
      () => sdk.eth.ethSignTransaction({ ...tx, txMetadata: { signedPayload: second.payload, keyId: F.CERTIFIED_KEY_ID } }),
      [{ text: EVM_REFUSAL, layer: 'device' }])
  }

  const sTx = opaqueSolanaTx()
  const solKey = Buffer.from(toBeHex(decodeBase58(sol), 32).slice(2), 'hex')
  assert('(c) fixture: device key absent from the message', !sTx.message.includes(solKey))
  console.log(`  Solana tx: legacy, 33 static accounts, unknown program, ${sTx.bytes} bytes`)
  console.log('  (c) OWNER: also grant the one-shot blind-signing consent on the card.')
  const c = await refusal('(c) opaque Solana tx the device key does not sign',
    () => sdk.solana.solanaSignTransaction({ raw_tx: sTx.rawTx, addressNList: SOLANA_PATH }),
    [{ text: SOL_REFUSAL_DEVICE, layer: 'device' }, { text: SOL_REFUSAL_DESKTOP, layer: 'Desktop' }])
  if (c?.layer === 'Desktop') {
    console.log('  NOT COVERED: F-715-1 device check. Desktop refuses a non-signer key before the device is asked,')
    console.log('  so the firmware check cannot be reached over REST. No signature was produced.')
  }

  // 5) Lock. 6) AdvancedMode must read off with no applyPolicies(false).
  console.log('\n  [5] clearSession (no press; the next device operation asks for the PIN)')
  await sdk.system.device.clearSession()
  const after = F.advancedMode(await F.waitFeatures(sdk))
  console.log(`  [6] AdvancedMode after clearSession: ${after}`)
  assert('cap 17: clearSession turned AdvancedMode off (no applyPolicies(false))', after === false)
})
