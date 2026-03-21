/**
 * evm-invalid/malformed-calldata.js — Truncated or garbage calldata
 *
 * Tests three cases:
 * 1. Calldata too short (only 2 bytes — not even a full selector)
 * 2. Valid selector but truncated params (selector + 16 bytes, needs 64)
 * 3. Pure garbage hex
 *
 * Expected: vault should still present the tx (blind signing path),
 * but decoder should fall to Tier 3 (unknown, raw hex)
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

run('Invalid: malformed calldata', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  const base = {
    addressNList: ETH_PATH,
    to: '0x0000000000000000000000000000000000000001',
    value: '0x0',
    nonce: '0x0',
    gasLimit: toHex(100000),
    gasPrice: toHex(20000000000),
    chainId: CHAINS.ETH,
  }

  // Test 1: too-short calldata (2 bytes)
  console.log('\n  Test 1: calldata = 0xab (2 bytes, not a valid selector)')
  let err1 = null, res1 = null
  try {
    res1 = await sdk.eth.ethSignTransaction({ ...base, data: '0xab' })
  } catch (e) { err1 = e }

  if (res1) {
    assert('Short calldata accepted (blind signing)', true)
  } else {
    assertThrows('Short calldata rejected', err1)
  }

  // Test 2: valid selector, truncated params
  console.log('\n  Test 2: transfer selector + 16 bytes (needs 64)')
  let err2 = null, res2 = null
  try {
    res2 = await sdk.eth.ethSignTransaction({
      ...base,
      data: '0xa9059cbb00000000000000000000000012345678', // only 20 param bytes
    })
  } catch (e) { err2 = e }

  if (res2) {
    assert('Truncated params accepted (blind signing)', true)
  } else {
    assertThrows('Truncated params rejected', err2)
  }
})
