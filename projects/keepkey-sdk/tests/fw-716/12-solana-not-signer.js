#!/usr/bin/env node
/**
 * fw-716/12 — a Solana transaction the device key does not sign is refused
 * with no device screen. 1 Desktop click (Approve), 0 device presses.
 *
 * A throwaway ed25519 key (node:crypto, never funded) is fee payer and sole
 * signer of a 1-lamport transfer to the device address; random blockhash.
 * Firmware 7.16 refuses this at fsm_msg_solana.h:845 ("Derived key is not a
 * signer for this tx"), before the AdvancedMode gate at :939.
 *
 * Desktop checks the same thing first (solana-signing.ts
 * signSolanaWireTransaction: "is not a required transaction signer") and
 * never sends the message to the device. That host refusal is reported as a
 * SKIP: no signature came back, but the firmware check was not reached.
 */
const crypto = require('node:crypto')
const { run, SOLANA_PATH, skip } = require('../_helpers')
const S = require('../fixtures/fw-716/solana-tron')

const FIRMWARE_REFUSAL = 'Derived key is not a signer for this tx'
const HOST_REFUSAL = 'is not a required transaction signer'

run('fw-716/12 Solana signer check: device key is not a signer', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address: sol } = await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH, show_display: false })
  const payer = S.throwawaySolanaKey()
  console.log(`  device SOL: ${sol}`)
  console.log(`  throwaway signer and fee payer: ${payer.address}`)
  const raw = S.unsignedWireTx(S.solTransferMessage(payer.address, sol, 1, crypto.randomBytes(32)))

  console.log('\n  OWNER: the Desktop card shows a 1-lamport SOL transfer from the throwaway key to this device.')
  console.log('         Click Approve (grant the one-shot consent if the card asks). The device should show NOTHING.')
  let out = null, err = null
  try {
    out = await sdk.solana.solanaSignTransaction({ raw_tx: raw, addressNList: SOLANA_PATH })
  } catch (e) { err = e }
  const msg = String(err?.message || err || '')
  console.log(`  result: ${out ? 'SIGNED' : `refused (${err?.status || '?'}): ${msg.slice(0, 200)}`}`)

  assert('no signature returned', !out?.signature)
  if (out?.signature) return
  if (/Signing rejected by user|One-shot blind-signing consent required/.test(msg)) {
    assert('Desktop gate pre-empted the device check (re-run, approve and grant consent)', false)
    return
  }
  if (msg.includes(HOST_REFUSAL)) {
    skip(`Desktop refused before the device ("${HOST_REFUSAL}", solana-signing.ts): the firmware signer check (fsm_msg_solana.h:845) is not reachable through Desktop REST`)
  }
  assert(`the firmware refused: '${FIRMWARE_REFUSAL}'`, msg.includes(FIRMWARE_REFUSAL))
})
