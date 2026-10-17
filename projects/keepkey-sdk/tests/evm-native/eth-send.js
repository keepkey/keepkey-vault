/**
 * evm-native/eth-send.js — Simple ETH transfer (no calldata)
 *
 * Device screen: "Send ETH to:" + address + amount + gas
 * Vault UI: SigningApproval with to/value, no decoded calldata
 * Pioneer: NOT needed (data is empty)
 *
 * Zoo: 12-btc-send-address.png (same pattern, ETH variant)
 */
const { run, ETH_PATH, CHAINS, toHex, SENTINEL_NONCE, assertSignedByDevice } = require('../_helpers')

run('ETH Native Send (no calldata)', async (getSdk, assert) => {
  const sdk = await getSdk()

  // Derive address first
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  assert('Got ETH address', address && address.startsWith('0x'))
  console.log(`  Address: ${address}`)

  // Simple send: 0.0001 ETH to a burn address
  const tx = {
    addressNList: ETH_PATH,
    to: '0x0000000000000000000000000000000000000001',
    value: toHex(100000000000000), // 0.0001 ETH
    data: '0x',
    nonce: SENTINEL_NONCE, // can never be mined
    gasLimit: '0x5208',   // 21000 — standard ETH transfer
    gasPrice: '0x3B9ACA00', // 1 Gwei
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  >>> APPROVE on device: verify address + amount <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assertSignedByDevice(assert, result, address, CHAINS.ETH)
})
