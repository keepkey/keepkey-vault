/**
 * evm-eip712/permit2-bex-shape.js — repro the BEX call shape exactly
 *
 * Mirrors what `chrome-extension/.../ethereumHandler.ts:signTypedData` sends:
 *   - the extra `addressNList` field on the SDK call (gets stripped by schema)
 *   - the typed data destructured + rebuilt as { domain, types, message, primaryType }
 *   - the typed data round-tripped through JSON.parse(JSON.stringify(...))
 *     in case key ordering mutates the firmware hash
 *
 * If the BEX-shape call recovers to the right signer here, the bug is even
 * deeper in the BEX (popup re-render, content-script proxy mutation, etc.).
 * If it fails here, we have the minimal repro.
 */
const { run, ETH_PATH } = require('../_helpers')
const { utils } = require('/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/node_modules/ethers')

run('Permit2 in BEX call shape', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device address: ${address}`)

  // Original dApp typedData (chainId is a STRING — Uniswap quirk)
  const dappTyped = {
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
      chainId: '1',
      verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    },
    message: {
      details: {
        token: '0x514910771af9ca656af840dff83e8264ecf986ca',
        amount: '1461501637330902918203684832716283019655932542975',
        expiration: '1779943164',
        nonce: '0',
      },
      spender: '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca',
      sigDeadline: '1777352964',
    },
  }

  // Mimic BEX:
  //   const parsed = typeof typedData === 'string' ? JSON.parse(typedData) : typedData;
  //   const { domain, types, message, primaryType } = parsed;
  // We feed it as a stringified message (worst-case dApp behavior) then
  // reassemble like ethereumHandler.signTypedData does.
  const stringified = JSON.stringify(dappTyped)
  const parsed = JSON.parse(stringified)
  const { domain, types, message, primaryType } = parsed
  const HDWalletPayload = {
    address,
    addressNList: ETH_PATH,
    typedData: { domain, types, message, primaryType },
  }

  console.log('\n  HDWalletPayload (BEX shape):')
  console.log('  ' + JSON.stringify(HDWalletPayload, null, 2).split('\n').join('\n  '))

  console.log('\n  >>> APPROVE on device <<<\n')
  const result = await sdk.eth.ethSignTypedData(HDWalletPayload)
  const sig = typeof result === 'string' ? result : result.signature
  assert('Got signature', !!sig)
  console.log(`\n  Returned sig: ${sig}`)

  // Verify against the SAME bytes we sent
  const typesNoDomain = { ...HDWalletPayload.typedData.types }
  delete typesNoDomain.EIP712Domain

  const recovered = utils.verifyTypedData(
    HDWalletPayload.typedData.domain,
    typesNoDomain,
    HDWalletPayload.typedData.message,
    sig,
  )
  console.log(`  Recovered:      ${recovered}`)
  console.log(`  Device:         ${address}`)
  assert('Recovered signer matches device address (BEX shape)', recovered.toLowerCase() === address.toLowerCase())
})
