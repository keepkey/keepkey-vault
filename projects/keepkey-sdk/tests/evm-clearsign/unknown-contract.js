/**
 * evm-clearsign/unknown-contract.js — Contract call with unknown selector
 *
 * Uses a bogus function selector 0xdeadbeef that no decoder will recognize.
 * Pioneer: called but returns nothing (unknown contract)
 * Local decoder: no match (not ERC-20)
 *
 * Vault UI SHOULD show:
 *   needsBlindSigning: true
 *   Warning: "Unknown contract method — review raw data"
 *   Raw calldata displayed as hex
 *
 * This tests the Tier 3 fallback path in calldata-decoder.ts
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

run('Unknown contract call — blind signing required', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Sender: ${address}`)

  // Random contract with unknown selector
  const tx = {
    addressNList: ETH_PATH,
    to: '0x1234567890abcdef1234567890abcdef12345678',
    value: toHex(50000000000000000), // 0.05 ETH sent WITH the call
    data: '0xdeadbeef' +
      '0000000000000000000000000000000000000000000000000000000000000042' +
      '00000000000000000000000000000000000000000000000000000000000000ff',
    nonce: '0x5',
    gasLimit: toHex(100000),
    gasPrice: toHex(20000000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  Expected vault UI:')
  console.log('    Contract: 0x1234...5678')
  console.log('    Method: 0xdeadbeef (UNKNOWN)')
  console.log('    Value: 0.05 ETH (sent with call)')
  console.log('    needsBlindSigning: TRUE')
  console.log('    Raw calldata shown as hex dump')
  console.log('\n  >>> APPROVE on device — blind signing scenario <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)
  assert('Got signed tx (blind signing allowed)', !!result)
})
