/**
 * evm-tx-1559/sign-and-recover.js — live regression test
 *
 * Re-signs the captured failing input via a paired KeepKey, parses the
 * returned serialized envelope, and asserts the recovered signer equals the
 * device's address. NO broadcast — pure signing-chain verification.
 *
 * Why: the BEX-side `[DECODE]` log catches this in production but only
 * after the fact and only inside the extension. This test runs the SAME
 * payload through the SDK in isolation so the bug can be reproduced and
 * bisected without touching keepkey-client at all.
 *
 * Pairs with evm-tx-1559/recover-fixture.js (offline, never needs device).
 *
 * Usage:
 *   KEEPKEY_API_KEY=<paired-bearer-token> node tests/evm-tx-1559/sign-and-recover.js
 *
 * If the device-derived address ≠ the fixture's expectedSigner (different
 * seed in your dev device), set EXPECTED_SIGNER=auto to use the device's
 * own ETH address as the expected.
 */
const fs = require('fs')
const path = require('path')
const { run, ETH_PATH } = require('../_helpers')
const { Transaction } = require('ethers')

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'evm-tx-1559-regression.json')

run('EIP-1559 sign + offline recover (regression)', async (getSdk, assert) => {
  const sdk = await getSdk()
  const blobs = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const names = Object.keys(blobs).filter(k => !k.startsWith('_'))

  const { address: deviceAddress } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device address: ${deviceAddress}`)

  for (const name of names) {
    const fix = blobs[name]
    console.log(`\n  ── ${name} ──`)

    // The fixture's input was captured from a specific user; if running on a
    // different paired device, the addressNList still points at the same
    // BIP44 slot but the address differs. Override `from` with the device's
    // address, otherwise the SDK will refuse to sign.
    const input = { ...fix.input, from: deviceAddress, addressNList: ETH_PATH }
    const expected = process.env.EXPECTED_SIGNER === 'auto' || fix.expectedSigner.toLowerCase() !== deviceAddress.toLowerCase()
      ? deviceAddress
      : fix.expectedSigner

    console.log(`     expected signer: ${expected}`)
    console.log(`     >>> APPROVE on device — replaying captured failing tx <<<\n`)

    let output
    try {
      output = await sdk.eth.ethSignTransaction(input)
    } catch (e) {
      assert(`${name}: SDK threw "${e.message?.slice(0, 60)}" instead of returning malformed bytes`, false)
      continue
    }

    const serialized = output.serialized || output.serializedTx
    if (!serialized) {
      assert(`${name}: SDK returned a serialized envelope`, false)
      continue
    }

    let parsed
    try {
      parsed = Transaction.from(serialized)
    } catch (e) {
      assert(`${name}: ethers can parse the serialized envelope`, false)
      console.error(`     parse error: ${e.message}`)
      continue
    }

    const recovered = parsed.from
    console.log(`     recovered: ${recovered}`)
    console.log(`     txHash:    ${parsed.hash}`)
    console.log(`     v=${parsed.signature.yParity} r=${parsed.signature.r.slice(0, 18)}... s=${parsed.signature.s.slice(0, 18)}...`)

    const match = recovered.toLowerCase() === expected.toLowerCase()
    assert(`${name}: live-signed envelope recovers to expected signer`, match)

    if (!match) {
      console.error(`     ⚠ MALFORMED-HEX bug reproduced. The SDK/firmware signing chain is producing serialized bytes whose ECDSA signature does NOT recover to the device's address.`)
      console.error(`     This is the keepkey-client release blocker. See RETRO_evm_tx_1559_signing_chain.md.`)
    }
  }
})
