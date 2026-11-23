#!/usr/bin/env node
/**
 * On 7.16 or later without capability 26, Desktop must refuse oversized
 * EIP-712 leaves. The 7.17 alpha suite tests the advertised capability.
 *
 * Nothing can be signed: the document's domain name is 1500 bytes. If a device
 * screen does appear, use Desktop's in-app Cancel; the suite then FAILs and
 * prints what came back.
 */
const { run, ETH_PATH, short, skip } = require('../_helpers')

const typedData = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Mail: [{ name: 'contents', type: 'string' }],
  },
  domain: { name: 'A'.repeat(1500) },
  primaryType: 'Mail',
  message: { contents: 'x' },
}

run('fw-716/11 EIP-712 leaf over 1024 B is refused without capability 26', async (getSdk, assert) => {
  const sdk = await getSdk()
  const features = await sdk.system.info.getFeatures()
  const { major_version: major, minor_version: minor, capabilities } = features
  if (major < 7 || (major === 7 && minor < 16) || !Array.isArray(capabilities)) {
    skip('Requires firmware 7.16 or later with an explicit capability list')
  }
  if (capabilities.includes(26)) skip('Capability 26 is advertised; use the 7.17 alpha positive-path suite on the bundled emulator')
  const { address: device } = await sdk.address.ethGetAddress({ address_n: ETH_PATH, show_display: false })
  console.log(`  device: ${device}`)

  console.log('  OWNER: approve the Desktop card. NO device screen is expected.')
  console.log('         If one appears, press Cancel in Desktop (the suite will FAIL).')
  let out, err
  try { out = await sdk.eth.ethSignTypedData({ address: device, typedData }) } catch (e) { err = e }

  const sig = typeof out === 'string' ? out : out?.signature
  const text = err ? String(err.message || err) : ''
  console.log(`  response: ${err ? `HTTP ${err.status ?? '?'} ${text.slice(0, 300)}` : `signature ${short(sig)}`}`)
  assert('no signature returned', !sig)
  assert('no device screen (no "User cancelled")', !/user cancelled/i.test(text))
  assert("error is the host guard: 'over the 1024-byte wire limit'", text.includes('over the 1024-byte wire limit'))
})
