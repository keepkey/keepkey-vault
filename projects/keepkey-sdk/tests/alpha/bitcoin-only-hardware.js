/**
 * Alpha Bitcoin-only physical-device acceptance through the production path:
 * keepkey-sdk -> Vault REST -> hdwallet -> KeepKey.
 *
 * This runner never wipes, resets, recovers, loads, changes settings, or
 * broadcasts. Signing uses synthetic, nonexistent prevouts.
 */

const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, resolve } = require('node:path')
const { createInterface } = require('node:readline/promises')
const { stdin, stdout } = require('node:process')
const { KeepKeySdk } = require('../../lib/index')

const HARDENED = 0x80000000
const BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE'
const phase = process.argv[2]
const validPhases = new Set(['preflight', 'addresses', 'signing', 'app', 'all'])

const ADDRESS_CASES = [
  { name: 'BIP44 legacy', purpose: 44, scriptType: 'p2pkh', pattern: /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/ },
  { name: 'BIP49 nested SegWit', purpose: 49, scriptType: 'p2sh-p2wpkh', pattern: /^3[1-9A-HJ-NP-Za-km-z]{25,34}$/ },
  { name: 'BIP84 native SegWit', purpose: 84, scriptType: 'p2wpkh', pattern: /^bc1q[023456789ac-hj-np-z]{38}$/ },
  { name: 'BIP86 Taproot', purpose: 86, scriptType: 'p2tr', pattern: /^bc1p[023456789ac-hj-np-z]{58}$/ },
]

const SIGN_CASES = [
  { name: 'BIP44 legacy', purpose: 44, scriptType: 'p2pkh', legacy: true },
  { name: 'BIP49 nested SegWit', purpose: 49, scriptType: 'p2sh-p2wpkh', prevoutByte: '33' },
  { name: 'BIP84 native SegWit', purpose: 84, scriptType: 'p2wpkh', prevoutByte: '44' },
  { name: 'BIP86 Taproot', purpose: 86, scriptType: 'p2tr', prevoutByte: '55' },
]

const NON_BTC_ADDRESS_ROUTES = [
  '/addresses/cosmos',
  '/addresses/osmosis',
  '/addresses/eth',
  '/addresses/tendermint',
  '/addresses/thorchain',
  '/addresses/mayachain',
  '/addresses/xrp',
  '/addresses/solana',
  '/addresses/tron',
  '/addresses/ton',
  '/addresses/hive',
]

const NON_BTC_SIGNING_ROUTES = [
  '/eth/sign-transaction', '/eth/sign-typed-data', '/eth/sign',
  '/xrp/sign-transaction', '/solana/sign-transaction', '/solana/sign-message',
  '/tron/sign-transaction', '/ton/sign-transaction',
  '/hive/sign-transfer', '/hive/sign-message', '/hive/sign-operations',
  '/tron/sign-message', '/tron/sign-typed-hash', '/ton/sign-message',
  '/solana/sign-offchain-message',
  '/cosmos/sign-amino', '/cosmos/sign-amino-delegate', '/cosmos/sign-amino-undelegate',
  '/cosmos/sign-amino-redelegate', '/cosmos/sign-amino-withdraw-delegator-rewards-all',
  '/cosmos/sign-amino-ibc-transfer',
  '/osmosis/sign-amino', '/osmosis/sign-amino-delegate', '/osmosis/sign-amino-undelegate',
  '/osmosis/sign-amino-redelegate', '/osmosis/sign-amino-withdraw-delegator-rewards-all',
  '/osmosis/sign-amino-ibc-transfer', '/osmosis/sign-amino-lp-remove',
  '/osmosis/sign-amino-lp-add', '/osmosis/sign-amino-swap',
  '/thorchain/sign-amino-transfer', '/thorchain/sign-amino-deposit',
  '/mayachain/sign-amino-transfer', '/mayachain/sign-amino-deposit',
  '/api/v2/swap/open', '/api/v2/swap/set', '/api/v2/swap/quote',
  '/api/v2/swap/execute', '/api/v2/swap/close',
  '/eth/clearsign/load-signer', '/eth/clearsign/sign-alpha-delegate-certificate',
]

const NON_BTC_READ_ROUTES = [
  '/api/zcash/shielded/status',
  '/api/v1/swaps', '/api/v1/swaps/stats', '/api/v1/swap/discovery',
  '/api/debug/portfolio', '/api/debug/portfolio/tokens',
  '/api/debug/pioneer-audit', '/api/debug/token-visibility',
  '/api/v2/assets/available',
  '/wc', '/mcp', '/bex-bridge',
]

const NON_BTC_DATA_REQUESTS = [
  ['/eth/verify', {}],
  ['/ton/build-transfer', {}],
  ['/tron/verify-message', {}],
  ['/api/v2/portfolio/balances', { pubkeys: [{ caip: 'eip155:1/slip44:60', pubkey: '0xdead' }] }],
  ['/api/v2/market/info', { caips: ['eip155:1/slip44:60'] }],
  ['/api/v2/tx/history', { queries: [{ caip: 'eip155:1/slip44:60', pubkey: '0xdead' }] }],
  ['/api/v2/utxo/unspent', { network: 'bip122:12a765e31ffd4059bada1e25190f6e98', xpub: 'xpub-invalid' }],
  ['/api/v2/network/fee-rate', { networkId: 'eip155:1' }],
  ['/api/v2/network/gas-price', { networkId: 'eip155:1' }],
  ['/api/v2/assets/search', { q: 'ethereum' }],
  ['/api/v2/staking/positions', { network: 'ethereum', address: '0xdead' }],
]

if (process.env.BTC_ALPHA_HARDWARE_TEST !== '1') {
  console.log('  SKIP alpha/bitcoin-only-hardware.js (set BTC_ALPHA_HARDWARE_TEST=1 and choose a phase)')
  process.exit(0)
}

if (!validPhases.has(phase)) {
  console.error('Usage: node tests/alpha/bitcoin-only-hardware.js <preflight|addresses|signing|app|all>')
  process.exit(2)
}

if (!stdin.isTTY || !stdout.isTTY) {
  console.error('Bitcoin-only hardware acceptance requires an interactive terminal.')
  process.exit(2)
}

const expectedHash = process.env.BTC_ALPHA_EXPECT_FIRMWARE_HASH
const artifactPath = process.env.BTC_ALPHA_ARTIFACT
const evidencePath = process.env.BTC_ALPHA_EVIDENCE_FILE
if (!expectedHash || !/^[0-9a-f]{64}$/i.test(expectedHash)) {
  console.error('BTC_ALPHA_EXPECT_FIRMWARE_HASH must be the exact 64-character candidate hash.')
  process.exit(2)
}
if (!artifactPath || !existsSync(artifactPath)) {
  console.error('BTC_ALPHA_ARTIFACT must name the exact flashable bitcoin-only firmware file.')
  process.exit(2)
}
if (!evidencePath) {
  console.error('BTC_ALPHA_EVIDENCE_FILE is required so the run cannot finish without preserving evidence.')
  process.exit(2)
}

const rl = createInterface({ input: stdin, output: stdout })
const evidence = {
  candidate: 'alpha-bitcoin-only',
  transport: 'keepkey-sdk -> Vault REST -> hdwallet -> KeepKey',
  phase,
  started_at: new Date().toISOString(),
  checks: [],
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hash256(bytes) {
  const first = createHash('sha256').update(bytes).digest()
  return createHash('sha256').update(first).digest()
}

function decodeBase58Check(address) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = 0n
  for (const character of address) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error(`invalid base58 character in ${address}`)
    value = value * 58n + BigInt(digit)
  }
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const decoded = value === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')
  let leadingZeroes = 0
  while (address[leadingZeroes] === '1') leadingZeroes++
  const bytes = Buffer.concat([Buffer.alloc(leadingZeroes), decoded])
  if (bytes.length < 5) throw new Error('base58check payload is too short')
  const payload = bytes.subarray(0, -4)
  const checksum = bytes.subarray(-4)
  const first = createHash('sha256').update(payload).digest()
  const expected = createHash('sha256').update(first).digest().subarray(0, 4)
  if (!checksum.equals(expected)) throw new Error(`invalid base58check checksum for ${address}`)
  return payload
}

function p2pkhScript(address) {
  const payload = decodeBase58Check(address)
  if (payload.length !== 21 || payload[0] !== 0) throw new Error(`${address} is not a Bitcoin mainnet P2PKH address`)
  return Buffer.concat([Buffer.from('76a914', 'hex'), payload.subarray(1), Buffer.from('88ac', 'hex')]).toString('hex')
}

function parseBitcoinTransaction(serializedHex) {
  const bytes = Buffer.from(serializedHex, 'hex')
  let offset = 0
  const take = (length) => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
      throw new Error(`truncated transaction at byte ${offset} (need ${length})`)
    }
    const result = bytes.subarray(offset, offset + length)
    offset += length
    return result
  }
  const readU32 = () => {
    const value = take(4).readUInt32LE(0)
    return value
  }
  const readVarInt = () => {
    const prefix = take(1)[0]
    if (prefix < 0xfd) return prefix
    if (prefix === 0xfd) return take(2).readUInt16LE(0)
    if (prefix === 0xfe) return take(4).readUInt32LE(0)
    const value = take(8).readBigUInt64LE(0)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('transaction varint exceeds safe integer range')
    return Number(value)
  }

  const version = readU32()
  const segwit = bytes[offset] === 0 && bytes[offset + 1] !== 0
  if (segwit) take(2)
  const inputs = Array.from({ length: readVarInt() }, () => {
    const txid = Buffer.from(take(32)).reverse().toString('hex')
    const vout = readU32()
    const scriptSig = take(readVarInt()).toString('hex')
    const sequence = readU32()
    return { txid, vout, scriptSig, sequence }
  })
  const outputs = Array.from({ length: readVarInt() }, () => ({
    amount: take(8).readBigUInt64LE(0),
    script: take(readVarInt()).toString('hex'),
  }))
  if (segwit) {
    for (let i = 0; i < inputs.length; i++) {
      const items = readVarInt()
      for (let j = 0; j < items; j++) take(readVarInt())
    }
  }
  const locktime = readU32()
  if (offset !== bytes.length) throw new Error(`transaction has ${bytes.length - offset} trailing bytes`)
  return { version, segwit, inputs, outputs, locktime }
}

const BURN_OUTPUT_SCRIPT = p2pkhScript(BURN_ADDRESS)

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

function bipPath(purpose) {
  return [HARDENED + purpose, HARDENED, HARDENED, 0, 0]
}

function persistEvidence() {
  const target = resolve(evidencePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  console.log(`\nEvidence: ${target}`)
}

function verifyArtifact() {
  const artifact = readFileSync(artifactPath)
  const artifactHash = sha256(artifact)
  check('artifact SHA-256 matches the expected candidate', artifactHash === expectedHash.toLowerCase(), artifactHash)
  check('artifact embeds the physical bitcoin-only identity', artifact.includes(Buffer.from('KeepKeyBTC\0', 'latin1')))
  evidence.artifact = { path: resolve(artifactPath), sha256: artifactHash, bytes: artifact.length }
}

async function connect() {
  const sdk = await KeepKeySdk.create({
    apiKey: process.env.KEEPKEY_API_KEY,
    baseUrl: process.env.KEEPKEY_URL || 'http://localhost:1646',
    serviceName: 'KeepKey Alpha Bitcoin-only Acceptance',
    serviceImageUrl: '',
  })
  const [health, features] = await Promise.all([
    sdk.system.info.getHealth(),
    sdk.system.info.getFeatures(),
  ])
  const version = `${features.major_version}.${features.minor_version}.${features.patch_version}`
  const expectedVersion = process.env.BTC_ALPHA_EXPECT_VERSION || '7.16.0'

  check('Vault reports a connected device', health.device_connected === true)
  check('device runs the expected alpha version', version === expectedVersion, version)
  check('physical firmware identifies as KeepKeyBTC', features.firmware_variant === 'KeepKeyBTC', features.firmware_variant)
  check(
    'device reports a 32-byte firmware hash',
    typeof features.firmware_hash === 'string' && /^[0-9a-f]{64}$/i.test(features.firmware_hash),
    String(features.firmware_hash),
  )
  check('device firmware hash matches the exact artifact', features.firmware_hash.toLowerCase() === expectedHash.toLowerCase())
  check('Vault exposes Taproot capability', features.supports_taproot === true)
  check('device is initialized before non-destructive wallet tests', features.initialized === true)
  evidence.firmware = {
    version,
    variant: features.firmware_variant,
    hash: features.firmware_hash,
    supports_taproot: features.supports_taproot,
  }
  return sdk
}

async function verifyRestBoundary(sdk) {
  const failures = []
  async function expect501(route, body, method = 'POST') {
    try {
      if (method === 'GET') await sdk.getClient().get(route)
      else await sdk.getClient().post(route, body)
      failures.push(`${route}: unexpectedly succeeded`)
    } catch (error) {
      if (error && error.status === 501 && /not available on bitcoin-only firmware/i.test(error.message)) {
        pass(`${route} is rejected before device dispatch`, 'HTTP 501')
      } else {
        failures.push(`${route}: ${error && error.status ? `HTTP ${error.status} ` : ''}${error && error.message ? error.message : error}`)
      }
    }
  }

  for (const route of NON_BTC_ADDRESS_ROUTES) {
    await expect501(route, { address_n: bipPath(44), show_display: false })
  }
  for (const route of NON_BTC_SIGNING_ROUTES) await expect501(route, {})
  for (const route of NON_BTC_READ_ROUTES) await expect501(route, undefined, 'GET')
  for (const [route, body] of NON_BTC_DATA_REQUESTS) await expect501(route, body)
  await expect501('/addresses/utxo', { address_n: bipPath(44), coin: 'Litecoin' })
  await expect501('/utxo/sign-transaction', { coin: 'Dogecoin', inputs: [{}], outputs: [{}] })
  await expect501('/system/info/get-public-key', { address_n: bipPath(44), coin_name: 'Zcash' })
  await expect501('/api/v1/activity/rebuild', { chainId: 'ethereum' })

  const batch = await sdk.xpub.getPublicKeys([
    { address_n: [HARDENED + 44, HARDENED + 60, HARDENED], type: 'address', networks: ['eip155:1'] },
    { address_n: [HARDENED + 44, HARDENED + 2, HARDENED], type: 'xpub', coin: 'Litecoin' },
    { address_n: [HARDENED + 84, HARDENED, HARDENED], type: 'xpub', coin: 'Bitcoin', script_type: 'p2wpkh' },
  ])
  check('batch derivation reports all requested paths', batch.total_requested === 3, String(batch.total_requested))
  check('batch derivation returns only the Bitcoin path', batch.pubkeys.length === 1, `returned ${batch.pubkeys.length}`)
  check('batch derivation returns a Bitcoin xpub', typeof batch.pubkeys[0]?.pubkey === 'string' && batch.pubkeys[0].pubkey.length > 0)
  evidence.batch_derivation = {
    requested: ['Ethereum address', 'Litecoin xpub', 'Bitcoin BIP84 xpub'],
    returned: batch.pubkeys.map(entry => ({ path: entry.path, type: entry.type, scriptType: entry.scriptType })),
  }

  const coins = await sdk.system.info.listCoins()
  check('coin listing is not empty', Array.isArray(coins) && coins.length > 0)
  check(
    'coin listing exposes only Bitcoin networks',
    coins.every(coin => coin && (coin.coin_name === 'Bitcoin' || coin.coin_name === 'Testnet')),
    coins.map(coin => coin && coin.coin_name).join(','),
  )
  check('coin listing includes Bitcoin mainnet', coins.some(coin => coin && coin.coin_name === 'Bitcoin'))
  check('every non-Bitcoin device route is fenced', failures.length === 0, failures.join('; '))
  evidence.non_btc_routes = {
    addresses: NON_BTC_ADDRESS_ROUTES,
    signing: NON_BTC_SIGNING_ROUTES,
    generic_coin_routes: ['/addresses/utxo', '/utxo/sign-transaction', '/system/info/get-public-key', '/api/pubkeys/batch'],
    activity_routes: ['/api/v1/activity/rebuild'],
    read_routes: NON_BTC_READ_ROUTES,
    data_routes: NON_BTC_DATA_REQUESTS.map(([route]) => route),
    expected_status: 501,
    listed_coins: coins.map(coin => coin.coin_name),
  }
}

async function verifyAddresses(sdk) {
  evidence.addresses = []
  for (const testCase of ADDRESS_CASES) {
    const request = {
      address_n: bipPath(testCase.purpose),
      coin: 'Bitcoin',
      script_type: testCase.scriptType,
      show_display: false,
    }
    const hidden = await sdk.address.utxoGetAddress(request)
    check(`${testCase.name} hidden derivation has the expected encoding`, testCase.pattern.test(hidden.address), hidden.address)

    console.log(`\nExpected ${testCase.name} address:\n\n  ${hidden.address}\n`)
    console.log('The device will display it now. Compare every character and the QR before approving.')
    const displayed = await sdk.address.utxoGetAddress({ ...request, show_display: true })
    check(`${testCase.name} displayed response matches hidden derivation`, displayed.address === hidden.address)
    await attest(`Did KeepKey display the complete ${testCase.name} address and a matching QR?`)
    evidence.addresses.push({
      name: testCase.name,
      path: `m/${testCase.purpose}'/0'/0'/0/0`,
      script_type: testCase.scriptType,
      address: hidden.address,
      display_confirmed: true,
    })
  }
}

function syntheticTransaction(testCase) {
  return {
    coin: 'Bitcoin',
    version: 2,
    locktime: 0,
    inputs: [{
      txid: testCase.prevoutByte ? testCase.prevoutByte.repeat(32) : '',
      vout: 0,
      addressNList: bipPath(testCase.purpose),
      amount: '80000',
      scriptType: testCase.scriptType,
      sequence: 0xfffffffd,
    }],
    outputs: [{
      address: BURN_ADDRESS,
      amount: '70000',
      addressType: 'spend',
      scriptType: 'p2pkh',
    }],
  }
}

function syntheticLegacyPrevout(address) {
  const amount = Buffer.alloc(8)
  amount.writeBigUInt64LE(80000n)
  const script = Buffer.from(p2pkhScript(address), 'hex')
  const raw = Buffer.concat([
    Buffer.from('0100000001', 'hex'),
    Buffer.alloc(32),
    Buffer.from('ffffffff0100ffffffff01', 'hex'),
    amount,
    Buffer.from([script.length]),
    script,
    Buffer.alloc(4),
  ])
  return {
    hex: raw.toString('hex'),
    txid: Buffer.from(hash256(raw)).reverse().toString('hex'),
  }
}

async function verifySigning(sdk) {
  evidence.signing = []
  for (const testCase of SIGN_CASES) {
    const tx = syntheticTransaction(testCase)
    if (testCase.legacy) {
      const source = await sdk.address.utxoGetAddress({
        address_n: bipPath(testCase.purpose),
        coin: 'Bitcoin',
        script_type: testCase.scriptType,
        show_display: false,
      })
      const prevout = syntheticLegacyPrevout(source.address)
      tx.inputs[0].txid = prevout.txid
      tx.inputs[0].hex = prevout.hex
    }
    console.log(`\n${testCase.name}: offline synthetic prevout; this transaction cannot be broadcast.`)
    console.log('Vault and KeepKey must independently show 0.00070000 BTC to the BitcoinEater address and a 0.00010000 BTC fee.')
    await attest(`Ready to begin the ${testCase.name} signing check?`)
    const signed = await sdk.btc.btcSignTransaction(tx)
    check(`${testCase.name} transaction serialized`, typeof signed.serializedTx === 'string' && /^[0-9a-f]+$/i.test(signed.serializedTx) && signed.serializedTx.length % 2 === 0)
    check(`${testCase.name} returned one signature`, Array.isArray(signed.signatures) && signed.signatures.length === 1 && /^[0-9a-f]+$/i.test(signed.signatures[0]))
    if (testCase.scriptType === 'p2tr') {
      check('Taproot signature is 64-byte Schnorr', signed.signatures[0].length === 128)
    }
    const parsed = parseBitcoinTransaction(signed.serializedTx)
    check(`${testCase.name} serialized version is 2`, parsed.version === 2, String(parsed.version))
    check(`${testCase.name} serialized locktime is 0`, parsed.locktime === 0, String(parsed.locktime))
    check(`${testCase.name} serialized exactly one input`, parsed.inputs.length === 1, String(parsed.inputs.length))
    check(`${testCase.name} serialized the requested prevout`, parsed.inputs[0]?.txid === tx.inputs[0].txid && parsed.inputs[0]?.vout === 0)
    check(`${testCase.name} serialized the requested sequence`, parsed.inputs[0]?.sequence === tx.inputs[0].sequence)
    check(`${testCase.name} serialized exactly one output`, parsed.outputs.length === 1, String(parsed.outputs.length))
    check(`${testCase.name} serialized exactly 70000 sats`, parsed.outputs[0]?.amount === 70000n, String(parsed.outputs[0]?.amount))
    check(`${testCase.name} serialized the BitcoinEater script`, parsed.outputs[0]?.script === BURN_OUTPUT_SCRIPT, parsed.outputs[0]?.script)
    check(`${testCase.name} input/output difference is exactly the displayed 10000-sat fee`, BigInt(tx.inputs[0].amount) - parsed.outputs[0].amount === 10000n)
    await attest(`Did Vault and KeepKey both show the exact ${testCase.name} destination, amount, and fee before approval?`)
    evidence.signing.push({
      name: testCase.name,
      path: `m/${testCase.purpose}'/0'/0'/0/0`,
      script_type: testCase.scriptType,
      synthetic_prevout: tx.inputs[0].txid,
      serialized_sha256: sha256(Buffer.from(signed.serializedTx, 'hex')),
      signature_bytes: signed.signatures[0].length / 2,
      parsed_output_sats: parsed.outputs[0].amount.toString(),
      parsed_output_script: parsed.outputs[0].script,
      parsed_fee_sats: (BigInt(tx.inputs[0].amount) - parsed.outputs[0].amount).toString(),
      display_confirmed: true,
    })
  }

  console.log('\nCancellation: approve the Vault gate, then reject the next Taproot signing request on KeepKey.')
  let rejected = false
  let rejection = ''
  try {
    const taproot = SIGN_CASES.find(testCase => testCase.scriptType === 'p2tr')
    if (!taproot) throw new Error('Taproot signing case is missing from the acceptance runner')
    await sdk.btc.btcSignTransaction(syntheticTransaction(taproot))
  } catch (error) {
    rejected = true
    rejection = String(error && error.message ? error.message : error)
  }
  check('physical cancellation rejects the SDK promise with cancellation semantics', rejected && /cancel|reject|denied/i.test(rejection), rejection)
  evidence.cancellation = { rejected, error: rejection }
}

async function verifyApp() {
  console.log('\nRestart Vault with the Bitcoin-only candidate connected before answering.')
  const observations = [
    'Did startup show the orange “Bitcoin-Only KeepKey” splash?',
    'Does the portfolio show Bitcoin only, with no Add Chain control?',
    'Are ShapeShift and WalletConnect absent from the top navigation?',
    'Is the WalletConnect toggle absent from Settings, with no ClearSign, Zcash, Hive, custom-chain, or swap control exposed?',
    'Does Settings contain the Bitcoin node section with Pioneer, self-hosted node, and offline choices?',
    'If first-run onboarding was eligible, did it offer exactly Pioneer, self-hosted node, and offline mode?',
    'After disconnect and reconnect, did Vault remain Bitcoin-only without altcoin cards or altcoin device prompts?',
    'During idle portfolio refresh, were there no repeated “Unknown message” device errors from altcoin polling?',
    'Did the activity list and address book contain only Bitcoin rows, with no stale altcoin data from an earlier full-firmware session?',
    'With offline mode enabled, did cached balance and device address derivation remain available while history, build, broadcast, sweep, swap, and report actions rejected as OFFLINE?',
    'While offline mode was enabled, did an OS-level connection monitor show no outbound Pioneer, Blockbook, Core, update, or relay connections?',
    'In Bitcoin Core mode, did Receive warn that address history/index discovery is unavailable instead of silently claiming index 0 is unused?',
    'In self-hosted mode, did disabling or breaking the configured node fail visibly without any Pioneer chain-data fallback?',
  ]
  for (const observation of observations) await attest(observation)
  evidence.app = { observations: observations.map(name => ({ name, confirmed: true })) }
}

async function main() {
  verifyArtifact()
  const sdk = await connect()
  await verifyRestBoundary(sdk)
  if (phase === 'addresses' || phase === 'all') await verifyAddresses(sdk)
  if (phase === 'signing' || phase === 'all') await verifySigning(sdk)
  if (phase === 'app' || phase === 'all') await verifyApp()
  evidence.completed_at = new Date().toISOString()
  evidence.passed = true
  persistEvidence()
}

main()
  .catch((error) => {
    evidence.completed_at = new Date().toISOString()
    evidence.passed = false
    evidence.error = String(error && error.stack ? error.stack : error)
    console.error(`\n${evidence.error}`)
    persistEvidence()
    process.exitCode = 1
  })
  .finally(() => rl.close())
