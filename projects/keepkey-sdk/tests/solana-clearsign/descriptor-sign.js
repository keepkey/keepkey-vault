#!/usr/bin/env node
/**
 * On-device KKSOLSW1 test — sign only, never broadcasts.
 *
 * 1. Loads the existing CI ClearSign key into shared device signer slot 3.
 * 2. Proves a descriptor bound to a different message is rejected.
 * 3. Signs an opaque v0 + ALT swap through SolanaSignTx with a valid descriptor.
 *
 * Requires firmware with KKSOLSW1 support and human confirmation of the signer
 * trust screen plus the ClearSign swap pages.
 */
const { run, SOLANA_PATH } = require('../_helpers')
const {
  TEST_KEY_ID,
  CI_TEST_PUBKEY,
  CI_SIGNER_ALIAS,
  buildSolanaSwapFixture,
  decodeSolanaAddress,
  wrapUnsignedTransaction,
} = require('../fixtures/solana-clearsign')

run('Solana ClearSign: KKSOLSW1 descriptor on device', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH })
  const signerPublicKey = decodeSolanaAddress(address)
  const fixture = buildSolanaSwapFixture(signerPublicKey)

  console.log(`  Device Solana address: ${address}`)
  console.log(`\n  Loading signer into shared ClearSign slot ${TEST_KEY_ID}, alias "${CI_SIGNER_ALIAS}"`)
  console.log('  >>> CONFIRM the "Trust signer" screen on device <<<\n')
  const load = await sdk.eth.loadClearsignSigner({
    keyId: TEST_KEY_ID,
    pubkey: CI_TEST_PUBKEY,
    alias: CI_SIGNER_ALIAS,
  })
  assert('ClearSign signer loaded (device confirmed)', !!load && load.ok === true)

  // Keep the signer/program/instruction shape valid but mutate the recent
  // blockhash. The signed descriptor now names a different exact message and
  // must fail closed before any blind-sign fallback is considered.
  const differentMessage = Buffer.from(fixture.message)
  differentMessage[69] ^= 1
  let mismatchError
  try {
    await sdk.solana.solanaSignTransaction({
      addressNList: SOLANA_PATH,
      raw_tx: wrapUnsignedTransaction(differentMessage).toString('base64'),
      swapMetadata: fixture.metadata,
      allowBlindSigning: true,
    })
  } catch (error) {
    mismatchError = error
  }
  assertThrows(
    'message-mismatched metadata fails closed even when fallback consent is present',
    mismatchError,
    'Invalid Solana swap metadata',
  )

  console.log('\n  Signing opaque Solana v0 swap with transaction-bound metadata')
  console.log('  >>> APPROVE the ClearSign signer, amount, minimum receive, destination, and final sign pages <<<')
  const result = await sdk.solana.solanaSignTransaction({
    addressNList: SOLANA_PATH,
    raw_tx: fixture.wireTransaction.toString('base64'),
    swapMetadata: fixture.metadata,
  })
  const signature = Buffer.from(result.signature, 'base64')
  const signedWire = Buffer.from(result.serializedTx, 'base64')
  assert('device returned a 64-byte Ed25519 signature', signature.length === 64)
  assert('signature was inserted into the original transaction', signedWire.subarray(1, 65).equals(signature))
  assert('signed transaction preserved the exact message', signedWire.subarray(65).equals(fixture.message))
})
