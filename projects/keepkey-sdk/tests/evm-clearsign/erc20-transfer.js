/**
 * evm-clearsign/erc20-transfer.js — ERC-20 transfer(address,uint256)
 *
 * Selector: 0xa9059cbb
 * Calldata decoded locally (Tier 2): Recipient + Amount fields
 * Pioneer: called for enhanced descriptor but local fallback sufficient
 *
 * Device screen: Contract call to USDC contract + amount
 * Vault UI: SigningApproval with decoded "Recipient" + "Amount" fields
 * needsBlindSigning: false (local decoder handles this)
 *
 * Zoo: 18-token-contract.png
 */
const { run, ETH_PATH, CHAINS, toHex, erc20Transfer } = require('../_helpers')

run('ERC-20 transfer() — clearsign decoded', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Sender: ${address}`)

  // USDC contract on Ethereum mainnet
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const recipient = '0x742d35Cc6634C0532950a20547b231011e30c8e7'
  const amount = 1000000n // 1 USDC (6 decimals)

  const data = erc20Transfer(recipient, amount)
  assert('Calldata starts with transfer selector', data.startsWith('0xa9059cbb'))
  assert('Calldata is 138 hex chars (4+32+32 bytes)', data.length === 2 + 8 + 64 + 64)

  const tx = {
    addressNList: ETH_PATH,
    to: USDC,
    value: '0x0', // No ETH value — token transfer
    data,
    nonce: '0x0',
    gasLimit: toHex(65000),
    gasPrice: toHex(20000000000), // 20 Gwei
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  Expected vault UI:')
  console.log('    Method: transfer(address,uint256)')
  console.log(`    Recipient: ${recipient}`)
  console.log(`    Amount: ${amount.toString()} (raw, 6 decimals = 1.00 USDC)`)
  console.log('    needsBlindSigning: false')
  console.log('\n  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assert('Got signed tx', !!result)
  assert('Has signature', !!(result.serializedTx || result.r))
})
