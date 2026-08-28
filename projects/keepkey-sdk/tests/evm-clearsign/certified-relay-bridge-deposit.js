#!/usr/bin/env node
/**
 * Production-shaped 7.16 acceptance: fetch a root-certified EVM schema from
 * the deployed ClearSign service and sign without loading a runtime signer or
 * enabling Advanced Mode.
 *
 * The service sees only chain, contract, selector, and calldata length. The
 * KeepKey verifies the certificate and delegate signature, then decodes the
 * actual depositor and orderId from the transaction it signs.
 */
const { run, ETH_PATH } = require('../_helpers')

const SERVICE = process.env.CLEARSIGN_SERVICE_URL ||
  'https://keepkey-clearsign.bithighlander.workers.dev'
const CONTRACT = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const SELECTOR = '0x49290c1c'
const DEPOSITOR = '0x742d35cc6634c0532950a20547b231011e30c8e7'
const ORDER_ID = `0x${'ab'.repeat(32)}`
const DATA = SELECTOR +
  DEPOSITOR.slice(2).padStart(64, '0') +
  ORDER_ID.slice(2)

run('7.16 certified Relay bridgeDeposit (Advanced Mode off)', async (getSdk, assert) => {
  const response = await fetch(`${SERVICE}/v1/evm/schema`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 1,
      contract: CONTRACT,
      selector: SELECTOR,
      calldataLength: (DATA.length - 2) / 2,
    }),
  })
  const envelope = await response.json()
  if (!response.ok) throw new Error(`ClearSign service ${response.status}: ${envelope.error || 'unknown error'}`)

  assert('service returned VERIFIED metadata', envelope.classification === 'VERIFIED')
  assert('envelope is certified v3', envelope.version === 3 && envelope.signedPayload?.slice(0, 4) === '0x03')
  assert('reserved delegate keyId is 0x80', envelope.keyId === 0x80)
  assert('reviewed alpha signer fingerprint matches', envelope.fingerprint === 'a9531b9d')
  assert('response is bound to the requested shape',
    envelope.chainId === 1 &&
    envelope.contract.toLowerCase() === CONTRACT &&
    envelope.selector.toLowerCase() === SELECTOR)

  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Device ETH address: ${address}`)
  console.log('  No LoadClearsignSigner call was made.')
  console.log('  Expect: Authenticated by KeepKey / bridgeDeposit / depositor / orderId.')

  const result = await sdk.eth.ethSignTransaction({
    to: CONTRACT,
    data: DATA,
    value: '0x0',
    nonce: '0x0',
    gasLimit: '0x30d40',
    gasPrice: '0x4a817c800',
    chainId: 1,
    addressNList: ETH_PATH,
    txMetadata: { signedPayload: envelope.signedPayload, keyId: envelope.keyId },
  })
  assert('certified Relay transaction signed', !!(result && (result.serializedTx || result.r)))
})
