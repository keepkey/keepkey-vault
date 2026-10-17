#!/usr/bin/env node
/**
 * fw-716/13 — with AdvancedMode off, a TRC-20 outside the firmware's trusted
 * table is refused by the FIRMWARE (FW 7.15 cap 25). 1 Desktop click
 * (Approve), 0 device presses.
 *
 * TriggerSmartContract transfer(address,uint256) of 1 base unit on USDC
 * (TEkxi…, a real TRC-20 the firmware table leaves out on purpose), from the
 * device to itself, random TaPoS. Desktop decodes it (no Advanced Mode offer),
 * so Approve reaches the device, which refuses with "Enable AdvancedMode to
 * blind-sign" (fsm_msg_tron.h) before any screen.
 *
 * Only that firmware refusal passes. A card 403 means the device was never
 * asked (Reject clicked, or the card timed out at 119 s): INCONCLUSIVE, FAIL.
 * A signature is a FAIL.
 *
 * Not here: TIP-712 hash signing. Desktop marks /tron/sign-typed-hash blind,
 * so on 7.16 its card disables Approve until AdvancedMode is on; the firmware's
 * "blind-sign typed hashes" refusal cannot be reached with AdvancedMode off.
 */
const { run, short } = require('../_helpers')
const F = require('./_fw716')
const S = require('../fixtures/fw-716/solana-tron')

const REJECTED = 'Signing rejected by user'
const FIRMWARE_REFUSAL = 'Enable AdvancedMode to blind-sign'

run('fw-716/13 TRON untrusted TRC-20 refused by the firmware (AdvancedMode off)', async (getSdk, assert) => {
  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  F.guardAdvancedModeOff(sdk, assert)
  const { address: tron } = await sdk.address.tronGetAddress({ address_n: F.TRON_PATH, show_display: false })
  console.log(`  device TRON: ${tron}`)

  const raw = S.trc20TransferRaw({ owner: tron, contract: S.TRON_USDC, to: tron, amount: 1, feeLimit: 30_000_000 })
  console.log(`\n  TRC-20 transfer on ${S.TRON_USDC} (outside the trusted table), raw_data ${raw.length / 2} B`)
  console.log('  OWNER: the card shows "1 base units (unverified token)" to this device. Click Approve')
  console.log('         (never Enable Advanced Mode). The device should show NOTHING.')
  const started = Date.now()
  let out = null, msg = '', status
  try { out = await sdk.tron.tronSignTransaction({ raw_tx: raw, addressNList: F.TRON_PATH }) } catch (e) {
    msg = String(e?.message || e)
    status = e?.status
  }
  const elapsed = Date.now() - started
  console.log(`  answered after ${(elapsed / 1000).toFixed(1)} s: ${out ? `SIGNED ${short(out.signature)}` : `refused (${status || '?'}): ${msg.slice(0, 200)}`}`)
  assert('no signature returned', !out?.signature)
  if (msg.includes(REJECTED)) {
    console.error(`  INCONCLUSIVE: the card answered 403 (${elapsed >= 119_000 ? 'its 119 s timeout' : 'Reject clicked'}); the device was never asked. Re-run and click Approve.`)
  }
  assert(`the FIRMWARE refused: '${FIRMWARE_REFUSAL}'`, msg.includes(FIRMWARE_REFUSAL))
})
