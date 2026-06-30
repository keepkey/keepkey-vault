// Firmware THORChain pin (alpha PR #261, CRITICAL). thor_isThorchainTx now pins
// the router (bumped to current v4 d37bbe..). A deposit to the real router
// clear-signs; a deposit to ANY other contract carrying the deposit selector is
// NOT clear-signed and — with AdvancedMode off — hits the blind-sign gate and is
// rejected (previously it bypassed the gate, the drain vector).
//
// Case (a) needs on-device approval; case (b) rejects before any confirmation.
//   KEEPKEY_API_KEY=<key> node tests/evm-firmware/thorchain-router-pin.js
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')
const { Transaction } = require('ethers')

const THOR_ROUTER_V4 = '0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146'
const word = (h) => h.replace(/^0x/, '').padStart(64, '0')

// deposit(vault, asset(ETH=0), amount, memo) — memo "SWAP:BTC.BTC:0x..:420"
const depositCalldata = '0x1fece7b4'
  + word('345b297ec83add7ff74d2f7933651bffa037d956') // asgard vault
  + word('0')                                         // asset = ETH native
  + word('65945acd2b867ef000')                        // amount
  + word('80')                                        // memo offset (canonical)
  + word('3b')                                         // memo length (59)
  + '535741503a4254432e4254433a30783431653535363030353438323465613662'
  + '30373332653635366533616436346532306539346534353a3432300000000000'

const baseTx = {
  addressNList: ETH_PATH, value: toHex('0x65945acd2b867ef000'),
  data: depositCalldata, nonce: '0x0', gasLimit: '0x186a0',
  gasPrice: toHex(0x5fb9aca00), chainId: CHAINS.ETH,
}

run('THORChain router pin — real router clear-signs, attacker contract blocked', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  // Verify the blind-sign gate is active (AdvancedMode off — the device default).
  const adv = (await sdk.system.info.getFeatures()).policies?.find(p => p.policy_name === 'AdvancedMode')
  assert('AdvancedMode is OFF (blind-sign gate active)', !adv || adv.enabled === false)

  // (a) deposit to the pinned router → clear-signs (needs on-device approval)
  const out = await sdk.eth.ethSignTransaction({ ...baseTx, from: address, to: THOR_ROUTER_V4 })
  assert('deposit to v4 router signs', !!(out.serialized || out.serializedTx))
  const parsed = Transaction.from(out.serialized || out.serializedTx)
  assert('recovers to device addr', parsed.from && parsed.from.toLowerCase() === address.toLowerCase())

  // (b) same calldata to an arbitrary (attacker) contract → must NOT clear-sign;
  // with AdvancedMode off it is blind-sign-blocked and rejected.
  let err
  try {
    await sdk.eth.ethSignTransaction({
      ...baseTx, from: address, to: '0x1234567890123456789012345678901234567890',
    })
  } catch (e) { err = e }
  assertThrows('deposit selector to non-router is rejected (no blind-sign bypass)', err)
})
