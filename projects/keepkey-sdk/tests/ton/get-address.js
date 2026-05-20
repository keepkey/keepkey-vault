/**
 * ton/get-address.js — Derive a TON wallet v4r2 address.
 *
 * Path: m/44'/607'/0' (TON BIP-44 is 3 levels, not 5 — SLIP-44 607)
 * Expected output: base64url-encoded 48-char address (starts with EQ/UQ).
 *
 * Purpose for this PR: smoke-test that /addresses/ton still returns
 * a valid address on feat/ton-build-transfer so the build/finalize
 * pair downstream has a real from-address to work with.
 */
const { run } = require('../_helpers')

// m/44'/607'/0' — SLIP-44 607 is TON. Only 3 levels.
const TON_PATH = [0x80000000 + 44, 0x80000000 + 607, 0x80000000]

run('TON getAddress (m/44\'/607\'/0\')', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.tonGetAddress({ address_n: TON_PATH })

  assert('Got an address', !!address)
  assert('Address is a string', typeof address === 'string')
  // Base64url user-friendly address is 48 chars with no padding.
  assert('Address length is 48', address.length === 48)
  // Mainnet v4r2 addresses start with EQ (bounceable) or UQ (non-bounceable)
  // once the tag byte is base64-encoded.
  assert('Address starts with EQ or UQ', /^(EQ|UQ)/.test(address))
  // Base64url alphabet only — no '+', '/', '=' leakage.
  assert('Address is base64url-clean', /^[A-Za-z0-9_-]+$/.test(address))

  console.log(`  TON address: ${address}`)
})
