/**
 * recovery/wrong-word.js — firmware #272 area: during cipher recovery the device
 * must REJECT invalid input rather than accept garbage as a seed.
 *
 * We can't enter a specific seed without reading the device's scrambled cipher
 * (OLED-only on production firmware). We don't need to: sending 5 identical
 * ciphered characters is never a valid cipher-entered BIP-39 word, so the
 * firmware rejects it. Observed on a 7.15.0 device, the rejection is:
 *   "Words were not entered correctly. Make sure you are using the substitution
 *    cipher."  (the anti-non-cipher guard; the per-word "Word not found in BIP39
 *    wordlist" path is the other valid rejection.) Either proves garbage is
 *    refused — that's the security property.
 *
 * The rejection can surface on the sendCharacter() that finalizes the word OR on
 * the in-flight recoverDevice() promise, so we catch both.
 *
 *  DESTRUCTIVE: needs an uninitialized device; wipes only if currently initialized
 *     (a wipe reboots the device and churns the USB transport — avoid when we can).
 *  HUMAN-IN-LOOP: approve pairing (first run) + Confirm "Recover device?".
 *  NOTE: on the unsigned RC, a wipe reboots into the "unofficial firmware" gate;
 *     prefer starting from an already-empty device, and replug if comms wedge.
 *
 * Requires the REST recovery endpoints (POST /system/recovery/character{,/delete,
 * /done}, GET /system/recovery/state). Run: node tests/run-all.js recovery
 */
const { run } = require('../_helpers')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUninitialized(sdk, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { const f = await sdk.system.info.getFeatures(); if (f && f.initialized === false) return true } catch (_) {}
    await sleep(1500)
  }
  return false
}

/** Wait until the recovery seq advances past `fromSeq` (device asked for the next
 *  character). Returns the new seq, or null on timeout. */
async function waitSeqAdvance(sdk, fromSeq, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try { const s = await sdk.system.recovery.getRecoveryState(); if (s && s.seq > fromSeq) return s.seq } catch (_) {}
    await sleep(500)
  }
  return null
}

run('Recovery #272: invalid input rejected during cipher recovery', async (getSdk, assert) => {
  const sdk = await getSdk()

  // Recovery needs an uninitialized device. Only wipe if it isn't already empty
  // (the wipe reboots the device and tends to wedge the USB transport).
  const f0 = await sdk.system.info.getFeatures()
  if (f0.initialized) {
    try { await sdk.system.device.wipe() } catch (_) {}
    assert('device uninitialized (after wipe)', await waitUninitialized(sdk))
  } else {
    assert('device already uninitialized', true)
  }

  const baseSeq = (await sdk.system.recovery.getRecoveryState()).seq

  // Begin cipher recovery (do NOT await — resolves/rejects when entry finishes).
  const recovery = sdk.system.device.recoverDevice({
    word_count: 12, pin_protection: false, passphrase_protection: false,
  })
  // The rejection may land on this promise instead of a sendCharacter call.
  let recPromiseErr = null
  recovery.catch((e) => { recPromiseErr = e })

  // Generous — this blocks on the human Confirm.  >>> CONFIRM "Recover device?".
  const seq0 = await waitSeqAdvance(sdk, baseSeq, 60000)
  assert('device entered cipher recovery (CharacterRequest received)', seq0 !== null)

  // Enter a guaranteed-invalid word: 5 identical ciphered chars + a separator.
  let seq = seq0
  let rejErr = null
  try {
    for (let i = 0; i < 5 && seq !== null; i++) {
      await sdk.system.recovery.sendCharacter('a')
      seq = await waitSeqAdvance(sdk, seq, 8000)
    }
    await sdk.system.recovery.sendCharacter(' ')   // finalize -> firmware validation
    await recovery
  } catch (e) { rejErr = e }

  const err = rejErr || recPromiseErr
  const msg = err ? String(err.message || JSON.stringify(err)) : ''
  console.log(`  recovery rejection -> ${msg.slice(0, 130) || 'NONE — device accepted garbage!'}`)
  assert('invalid recovery input rejected on-device',
    /word not found|wordlist|not entered correctly|substitution cipher/i.test(msg))
})
