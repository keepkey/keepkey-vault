/**
 * evm-clearsign/relay-v2-schema-flow.js — the epic's payoff, on device.
 *
 * Proves "add a new service (relay) via a signed static-schema payload":
 *   1. Load the slot-3 test signer at runtime (LoadClearsignSigner) — DEVICE CONFIRM.
 *   2. Sign a real-shape relay solver swap (0x02d5f05f: token, amount, requestId)
 *      with a v2 STATIC-SCHEMA blob (no tx_hash, no per-tx signing). The device
 *      decodes token/amount/requestId FROM the calldata it signs and clear-signs
 *      them — DEVICE CONFIRM the clear-sign screens.
 *
 * Relay is NOT in the firmware's native allowlist — this is the whole point:
 * a signed schema teaches the device to clear-sign a brand-new contract.
 *
 * Requires firmware 7.15.0-rc4+ (v2 static schema, METADATA_VERSION_SCHEMA).
 * Blob + calldata from projects/keepkey-clearsign/docs/relay-v2-schema-payload/.
 *
 * Run: KEEPKEY_API_KEY=… node tests/evm-clearsign/relay-v2-schema-flow.js
 */
const { run, ETH_PATH } = require('../_helpers')

// v2 static-schema blob for (chainId 1, relay solver, selector 0x02d5f05f),
// signed by the slot-3 test key. First byte 0x02 = METADATA_VERSION_SCHEMA.
const RELAY_BLOB_B64 =
  'AgAAAAFM0A44diLDW925tMliwTZGIzi8MQLV8F8ACXJlbGF5U3dhcAMFdG9rZW4BBmFtb3VudAUGBFVTREMJcmVxdWVzdElkAgFlU/EAA0jTsCp1JgC29oO6f8a2SFa6ruyRxFpiy6wInS4yP8jhLwkDxk8iEf/iYRoue2SoZ7XTxrdAVMIAdPloJXX3Do0c'

const RELAY_TO = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
// selector + token(USDC) + amount(2987.5 USDC) + requestId — byte-identical to
// real relay traffic (100 bytes, all fixed words).
const RELAY_DATA =
  '0x02d5f05f000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' +
  '00000000000000000000000000000000000000000000000000000000b211a1e0' +
  '000000000000000000000000000000000000000000000000000000000000cd7c'

const SLOT3_PUBKEY = '02e3b3015c47ddcaabe4f8e872f1ed8f09ca145a8d81770d92213d56da31ab5107'
const KEY_ID = 3
const ALIAS = 'CI Test'

run('clear-sign v2: relay static-schema on device', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device ETH address: ${address}`)

  const blobHex = Buffer.from(RELAY_BLOB_B64, 'base64').toString('hex')
  console.log(`  v2 blob: version byte 0x${blobHex.slice(0, 2)} (expect 0x02), ${blobHex.length / 2} bytes`)
  assert('blob is v2 (METADATA_VERSION_SCHEMA)', blobHex.slice(0, 2) === '02')

  console.log(`\n  Loading signer into slot ${KEY_ID}, alias "${ALIAS}"`)
  console.log(`  pubkey ${SLOT3_PUBKEY}`)
  console.log('  >>> CONFIRM the "Trust signer" screen on device <<<\n')
  const load = await sdk.eth.loadClearsignSigner({ keyId: KEY_ID, pubkey: SLOT3_PUBKEY, alias: ALIAS })
  assert('signer loaded (device confirmed)', !!load && load.ok === true)

  console.log('\n  Signing relay swap — the device decodes token/amount/requestId from the calldata')
  console.log('  >>> APPROVE the clear-sign pages on device <<<')
  console.log('      expect: token 0xA0b8…eb48 (USDC),  amount 2987.5 USDC,  requestId 52604')
  const result = await sdk.eth.ethSignTransaction({
    to: RELAY_TO,
    data: RELAY_DATA,
    value: '0x0',
    nonce: '0x0',
    gasLimit: '0x30d40',
    gasPrice: '0x4a817c800',
    chainId: 1,
    addressNList: ETH_PATH,
    txMetadata: { signedPayload: blobHex, keyId: KEY_ID },
  })
  assert('relay tx signed (device clear-signed the schema)', !!(result && (result.serializedTx || result.r)))
  console.log(`  signature: r=${(result.r || '').slice(0, 18)}… v=${result.v}`)
})
