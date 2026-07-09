/**
 * evm-clearsign/clearsign-signer-flows.js — dual-mode on-device clear-sign test.
 *
 * Exercises the full runtime-signer clear-sign train against a real device, in
 * either of two trust sources — same load→sign→assert skeleton, different signer:
 *
 *   CLEARSIGN_MODE=self     (default) — the CI test key signs golden catalog blobs
 *                                       offline; loads into slot 3. No Pioneer.
 *   CLEARSIGN_MODE=pioneer            — the live Pioneer insight signer builds the
 *                                       blob and returns its pubkey; loads into the
 *                                       slot Pioneer signs (CLEARSIGN_KEY_SLOT, def 1).
 *
 * Both modes:
 *   1. loadClearsignSigner(pubkey, slot)  → DEVICE CONFIRM ("Trust signer" screen)
 *   2. per flow: ethSignTransaction with the bound metadata blob → DEVICE clear-sign
 *      pages (VERIFIED) instead of raw hex. Assert a signature comes back.
 *
 * Requires firmware 7.15.0-rc3+ (LoadClearsignSigner msg 117) and a Vault built with
 * the hdwallet loadClearsignSigner method + /eth/clearsign/load-signer route. Signers
 * are RAM-only — reload after a device reboot. Sign-only, no broadcast.
 *
 * Run:  KEEPKEY_API_KEY=… node tests/evm-clearsign/clearsign-signer-flows.js
 *       KEEPKEY_API_KEY=… CLEARSIGN_MODE=pioneer node tests/evm-clearsign/clearsign-signer-flows.js
 *
 * pioneer mode needs Pioneer's /descriptors/sign enabled (CLEARSIGN_LIVE_SIGN=true +
 * INSIGHT_MNEMONIC) at PIONEER_URL (default http://localhost:9001).
 */
const { run, ETH_PATH, erc20Approve } = require('../_helpers')
const { buildFlowBlob, sighashLegacy, CI_TEST_PUBKEY, CI_SIGNER_ALIAS, TEST_KEY_ID } = require('../_clearsign')

const MODE = process.env.CLEARSIGN_MODE || 'self'
const PIONEER_URL = (process.env.PIONEER_URL || 'http://localhost:9001').replace(/\/+$/, '')

// Deterministic legacy tx params — identical to _clearsign.js so Pioneer, the local
// sighash cross-check, and the device all recompute the same EIP-155 sighash.
const NONCE = '0x0', GAS_PRICE = '0x4a817c800' /* 20 gwei */, GAS_LIMIT = '0x3d090' /* 250000 */

// self mode: golden catalog flows the CI key signs offline (slot 3, byte-parity-proven).
// CLEARSIGN_FLOW=<key> runs a single flow (useful for isolating one flow / avoiding
// the consecutive-sign hang while that's investigated separately).
const ALL_SELF_FLOWS = ['aave-v3-supply', 'erc20-transfer', 'erc20-approve-unlimited']
const SELF_FLOWS = process.env.CLEARSIGN_FLOW ? [process.env.CLEARSIGN_FLOW] : ALL_SELF_FLOWS

// pioneer mode: real contracts Pioneer classifies VERIFIED. Extend as coverage grows.
const PIONEER_FLOWS = [
  {
    label: 'approve (VERIFIED contract)',
    chainId: 1,
    to: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    data: erc20Approve('0x1111111111111111111111111111111111111111', 1000000n),
    value: '0x0',
  },
]

const hb = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'))

/** self mode: CI signer + offline golden blobs (buildFlowBlob does the binding). */
function selfProvider() {
  const flows = SELF_FLOWS.map((k) => {
    const b = buildFlowBlob(k)
    return { label: k, tx: b.tx, blobHex: b.blobHex, keyId: b.keyId }
  })
  return {
    signer: { keyId: TEST_KEY_ID, pubkey: CI_TEST_PUBKEY, alias: CI_SIGNER_ALIAS },
    flows,
  }
}

/** pioneer mode: fetch each blob + the signer pubkey from live Pioneer. */
async function pioneerProvider(assert) {
  const flows = []
  for (const f of PIONEER_FLOWS) {
    const body = {
      chainId: f.chainId, contractAddress: f.to, data: f.data,
      nonce: NONCE, gasLimit: GAS_LIMIT, value: f.value, gasPrice: GAS_PRICE,
    }
    const resp = await fetch(`${PIONEER_URL}/api/v1/descriptors/sign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const d = await resp.json()
    if (!d.success) throw new Error(`Pioneer /sign failed for ${f.label}: ${d.error} `
      + `(enable with CLEARSIGN_LIVE_SIGN=true + INSIGHT_MNEMONIC on ${PIONEER_URL})`)

    // Prove the tx we'll send the device binds to the blob Pioneer signed.
    const localHash = '0x' + Buffer.from(sighashLegacy(hb(f.to), BigInt(f.value), hb(f.data), f.chainId)).toString('hex')
    if (localHash !== d.txHash) throw new Error(`${f.label}: sighash mismatch — local ${localHash} != Pioneer ${d.txHash}`)

    console.log(`  [${f.label}] classification=${d.classification} keyId=${d.keyId} `
      + `pubkey=${(d.signerPubkey || 'MISSING').slice(0, 22)}… blob=${Buffer.from(d.signedPayload, 'base64').length}B`)
    flows.push({
      label: f.label, keyId: d.keyId, signerPubkey: d.signerPubkey, classification: d.classification,
      blobHex: Buffer.from(d.signedPayload, 'base64').toString('hex'),  // caller path arrayifies a STRING as hex
      tx: { to: f.to, value: f.value, data: f.data, nonce: NONCE, gasLimit: GAS_LIMIT, gasPrice: GAS_PRICE, chainId: f.chainId },
    })
  }

  const f0 = flows[0]
  // Preconditions that name their own fix if Pioneer isn't fully deployed:
  assert('Pioneer returned signerPubkey (needs feat/clearsign-live-signer build)', !!f0.signerPubkey)
  assert(`Pioneer signs a LOADABLE slot keyId=${f0.keyId} (1-3; set CLEARSIGN_KEY_SLOT=1 if 0)`,
    f0.keyId >= 1 && f0.keyId <= 3)
  if (!flows.every((f) => f.keyId === f0.keyId && f.signerPubkey === f0.signerPubkey))
    throw new Error('Pioneer flows disagree on signer — all must share one keyId + pubkey')

  return { signer: { keyId: f0.keyId, pubkey: f0.signerPubkey, alias: 'Pioneer Insight' }, flows }
}

run(`clear-sign runtime signer (mode=${MODE})`, async (getSdk, assert) => {
  const sdk = await getSdk()

  // loadClearsignSigner + ethSignTransaction each block on a human device confirm,
  // but the SDK wrappers use post()'s 30s read timeout (not its 600s signingTimeoutMs),
  // so a slow confirm aborts client-side. Raise the read timeout for this run.
  // (sdk.client is TS-private but a real runtime property.)
  if (sdk.client) sdk.client.timeoutMs = 600_000

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device ETH address: ${address}`)

  const { signer, flows } = MODE === 'pioneer' ? await pioneerProvider(assert) : selfProvider()

  console.log(`\n  Loading signer into slot ${signer.keyId}, alias "${signer.alias}"`)
  console.log(`  pubkey ${signer.pubkey}`)
  console.log('  >>> CONFIRM the "Trust signer" screen on device <<<\n')
  const load = await sdk.eth.loadClearsignSigner(signer)
  assert('Signer loaded (device confirmed)', !!load && load.ok === true)

  for (const f of flows) {
    console.log(`\n  [${f.label}] to=${f.tx.to} keyId=${f.keyId}`)
    console.log('    >>> APPROVE the clear-sign pages on device (should NOT be raw hex) <<<')
    const result = await sdk.eth.ethSignTransaction({
      ...f.tx,
      addressNList: ETH_PATH,
      txMetadata: { signedPayload: f.blobHex, keyId: f.keyId },
    })
    assert(`[${f.label}] got signature`, !!(result && (result.serializedTx || result.r)))
  }
})
