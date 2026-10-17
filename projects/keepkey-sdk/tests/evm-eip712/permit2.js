/**
 * evm-eip712/permit2.js — Uniswap Permit2 token approval via EIP-712
 *
 * This is the #1 phishing vector in DeFi. A signed permit gives the
 * spender off-chain approval to move tokens without an on-chain approve().
 *
 * Vault UI SHOULD show:
 *   EIP-712 Typed Data badge
 *   Domain: Permit2
 *   Fields: token, amount, expiration, spender
 *   WARNING if amount is MAX_UINT256 or expiration is far future
 *
 * Zoo: 19-eip712-permit.png
 */
const { run, ETH_PATH, short } = require('../_helpers')
const { verifyTypedData } = require('ethers')

run('EIP-712 Permit2 — token spending approval', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Signer: ${address}`)

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
    },
    primaryType: 'PermitSingle',
    domain: {
      name: 'Permit2',
      chainId: 1,
      verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    },
    message: {
      details: {
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
        amount: '1', // 0.000001 USDC: bounded and worthless
        expiration: '1893456000', // 2030-01-01
        nonce: '0',
      },
      spender: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', // Uniswap Universal Router
      // 2023-11-14, already past: Permit2 reverts SignatureExpired, so this
      // signature can never be used even if it leaks.
      sigDeadline: '1700000000',
    },
  }

  console.log('\n  Typed data domain:', JSON.stringify(typedData.domain, null, 4))
  console.log('  Message:', JSON.stringify(typedData.message, null, 4))
  console.log('\n  Expected vault UI:')
  console.log('    Domain: Permit2')
  console.log('    Token: USDC (0xA0b8...)')
  console.log('    Amount: 1 (bounded)')
  console.log('    Spender: Uniswap Universal Router')
  console.log('    Expiration: 2030-01-01')
  console.log('    Signature valid until: 2023-11-14 (in the past)')
  console.log('\n  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTypedData({
    address,
    typedData,
  })

  const sig = typeof result === 'string' ? result : result?.signature
  assert('Signature is a 65-byte hex string', typeof sig === 'string' && /^0x[0-9a-fA-F]{130}$/.test(sig))
  if (typeof sig !== 'string') return
  console.log(`  Signature: ${short(sig)}`)
  const { EIP712Domain, ...types } = typedData.types
  const recovered = verifyTypedData(typedData.domain, types, typedData.message, sig)
  assert('Signature recovers to the device', recovered.toLowerCase() === address.toLowerCase())
})
