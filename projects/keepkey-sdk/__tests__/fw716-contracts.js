// Offline: the 7.16 SDK surface calls the Desktop routes that exist, and
// nothing calls routes Desktop does not have.
const assert = require('node:assert/strict')
const { KeepKeySdk } = require('../lib')

async function main() {
  const calls = []
  const fakeClient = {
    signingTimeoutMs: 600000,
    post: async (path, body, timeoutMs) => {
      calls.push({ path, body, timeoutMs })
      return { ok: true }
    },
    get: async (path) => {
      calls.push({ path })
      return { ok: true }
    },
  }
  const sdk = new KeepKeySdk(fakeClient)

  const reportBody = { chain: 'evm', chainId: 1, from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), data: '0x', value: '0x0' }
  await sdk.clearsign.report(reportBody)
  assert.deepEqual(calls.pop(), { path: '/clearsign/report', body: reportBody, timeoutMs: undefined })

  await sdk.solana.decodeTransaction({ raw_tx: 'AA==' })
  assert.deepEqual(calls.pop(), { path: '/solana/decode-transaction', body: { raw_tx: 'AA==' }, timeoutMs: undefined })

  await sdk.system.device.applyPolicies({ policyName: 'AdvancedMode', enabled: false })
  assert.deepEqual(calls.pop().body, { policyName: 'AdvancedMode', enabled: false })

  const quote = { fromCaip: 'eip155:8453/slip44:60', toCaip: 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '0.0001', fromAddress: '0x1', toAddress: '0x1' }
  await sdk.chain.getSwapQuote(quote)
  assert.deepEqual(calls.pop(), { path: '/api/v2/swap/quote', body: quote, timeoutMs: undefined })

  // No Desktop route serves these; the SDK must not offer them.
  assert.equal(sdk.address.bnbGetAddress, undefined)
  assert.equal(sdk.binance, undefined)
  assert.equal(sdk.system.info.getSupportedAssets, undefined)
  assert.equal(sdk.chain.getInboundAddresses, undefined)

  console.log('fw716 SDK contracts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
