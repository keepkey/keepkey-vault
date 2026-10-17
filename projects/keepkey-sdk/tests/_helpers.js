/**
 * Shared test helpers for keepkey-vault-sdk device tests.
 *
 * Usage:
 *   const { sdk, assert, run, ETH_PATH } = require('./_helpers')
 */

const { KeepKeySdk } = require('../lib/index')

// ── Constants ────────────────────────────────────────────────────────

/** m/44'/60'/0'/0/0 as BIP-44 hardened array */
const ETH_PATH = [0x80000000 + 44, 0x80000000 + 60, 0x80000000, 0, 0]

/** m/44'/501'/0'/0' — Phantom/Solflare default account. */
const SOLANA_PATH = [0x80000000 + 44, 0x80000000 + 501, 0x80000000, 0x80000000]

/** Standard EVM chain IDs */
const CHAINS = {
  ETH: 1,
  POLYGON: 137,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  AVALANCHE: 43114,
  BSC: 56,
  BASE: 8453,
}

/** Nonce for every signing suite that may run on a real-funds device. No
 * account reaches 2^32-1 transactions, so a signature over it can never be
 * mined even if its bytes leak through a log or a shared report. Fixed on
 * purpose: no override, so a stray env var can never make a signature minable. */
const SENTINEL_NONCE = '0xffffffff'

/** Well-known ERC-20 selectors */
const SEL = {
  transfer: '0xa9059cbb',
  approve: '0x095ea7b3',
  transferFrom: '0x23b872dd',
}

// ── SDK init ─────────────────────────────────────────────────────────

let _sdk = null

// Each suite is its own process, so the API key from the first pairing is kept
// here (outside the repo) and reused; the SDK pairs again if Desktop rejects it.
const KEY_FILE = require('path').join(require('os').homedir(), '.keepkey', 'sdk-test-api-key')

function readKeyFile() {
  try { return require('fs').readFileSync(KEY_FILE, 'utf8').trim() || undefined } catch { return undefined }
}

/** The key the suites use: KEEPKEY_API_KEY, else the one saved by the last pairing. */
function savedApiKey() {
  return process.env.KEEPKEY_API_KEY || readKeyFile()
}

/** Does Desktop accept this key? The same check the SDK makes (GET /auth/pair). */
async function keyAccepted(baseUrl, key) {
  try {
    const resp = await fetch(`${baseUrl}/auth/pair`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) })
    return resp.ok && (await resp.json()).paired === true
  } catch { return false }
}

/** Save the key this process ends with. The SDK can pair again mid-suite (a
 *  401 re-pair), so this also runs at exit: the next suite then reuses it. */
function saveApiKey() {
  const key = _sdk && _sdk.apiKey
  if (!key || key === readKeyFile()) return
  try {
    const fs = require('fs')
    fs.mkdirSync(require('path').dirname(KEY_FILE), { recursive: true })
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 })
    fs.chmodSync(KEY_FILE, 0o600) // mode applies only when the file is created
  } catch (e) {
    console.warn(`  WARNING: could not save the API key to ${KEY_FILE}: ${e.message}`)
  }
}

async function getSdk() {
  if (_sdk) return _sdk
  const baseUrl = process.env.KEEPKEY_URL || 'http://localhost:1646'
  const envKey = process.env.KEEPKEY_API_KEY
  const fileKey = readKeyFile()
  let apiKey = envKey || fileKey
  // A stale KEEPKEY_API_KEY must not make every suite pair: fall back to the saved key.
  if (envKey && fileKey && envKey !== fileKey && !(await keyAccepted(baseUrl, envKey))) {
    console.warn('  WARNING: Desktop rejected KEEPKEY_API_KEY; using the saved key instead. Unset KEEPKEY_API_KEY.')
    apiKey = fileKey
  }
  _sdk = await KeepKeySdk.create({
    apiKey,
    baseUrl,
    serviceName: 'KeepKey SDK Tests',
    serviceImageUrl: '',
  })
  if (apiKey && _sdk.apiKey !== apiKey) console.warn('  NOTE: Desktop did not accept the saved key, so this suite paired again (saved for the next suites).')
  saveApiKey()
  process.on('exit', saveApiKey)
  return _sdk
}

// ── Assertion helpers ────────────────────────────────────────────────

let _passed = 0, _failed = 0

function assert(label, condition) {
  if (condition) {
    console.log(`  \u2705 ${label}`)
    _passed++
  } else {
    console.error(`  \u274C ${label}`)
    _failed++
  }
}

function assertThrows(label, err, matchStr) {
  if (err) {
    const msg = String(err.message || err)
    if (!matchStr || msg.toLowerCase().includes(matchStr.toLowerCase())) {
      console.log(`  \u2705 ${label} (threw: ${msg.slice(0, 80)})`)
      _passed++
    } else {
      console.error(`  \u274C ${label} (threw "${msg}" but expected "${matchStr}")`)
      _failed++
    }
  } else {
    console.error(`  \u274C ${label} (did not throw)`)
    _failed++
  }
}

function summary() {
  console.log(`\n  Result: ${_passed} passed, ${_failed} failed\n`)
  return _failed
}

/** Exit code run-all.js counts as SKIPPED: neither passed nor failed. */
const SKIP_EXIT = 3

/** Stop the suite and report it SKIPPED. A skip never hides a failure: if an
 * assertion already failed, the suite exits as failed instead. */
function skip(reason) {
  if (_failed > 0) {
    console.error(`\n  SKIP requested (${reason}) after ${_failed} failed assertion(s): reporting FAILED`)
    process.exit(1)
  }
  console.log(`\n  SKIPPED: ${reason}\n`)
  process.exit(SKIP_EXIT)
}

/** Suites that WIPE the device call this before anything else. A refusal
 * exits non-zero so it can never be read as a pass. */
function requireWipeAllowed() {
  if (process.env.KEEPKEY_ALLOW_WIPE === '1') return
  console.error('  REFUSED: this suite WIPES the connected device. Set KEEPKEY_ALLOW_WIPE=1 on a test device.')
  process.exit(2)
}

// ── Runner ───────────────────────────────────────────────────────────

const _atEnd = []
const _notCovered = []

/** Run `fn` when the suite ends: passed, crashed, or killed by SIGTERM/SIGINT
 *  (not on skip()). */
function atEnd(fn) { _atEnd.push(fn) }

/** Record a part of the suite that did not run. A suite with any such part and
 *  no failure ends SKIPPED (partial), never passed. */
function notCovered(reason) {
  console.log(`  NOT COVERED: ${reason}`)
  _notCovered.push(reason)
}

async function runAtEnd() {
  for (const fn of _atEnd.splice(0).reverse()) {
    try { await fn() } catch (e) {
      console.error(`  cleanup failed: ${e.message || e}`)
      _failed++
    }
  }
}

function run(name, fn) {
  console.log(`\n=== ${name} ===\n`)
  // run-all.js kills a suite past its timeout with SIGTERM (and waits for it to
  // exit); Ctrl-C sends SIGINT. Either way the cleanup still runs, e.g. turning
  // AdvancedMode back off. A second signal kills outright.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.once(sig, async () => {
      console.error(`\n  ${sig}: suite killed, running cleanup`)
      _failed++
      await runAtEnd()
      summary()
      process.exit(1)
    })
  }
  fn(getSdk, assert, assertThrows).then(async () => {
    await runAtEnd()
    const fails = summary()
    if (fails === 0 && _notCovered.length > 0) {
      console.log(`  PARTIAL, reported as SKIPPED. Not covered: ${_notCovered.join('; ')}\n`)
      process.exit(SKIP_EXIT)
    }
    process.exit(fails > 0 ? 1 : 0)
  }).catch(async e => {
    console.error('\nTest crashed:', e)
    await runAtEnd()
    process.exit(1)
  })
}

/**
 * Runtime-signer suites (LoadClearsignSigner, KKSOLSC1/KKSOLSW1 blobs) need a
 * session AdvancedMode on 7.16: SKIP when it is off. When it is on, the suite
 * ends with clearSession, which clears AdvancedMode and drops the public CI
 * test signer it loaded (no press, no flash write). On 7.16 the runtime tier
 * still shows the raw review: these suites never prove clear-sign pages.
 */
async function requireAdvancedModeSession(sdk) {
  const features = await sdk.system.info.getFeatures()
  const p = (features.policies || []).find((x) => x.policy_name === 'AdvancedMode')
  if (!p || p.enabled !== true) skip('runtime tier needs a session AdvancedMode (opt-in)')
  atEnd(async () => {
    await sdk.system.device.clearSession()
    console.log('  clearSession: AdvancedMode and runtime signers cleared')
  })
}

// ── Signature checks ─────────────────────────────────────────────────

/** Parse a signed EVM envelope: { from, nonce, chainId } as ethers recovers them.
 *  Pass criteria compare `from` with the device address, never `!!result`. */
function recoverEvm(serialized) {
  const tx = require('ethers').Transaction.from(serialized)
  return { from: (tx.from || '').toLowerCase(), nonce: BigInt(tx.nonce), chainId: Number(tx.chainId) }
}

/** The pass check for an EVM sign: the envelope recovers to the device, on
 *  this chain, with the sentinel nonce. Returns the parsed tx or null. */
function assertSignedByDevice(assert, result, address, chainId) {
  const serialized = result && (result.serialized || result.serializedTx)
  assert('returns a serialized envelope', !!serialized)
  if (!serialized) return null
  const tx = recoverEvm(serialized)
  console.log(`  signed: ${short(serialized)} recovered ${tx.from}`)
  assert('signature recovers to the device', tx.from === address.toLowerCase())
  assert(`chainId ${chainId}`, tx.chainId === chainId)
  assert(`nonce is the sentinel ${SENTINEL_NONCE}`, tx.nonce === BigInt(SENTINEL_NONCE))
  return tx
}

/** Print only a prefix of a signature or serialized tx. */
function short(hex) {
  const s = String(hex || '')
  return s.length > 18 ? `${s.slice(0, 18)}…(${s.length} chars)` : s
}

// ── Hex helpers ──────────────────────────────────────────────────────

function toHex(n) { return '0x' + BigInt(n).toString(16) }
function padAddress(addr) { return '0x' + addr.replace(/^0x/, '').padStart(64, '0') }
function padUint256(n) { return '0x' + BigInt(n).toString(16).padStart(64, '0') }

/** Build ERC-20 transfer(address,uint256) calldata */
function erc20Transfer(to, amount) {
  return SEL.transfer +
    to.replace(/^0x/, '').padStart(64, '0') +
    BigInt(amount).toString(16).padStart(64, '0')
}

/** Build ERC-20 approve(address,uint256) calldata */
function erc20Approve(spender, amount) {
  return SEL.approve +
    spender.replace(/^0x/, '').padStart(64, '0') +
    BigInt(amount).toString(16).padStart(64, '0')
}

module.exports = {
  getSdk, savedApiKey, assert, assertThrows, summary, run, atEnd, notCovered, requireWipeAllowed, requireAdvancedModeSession, skip, SKIP_EXIT,
  ETH_PATH, SOLANA_PATH, CHAINS, SEL, SENTINEL_NONCE, recoverEvm, assertSignedByDevice, short,
  toHex, padAddress, padUint256, erc20Transfer, erc20Approve,
}
