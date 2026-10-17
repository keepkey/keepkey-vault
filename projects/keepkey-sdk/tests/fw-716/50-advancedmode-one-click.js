#!/usr/bin/env node
/**
 * fw-716/50 — DESKTOP: the approval card's main button turns AdvancedMode on,
 * then signs. Owner-driven, opt-in only: KK716_ONE_CLICK=1.
 *
 * Cost: 1 Desktop click (the card's main button, 'Enable Advanced Mode') +
 * 'Enable Policy' on the device with the PIN, then about 2-3 blind-sign
 * presses. The restore is clearSession (0 presses, no flash write); the next
 * device operation asks for the PIN. Run with KEEPKEY_SUITE_TIMEOUT_MS=900000
 * (worst case: PIN, the card, blind-sign screens, policy re-reads, cleanup).
 *
 * Signs only, never broadcasts: chain 1, a random contract, value 0,
 * SENTINEL_NONCE, so the tx can never be mined.
 *
 * Pass: the signature recovers to the device; AdvancedMode reads true after
 * the sign and false after the restore.
 */
const { run, atEnd, skip, assertSignedByDevice, ETH_PATH } = require('../_helpers')
const F = require('./_fw716')

const MIN_BUDGET_MS = 900_000
const DROP_POLL_MS = 120_000

run('fw-716/50 one-click AdvancedMode from the approval card', async (getSdk, assert) => {
  if (process.env.KK716_ONE_CLICK !== '1') skip('opt-in: set KK716_ONE_CLICK=1 (owner-driven, turns AdvancedMode on)')
  const budget = Number(process.env.KEEPKEY_SUITE_TIMEOUT_MS) || 180_000
  if (budget < MIN_BUDGET_MS) {
    skip(`needs KEEPKEY_SUITE_TIMEOUT_MS=${MIN_BUDGET_MS}: run-all.js would kill it at ${budget} ms mid-session`)
  }

  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)

  // finally: clearSession, then applyPolicies(false) only if it still reads on.
  atEnd(async () => {
    await sdk.system.device.clearSession()
    let on = F.advancedMode(await F.waitFeatures(sdk))
    if (on !== false) {
      console.log("  restore: still on after clearSession. OWNER: confirm 'Disable Policy' on the device and enter the PIN.")
      let wait = 0
      try {
        await sdk.system.device.applyPolicies({ policyName: 'AdvancedMode', enabled: false })
      } catch (err) {
        if (typeof err?.status === 'number') throw err
        // No HTTP answer (the route has no idle-timeout exemption): read the device.
        console.log(`  applyPolicies(false): no HTTP answer (${err.name}). Reading the device state instead.`)
        wait = DROP_POLL_MS
      }
      const end = Date.now() + wait
      do { on = F.advancedMode(await F.waitFeatures(sdk)) } while (on !== false && Date.now() < end)
    }
    console.log(`  restore: AdvancedMode ${on}`)
    assert('AdvancedMode reads false after the restore', on === false)
    if (on !== false) console.error('\n  !!! AdvancedMode is STILL ON. Lock or unplug the device now. !!!\n')
  })

  // The address read can ask for the PIN; a retry covers a dropped socket.
  const getAddress = () => sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  let device
  try { device = (await getAddress()).address } catch (err) {
    if (typeof err?.status === 'number') throw err
    console.log(`  ethGetAddress: no HTTP answer (${err.name}); asking once more`)
    device = (await getAddress()).address
  }
  console.log(`  device: ${device}`)

  const tx = F.evmTx({ from: device, to: F.randomAddress(), data: '0xdeadbeef' + F.word(F.randomHex(32)), value: '0x0', chainId: 1 })
  console.log(`  tx: chain 1, to ${tx.to} (random), data ${tx.data.slice(0, 10)}+32 bytes, value 0, nonce ${tx.nonce}`)
  console.log("\n  OWNER: use the card's main button (Enable Advanced Mode).")
  console.log("         Device: 'Enable Policy' + PIN, then the blind-sign screens: confirm them.")

  let out
  try { out = await sdk.eth.ethSignTransaction(tx) } catch (err) {
    console.error(`  sign: ${err?.status ?? '-'} ${String(err?.message || err).slice(0, 240)}`)
    assert('the one-click sign returns a signature', false)
    return
  }
  assertSignedByDevice(assert, out, device, 1)

  const on = F.advancedMode(await F.waitFeatures(sdk))
  console.log(`  AdvancedMode after the sign: ${on}`)
  assert('AdvancedMode reads true after the sign', on === true)
})
