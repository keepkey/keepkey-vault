/**
 * evm-clearsign/erc20-approve-unlimited.js — UNLIMITED ERC-20 approval
 *
 * MAX_UINT256 = 2^256-1 = "infinite" spending approval
 * This is the most dangerous common EVM operation.
 *
 * Vault UI SHOULD flag this with a strong warning:
 *   "UNLIMITED spending approval — spender can drain ALL your USDC"
 *
 * Zoo: 19-eip712-permit.png (similar risk profile)
 */
const { run, ETH_PATH, CHAINS, toHex, erc20Approve } = require('../_helpers')

const MAX_UINT256 = (2n ** 256n) - 1n

run('ERC-20 approve() — UNLIMITED (MAX_UINT256)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Owner: ${address}`)

  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const spender = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'

  const data = erc20Approve(spender, MAX_UINT256)

  const tx = {
    addressNList: ETH_PATH,
    to: USDC,
    value: '0x0',
    data,
    nonce: '0x2',
    gasLimit: toHex(50000),
    gasPrice: toHex(20000000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  Expected vault UI:')
  console.log('    Method: approve(address,uint256)')
  console.log(`    Spender: ${spender}`)
  console.log('    Allowance: MAX_UINT256 (UNLIMITED!)')
  console.log('    WARNING: This gives permanent unlimited spending power')
  console.log('\n  >>> APPROVE on device — note the risk <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)
  assert('Got signed tx', !!result)
})
