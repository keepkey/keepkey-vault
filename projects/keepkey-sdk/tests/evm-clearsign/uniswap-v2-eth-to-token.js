/**
 * evm-clearsign/uniswap-v2-eth-to-token.js
 *
 * Uniswap V2 Router: swapExactETHForTokens. Zero presses.
 *
 * Firmware 7.16 has no built-in key 0, so the old keyId-0 metadata blob can no
 * longer describe this call, and no certified entry covers the V2 router. With
 * AdvancedMode off the device would show raw data; the suite checks that
 * Desktop's report says so instead of signing.
 *
 * run: make sdk-test-uniswap-v2-eth-to-token
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function buildSwapExactETHForTokens(amountOutMin, path, to, deadline) {
  const sel = '7ff36ab5'
  const p = (v) => BigInt(v).toString(16).padStart(64, '0')
  const addr = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const parts = [p(amountOutMin), p(0x80), addr(to), p(deadline), p(path.length), ...path.map(addr)]
  return '0x' + sel + parts.join('')
}

run('Uniswap V2: swapExactETHForTokens (device shows raw data)', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Swapper: ${address}`)

  const deadline = Math.floor(Date.now() / 1000) + 1200
  const data = buildSwapExactETHForTokens(9500000, [WETH, USDC], address, deadline)

  const tx = {
    addressNList: ETH_PATH,
    to: UNISWAP_V2_ROUTER,
    value: toHex(10000000000000000n),
    data,
    gasLimit: toHex(200000),
    maxFeePerGas: toHex(30000000000),
    maxPriorityFeePerGas: toHex(1500000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  ┌─── PAYLOAD ──────────────────────────────────────┐')
  console.log(`  │ Contract: ${UNISWAP_V2_ROUTER}`)
  console.log(`  │ Method:   swapExactETHForTokens (0x7ff36ab5)`)
  console.log(`  │ Value:    0.01 ETH`)
  console.log(`  │ Chain:    Ethereum (1)`)
  console.log('  └──────────────────────────────────────────────────┘')

  // Zero presses. With AdvancedMode off, 7.16 cannot show this call, so
  // Desktop's report must say the device shows raw data (the signing card then
  // blocks it). Signing it would need AdvancedMode: see fw-716/50 (opt-in).
  const report = await sdk.clearsign.report({
    chain: 'evm', chainId: tx.chainId, from: address, to: tx.to, data: tx.data, value: tx.value,
  })
  console.log(`  report: ${report.protectionLevel} source=${report.descriptor.source} [${report.limitations.map((l) => l.code).join(', ')}]`)
  assert('Desktop saw the device', !report.limitations.some((l) => l.code === 'DEVICE_NOT_CONNECTED'))
  assert('report says the device shows raw data', report.limitations.some((l) => l.code === 'DEVICE_SHOWS_RAW_DATA'))
})
