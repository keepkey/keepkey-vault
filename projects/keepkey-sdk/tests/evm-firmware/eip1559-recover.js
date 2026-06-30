// Firmware EVM pre-image correctness (alpha PR #255).
//
// The "contract deployments won't sign" bug was an RLP pre-image defect: Stage-1
// list length counted raw field bytes while Stage-2 hashed leading-zero-stripped
// bytes, so any tx with a leading-zero byte in nonce/gas/value/fee recovered to a
// WRONG/random address. EIP-1559 also: priority fee must always be hashed,
// chain_id is required. The strongest end-to-end check is: sign a spread of
// small/leading-zero-prone txs via the live Vault and verify EACH recovers to the
// device's own address. (Requires on-device approval per tx.)
//
//   KEEPKEY_API_KEY=<key> node tests/evm-firmware/eip1559-recover.js
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')
const { Transaction } = require('ethers')

run('EVM pre-image correctness — recovered signer == device address', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  assert('Got device ETH address', address && address.startsWith('0x'))
  const dev = address.toLowerCase()

  // Field shapes that historically broke the pre-image: zero value (empty/
  // leading-zero), small nonce, small gas, and EIP-1559 with NO priority fee.
  const recipient = '0x000000000000000000000000000000000000dEaD'
  const cases = [
    { label: 'legacy, nonce 5, value 0', tx: {
        to: recipient, value: '0x0', data: '0x', nonce: '0x5',
        gasLimit: '0x5208', gasPrice: toHex(20e9), chainId: CHAINS.ETH } },
    { label: 'legacy, small value (leading-zero-prone)', tx: {
        to: recipient, value: '0x5', data: '0x', nonce: '0x1',
        gasLimit: '0x5208', gasPrice: '0x100', chainId: CHAINS.ETH } },
    { label: 'EIP-1559, nonce 5, value 0', tx: {
        to: recipient, value: '0x0', data: '0x', nonce: '0x5', gasLimit: '0x5208',
        maxFeePerGas: toHex(30e9), maxPriorityFeePerGas: toHex(1.5e9), chainId: CHAINS.ETH } },
    { label: 'EIP-1559, NO priority fee (always-hash-priority fix)', tx: {
        to: recipient, value: '0x0', data: '0x', nonce: '0x2', gasLimit: '0x5208',
        maxFeePerGas: toHex(30e9), chainId: CHAINS.ETH } },
  ]

  for (const c of cases) {
    const out = await sdk.eth.ethSignTransaction({ addressNList: ETH_PATH, from: address, ...c.tx })
    const parsed = Transaction.from(out.serialized || out.serializedTx)
    assert(`${c.label} → recovers to device addr`, parsed.from && parsed.from.toLowerCase() === dev)
  }
})
