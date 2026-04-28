/**
 * evm-eip712/permit2.js — Uniswap Permit2 signing + sig recovery diff
 *
 * Reproduces the exact Uniswap dApp request that recovers to the wrong
 * signer in production (Apr 2026). The dApp sees the device address as
 * `0x141D9959…` (correct), but ethers.verifyTypedData on the returned
 * signature recovers a different address — meaning the bytes the device
 * hashed differ from the bytes ethers reconstructs from the same input.
 *
 * If THIS test fails (recovered ≠ device address), the bug is in the
 * vault REST → firmware EIP-712 path, not in the BEX. If it passes,
 * the BEX is mutating the typed data before sending to the vault.
 */
const { run, ETH_PATH } = require('../_helpers')
const { utils } = require('/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/node_modules/ethers')

run('EIP-712 Permit2 — sign + recover diff (Uniswap repro)', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device address: ${address}`)

  // Exact payload captured from a failing Uniswap swap, Apr 2026.
  // chainId is intentionally the STRING "1" — that's what Uniswap sends.
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
      chainId: '1',
      verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    },
    message: {
      details: {
        token: '0x514910771af9ca656af840dff83e8264ecf986ca',  // LINK
        amount: '1461501637330902918203684832716283019655932542975', // max uint160
        expiration: '1779943164',
        nonce: '0',
      },
      spender: '0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca',
      sigDeadline: '1777352964',
    },
  }

  // ethers expects EIP712Domain stripped from `types` for hashing helpers
  const typesNoDomain = { ...typedData.types }
  delete typesNoDomain.EIP712Domain

  // Compute what ethers thinks the device SHOULD hash
  const expectedDomainSep = utils._TypedDataEncoder.hashDomain(typedData.domain)
  const expectedStructHash = utils._TypedDataEncoder.from(typesNoDomain).hash(typedData.message)
  const expectedDigest = utils._TypedDataEncoder.hash(typedData.domain, typesNoDomain, typedData.message)

  console.log('\n  ── Expected (ethers) ──')
  console.log(`  domainSeparator: ${expectedDomainSep}`)
  console.log(`  structHash:      ${expectedStructHash}`)
  console.log(`  digest:          ${expectedDigest}`)

  console.log('\n  >>> APPROVE on device <<<\n')

  const result = await sdk.eth.ethSignTypedData({ address, typedData })
  const sig = typeof result === 'string' ? result : result.signature
  assert('Got signature', !!sig)
  console.log(`\n  Returned sig: ${sig}`)

  // Recover the signer from the SAME typed data we sent.
  let recovered
  try {
    recovered = utils.verifyTypedData(typedData.domain, typesNoDomain, typedData.message, sig)
  } catch (e) {
    console.error(`  Recovery threw: ${e.message}`)
    return
  }

  console.log(`  Recovered:      ${recovered}`)
  console.log(`  Device:         ${address}`)

  const match = recovered.toLowerCase() === address.toLowerCase()
  assert('Recovered signer matches device address', match)

  if (!match) {
    console.log('\n  ❌ DATA DRIFT — device hashed something other than the typed data above.')
    console.log('  Next step: diff the firmware-side domainSeparator/digest against the')
    console.log('  expected values above to find which field gets mangled in the vault')
    console.log('  REST → firmware path.')
  }
})
