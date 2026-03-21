/**
 * evm-clearsign/uniswap-v3-exact-input.js
 *
 * Uniswap V3 SwapRouter: exactInputSingle(ExactInputSingleParams)
 * Selector: 0x414bf389
 *
 * V3 uses a single struct param with:
 *   tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96
 *
 * Swap 0.01 ETH → USDC on Uniswap V3 (0.3% fee tier)
 *
 * This is the most common V3 swap path. Pioneer should decode the struct
 * fields and show tokenIn/tokenOut/amountIn/amountOutMinimum.
 *
 * run: make sdk-test-uniswap-v3-exact-input
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function buildExactInputSingle(tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMin) {
  const sel = '414bf389'
  const addr = a => a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const p = v => BigInt(v).toString(16).padStart(64, '0')

  // struct ExactInputSingleParams packed as tuple:
  // (address tokenIn, address tokenOut, uint24 fee, address recipient,
  //  uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)
  const parts = [
    addr(tokenIn),
    addr(tokenOut),
    p(fee),            // uint24 but ABI-encoded as uint256
    addr(recipient),
    p(deadline),
    p(amountIn),
    p(amountOutMin),
    p(0),              // sqrtPriceLimitX96 = 0 (no limit)
  ]
  return '0x' + sel + parts.join('')
}

run('Uniswap V3: exactInputSingle (ETH → USDC, 0.3% pool)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Swapper: ${address}`)

  const deadline = Math.floor(Date.now() / 1000) + 1200
  const amountIn = 10000000000000000n  // 0.01 ETH
  const amountOutMin = 9500000         // 9.5 USDC (5% slippage)
  const fee = 3000                     // 0.3% fee tier

  const data = buildExactInputSingle(
    WETH, USDC, fee, address, deadline, amountIn, amountOutMin,
  )

  const tx = {
    addressNList: ETH_PATH,
    to: UNISWAP_V3_ROUTER,
    value: toHex(amountIn), // ETH sent with call (wraps to WETH internally)
    data,
    nonce: '0x2',
    gasLimit: toHex(250000),
    maxFeePerGas: toHex(30000000000),
    maxPriorityFeePerGas: toHex(1500000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  ┌─── PAYLOAD ───────────────────────────────────────┐')
  console.log(`  │ To:       ${UNISWAP_V3_ROUTER}`)
  console.log(`  │           (Uniswap V3 SwapRouter)`)
  console.log(`  │ Value:    0.01 ETH (wraps to WETH in router)`)
  console.log(`  │ Method:   exactInputSingle (0x414bf389)`)
  console.log(`  │ TokenIn:  WETH`)
  console.log(`  │ TokenOut: USDC`)
  console.log(`  │ Fee:      3000 (0.3% pool)`)
  console.log(`  │ AmountIn: ${amountIn} wei (0.01 ETH)`)
  console.log(`  │ MinOut:   ${amountOutMin} (9.5 USDC)`)
  console.log(`  │ Chain:    Ethereum (1)`)
  console.log(`  └──────────────────────────────────────────────────┘`)
  console.log(`\n  Data: ${data.slice(0, 40)}...`)
  console.log(`  Data length: ${(data.length - 2) / 2} bytes`)

  console.log('\n  ┌─── EXPECTED VAULT UI ────────────────────────────┐')
  console.log('  │ If Pioneer online:                               │')
  console.log('  │   Method: exactInputSingle                       │')
  console.log('  │   tokenIn: WETH, tokenOut: USDC                  │')
  console.log('  │   amountIn: 0.01 ETH, minOut: 9.5 USDC           │')
  console.log('  │   fee: 3000 (0.3%)                               │')
  console.log('  │   needsBlindSigning: false                       │')
  console.log('  │ If Pioneer offline:                               │')
  console.log('  │   selector: 0x414bf389                           │')
  console.log('  │   needsBlindSigning: true                        │')
  console.log('  │   Raw hex dump of calldata                       │')
  console.log('  └──────────────────────────────────────────────────┘')

  console.log('\n  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assert('Got signed tx', !!result)
  assert('Has signature data', !!(result.serializedTx || result.v !== undefined))
})
