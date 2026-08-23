/**
 * evm-clearsign/provider-live-sign-flow.js — the live provider path, on device.
 *
 * A provider hosts a signing server holding its own key. The wallet sends the
 * unsigned transaction; the server decodes it, attests what it derived, and
 * returns a blob bound to that transaction's real sighash. The device shows the
 * decode under the provider's identity.
 *
 *   1. GET  /signer  — the identity the device's trust screen must match.
 *   2. POST /sign    — the exact tx we are about to sign. The server derives the
 *                      selector, the values and the sighash from those bytes.
 *   3. Load signer   — DEVICE CONFIRM, fingerprint must match.
 *   4. Sign          — DEVICE CONFIRM decoded recipient/amount, not raw hex.
 *
 * Also checks the two refusals that matter more than the happy path: an
 * uncurated contract and calldata with trailing bytes must be DECLINED, not
 * stamped. A signer that attests what it cannot decode is worse than no signer,
 * because a matched blob REPLACES the device's raw-data screen.
 *
 * Needs firmware 7.15.0-rc4+, AdvancedMode on, and the provider server
 * (cd projects/keepkey-clearsign-server && make serve).
 *
 * Run: KEEPKEY_API_KEY=… node tests/evm-clearsign/provider-live-sign-flow.js
 */
const { run, ETH_PATH, erc20Transfer } = require('../_helpers')

const PROVIDER = process.env.CLEARSIGN_PROVIDER || 'http://localhost:1647'

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const UNCURATED = '0x1111111254eeb25477b68fb85ed929f73a960582'
const RECIPIENT = '0x742d35cc6634c0532950a20547b231011e30c8e7'
const AMOUNT = 1000000n // 1.0 USDC

// The exact transaction the device will sign. Every field feeds the sighash, so
// any drift between what we send the signer and what we send the device makes
// the device reject the blob and blind-sign.
const TX = {
  chainId: 1,
  to: USDC,
  data: '0x' + erc20Transfer(RECIPIENT, AMOUNT).replace(/^0x/, ''),
  value: '0x0',
  nonce: '0x0',
  gasLimit: '0x3d090',
  gasPrice: '0x4a817c800',
}

async function post(path, body) {
  const response = await fetch(`${PROVIDER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

run('clear-sign: live provider attestation on device', async (getSdk, assert) => {
  let signer
  try {
    const response = await fetch(`${PROVIDER}/signer`)
    if (!response.ok) throw new Error(`${response.status}`)
    signer = await response.json()
  } catch (cause) {
    console.log(`  SKIPPED — no provider server at ${PROVIDER} (${cause.message}).`)
    console.log('  Start it: cd projects/keepkey-clearsign-server && make serve\n')
    return
  }

  console.log(`  Provider: ${signer.alias} · ${signer.fingerprint} · slot ${signer.keyId}`)

  // Refusals first — they cost no device presses and they are the property that
  // makes the happy path safe.
  const uncurated = await post('/sign', { ...TX, to: UNCURATED })
  assert('declines an uncurated contract', uncurated.status === 422 && uncurated.body.classification === 'OPAQUE')

  const trailing = await post('/sign', { ...TX, data: TX.data + 'dead' })
  assert('declines calldata with trailing bytes', trailing.status === 422)

  const noFee = await post('/sign', { ...TX, gasPrice: undefined })
  assert('declines a tx with no fee model', noFee.status >= 400)

  const attested = await post('/sign', TX)
  assert('attests the curated transfer', attested.status === 200)
  const { signedPayload, keyId, txHash, decoded } = attested.body
  console.log(`  Attested: ${decoded.contract} · ${decoded.method}(${decoded.args.join(', ')})`)
  console.log(`  txHash ${txHash}`)

  assert('blob is v1 (METADATA_VERSION_LEGACY)', signedPayload.slice(0, 2) === '01')
  assert('blob key_id matches the signer slot', keyId === signer.keyId)
  // The tx_hash the server bound is inside the blob it signed; if it were not
  // the digest of the tx below, the device would refuse it.
  assert('blob carries the derived tx hash', signedPayload.includes(txHash))

  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device ETH address: ${address}`)

  console.log(`\n  Loading "${signer.alias}" into slot ${signer.keyId}`)
  console.log(`\n  >>> The device must show fingerprint ${signer.fingerprint.toUpperCase()} <<<`)
  console.log('  >>> Anything else: REJECT — you do not know which key you are trusting <<<\n')
  const load = await sdk.eth.loadClearsignSigner({
    keyId: signer.keyId,
    pubkey: signer.publicKeyHex,
    alias: signer.alias,
  })
  assert('signer loaded (device confirmed)', !!load && load.ok === true)

  console.log(`\n  Signing 1.0 USDC → ${RECIPIENT}`)
  console.log('  >>> APPROVE the clear-sign pages — USD Coin, recipient, 1 USDC, no raw hex <<<')
  const result = await sdk.eth.ethSignTransaction({
    ...TX,
    addressNList: ETH_PATH,
    txMetadata: { signedPayload, keyId },
  })
  assert('device signed under the provider identity', !!(result && (result.serializedTx || result.r)))
})
