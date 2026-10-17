#!/usr/bin/env node
/**
 * fw-716/13 — with AdvancedMode off, TRON signing outside the trusted
 * table is refused (FW 7.15 cap 25). 2 Desktop clicks, 0 device presses.
 *
 * (a) TriggerSmartContract transfer(address,uint256) of 1 base unit on USDC
 *     (TEkxi…, a real TRC-20 the firmware table leaves out on purpose), from
 *     the device to itself, random TaPoS. The firmware refuses with
 *     "Enable AdvancedMode to blind-sign"; a card Reject (403) also counts.
 *     The suite prints which layer refused.
 * (b) TIP-712 hash-only signing with random hashes. Desktop marks it blind but
 *     does not require AdvancedMode, so the card allows Approve; the firmware
 *     refuses with "Enable AdvancedMode to blind-sign typed hashes".
 *
 * AdvancedMode on at the start is a FAIL (it would turn both into blind-sign
 * screens). A signature from either step is a FAIL.
 */
const crypto = require('node:crypto')
const { run, short } = require('../_helpers')
const F = require('./_fw716')
const S = require('../fixtures/fw-716/solana-tron')

const REJECTED = 'Signing rejected by user'

async function attempt(fn) {
  try { return { out: await fn(), msg: '' } } catch (e) { return { out: null, msg: String(e?.message || e), status: e?.status } }
}

run('fw-716/13 TRON untrusted TRC-20 and TIP-712 hashes refused (AdvancedMode off)', async (getSdk, assert) => {
  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  const { address: tron } = await sdk.address.tronGetAddress({ address_n: F.TRON_PATH, show_display: false })
  console.log(`  device TRON: ${tron}`)

  const raw = S.trc20TransferRaw({ owner: tron, contract: S.TRON_USDC, to: tron, amount: 1, feeLimit: 30_000_000 })
  console.log(`\n  (a) TRC-20 transfer on ${S.TRON_USDC} (outside the trusted table), raw_data ${raw.length / 2} B`)
  console.log('  OWNER: card 1 of 2 shows "1 base units (unverified token)" to this device. Click Approve.')
  console.log('         The device should show NOTHING.')
  const a = await attempt(() => sdk.tron.tronSignTransaction({ raw_tx: raw, addressNList: F.TRON_PATH }))
  console.log(`  result: ${a.out ? `SIGNED ${short(a.out.signature)}` : `refused (${a.status || '?'}): ${a.msg.slice(0, 200)}`}`)
  assert('(a) no signature returned', !a.out?.signature)
  const byFirmware = a.msg.includes('Enable AdvancedMode to blind-sign')
  const byCard = a.msg.includes(REJECTED)
  console.log(`  (a) refused by: ${byFirmware ? 'the FIRMWARE' : byCard ? 'the Desktop CARD (403)' : 'neither expected layer'}`)
  assert("(a) refusal is the firmware's 'Enable AdvancedMode to blind-sign' or a 403 card rejection", byFirmware || byCard)

  const ds = F.randomHex(32), mh = F.randomHex(32)
  console.log(`\n  (b) TIP-712 hashes: domain ${short(ds)} message ${short(mh)}`)
  console.log('  OWNER: card 2 of 2 shows "TIP-712 hashes (blind)". Click Approve. The device should show NOTHING.')
  const b = await attempt(() => sdk.tron.tronSignTypedHash({ addressNList: F.TRON_PATH, domain_separator_hash: ds, message_hash: mh }))
  console.log(`  result: ${b.out ? `SIGNED ${short(b.out.signature)}` : `refused (${b.status || '?'}): ${b.msg.slice(0, 200)}`}`)
  assert('(b) no signature returned', !b.out?.signature)
  if (b.msg.includes(REJECTED)) console.log('  (b) the card was rejected, so the device was never asked: re-run and click Approve.')
  assert("(b) the firmware refused: 'Enable AdvancedMode to blind-sign typed hashes'", b.msg.includes('Enable AdvancedMode to blind-sign typed hashes'))
})
