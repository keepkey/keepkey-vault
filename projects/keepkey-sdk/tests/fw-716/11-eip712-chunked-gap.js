#!/usr/bin/env node
/**
 * fw-716/11 — EIP-712 chunked values (capability 26) cannot be reached through
 * Desktop. 1 Desktop click; 0 device presses expected.
 *
 * 7.16 advertises CAPABILITY_EIP712_CHUNKED_VALUES (26), but hdwallet's
 * eip712Streaming.ts capLeaf() throws on any string/bytes leaf over 1024 bytes
 * ("<what> value is N bytes, over the 1024-byte wire limit") when the device
 * asks for it, before the value is sent. So this suite proves only the host
 * guard, never the device's chunked path.
 *
 * Nothing can be signed: the document's domain name is 1500 bytes. If a device
 * screen does appear, use Desktop's in-app Cancel; the suite then FAILs and
 * prints what came back.
 */
const { run, ETH_PATH, short } = require('../_helpers')

const GAP = 'KNOWN GAP: CAPABILITY_EIP712_CHUNKED_VALUES=26 not exercised (hdwallet caps leaves at 1024 B)'

const typedData = {
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    Mail: [{ name: 'contents', type: 'string' }],
  },
  domain: { name: 'A'.repeat(1500) },
  primaryType: 'Mail',
  message: { contents: 'x' },
}

run('fw-716/11 EIP-712 leaf over 1024 B stops on the host (capability 26 gap)', async (getSdk, assert) => {
  console.log(`  ${GAP}`)
  const sdk = await getSdk()
  const caps = (await sdk.system.info.getFeatures()).capabilities
  console.log(`  device advertises capability 26: ${Array.isArray(caps) ? caps.includes(26) : 'unknown (no capabilities in features)'}`)
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
  console.log(`\n  ${GAP}`)
})
