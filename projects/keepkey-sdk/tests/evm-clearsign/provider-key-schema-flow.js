/**
 * evm-clearsign/provider-key-schema-flow.js — the whole chain, end to end.
 *
 * ceremony key → offline catalog build → read-only server → device clear-signs.
 *
 * Deliberately consumes only what the server publishes. No key file, no local
 * schema building: if this passes, the bytes a real client would fetch are the
 * bytes the device decoded. Building the schema in-process would have proven
 * the serializer and nothing about the catalog.
 *
 *   1. GET /signer      — the identity the device's trust screen must match.
 *   2. GET /catalog/…   — pull the USDC transfer schema and verify its
 *                         signature offline, before spending any device press.
 *   3. Load the signer  — DEVICE CONFIRM. The fingerprint on screen MUST equal
 *                         the one printed here; only a human can check that,
 *                         the device never reports it back over the wire.
 *   4. Sign a transfer  — DEVICE CONFIRM decoded recipient/amount, not raw hex.
 *
 * Step 4 is what makes step 3 more than theatre: the device only decodes if the
 * catalog's signature verifies against the key it was told to trust.
 *
 * Needs firmware 7.15.0-rc4+ (METADATA_VERSION_SCHEMA) and the catalog server
 * (cd projects/keepkey-clearsign-server && make serve).
 *
 * Run: KEEPKEY_API_KEY=… node tests/evm-clearsign/provider-key-schema-flow.js
 */
const { sha256 } = require('@noble/hashes/sha256')
const { secp256k1 } = require('@noble/curves/secp256k1')
const { run, ETH_PATH, erc20Transfer } = require('../_helpers')

const CATALOG = process.env.CLEARSIGN_CATALOG || 'http://localhost:1647'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const TRANSFER = '0xa9059cbb'
const RECIPIENT = '0x1d0e8e5c8f4a3f4b0c9a2e6d7b8c1a3f5e2d4c6b'
const AMOUNT = 1000000000n // 1000 USDC at 6 decimals

async function getJson(path) {
  const response = await fetch(`${CATALOG}${path}`)
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`)
  return response.json()
}

run('clear-sign: catalog schema signs on device', async (getSdk, assert) => {
  let signer, chain
  try {
    signer = await getJson('/signer')
    chain = await getJson('/catalog/eip155-1.json')
  } catch (cause) {
    // Not a failure: run-all.js has no catalog server. Say why it did nothing
    // rather than passing silently.
    console.log(`  SKIPPED — no catalog at ${CATALOG} (${cause.message}).`)
    console.log('  Start it: cd projects/keepkey-clearsign-server && make serve\n')
    return
  }

  console.log(`  Catalog: ${CATALOG} · signer ${signer.alias} · slot ${signer.keyId}`)
  console.log(`  eip155:1 — ${Object.keys(chain.entries).length} schemas, built ${chain.builtAt}`)

  const fingerprint = Buffer.from(sha256(Buffer.from(signer.publicKeyHex, 'hex'))).toString('hex').slice(0, 8)
  assert('served fingerprint matches its public key', fingerprint === signer.fingerprint)

  const b64 = chain.entries[`${USDC}:${TRANSFER}`]
  assert('catalog has the USDC transfer schema', typeof b64 === 'string')
  const blob = Buffer.from(b64, 'base64')
  assert('blob is v2 (METADATA_VERSION_SCHEMA)', blob[0] === 0x02)

  // The last body byte is key_id; it must equal the slot we load, or the device
  // resolves the wrong pubkey and rejects.
  const body = blob.subarray(0, blob.length - 65)
  assert('blob key_id matches the signer slot', body[body.length - 1] === signer.keyId)

  // Verify offline first — a corrupted or substituted entry should cost zero
  // device presses to catch. lowS:false matches the reference signer.
  const signature = secp256k1.Signature.fromCompact(blob.subarray(body.length, body.length + 64))
  const verified = secp256k1.verify(signature, sha256(body), Buffer.from(signer.publicKeyHex, 'hex'), { lowS: false })
  assert('catalog signature verifies under the served public key', verified)

  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device ETH address: ${address}`)

  console.log(`\n  Loading "${signer.alias}" into slot ${signer.keyId}`)
  console.log(`  pubkey ${signer.publicKeyHex}`)
  console.log(`\n  >>> The device must show fingerprint ${fingerprint.toUpperCase()} <<<`)
  console.log('  >>> Anything else: REJECT — you do not know which key you are trusting <<<\n')
  const load = await sdk.eth.loadClearsignSigner({
    keyId: signer.keyId,
    pubkey: signer.publicKeyHex,
    alias: signer.alias,
  })
  assert('signer loaded (device confirmed)', !!load && load.ok === true)

  // transfer(address,uint256) — 4 + 2*32 bytes. The device requires exactly
  // this length or v2 decode fails and it falls back to blind-signing.
  const data = '0x' + erc20Transfer(RECIPIENT, AMOUNT).replace(/^0x/, '')
  assert('calldata is 4 + 32*num_args bytes', (data.length - 2) / 2 === 68)

  console.log(`\n  Signing 1000 USDC → ${RECIPIENT}`)
  console.log('  >>> APPROVE the clear-sign pages — recipient and amount, no raw hex <<<')
  const result = await sdk.eth.ethSignTransaction({
    to: USDC,
    value: '0x0',
    data,
    nonce: '0x0',
    gasLimit: '0x' + (250000).toString(16),
    gasPrice: '0x' + (20000000000).toString(16),
    chainId: 1,
    addressNList: ETH_PATH,
    // The catalog stores base64 (compact, matches the reference payload); the
    // vault's REST layer takes hex. Convert at the edge, as relay-v2 does.
    txMetadata: { signedPayload: blob.toString('hex'), keyId: signer.keyId },
  })
  assert('device signed under the catalog identity', !!(result && (result.serializedTx || result.r)))
})
