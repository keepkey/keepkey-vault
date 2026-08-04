#!/usr/bin/env node
/**
 * Manual x402 EVM boundary test. Signs only; never broadcasts or settles.
 * The authorization is deliberately expired (`validBefore = 1`).
 */
const { verifyTypedData } = require('ethers')
const { run, ETH_PATH } = require('../_helpers')

run('x402 EVM exact — expired EIP-3009 authorization', async (getSdk, assert) => {
  const sdk = await getSdk()
  const signer = await sdk.x402.evm.createSigner({ addressNList: ETH_PATH })

  const domain = {
    name: 'USDC',
    version: '2',
    chainId: 84532n,
    verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  }
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  }
  const message = {
    from: signer.address,
    to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    value: 2000n,
    validAfter: 0n,
    validBefore: 1n, // permanently expired: signature cannot authorize a transfer
    nonce: '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
  }

  console.log(`  Device EVM address: ${signer.address}`)
  console.log('  Fixture: Base Sepolia USDC, 0.002 USDC, expired authorization')
  console.log('  No transaction will be broadcast or submitted to a facilitator.')
  console.log('\n  Expected device review:')
  console.log('    x402 / TransferWithAuthorization')
  console.log('    0.002 USDC')
  console.log(`    From: ${signer.address}`)
  console.log(`    To:   ${message.to}`)
  console.log('\n  >>> VERIFY EVERY FIELD, THEN APPROVE ON KEEPKEY <<<\n')

  const signature = await signer.signTypedData({
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  })
  const recovered = verifyTypedData(domain, types, message, signature)

  assert('received a 65-byte EIP-712 signature', /^0x[0-9a-fA-F]{130}$/.test(signature))
  assert('signature recovers the device address', recovered.toLowerCase() === signer.address.toLowerCase())
  console.log(`  Signature: ${signature.slice(0, 42)}...`)
})
