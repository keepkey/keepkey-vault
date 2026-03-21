/**
 * evm-invalid/missing-to.js — Transaction with missing 'to' field
 *
 * A tx with no 'to' is a contract creation. With calldata, this deploys
 * a contract. With empty data, this is nonsensical.
 *
 * Expected: vault should reject or device should show contract creation warning
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

run('Invalid: missing "to" field (contract creation)', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  const tx = {
    addressNList: ETH_PATH,
    // to: MISSING
    value: '0x0',
    data: '0x',
    nonce: '0x0',
    gasLimit: '0x5208',
    gasPrice: '0x3B9ACA00',
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload (no "to"):', JSON.stringify(tx, null, 4))

  let err = null
  try {
    await sdk.eth.ethSignTransaction(tx)
  } catch (e) {
    err = e
  }

  assertThrows('Vault rejects tx with missing "to"', err)
})
