/**
 * evm-clearsign/uniswap-v3-multicall.js
 *
 * Uniswap V3 SwapRouter02: multicall(uint256,bytes[])
 * Selector: 0x5ae401dc
 *
 * The modern V3 router uses multicall to batch operations:
 *   1. exactInputSingle (the swap)
 *   2. unwrapWETH9 (convert output WETH to ETH if needed)
 *
 * This is the REAL pattern dApps use — not the raw exactInputSingle.
 * Pioneer must decode the outer multicall AND the inner calls.
 *
 * This is a harder test for the decoder: nested ABI-encoded calls
 * inside a dynamic bytes array.
 *
 * run: make sdk-test-uniswap-v3-multicall
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

const UNISWAP_V3_ROUTER02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function buildMulticall(deadline, innerCalls) {
  const sel = '5ae401dc'
  const p = v => BigInt(v).toString(16).padStart(64, '0')

  // multicall(uint256 deadline, bytes[] data)
  // data is a dynamic array of bytes (each inner call is ABI-encoded)
  let offset = 64 // 2 params × 32 bytes
  const parts = [p(deadline), p(offset)]

  // Encode the bytes[] array
  parts.push(p(innerCalls.length)) // array length

  // Calculate offsets for each bytes element
  const dataOffsets = []
  let currentOffset = innerCalls.length * 32 // skip the offset slots
  for (const call of innerCalls) {
    dataOffsets.push(p(currentOffset))
    const byteLen = (call.length - 2) / 2 // hex string to byte count
    const paddedLen = Math.ceil(byteLen / 32) * 32
    currentOffset += 32 + paddedLen // length prefix + padded data
  }
  parts.push(...dataOffsets)

  // Encode each bytes element
  for (const call of innerCalls) {
    const hex = call.replace(/^0x/, '')
    const byteLen = hex.length / 2
    parts.push(p(byteLen))
    const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')
    parts.push(padded)
  }

  return '0x' + sel + parts.join('')
}

run('Uniswap V3: multicall (real dApp pattern)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Swapper: ${address}`)

  const deadline = Math.floor(Date.now() / 1000) + 1200
  const addr = a => a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const p = v => BigInt(v).toString(16).padStart(64, '0')

  // Inner call 1: exactInputSingle
  const exactInputSingleData = '0x414bf389' +
    addr(WETH) +       // tokenIn
    addr(USDC) +       // tokenOut
    p(3000) +          // fee (0.3%)
    addr(address) +    // recipient
    p(deadline) +      // deadline
    p(10000000000000000n) + // amountIn (0.01 ETH)
    p(9500000) +       // amountOutMinimum (9.5 USDC)
    p(0)               // sqrtPriceLimitX96

  const innerCalls = [exactInputSingleData]

  const data = buildMulticall(deadline, innerCalls)

  const tx = {
    addressNList: ETH_PATH,
    to: UNISWAP_V3_ROUTER02,
    value: toHex(10000000000000000n), // 0.01 ETH
    data,
    nonce: '0x3',
    gasLimit: toHex(300000),
    maxFeePerGas: toHex(30000000000),
    maxPriorityFeePerGas: toHex(1500000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  ┌─── PAYLOAD ───────────────────────────────────────┐')
  console.log(`  │ To:       ${UNISWAP_V3_ROUTER02}`)
  console.log(`  │           (Uniswap SwapRouter02 — modern router)`)
  console.log(`  │ Value:    0.01 ETH`)
  console.log(`  │ Method:   multicall(uint256,bytes[]) (0x5ae401dc)`)
  console.log(`  │ Inner:    exactInputSingle (WETH→USDC, 0.3%)`)
  console.log(`  │ AmountIn: 0.01 ETH`)
  console.log(`  │ MinOut:   9.5 USDC`)
  console.log(`  │ Gas:      300k (multicall needs more gas)`)
  console.log(`  │ Chain:    Ethereum (1)`)
  console.log(`  └──────────────────────────────────────────────────┘`)
  console.log(`\n  Data length: ${(data.length - 2) / 2} bytes`)

  console.log('\n  ┌─── EXPECTED VAULT UI ────────────────────────────┐')
  console.log('  │ This is the KEY clearsign test:                  │')
  console.log('  │ Pioneer must decode multicall → inner calls      │')
  console.log('  │ Show: "Swap 0.01 ETH → min 9.5 USDC"            │')
  console.log('  │ If only outer multicall decoded:                 │')
  console.log('  │   Shows "multicall" with raw inner bytes         │')
  console.log('  │ If nothing decoded:                              │')
  console.log('  │   needsBlindSigning=true, raw hex dump           │')
  console.log('  └──────────────────────────────────────────────────┘')

  console.log('\n  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assert('Got signed tx', !!result)
  assert('Has signature data', !!(result.serializedTx || result.v !== undefined))
})
