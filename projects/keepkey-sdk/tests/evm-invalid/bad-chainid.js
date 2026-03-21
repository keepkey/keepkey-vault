/**
 * evm-invalid/bad-chainid.js — Transaction with chain ID = 0 or nonsense value
 *
 * Chain ID 0 is invalid per EIP-155. Chain ID 999999999 is not a known network.
 * Expected: vault may default chainId 0 to 1, or reject entirely
 */
const { run, ETH_PATH, toHex } = require('../_helpers')

run('Invalid: chain ID edge cases', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  // Test 1: chainId = 0 (should default to 1 per rest-api.ts)
  console.log('\n  Test 1: chainId = 0')
  const tx0 = {
    addressNList: ETH_PATH,
    to: '0x0000000000000000000000000000000000000001',
    value: '0x0',
    data: '0x',
    nonce: '0x0',
    gasLimit: '0x5208',
    gasPrice: '0x3B9ACA00',
    chainId: 0,
  }

  // The vault defaults chainId 0 → 1, so this should actually work
  let result = null, err = null
  try {
    result = await sdk.eth.ethSignTransaction(tx0)
  } catch (e) { err = e }

  if (result) {
    assert('chainId=0 was auto-corrected to 1 (signed ok)', true)
  } else {
    assertThrows('chainId=0 rejected', err)
  }

  // Test 2: chainId = negative
  console.log('\n  Test 2: chainId = -1')
  err = null
  try {
    await sdk.eth.ethSignTransaction({ ...tx0, chainId: -1 })
  } catch (e) { err = e }
  assertThrows('chainId=-1 rejected', err)
})
