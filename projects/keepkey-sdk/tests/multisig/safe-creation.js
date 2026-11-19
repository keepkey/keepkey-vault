#!/usr/bin/env node
/** Sign a disposable 2-of-2 Safe creation fixture through Vault's public API. */
const assert = require('node:assert/strict')
const { Interface, Transaction } = require('ethers')
const { ETH_PATH, run, SENTINEL_NONCE, skip } = require('../_helpers')

const FACTORY = '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67'
const SINGLETON = '0x29fcb43b46531bca003ddc8fcb67ffe91900c762'
const OWNERS = ['0xe4f420a0786451a10bf2fd4702e9b76632c08109', '0x3ef438c34ce51a697a24247fe033c4562c94f0fd']
const ZERO = '0x' + '00'.repeat(20)
const setup = new Interface(['function setup(address[],uint256,address,bytes,address,address,uint256,address)'])
const factory = new Interface(['function createProxyWithNonce(address,bytes,uint256)'])

async function signSafeCreation(sdk) {
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  const initializer = setup.encodeFunctionData('setup', [OWNERS, 2, ZERO, '0x', ZERO, ZERO, 0, ZERO])
  const data = factory.encodeFunctionData('createProxyWithNonce', [SINGLETON, initializer, 61001])
  const reviews = []
  for (const chainId of [1, 8453]) {
    const result = await sdk.eth.ethSignTransaction({
      addressNList: ETH_PATH, from: address, chainId, to: FACTORY,
      value: '0x0', nonce: SENTINEL_NONCE, gasLimit: '0x61a80',
      maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0x3b9aca00', data,
    })
    const report = result.clearSignReport
    assert.equal(report?.descriptor.source, 'erc7730', 'Vault must attach the signed Safe creation definition')
    assert.equal(report.descriptor.authenticated, true)
    const raw = result.serialized || result.serializedTx
    assert.equal(typeof raw, 'string', 'Vault must return the signed transaction bytes')
    const signed = Transaction.from(raw.startsWith('0x') ? raw : '0x' + raw)
    assert.equal(signed.chainId, BigInt(chainId))
    assert.equal(signed.nonce, Number(SENTINEL_NONCE))
    assert.equal(signed.from?.toLowerCase(), address.toLowerCase())
    assert.equal(signed.to?.toLowerCase(), FACTORY)
    assert.equal(signed.data, data)
    assert.equal(signed.value, 0n)
    reviews.push(report)
    console.log(`Chain ${chainId}: certified 2-of-2 Safe creation, signer and transaction bytes verified`)
  }
  return reviews
}

module.exports = { signSafeCreation }

if (require.main === module) {
  if (process.env.KEEPKEY_SDK_SAFE_CREATION !== '1') skip('Set KEEPKEY_SDK_SAFE_CREATION=1 on a disposable emulator')
  run('Safe creation over the SDK', async getSdk => {
    await signSafeCreation(await getSdk())
  })
}
