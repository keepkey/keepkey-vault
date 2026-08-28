#!/usr/bin/env node
/**
 * Interactive structured EIP-712 acceptance matrix.
 *
 * Firmware 7.16 should walk and display every field with Advanced Mode OFF.
 * Signing is local and never broadcasts. Keep batches small: each case has
 * several device pages and a signature is returned only after final approval.
 *
 * List: EIP712_LIST=1 node tests/evm-eip712/matrix.js
 * One:  KEEPKEY_API_KEY=… EIP712_FLOW=permit2-single node tests/evm-eip712/matrix.js
 * Page: KEEPKEY_API_KEY=… EIP712_START=0 EIP712_LIMIT=2 node tests/evm-eip712/matrix.js
 */
const { run, ETH_PATH } = require('../_helpers')
const { fixtures } = require('../fixtures/eip712-matrix')

const ALL_FLOWS = Object.keys(fixtures)

function integerEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function selectedFlows() {
  const named = (process.env.EIP712_FLOW || '').split(',').map(value => value.trim()).filter(Boolean)
  if (named.length) {
    const unknown = named.filter(key => !fixtures[key])
    if (unknown.length) throw new Error(`Unknown EIP712_FLOW: ${unknown.join(', ')}`)
    return named
  }
  const start = integerEnv('EIP712_START', 0)
  const limit = integerEnv('EIP712_LIMIT', 1)
  return ALL_FLOWS.slice(start, start + limit)
}

if (process.env.EIP712_LIST === '1') {
  console.log(`Structured EIP-712 matrix (${ALL_FLOWS.length} flows):`)
  ALL_FLOWS.forEach((key, index) => console.log(`${index}  ${key} — ${fixtures[key].purpose}`))
  process.exit(0)
}

const flows = selectedFlows()
if (!flows.length) throw new Error('Selected EIP-712 batch is empty')

run(`structured EIP-712: sign ${flows.length}/${ALL_FLOWS.length} flows`, async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Signer: ${address}`)
  console.log('  Acceptance: Advanced Mode OFF; exact domain/type/member/value pages; no blind-sign warning.')

  for (const key of flows) {
    const fixture = fixtures[key]
    console.log(`\n  [${key}] ${fixture.purpose}`)
    console.log(`  Primary type: ${fixture.typedData.primaryType}`)
    console.log(`  Domain: ${JSON.stringify(fixture.typedData.domain)}`)
    console.log('  >>> APPROVE every structured page, then the final signature <<<')

    const result = await sdk.eth.ethSignTypedData({ address, typedData: fixture.typedData })
    const signature = typeof result === 'string' ? result : result?.signature
    assert(`[${key}] got a 65-byte signature`, typeof signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(signature))
  }
})
