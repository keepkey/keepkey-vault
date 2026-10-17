/**
 * evm-native/polygon-send.js — Simple MATIC transfer on Polygon (chainId 137)
 *
 * Device screen: "Send to:" + address + "Chain ID: 137" + amount
 * Vault UI: SigningApproval — same address m/44'/60'/0'/0/0, chain ID highlighted
 * Pioneer: NOT needed (data is empty)
 *
 * Zoo: evm-chains/polygon-chain137 (chain ID verification)
 */
const { run, ETH_PATH, CHAINS, toHex, SENTINEL_NONCE, assertSignedByDevice } = require('../_helpers')

run('Polygon Native Send (chain ID 137)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Address: ${address}`)

  const tx = {
    addressNList: ETH_PATH,
    to: '0x0000000000000000000000000000000000000001',
    value: toHex(1000000000000000), // 0.001 MATIC
    data: '0x',
    nonce: SENTINEL_NONCE, // can never be mined
    gasLimit: '0x5208',
    gasPrice: '0x6FC23AC00', // 30 Gwei
    chainId: CHAINS.POLYGON,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  >>> APPROVE on device: verify Chain ID = 137 (Polygon) <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assertSignedByDevice(assert, result, address, CHAINS.POLYGON)
})
