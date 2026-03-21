/**
 * evm-clearsign/erc20-approve.js — ERC-20 approve(address,uint256)
 *
 * Selector: 0x095ea7b3
 * Calldata decoded locally (Tier 2): Spender + Amount fields
 * Pioneer: called for enhanced descriptor
 *
 * Device screen: Contract call to USDC contract
 * Vault UI: SigningApproval with decoded "Spender" + "Allowance" fields
 * needsBlindSigning: false
 *
 * SECURITY NOTE: Approvals are high-risk. Unlimited approvals (MAX_UINT256)
 * give the spender permanent access to drain all tokens of that type.
 */
const { run, ETH_PATH, CHAINS, toHex, erc20Approve } = require('../_helpers')

run('ERC-20 approve() — clearsign decoded', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Owner: ${address}`)

  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const spender = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' // Uniswap Router
  const amount = 1000000000n // 1000 USDC — reasonable bounded approval

  const data = erc20Approve(spender, amount)
  assert('Calldata starts with approve selector', data.startsWith('0x095ea7b3'))

  const tx = {
    addressNList: ETH_PATH,
    to: USDC,
    value: '0x0',
    data,
    nonce: '0x1',
    gasLimit: toHex(50000),
    gasPrice: toHex(20000000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  Expected vault UI:')
  console.log('    Method: approve(address,uint256)')
  console.log(`    Spender: ${spender} (Uniswap Router)`)
  console.log(`    Allowance: ${amount.toString()} (bounded, not unlimited)`)
  console.log('\n  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)
  assert('Got signed tx', !!result)
})
