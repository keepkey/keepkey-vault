/**
 * evm-clearsign/uniswap-v2-token-to-eth.js
 *
 * Uniswap V2 Router: swapExactTokensForETH(uint256,uint256,address[],address,uint256)
 * Selector: 0x18cbafe5
 *
 * Swap 100 USDC → ETH via USDC→WETH path
 * NOTE: This requires a prior approve() of the Router on the USDC contract.
 *       value=0 because we're sending tokens, not ETH.
 *
 * Vault signing window should show:
 *   Contract: Uniswap V2 Router02
 *   Method: swapExactTokensForETH
 *   Value: 0 ETH (token-to-ETH swap, no ETH sent with call)
 *   Decoded params:
 *     amountIn: 100000000 (100 USDC)
 *     amountOutMin: ~0.003 ETH
 *     path: [USDC, WETH]
 *
 * run: make sdk-test-uniswap-v2-token-to-eth
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function buildSwapExactTokensForETH(amountIn, amountOutMin, path, to, deadline) {
  const sel = '18cbafe5'
  const p = v => BigInt(v).toString(16).padStart(64, '0')
  const addr = a => a.replace(/^0x/, '').toLowerCase().padStart(64, '0')

  // (uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)
  // Dynamic array offset: 5 params × 32 = 160 = 0xa0
  const parts = [
    p(amountIn),
    p(amountOutMin),
    p(0xa0),          // offset to path
    addr(to),
    p(deadline),
    p(path.length),
    ...path.map(addr),
  ]
  return '0x' + sel + parts.join('')
}

run('Uniswap V2: swapExactTokensForETH (USDC → ETH)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Swapper: ${address}`)

  const deadline = Math.floor(Date.now() / 1000) + 1200
  const amountIn = 100000000       // 100 USDC (6 decimals)
  const amountOutMin = 3000000000000000n // 0.003 ETH minimum

  const data = buildSwapExactTokensForETH(
    amountIn, amountOutMin, [USDC, WETH], address, deadline,
  )

  const tx = {
    addressNList: ETH_PATH,
    to: UNISWAP_V2_ROUTER,
    value: '0x0', // No ETH sent — selling tokens
    data,
    nonce: '0x1',
    gasLimit: toHex(200000),
    maxFeePerGas: toHex(30000000000),
    maxPriorityFeePerGas: toHex(1500000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  ┌─── PAYLOAD ───────────────────────────────────────┐')
  console.log(`  │ To:       ${UNISWAP_V2_ROUTER}`)
  console.log(`  │ Value:    0 ETH (selling tokens, not ETH)`)
  console.log(`  │ Method:   swapExactTokensForETH (0x18cbafe5)`)
  console.log(`  │ AmountIn: ${amountIn} (100 USDC)`)
  console.log(`  │ MinOut:   ${amountOutMin} wei (0.003 ETH)`)
  console.log(`  │ Path:     USDC → WETH`)
  console.log(`  │ Chain:    Ethereum (1)`)
  console.log(`  └──────────────────────────────────────────────────┘`)
  console.log(`\n  Data: ${data.slice(0, 40)}...`)
  console.log(`  NOTE: Requires prior approve() of Router on USDC contract`)

  console.log('\n  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assert('Got signed tx', !!result)
  assert('Has signature data', !!(result.serializedTx || result.v !== undefined))
})
