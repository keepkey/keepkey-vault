/**
 * recovery/wrong-word.js — REST/SDK INTEGRATION smoke for cipher recovery:
 * garbage input is rejected on-device end-to-end through the REST recovery
 * endpoints (recover-device → sendCharacter → the on-device rejection surfaces
 * to the caller). It proves the plumbing refuses invalid input; it is NOT the
 * per-word BIP-39 (firmware #272) unit test.
 *
 * WHY #272 is not asserted here: the real #272 check must enter a VALID cipher
 * sequence that DECODES to a non-BIP-39 word and assert "Word not found in
 * BIP39 wordlist". That requires reading the device's scrambled cipher — which
 * is OLED-only on production firmware and exposed to the host ONLY over
 * DebugLink (emulator / DEBUG_LINK builds). Doing it against a REAL device
 * would require the firmware to leak the scramble over the wire, weakening the
 * cipher's host-blindness — so we deliberately don't. #272 is covered safely at
 * the emulator level in python-keepkey:
 *   test_msg_recoverydevice_cipher.py :: test_invalid_bip39_word_rejected
 *   (reads the cipher via DebugLink, enters a decoded non-wordlist word,
 *    asserts "Word not found in BIP39 wordlist").
 *
 * On a real device, 5 identical ciphered characters finalize to a non-wordlist
 * word; the device rejects with either "Word not found in BIP39 wordlist" or the
 * substitution-cipher guard depending on the scramble — either proves garbage is
 * refused. The rejection can surface on the sendCharacter() that finalizes the
 * word OR on the in-flight recoverDevice() promise, so we catch both.
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

run('Recovery: garbage cipher input rejected on-device (REST integration; per-word #272 lives in pyk)', async (getSdk, assert) => {
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
  // Each send carries the current seq (the vault pins it to that exact
  // CharacterRequest and to this client — a stale/foreign send is a 409).
  let curSeq = seq0
  let rejErr = null
  try {
    for (let i = 0; i < 5; i++) {
      await sdk.system.recovery.sendCharacter('a', curSeq)
      const next = await waitSeqAdvance(sdk, curSeq, 8000)
      if (next === null) break   // device stopped asking (likely already rejected)
      curSeq = next
    }
    await sdk.system.recovery.sendCharacter(' ', curSeq)   // finalize -> firmware validation
    await recovery
  } catch (e) { rejErr = e }

  const err = rejErr || recPromiseErr
  const msg = err ? String(err.message || JSON.stringify(err)) : ''
  console.log(`  recovery rejection -> ${msg.slice(0, 130) || 'NONE — device accepted garbage!'}`)
  assert('invalid recovery input rejected on-device',
    /word not found|wordlist|not entered correctly|substitution cipher/i.test(msg))
})
