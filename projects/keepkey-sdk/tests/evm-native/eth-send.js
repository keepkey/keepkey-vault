/**
 * evm-native/eth-send.js — Simple ETH transfer (no calldata)
 *
 * Device screen: "Send ETH to:" + address + amount + gas
 * Vault UI: SigningApproval with to/value, no decoded calldata
 * Pioneer: NOT needed (data is empty)
 *
 * Zoo: 12-btc-send-address.png (same pattern, ETH variant)
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

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
    nonce: '0x0',
    gasLimit: '0x5208',   // 21000 — standard ETH transfer
    gasPrice: '0x3B9ACA00', // 1 Gwei
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  >>> APPROVE on device: verify address + amount <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assert('Got signed tx', !!result)
  assert('Has serializedTx or v/r/s', !!(result.serializedTx || result.v !== undefined))

  if (result.serializedTx) console.log(`  serializedTx: ${result.serializedTx.slice(0, 40)}...`)
  if (result.v !== undefined) console.log(`  v=${result.v} r=${result.r?.slice(0, 20)}... s=${result.s?.slice(0, 20)}...`)
})
