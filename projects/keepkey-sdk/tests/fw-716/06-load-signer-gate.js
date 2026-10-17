#!/usr/bin/env node
/**
 * fw-716/06 — runtime ClearSign signers need AdvancedMode on 7.16, and Desktop
 * refuses persist:true at schema validation. 0 device presses, no card.
 *
 * load-signer is not a SIGNING_ROUTE, so Desktop shows no approval card. If the
 * session is locked, the firmware runs CHECK_PIN before the AdvancedMode check,
 * so Desktop's PIN pad may appear once.
 *
 * Pass criteria come from what the API returns:
 *   persist:true  -> HTTP 400 'persistent ClearSign signers are not supported'
 *                    (schemas.ts LoadClearsignSignerRequest), before the device
 *   no persist    -> 'AdvancedMode required for clearsign signers'
 *                    (fsm_msgLoadClearsignSigner), never { ok: true }
 *   afterwards    -> AdvancedMode still off
 *
 * Nothing is loaded and nothing is written to flash. If a signer did load
 * (a FAIL), the suite ends with clearSession, which drops it.
 */
const { run, atEnd } = require('../_helpers')
const { CI_TEST_PUBKEY, CI_SIGNER_ALIAS, TEST_KEY_ID } = require('../_clearsign')
const F = require('./_fw716')

const signer = { keyId: TEST_KEY_ID, pubkey: CI_TEST_PUBKEY, alias: CI_SIGNER_ALIAS }

/** Run a call that must fail. Returns { out, err }; never throws. */
async function attempt(fn) {
  try { return { out: await fn() } } catch (err) { return { err } }
}

run('fw-716/06 load-signer gate (AdvancedMode off, no persist)', async (getSdk, assert) => {
  const sdk = await getSdk()
  // A signer that loads is a FAIL; clearSession then drops it (no press).
  let loaded = false
  atEnd(async () => {
    if (!loaded) return
    await sdk.system.device.clearSession()
    console.log('  clearSession: the loaded runtime signer was dropped')
  })

  // 1) The gate is only meaningful with AdvancedMode off.
  await F.requireAdvancedModeOff(sdk, assert)

  // 2) persist:true is refused by Desktop's schema, before any device call.
  console.log(`\n  [2] loadClearsignSigner keyId=${signer.keyId} alias='${signer.alias}' persist:true`)
  const persisted = await attempt(() => sdk.eth.loadClearsignSigner({ ...signer, persist: true }))
  if (persisted.out) {
    console.error(`  returned ${JSON.stringify(persisted.out)}`)
    loaded = true
  } else {
    console.log(`  -> ${persisted.err.status ?? '-'} ${String(persisted.err.message).slice(0, 200)}`)
  }
  assert('persist:true: no { ok: true }', !persisted.out)
  assert('persist:true: HTTP 400', persisted.err?.status === 400)
  assert("persist:true: 'persistent ClearSign signers are not supported'",
    String(persisted.err?.message || '').includes('persistent ClearSign signers are not supported'))

  // 3) Without persist the request reaches the firmware, which refuses it.
  console.log(`\n  [3] loadClearsignSigner keyId=${signer.keyId} alias='${signer.alias}' (RAM only)`)
  console.log('  OWNER: no device screen is expected. Enter the PIN on Desktop if it asks.')
  console.log("         If a 'Trust signer' screen appears, press Cancel on the device: that is a FAIL.")
  const ram = await attempt(() => sdk.eth.loadClearsignSigner(signer))
  const ramMsg = String(ram.err?.message || '')
  if (ram.out) {
    console.error(`  returned ${JSON.stringify(ram.out)}: the device trusted a runtime signer with AdvancedMode off`)
    loaded = true
  } else {
    console.log(`  -> ${ram.err.status ?? '-'} ${ramMsg.slice(0, 200)}`)
    if (ramMsg.includes('User rejected clear-sign signer')) {
      console.error("  A device screen or the PIN pad was cancelled. The firmware refusal was not observed.")
    }
  }
  assert('no persist: no { ok: true }', !ram.out)
  assert("no persist: 'AdvancedMode required for clearsign signers'",
    ramMsg.includes('AdvancedMode required for clearsign signers'))

  // 4) The refusal changed no policy.
  const on = F.advancedMode(await F.waitFeatures(sdk))
  console.log(`\n  [4] AdvancedMode after ${F.FEATURES_WAIT_MS} ms: ${on}`)
  assert('AdvancedMode is still off', on === false)
})

