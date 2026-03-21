/**
 * evm-clearsign/uniswap-v2-eth-to-token.js
 *
 * Uniswap V2 Router: swapExactETHForTokens — FULL CLEAR-SIGN TEST
 *
 * This test sends a signed Pioneer metadata blob alongside the transaction.
 * The firmware verifies the blob and displays decoded contract info on the
 * device OLED instead of raw hex.
 *
 * Fixture: tests/fixtures/evm-blobs.json["uniswap-v2-eth-to-token"]
 * Signed with test mnemonic: abandon...about (key_id=0)
 *
 * Device OLED should show:
 *   "swapExactETHForTokens"
 *   amountOutMin: 9500000
 *   to: 0x742d35Cc...
 *   (NOT raw hex)
 *
 * run: make sdk-test-uniswap-v2-eth-to-token
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')
const BLOBS = require('../fixtures/evm-blobs.json')

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

run('Uniswap V2: swapExactETHForTokens (CLEAR-SIGN)', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Swapper: ${address}`)

  const deadline = Math.floor(Date.now() / 1000) + 1200
  const data = buildSwapExactETHForTokens(9500000, [WETH, USDC], address, deadline)
  const blob = BLOBS['uniswap-v2-eth-to-token']

  assert('Fixture blob exists', !!blob)
  assert('Blob is hex string', typeof blob === 'string' && blob.length > 100)
  console.log(`  Blob: ${blob.slice(0, 40)}...${blob.slice(-20)} (${blob.length / 2} bytes)`)

  const tx = {
    addressNList: ETH_PATH,
    to: UNISWAP_V2_ROUTER,
    value: toHex(10000000000000000n),
    data,
    nonce: '0x0',
    gasLimit: toHex(200000),
    maxFeePerGas: toHex(30000000000),
    maxPriorityFeePerGas: toHex(1500000000),
    chainId: CHAINS.ETH,
    txMetadata: {
      signedPayload: blob,
      keyId: 0,
    },
  }

  console.log('\n  ┌─── CLEAR-SIGN PAYLOAD ───────────────────────────┐')
  console.log(`  │ Contract: ${UNISWAP_V2_ROUTER}`)
  console.log(`  │ Method:   swapExactETHForTokens (0x7ff36ab5)`)
  console.log(`  │ Value:    0.01 ETH`)
  console.log(`  │ Metadata: ${blob.length / 2} byte signed blob (key_id=0)`)
  console.log(`  │ Chain:    Ethereum (1)`)
  console.log('  └──────────────────────────────────────────────────┘')
  console.log('\n  Device OLED should show DECODED info, not hex.')
  console.log('  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)

  assert('Got signed tx', !!result)
  assert('Has signature', !!(result.serializedTx || result.v !== undefined))

  if (result.v !== undefined) {
    console.log(`  v=${result.v} r=${result.r?.slice(0, 20)}... s=${result.s?.slice(0, 20)}...`)
  }
})
