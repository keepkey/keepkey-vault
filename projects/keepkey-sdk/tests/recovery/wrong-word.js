/**
 * recovery/wrong-word.js — firmware #272: during cipher recovery, a word that
 * isn't in the BIP-39 wordlist must be rejected (per-word validation).
 *
 * We can't enter a SPECIFIC seed without reading the device's scrambled cipher
 * (OLED-only on production firmware) — but we don't need to. Sending the same
 * ciphered character 5x de-ciphers to 5 identical letters, which is never a
 * BIP-39 word (and dodges the 4-char auto-complete) whatever the scramble is.
 * The firmware then rejects the word and recoverDevice() fails with
 * "Word not found in BIP39 wordlist".
 *
 *  DESTRUCTIVE: wipes the device. Use a TEST device only.
 *  HUMAN-IN-LOOP: press Confirm to start recovery (+ approve pairing on first run).
 *
 * Requires the REST recovery-character endpoints (POST /system/recovery/character
 * {,/delete,/done}, GET /system/recovery/state). Run: node tests/run-all.js recovery
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

run('Recovery #272: invalid word rejected during cipher recovery', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  // Start from a clean, uninitialized device.
  try { await sdk.system.device.wipe() } catch (_) { /* wipe reboots -> call may drop */ }
  assert('device uninitialized before recovery', await waitUninitialized(sdk))

  const baseSeq = (await sdk.system.recovery.getRecoveryState()).seq

  // Begin cipher recovery (do NOT await — it resolves/rejects when entry finishes).
  const recovery = sdk.system.device.recoverDevice({
    word_count: 12, pin_protection: false, passphrase_protection: false,
  })

  // Wait (generously — this blocks on the human Confirm) for the device to enter
  // the cipher and emit the first CharacterRequest.  >>> PRESS CONFIRM on the device.
  let seq = await waitSeqAdvance(sdk, baseSeq, 60000)
  assert('device entered cipher recovery (CharacterRequest received)', seq !== null)

  // Enter a guaranteed-invalid first word: 5 identical letters, then a separator.
  for (let i = 0; i < 5 && seq !== null; i++) {
    await sdk.system.recovery.sendCharacter('a')
    seq = await waitSeqAdvance(sdk, seq, 8000)
  }
  await sdk.system.recovery.sendCharacter(' ')   // finalize the word -> per-word validation

  // recoverDevice() must reject — the firmware aborts on the unknown word.
  let recErr = null
  try { await recovery } catch (e) { recErr = e }
  console.log(`  recoverDevice() -> ${recErr ? String(recErr.message || recErr).slice(0, 110) : 'RESOLVED (unexpected!)'}`)
  assertThrows('invalid word rejected (recoverDevice fails with "Word not found")', recErr, 'word')
})
