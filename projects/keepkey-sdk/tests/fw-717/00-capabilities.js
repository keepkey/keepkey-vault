#!/usr/bin/env node
const { run, skip } = require('../_helpers')

const REQUIRED_CAPABILITIES = {
  4: 'ERC-7730 runtime review',
  18: 'certified Solana review',
  19: 'Solana lookup-table attestation',
  26: 'chunked EIP-712 values',
  27: 'certified EVM contacts',
  28: 'Safe typed calls',
  29: 'ERC-7730 typed iteration',
  30: 'ERC-7730 typed settlement',
  32: 'certified native contacts',
}

if (process.env.KEEPKEY_SDK_ALPHA !== '1') skip('Set KEEPKEY_SDK_ALPHA=1 on the bundled 7.17 emulator')

run('7.17 alpha ClearSign capabilities over SDK REST', async (getSdk, assert) => {
  const sdk = await getSdk()
  const features = await sdk.system.info.getFeatures()
  const version = [features.major_version, features.minor_version, features.patch_version].join('.')
  assert('firmware reports 7.17.0', version === '7.17.0')
  assert('firmware reports the Emulator variant', features.firmware_variant === 'Emulator')
  assert('firmware reports an explicit capability list', Array.isArray(features.capabilities))
  for (const [id, label] of Object.entries(REQUIRED_CAPABILITIES)) {
    assert(`capability ${id}: ${label}`, features.capabilities?.includes(Number(id)))
  }
  console.log(`  Monero signing (31, build-dependent): ${features.capabilities?.includes(31) ? 'advertised' : 'absent'}`)
})
