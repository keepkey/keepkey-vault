/**
 * evm-clearsign/loadsigner-sign-flows.js — the vault-side clear-sign train, on device.
 *
 * 1. Loads the CI test signer (pubkey == firmware slot 3) at runtime via the new
 *    POST /eth/clearsign/load-signer route  →  DEVICE CONFIRM (trust screen).
 * 2. For each flagship flow: builds the metadata blob bound to the tx's real
 *    sighash (tests/_clearsign.js, byte-parity-proven offline) and signs via
 *    /eth/sign-transaction with txMetadata  →  DEVICE CONFIRM (clear-sign pages).
 *
 * Requires firmware 7.15.0-rc3+ (LoadClearsignSigner msg 117) and a Vault built
 * with the new hdwallet loadClearsignSigner + route. Sign-only, no broadcast,
 * no wipe. The signer is RAM-only — reload if the device reboots.
 *
 * Run: KEEPKEY_API_KEY=… node tests/evm-clearsign/loadsigner-sign-flows.js
 */
const { run, ETH_PATH } = require('../_helpers')
const { buildFlowBlob, CI_TEST_PUBKEY, CI_SIGNER_ALIAS, TEST_KEY_ID } = require('../_clearsign')

// Flagship tranche: STRING + TOKEN_AMOUNT + ADDRESS (aave), token transfer,
// and an UNLIMITED approval render. Expand to the full 51 once green.
const FLOWS = ['aave-v3-supply', 'erc20-transfer', 'erc20-approve-unlimited']

run('clear-sign: load CI signer + sign flagship flows', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device ETH address: ${address}`)

  console.log(`\n  Loading CI signer into slot ${TEST_KEY_ID}, alias "${CI_SIGNER_ALIAS}"`)
  console.log(`  pubkey ${CI_TEST_PUBKEY}`)
  console.log('  >>> CONFIRM the "Trust signer" screen on device <<<\n')
  const load = await sdk.eth.loadClearsignSigner({ keyId: TEST_KEY_ID, pubkey: CI_TEST_PUBKEY, alias: CI_SIGNER_ALIAS })
  assert('Signer loaded (device confirmed)', !!load && load.ok === true)

  for (const key of FLOWS) {
    const { tx, blobHex, keyId, flow } = buildFlowBlob(key)
    console.log(`\n  [${key}] ${flow.method}  to=${tx.to}`)
    console.log(`    args: ${flow.args.map(a => a.name).join(', ')}`)
    console.log('    >>> APPROVE the clear-sign pages on device <<<')
    const result = await sdk.eth.ethSignTransaction({
      ...tx,
      addressNList: ETH_PATH,
      txMetadata: { signedPayload: blobHex, keyId },
    })
    assert(`[${key}] got signature`, !!(result && (result.serializedTx || result.r)))
  }
})
