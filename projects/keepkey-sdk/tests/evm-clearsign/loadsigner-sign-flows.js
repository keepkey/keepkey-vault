/**
 * evm-clearsign/loadsigner-sign-flows.js — the vault-side clear-sign train, on device.
 *
 * 1. Loads the CI test signer (pubkey == firmware slot 3) at runtime via the new
 *    POST /eth/clearsign/load-signer route  →  DEVICE CONFIRM (trust screen).
 * 2. For each selected flow: builds the metadata blob bound to the tx's real
 *    sighash (tests/_clearsign.js, byte-parity-proven offline) and signs via
 *    /eth/sign-transaction with txMetadata  →  DEVICE CONFIRM (clear-sign pages).
 *
 * Requires firmware 7.15.0-rc3+ (LoadClearsignSigner msg 117) and a Vault built
 * with the new hdwallet loadClearsignSigner + route. Sign-only, no broadcast,
 * no wipe. The signer is RAM-only — reload if the device reboots.
 *
 * The frozen 51-flow Python-parity corpus plus separately sourced 2026 SDK
 * additions are addressable without turning one run into a
 * multi-hour approval ceremony. Select a comma-separated list, or page through
 * it with CLEARSIGN_START + CLEARSIGN_LIMIT. The default is the first five.
 *
 * List only: CLEARSIGN_LIST=1 node tests/evm-clearsign/loadsigner-sign-flows.js
 * Run batch: KEEPKEY_API_KEY=… CLEARSIGN_START=0 CLEARSIGN_LIMIT=5 \
 *   node tests/evm-clearsign/loadsigner-sign-flows.js
 * Named: KEEPKEY_API_KEY=… CLEARSIGN_FLOW=aave-v3-supply,erc20-transfer \
 *   node tests/evm-clearsign/loadsigner-sign-flows.js
 */
const { run, ETH_PATH } = require('../_helpers')
const { ALL_FLOWS, buildFlowBlob, CI_TEST_PUBKEY, CI_SIGNER_ALIAS, TEST_KEY_ID } = require('../_clearsign')

const FLOW_KEYS = Object.keys(ALL_FLOWS).sort()

function integerEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function selectedFlows() {
  const named = (process.env.CLEARSIGN_FLOW || '').split(',').map(value => value.trim()).filter(Boolean)
  if (named.length) {
    const unknown = named.filter(key => !ALL_FLOWS[key])
    if (unknown.length) throw new Error(`Unknown CLEARSIGN_FLOW: ${unknown.join(', ')}`)
    return named
  }
  const start = integerEnv('CLEARSIGN_START', 0)
  const limit = integerEnv('CLEARSIGN_LIMIT', 5)
  return FLOW_KEYS.slice(start, start + limit)
}

if (process.env.CLEARSIGN_LIST === '1') {
  console.log(`Runtime-signer ClearSign corpus (${FLOW_KEYS.length} flows):`)
  FLOW_KEYS.forEach((key, index) => console.log(`${String(index).padStart(2, ' ')}  ${key}`))
  process.exit(0)
}

const FLOWS = selectedFlows()
if (!FLOWS.length) throw new Error('Selected ClearSign batch is empty')

run(`clear-sign: load CI signer + sign ${FLOWS.length}/${FLOW_KEYS.length} flows`, async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device ETH address: ${address}`)
  console.log(`  Batch: ${FLOWS.join(', ')}`)
  console.log('  Lane: legacy transaction-bound metadata; raw review remains mandatory.')

  console.log(`\n  Loading CI signer into slot ${TEST_KEY_ID}, alias "${CI_SIGNER_ALIAS}"`)
  console.log(`  pubkey ${CI_TEST_PUBKEY}`)
  console.log('  >>> CONFIRM the "Trust signer" screen on device <<<\n')
  const load = await sdk.eth.loadClearsignSigner({ keyId: TEST_KEY_ID, pubkey: CI_TEST_PUBKEY, alias: CI_SIGNER_ALIAS })
  assert('Signer loaded (device confirmed)', !!load && load.ok === true)

  for (const key of FLOWS) {
    const { tx, blobHex, keyId, flow } = buildFlowBlob(key)
    console.log(`\n  [${key}] ${flow.method}  to=${tx.to}`)
    console.log(`    args: ${flow.args.map(a => a.name).join(', ')}`)
    if (flow.sources?.length) console.log(`    source: ${flow.sources[0]}`)
    console.log('    >>> APPROVE the clear-sign pages on device <<<')
    const result = await sdk.eth.ethSignTransaction({
      ...tx,
      addressNList: ETH_PATH,
      txMetadata: { signedPayload: blobHex, keyId },
    })
    assert(`[${key}] got signature`, !!(result && (result.serializedTx || result.r)))
  }
})
