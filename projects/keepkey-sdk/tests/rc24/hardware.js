/**
 * RC24 physical-device acceptance tests through the production path:
 * keepkey-sdk -> Vault REST -> hdwallet -> KeepKey.
 *
 * This file is discovered by `test:all`, so it deliberately exits without
 * touching hardware unless RC24_HARDWARE_TEST=1 and an explicit phase are set.
 * It never wipes, resets, loads, recovers, or broadcasts from the device.
 */

const { createHash } = require('node:crypto')
const { createInterface } = require('node:readline/promises')
const { stdin, stdout } = require('node:process')
const { KeepKeySdk } = require('../../lib/index')

const TAPROOT_PATH = [0x80000000 + 86, 0x80000000, 0x80000000, 0, 0]
const SYNTHETIC_PREVOUT = '11'.repeat(32)
const BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE'
const ENTROPY_BLOCK_SIZE = 8192
const ENTROPY_BLOCKS = 8

const phase = process.argv[2]

if (process.env.RC24_HARDWARE_TEST !== '1') {
  console.log('  SKIP rc24/hardware.js (set RC24_HARDWARE_TEST=1 and choose an explicit phase)')
  process.exit(0)
}

const validPhases = new Set(['taproot', 'p2wpkh-control', 'locked-entropy', 'entropy-budget'])
if (!validPhases.has(phase)) {
  console.error('Usage: npm run test:rc24:hardware -- <taproot|p2wpkh-control|locked-entropy|entropy-budget>')
  process.exit(2)
}

if (!stdin.isTTY || !stdout.isTTY) {
  console.error('RC24 hardware acceptance requires an interactive terminal for operator attestations.')
  process.exit(2)
}

const rl = createInterface({ input: stdin, output: stdout })
const evidence = {
  candidate: 'v7.15.0-rc24',
  transport: 'keepkey-sdk -> Vault REST -> hdwallet -> KeepKey',
  phase,
  started_at: new Date().toISOString(),
  checks: [],
}

function pass(name, details) {
  console.log(`  PASS ${name}${details ? ` — ${details}` : ''}`)
  evidence.checks.push({ name, passed: true, ...(details ? { details } : {}) })
}

function check(name, condition, details) {
  if (!condition) throw new Error(`FAIL ${name}${details ? ` — ${details}` : ''}`)
  pass(name, details)
}

async function attest(question) {
  const answer = (await rl.question(`\n${question} [y/N] `)).trim().toLowerCase()
  check(question, answer === 'y' || answer === 'yes', `operator answered ${answer || '(empty)'}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function entropyHealth(bytes, label) {
  check(`${label}: exact length`, bytes instanceof Uint8Array && bytes.length === ENTROPY_BLOCK_SIZE)
  const distinct = new Set(bytes).size
  check(`${label}: byte diversity`, distinct >= 250, `${distinct}/256 byte values observed`)

  let oneBits = 0
  for (const byte of bytes) {
    let value = byte
    while (value) {
      oneBits += value & 1
      value >>>= 1
    }
  }
  const ratio = oneBits / (bytes.length * 8)
  check(`${label}: basic monobit health`, ratio >= 0.47 && ratio <= 0.53, `ones=${ratio.toFixed(5)}`)
  return sha256(bytes)
}

async function connect() {
  const sdk = await KeepKeySdk.create({
    apiKey: process.env.KEEPKEY_API_KEY,
    baseUrl: process.env.KEEPKEY_URL || 'http://localhost:1646',
    serviceName: 'KeepKey RC24 Hardware Acceptance',
    serviceImageUrl: '',
  })
  const [health, features] = await Promise.all([
    sdk.system.info.getHealth(),
    sdk.system.info.getFeatures(),
  ])

  check('Vault reports a connected device', health.device_connected === true)
  check(
    'firmware version is 7.15.0',
    features.major_version === 7 && features.minor_version === 15 && features.patch_version === 0,
    `${features.major_version}.${features.minor_version}.${features.patch_version}`,
  )
  const expectedFirmwareHash = process.env.RC24_EXPECT_FIRMWARE_HASH
  check(
    'RC24_EXPECT_FIRMWARE_HASH identifies the exact candidate',
    typeof expectedFirmwareHash === 'string' && /^[0-9a-f]{64}$/i.test(expectedFirmwareHash),
  )
  check('firmware binary hash matches the RC24 artifact', features.firmware_hash === expectedFirmwareHash)
  evidence.firmware = {
    version: `${features.major_version}.${features.minor_version}.${features.patch_version}`,
    variant: features.firmware_variant,
    hash: features.firmware_hash,
  }
  return { sdk, features }
}

async function taproot() {
  const { sdk, features } = await connect()
  check('Vault exposes Taproot capability', features.supports_taproot === true)

  const hidden = await sdk.address.utxoGetAddress({
    address_n: TAPROOT_PATH,
    coin: 'Bitcoin',
    script_type: 'p2tr',
    show_display: false,
  })
  check('BIP86 address is mainnet P2TR', /^bc1p[023456789ac-hj-np-z]{58}$/.test(hidden.address), hidden.address)
  if (process.env.RC24_EXPECT_ADDRESS) {
    check('address matches RC24_EXPECT_ADDRESS', hidden.address === process.env.RC24_EXPECT_ADDRESS)
  }

  console.log(`\nExpected full device address:\n\n  ${hidden.address}\n`)
  console.log('The next SDK request sets show_display=true. Compare every character/QR before approving.')
  const trusted = await sdk.address.utxoGetAddress({
    address_n: TAPROOT_PATH,
    coin: 'Bitcoin',
    script_type: 'p2tr',
    show_display: true,
  })
  check('trusted-display response matches hidden derivation', trusted.address === hidden.address)
  await attest('Did the KeepKey show the complete, untruncated address (and matching QR), and did you approve it?')
  evidence.taproot_address = hidden.address

  console.log('\nNext is an offline Taproot signing smoke test.')
  console.log('The input references a nonexistent synthetic prevout, so the transaction cannot be broadcast.')
  console.log('Expected screen: send 0.00090000 BTC to the BitcoinEater address; fee 0.00010000 BTC.')
  await attest('Are you ready to begin and approve only if those exact amount/destination/fee values appear?')

  const tx = {
    coin: 'Bitcoin',
    version: 2,
    locktime: 0,
    inputs: [{
      txid: SYNTHETIC_PREVOUT,
      vout: 0,
      addressNList: TAPROOT_PATH,
      amount: '100000',
      scriptType: 'p2tr',
      sequence: 0xfffffffd,
    }],
    outputs: [{
      address: BURN_ADDRESS,
      amount: '90000',
      addressType: 'spend',
      scriptType: 'p2pkh',
    }],
  }
  const signed = await sdk.btc.btcSignTransaction(tx)
  check('Taproot transaction serialized', typeof signed.serializedTx === 'string' && /^[0-9a-f]+$/i.test(signed.serializedTx))
  check(
    'Taproot Schnorr signature returned',
    Array.isArray(signed.signatures) && signed.signatures.length === 1 && /^[0-9a-f]{128}$/i.test(signed.signatures[0]),
  )
  evidence.taproot_signing = {
    synthetic_prevout: SYNTHETIC_PREVOUT,
    serialized_sha256: sha256(Buffer.from(signed.serializedTx, 'hex')),
    signature_length: signed.signatures[0].length / 2,
  }
  await attest('Did the KeepKey show those exact amount/destination/fee values before you approved?')

  console.log('\nCancellation check: the same synthetic request will start again. Reject it on KeepKey.')
  let rejected = false
  try {
    await sdk.btc.btcSignTransaction(tx)
  } catch (error) {
    rejected = true
    evidence.taproot_cancel_error = String(error && error.message ? error.message : error)
  }
  check('operator cancellation rejects the SDK signing promise', rejected)
}

async function p2wpkhControl() {
  const { sdk } = await connect()
  const path = [0x80000000 + 84, 0x80000000, 0x80000000, 0, 0]
  const tx = {
    coin: 'Bitcoin',
    version: 2,
    locktime: 0,
    inputs: [{
      txid: '22'.repeat(32),
      vout: 0,
      addressNList: path,
      amount: '80000',
      scriptType: 'p2wpkh',
      sequence: 0xfffffffd,
    }],
    outputs: [{
      address: BURN_ADDRESS,
      amount: '70000',
      addressType: 'spend',
      scriptType: 'p2pkh',
    }],
  }

  console.log('\nP2WPKH control: offline synthetic prevout, never broadcast.')
  console.log('First approve the Vault desktop signing gate, then KeepKey must independently show:')
  console.log('send 0.00070000 BTC to the BitcoinEater address; fee 0.00010000 BTC.')
  await attest('Are you ready to approve Vault and then approve the physical device only if those exact fields appear?')
  const signed = await sdk.btc.btcSignTransaction(tx)
  check('P2WPKH control transaction serialized', typeof signed.serializedTx === 'string' && /^[0-9a-f]+$/i.test(signed.serializedTx))
  check(
    'P2WPKH control ECDSA signature returned',
    Array.isArray(signed.signatures) && signed.signatures.length === 1 && /^[0-9a-f]+$/i.test(signed.signatures[0]),
    `signature bytes=${Array.isArray(signed.signatures) ? signed.signatures[0]?.length / 2 : 0}`,
  )
  evidence.p2wpkh_control = {
    synthetic_prevout: tx.inputs[0].txid,
    serialized_sha256: sha256(Buffer.from(signed.serializedTx, 'hex')),
    signature_length: signed.signatures[0].length / 2,
  }
  await attest('Did the physical KeepKey show and require approval of those exact amount/destination/fee values?')
}

async function lockedEntropy() {
  const { sdk, features } = await connect()
  check('device is initialized for locked-device policy test', features.initialized === true)
  check('PIN protection is enabled for locked-device policy test', features.pin_protection === true)
  await attest('Is this a test-safe initialized device, ready for its SDK session to be locked?')

  await sdk.system.device.clearSession()
  const locked = await sdk.system.info.getFeatures()
  check('SDK clearSession locked the device', locked.pin_cached === false)

  console.log('\nThe next SDK getEntropy(8192) must show a Generate Entropy confirmation on the locked device.')
  console.log('Complete any PIN flow and approve only the Generate Entropy request.')
  const sample = await sdk.system.info.getEntropy(ENTROPY_BLOCK_SIZE)
  const digest = entropyHealth(sample, 'locked entropy sample')
  await attest('Did the locked device explicitly require Generate Entropy confirmation before returning bytes?')
  evidence.locked_entropy = { size: sample.length, sha256: digest, confirmation_observed: true }
}

async function entropyBudget() {
  const { sdk, features } = await connect()
  check('device is uninitialized for fresh-budget policy test', features.initialized === false)
  check('uninitialized device has no PIN protection', features.pin_protection === false)
  await attest('Was this disposable device power-cycled immediately before this phase, with no GetEntropy request since boot?')

  console.log('\nRequests 1-8 must return without any device confirmation. Do not press a device button.')
  const digests = []
  for (let i = 0; i < ENTROPY_BLOCKS; i++) {
    const sample = await sdk.system.info.getEntropy(ENTROPY_BLOCK_SIZE)
    digests.push(entropyHealth(sample, `budget block ${i + 1}`))
  }
  check('8 x 8192 bytes consumed exactly 64 KiB', ENTROPY_BLOCKS * ENTROPY_BLOCK_SIZE === 65536)
  check('all eight entropy blocks are unique', new Set(digests).size === ENTROPY_BLOCKS)
  await attest('Did all eight 8192-byte requests complete with no confirmation screen and no device button press?')

  console.log('\nThe ninth 8192-byte request exceeds the free 64 KiB budget and must restore Generate Entropy confirmation.')
  const next = await sdk.system.info.getEntropy(ENTROPY_BLOCK_SIZE)
  const nextDigest = entropyHealth(next, 'post-budget block')
  await attest('Did the ninth request require Generate Entropy confirmation before returning bytes?')
  check('post-budget block differs from all free-budget blocks', !digests.includes(nextDigest))
  const health = await sdk.system.info.getHealth()
  check('Vault/device remained healthy after entropy run', health.device_connected === true)
  evidence.entropy_budget = {
    block_size: ENTROPY_BLOCK_SIZE,
    free_blocks: ENTROPY_BLOCKS,
    free_bytes: ENTROPY_BLOCKS * ENTROPY_BLOCK_SIZE,
    block_sha256: digests,
    post_budget_sha256: nextDigest,
    first_eight_confirmation_observed: false,
    post_budget_confirmation_observed: true,
  }
}

async function main() {
  if (phase === 'taproot') await taproot()
  if (phase === 'p2wpkh-control') await p2wpkhControl()
  if (phase === 'locked-entropy') await lockedEntropy()
  if (phase === 'entropy-budget') await entropyBudget()
  evidence.completed_at = new Date().toISOString()
  evidence.passed = true
  console.log('\nRC24_EVIDENCE_BEGIN')
  console.log(JSON.stringify(evidence, null, 2))
  console.log('RC24_EVIDENCE_END\n')
}

main()
  .catch((error) => {
    evidence.completed_at = new Date().toISOString()
    evidence.passed = false
    evidence.error = String(error && error.stack ? error.stack : error)
    console.error(`\n${evidence.error}`)
    console.error('\nRC24_EVIDENCE_BEGIN')
    console.error(JSON.stringify(evidence, null, 2))
    console.error('RC24_EVIDENCE_END\n')
    process.exitCode = 1
  })
  .finally(() => rl.close())
