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

/** Well-known ERC-20 selectors */
const SEL = {
  transfer: '0xa9059cbb',
  approve: '0x095ea7b3',
  transferFrom: '0x23b872dd',
}

// ── SDK init ─────────────────────────────────────────────────────────

let _sdk = null

async function getSdk() {
  if (_sdk) return _sdk
  _sdk = await KeepKeySdk.create({
    apiKey: process.env.KEEPKEY_API_KEY,
    baseUrl: process.env.KEEPKEY_URL || 'http://localhost:1646',
    serviceName: 'KeepKey SDK Tests',
    serviceImageUrl: '',
  })
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

// ── Runner ───────────────────────────────────────────────────────────

function run(name, fn) {
  console.log(`\n=== ${name} ===\n`)
  fn(getSdk, assert, assertThrows).then(() => {
    const fails = summary()
    process.exit(fails > 0 ? 1 : 0)
  }).catch(e => {
    console.error('\nTest crashed:', e)
    process.exit(1)
  })
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
  getSdk, assert, assertThrows, summary, run,
  ETH_PATH, CHAINS, SEL,
  toHex, padAddress, padUint256, erc20Transfer, erc20Approve,
}
