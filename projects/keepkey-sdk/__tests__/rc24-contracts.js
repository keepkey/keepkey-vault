const assert = require('node:assert/strict')
const { KeepKeySdk } = require('../lib')

async function main() {
  const calls = []
  const fakeClient = {
    signingTimeoutMs: 600000,
    post: async (path, body, timeoutMs) => {
      calls.push({ kind: 'json', path, body, timeoutMs })
      if (path === '/addresses/utxo') {
        return { address: `bc1p${'q'.repeat(58)}` }
      }
      if (path === '/utxo/sign-transaction') {
        return { serializedTx: '00', signatures: ['11'.repeat(64)] }
      }
      throw new Error(`unexpected JSON endpoint: ${path}`)
    },
    postBytes: async (path, body, timeoutMs) => {
      calls.push({ kind: 'bytes', path, body, timeoutMs })
      return new Uint8Array(body.size).fill(0xa5)
    },
  }
  const sdk = new KeepKeySdk(fakeClient)

  const address = await sdk.address.utxoGetAddress({
    address_n: [0x80000056, 0x80000000, 0x80000000, 0, 0],
    coin: 'Bitcoin',
    script_type: 'p2tr',
    show_display: true,
  })
  assert.match(address.address, /^bc1p/)
  const addressCall = calls.find(call => call.path === '/addresses/utxo')
  assert.equal(addressCall.body.script_type, 'p2tr')
  assert.equal(addressCall.body.show_display, true)
  assert.equal(addressCall.timeoutMs, fakeClient.signingTimeoutMs)

  const entropy = await sdk.system.info.getEntropy(8192)
  const entropyCall = calls.find(call => call.path === '/system/info/get-entropy')
  assert.equal(entropyCall.kind, 'bytes')
  assert.equal(entropyCall.body.size, 8192)
  assert.equal(entropyCall.timeoutMs, fakeClient.signingTimeoutMs)
  assert.equal(entropy.length, 8192)

  const signed = await sdk.btc.btcSignTransaction({ inputs: [], outputs: [] })
  const signingCall = calls.find(call => call.path === '/utxo/sign-transaction')
  assert.equal(signingCall.timeoutMs, fakeClient.signingTimeoutMs)
  assert.equal(signed.signatures[0].length, 128)

  console.log('RC24 SDK contracts: passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
