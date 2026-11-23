/** Exercise the public SDK through its real JSON transport with fixed responses. */
const assert = require('node:assert/strict')
const { TypedDataEncoder } = require('ethers')
const { KeepKeySdk, SdkError } = require('../lib')
const { VaultClient } = require('../lib/client')
const { safeTxHash, typedData } = require('../../keepkey-vault/__tests__/fixtures/safe/base-usdc-transfer.json')

async function main() {
  const client = new VaultClient('http://vault.test', 'fixture-key', 'SDK multisig test')
  const sdk = new KeepKeySdk(client)
  const owner = '0x' + '22'.repeat(20)
  const calls = []
  const { EIP712Domain: _domain, ...types } = typedData.types
  assert.equal(TypedDataEncoder.hash(typedData.domain, types, typedData.message), safeTxHash)
  const approvals = { signature: '0x' + '11'.repeat(65) }
  const partial = { signatures: ['30440220', '30450221'], serializedTx: '' }
  const vaultReplies = [
    Response.json(approvals),
    Response.json(partial),
    Response.json({ error: 'Bitcoin multisig is disabled' }, { status: 403 }),
    Response.json({ error: 'User rejected the Safe approval' }, { status: 403 }),
  ]
  const originalFetch = global.fetch
  global.fetch = async (url, options) => {
    const reply = vaultReplies.shift()
    assert(reply, 'Unexpected SDK request or retry')
    const headers = new Headers(options.headers)
    assert.equal(headers.get('authorization'), 'Bearer fixture-key')
    calls.push({ path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) })
    return reply
  }
  try {
    const approval = { address: owner, typedData }
    assert.deepEqual(await sdk.eth.ethSignTypedData(approval), approvals)

    const node = {
      depth: 4, child_num: 0x80000002, fingerprint: 0xdeadbeef,
      chain_code: '33'.repeat(32), public_key: '02' + '44'.repeat(32),
    }
    const multisig = {
      m: 2,
      pubkeys: Array.from({ length: 3 }, (_, i) => ({
        node: { ...node, public_key: '02' + String(i + 4).repeat(64) },
        address_n: [0, 7],
      })),
      signatures: ['30440220', '', ''],
    }
    const tx = {
      coin: 'Bitcoin', version: 2, locktime: 500000,
      inputs: [{ addressNList: [0x80000030, 0x80000000, 0x80000000, 0x80000002, 0, 7],
        scriptType: 'p2wsh', amount: '100000', multisig }],
      outputs: [{ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '60000' },
        { addressNList: [0x80000030, 0x80000000, 0x80000000, 0x80000002, 1, 0], amount: '39000',
          scriptType: 'p2wsh', multisig: { ...multisig, signatures: [],
            pubkeys: multisig.pubkeys.map(key => ({ ...key, address_n: [1, 0] })) } }],
    }
    assert.deepEqual(await sdk.btc.btcSignTransaction(tx), partial)
    await assert.rejects(sdk.btc.btcSignTransaction(tx),
      error => error instanceof SdkError && error.status === 403)
    await assert.rejects(sdk.eth.ethSignTypedData(approval),
      error => error instanceof SdkError && error.status === 403)
    assert.deepEqual(calls.map(({ path, method, body }) => [path, method, body]), [
      ['/eth/sign-typed-data', 'POST', approval],
      ['/utxo/sign-transaction', 'POST', tx],
      ['/utxo/sign-transaction', 'POST', tx],
      ['/eth/sign-typed-data', 'POST', approval],
    ])
  } finally {
    global.fetch = originalFetch
  }
  console.log('Multisig SDK contracts: SafeTx digest, Bitcoin threshold and change data, partial signatures, and terminal refusals passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
