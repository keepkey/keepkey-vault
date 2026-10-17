/**
 * evm-clearsign/unknown-contract.js — Contract call with unknown selector
 *
 * Uses a bogus function selector 0xdeadbeef that no decoder will recognize.
 * Pioneer: called but returns nothing (unknown contract)
 * Local decoder: no match (not ERC-20)
 *
 * Vault UI SHOULD show:
 *   needsBlindSigning: true
 *   Warning: "Unknown contract method — review raw data"
 *   Raw calldata displayed as hex
 *
 * This tests the Tier 3 fallback path in calldata-decoder.ts
 */
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')

run('Unknown contract call — red, device shows raw data', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Sender: ${address}`)

  // Random contract with unknown selector
  const tx = {
    addressNList: ETH_PATH,
    to: '0x1234567890abcdef1234567890abcdef12345678',
    value: toHex(50000000000000000), // 0.05 ETH sent WITH the call
    data: '0xdeadbeef' +
      '0000000000000000000000000000000000000000000000000000000000000042' +
      '00000000000000000000000000000000000000000000000000000000000000ff',
    gasLimit: toHex(100000),
    gasPrice: toHex(20000000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  Expected vault UI:')
  console.log('    Contract: 0x1234...5678')
  console.log('    Method: 0xdeadbeef (UNKNOWN)')
  console.log('    Value: 0.05 ETH (sent with call)')
  console.log('    needsBlindSigning: TRUE')
  console.log('    Raw calldata shown as hex dump')

  // Zero presses. With AdvancedMode off, 7.16 cannot show this call, so
  // Desktop's report must say the device shows raw data (the signing card then
  // blocks it). Signing it would need AdvancedMode: see fw-716/50 (opt-in).
  const report = await sdk.clearsign.report({
    chain: 'evm', chainId: tx.chainId, from: address, to: tx.to, data: tx.data, value: tx.value,
  })
  console.log(`  report: ${report.protectionLevel} source=${report.descriptor.source} [${report.limitations.map((l) => l.code).join(', ')}]`)
  assert('Desktop saw the device', !report.limitations.some((l) => l.code === 'DEVICE_NOT_CONNECTED'))
  assert('report says the device shows raw data', report.limitations.some((l) => l.code === 'DEVICE_SHOWS_RAW_DATA'))
  assert("no description: source 'none'", report.descriptor.source === 'none')
  assert('report is below P4', report.protectionLevel !== 'P4' && report.protectionLevel !== 'P5')
})
