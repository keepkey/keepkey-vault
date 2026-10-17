#!/usr/bin/env node
/**
 * fw-716/36 — a TRC-20 USDT transfer clear-signs with AdvancedMode off
 * (FW 7.15 cap 25). 1 Desktop click + 2 device presses.
 *
 * TriggerSmartContract transfer of 1 base unit (0.000001 USDT) on
 * TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t from the device to itself, fee_limit
 * 30 TRX, random ref_block_bytes and ref_block_hash: TaPoS can never match a
 * real block, so the signed transaction can never land. Signs only.
 *
 * Pass: secp256k1 recovery over sha256(raw_data) gives the device's TRON
 * address.
 */
const { run, short } = require('../_helpers')
const F = require('./_fw716')
const S = require('../fixtures/fw-716/solana-tron')

run('fw-716/36 TRC-20 USDT transfer clear-signs (AdvancedMode off)', async (getSdk, assert) => {
  const sdk = await getSdk()
  await F.requireAdvancedModeOff(sdk, assert)
  const { address: tron } = await sdk.address.tronGetAddress({ address_n: F.TRON_PATH, show_display: false })
  console.log(`  device TRON: ${tron}`)

  const raw = S.trc20TransferRaw({ owner: tron, contract: S.TRON_USDT, to: tron, amount: 1, feeLimit: 30_000_000 })
  console.log(`  raw_data: ${raw.length / 2} B, random TaPoS (can never land)`)
  console.log('\n  OWNER: approve the Desktop card (0.000001 USDT to this device). Then on the device:')
  console.log(`         1. "TRC-20 Transfer" / "Send 0.000001 USDT to ${tron}?"  -> confirm`)
  console.log('         2. "TRON" / "Energy fee limit 30 TRX" / "Bandwidth fees are extra"  -> confirm')
  const out = await sdk.tron.tronSignTransaction({ raw_tx: raw, addressNList: F.TRON_PATH })
  const sig = String(out?.signature || '')
  console.log(`  signature: ${short(sig)}`)
  assert('returns a 65-byte signature', /^(0x)?[0-9a-f]{130}$/i.test(sig))
  if (!sig) return
  const signer = S.recoverTronSigner(raw, sig)
  console.log(`  recovered: ${signer}`)
  assert('signature over sha256(raw_data) recovers to the device TRON address', signer === tron)
})
