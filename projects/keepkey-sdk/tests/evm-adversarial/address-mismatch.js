/**
 * evm-adversarial/address-mismatch.js — "from" doesn't match derivation path
 *
 * Attack scenario: dApp provides a "from" address that doesn't belong to
 * the user's KeepKey. The vault must resolve addressNList by scanning,
 * and should fail if the address isn't on the device.
 *
 * Expected: vault should reject — cannot find matching path for this address
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

run('Adversarial: from address not on device', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  // Use a random address that definitely isn't derived from this device
  const fakeFrom = '0xdead000000000000000000000000000000000bad'

  const tx = {
    from: fakeFrom, // NOT on this KeepKey
    // addressNList omitted — vault must resolve from `from`
    to: '0x0000000000000000000000000000000000000001',
    value: toHex(100000000000000),
    data: '0x',
    nonce: '0x0',
    gasLimit: '0x5208',
    gasPrice: '0x3B9ACA00',
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('  from address is NOT derived from this device seed')

  let err = null
  try {
    await sdk.eth.ethSignTransaction(tx)
  } catch (e) { err = e }

  assertThrows('Vault rejects unknown from address', err)
})
