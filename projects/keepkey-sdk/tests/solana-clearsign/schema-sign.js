#!/usr/bin/env node
/**
 * On-device KKSOLSC1 test — signs only, never broadcasts.
 *
 * Proves the reusable-schema path end to end:
 *   1. Load the CI ClearSign key into shared signer slot 3.
 *   2. Sign a Relay-shaped deposit with a valid schema — the device should
 *      show the decoded program/instruction/amount/vault instead of a blind
 *      "confirm this transaction" prompt.
 *   3. Sign the SAME schema against a DIFFERENT amount, proving one signature
 *      is genuinely reusable (this is the whole point of KKSOLSC1).
 *   4. Prove a schema that under-covers the instruction data is refused.
 *
 * Requires firmware with KKSOLSC1 support plus human confirmations.
 */
const { run, SOLANA_PATH } = require('../_helpers')
const {
  TEST_KEY_ID,
  CI_TEST_PUBKEY,
  CI_SIGNER_ALIAS,
  CATALOG,
  ARG_U64,
  base58Decode,
  buildSignedSchema,
  buildRelayInstructionData,
} = require('../fixtures/solana-schema')

/**
 * A legacy Solana message calling the Relay program with N accounts. Legacy
 * (not v0) and no lookup tables, because a schema deliberately refuses
 * ALT-backed instructions — their accounts are not in the signed bytes.
 */
function buildRelayMessage(signerPublicKey, instructionData, extraAccounts = 4) {
  const program = base58Decode(CATALOG.relayDepositNative.programId)
  const accounts = [Buffer.from(signerPublicKey)]
  for (let i = 1; i <= extraAccounts; i++) accounts.push(Buffer.alloc(32, 0x30 + i))
  accounts.push(program) // program account last

  const parts = [
    Buffer.from([1, 0, 1]), // 1 required sig, 0 readonly signed, 1 readonly unsigned
    Buffer.from([accounts.length]),
    ...accounts,
    Buffer.alloc(32, 0xbb), // recent blockhash
    Buffer.from([1]), // one instruction
    Buffer.from([accounts.length - 1]), // program index
    Buffer.from([extraAccounts + 1]), // account index count
    Buffer.from(Array.from({ length: extraAccounts + 1 }, (_, i) => i)),
    Buffer.from([instructionData.length]),
    Buffer.from(instructionData),
  ]
  return Buffer.concat(parts)
}

/** Wrap a message as an unsigned wire transaction (1 empty signature slot). */
function wrapUnsigned(message) {
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message])
}

function decodeSolanaAddress(address) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = 0n
  for (const ch of address) num = num * 58n + BigInt(ALPHABET.indexOf(ch))
  const bytes = []
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn))
    num >>= 8n
  }
  while (bytes.length < 32) bytes.unshift(0)
  return Buffer.from(bytes)
}

run('Solana ClearSign: KKSOLSC1 reusable schema on device', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.solanaGetAddress({ address_n: SOLANA_PATH })
  const signer = decodeSolanaAddress(address)
  console.log(`  Device Solana address: ${address}`)

  console.log(`\n  Loading signer into ClearSign slot ${TEST_KEY_ID}, alias "${CI_SIGNER_ALIAS}"`)
  console.log('  >>> CONFIRM the "Trust signer" screen on device <<<\n')
  const load = await sdk.eth.loadClearsignSigner({
    keyId: TEST_KEY_ID,
    pubkey: CI_TEST_PUBKEY,
    alias: CI_SIGNER_ALIAS,
  })
  assert('ClearSign signer loaded (device confirmed)', !!load && load.ok === true)

  const { schema } = buildSignedSchema(CATALOG.relayDepositNative)

  // ── 1. Valid schema, first amount ──
  const dataA = buildRelayInstructionData(CATALOG.relayDepositNative.discriminator, 526490980n)
  console.log('  >>> CONFIRM the decoded Relay screens (Amount 526490980) <<<\n')
  const signedA = await sdk.solana.solanaSignTransaction({
    addressNList: SOLANA_PATH,
    raw_tx: wrapUnsigned(buildRelayMessage(signer, dataA)).toString('base64'),
    schema,
  })
  assert('signed a schema-decoded Relay deposit', !!signedA && !!(signedA.signature || signedA.serialized))

  // ── 2. THE point of KKSOLSC1: the SAME signature covers a different tx ──
  const dataB = buildRelayInstructionData(CATALOG.relayDepositNative.discriminator, 25000000n)
  console.log('  >>> CONFIRM again — same schema, different amount (25000000) <<<\n')
  const signedB = await sdk.solana.solanaSignTransaction({
    addressNList: SOLANA_PATH,
    raw_tx: wrapUnsigned(buildRelayMessage(signer, dataB)).toString('base64'),
    schema,
  })
  assert('the same schema signature covered a second, different transaction', !!signedB)

  // ── 3. Under-covering schema must be refused, not blind-signed ──
  const partial = buildSignedSchema({
    ...CATALOG.relayDepositNative,
    args: [{ type: ARG_U64, label: 'Amount' }], // 8+8 = 16, not 48
  })
  await assertThrows(
    'a schema that does not account for all instruction bytes is refused',
    () =>
      sdk.solana.solanaSignTransaction({
        addressNList: SOLANA_PATH,
        raw_tx: wrapUnsigned(buildRelayMessage(signer, dataA)).toString('base64'),
        schema: partial.schema,
      }),
  )
})
