/**
 * recovery/load-verify.js — Wipe, load a RANDOM BIP-39 seed, and verify the
 * device derives the SAME ETH address an independent library (ethers v6) does.
 *
 * Exercises WipeDevice + LoadDevice + address derivation across word counts.
 * LoadDevice is production-available (fsm_msgLoadDevice is gated only by
 * CHECK_NOT_INITIALIZED + an on-device confirm — NOT #if DEBUG_LINK), so this
 * runs against the real flashed RC.
 *
 *  DESTRUCTIVE: this WIPES the connected device. Use a TEST device only.
 *  HUMAN-IN-LOOP: each wipe/load blocks until you press Confirm on the device.
 *
 * Robustness: WipeDevice (and possibly LoadDevice) reboots the device, so the
 * REST/USB connection drops mid-call (UND_ERR_SOCKET "other side closed"). That
 * is EXPECTED — we swallow the dropped call and then poll getFeatures() until the
 * device re-enumerates and reports the intended state, so correctness is asserted
 * from device STATE, not from the (unreliable) call return.
 *
 * NOT covered: recovery_cipher.c per-word/dry-run/wipe-on-failure (#272) — that's
 * the on-device CIPHER flow (recoverDevice), see the G1-G12 manual matrix.
 *
 * Run: node tests/run-all.js recovery   (vault must serve localhost:1646)
 */
const { run } = require('../_helpers')
const { Mnemonic, HDNodeWallet, randomBytes } = require('ethers')

const ETH_PATH = [0x80000000 + 44, 0x80000000 + 60, 0x80000000, 0, 0]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const randomMnemonic = (entropyBytes) => Mnemonic.fromEntropy(randomBytes(entropyBytes)).phrase
const expectedEth = (mnemonic) => HDNodeWallet.fromPhrase(mnemonic).address.toLowerCase()

/**
 * Poll getFeatures() until it returns and `.initialized === wantInitialized`,
 * tolerating the connection drops a wipe/load reboot causes. Returns the
 * features object on success, or null on timeout.
 */
async function waitForState(sdk, wantInitialized, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const f = await sdk.system.info.getFeatures()
      if (f && f.initialized === wantInitialized) return f
    } catch (_) { /* device re-enumerating after reboot */ }
    await sleep(1500)
  }
  return null
}

/** Wipe, tolerating the reboot drop; resolves once the device is back + uninitialized. */
async function robustWipe(sdk) {
  try { await sdk.system.device.wipe() } catch (_) { /* reboot drops the call */ }
  return waitForState(sdk, false)
}

/** Load a mnemonic, tolerating any reboot drop; resolves once back + initialized. */
async function robustLoad(sdk, mnemonic, label) {
  try { await sdk.system.device.loadDevice({ mnemonic, label }) } catch (_) { /* may re-enumerate */ }
  return waitForState(sdk, true)
}

run('Recovery: wipe + load random seed, verify derivation', async (getSdk, assert) => {
  const sdk = await getSdk()

  // 1 — 12-word random seed: device must match independent (ethers) derivation
  const m12 = randomMnemonic(16)
  console.log(`  12-word seed: ${m12}`)
  assert('wipe -> device uninitialized', !!(await robustWipe(sdk)))
  assert('load 12-word -> device initialized', !!(await robustLoad(sdk, m12, 'rc-12')))
  const a12 = (await sdk.address.ethGetAddress({ address_n: ETH_PATH })).address.toLowerCase()
  console.log(`    device: ${a12}   ethers: ${expectedEth(m12)}`)
  assert('12-word: device ETH addr == ethers derivation', a12 === expectedEth(m12))

  // 2 — 24-word random seed: matches, and differs from the 12-word seed
  const m24 = randomMnemonic(32)
  console.log(`  24-word seed: ${m24}`)
  await robustWipe(sdk)
  assert('load 24-word -> device initialized', !!(await robustLoad(sdk, m24, 'rc-24')))
  const a24 = (await sdk.address.ethGetAddress({ address_n: ETH_PATH })).address.toLowerCase()
  console.log(`    device: ${a24}   ethers: ${expectedEth(m24)}`)
  assert('24-word: device ETH addr == ethers derivation', a24 === expectedEth(m24))
  assert('different seeds derive different addresses', a12 !== a24)

  // 3 — Edge: invalid-checksum mnemonic must be rejected (device stays uninitialized).
  //     A socket error alone isn't proof of rejection (load may reboot too), so we
  //     assert from STATE: after the bad load the device must still be uninitialized.
  const badMnemonic = Array(12).fill('abandon').join(' ')   // valid words, bad BIP-39 checksum
  await robustWipe(sdk)
  try { await sdk.system.device.loadDevice({ mnemonic: badMnemonic, skip_checksum: false }) } catch (_) {}
  const stillUninit = await waitForState(sdk, false, 15000)
  assert('invalid-checksum mnemonic rejected (device stays uninitialized)', !!stillUninit)
})
