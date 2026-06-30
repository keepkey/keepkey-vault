// Firmware sellToUniswap offset validation (alpha PR #260, HIGH). The handler
// reads tokens[] at fixed offsets that are only correct when the dynamic-array
// head pointer (word0) is canonical (0x80). A non-canonical word0 lets the EVM
// decode a different array than the firmware displays (display/execution drain),
// so it is now rejected.
//
// Case (a) needs on-device approval; case (b) rejects before confirmation.
//   KEEPKEY_API_KEY=<key> node tests/evm-firmware/selltouniswap-offset.js
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')
const { Transaction } = require('ethers')

const ZX_EXCHANGE_PROXY = '0xdef1c0ded9bec7f1a1670819833240f027b25eff' // ZXSWAP_ADDRESS
const word = (h) => h.replace(/^0x/, '').padStart(64, '0')

// sellToUniswap(address[] tokens, uint256 sellAmount, uint256 minBuyAmount, bool isSushi)
function sellToUniswap(tokensOffsetHex) {
  return '0xd9627aa4'
    + word(tokensOffsetHex)  // word0: tokens[] head pointer
    + word('3fb33ddbf39e4')  // sellAmount
    + word('155cbf')         // minBuyAmount
    + word('1')              // isSushi
    + word('2')              // numTokens
    + word('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') // tokens[0] (ETH placeholder)
    + word('a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') // tokens[1] (USDC)
}

const baseTx = {
  addressNList: ETH_PATH, to: ZX_EXCHANGE_PROXY, value: '0x0',
  nonce: '0x0', gasLimit: '0x26249', gasPrice: toHex(0x24c988ac00), chainId: CHAINS.ETH,
}

run('sellToUniswap dynamic-array offset validation', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  // Verify the blind-sign gate is active (AdvancedMode off — the device default).
  const adv = (await sdk.system.info.getFeatures()).policies?.find(p => p.policy_name === 'AdvancedMode')
  assert('AdvancedMode is OFF (blind-sign gate active)', !adv || adv.enabled === false)

  // (a) canonical word0 (0x80) → clear-signs (needs on-device approval)
  const out = await sdk.eth.ethSignTransaction({ ...baseTx, from: address, data: sellToUniswap('80') })
  assert('canonical sellToUniswap signs', !!(out.serialized || out.serializedTx))
  const parsed = Transaction.from(out.serialized || out.serializedTx)
  assert('recovers to device addr', parsed.from && parsed.from.toLowerCase() === address.toLowerCase())

  // (b) non-canonical word0 (0xa0) → display/execution mismatch → rejected
  let err
  try {
    await sdk.eth.ethSignTransaction({ ...baseTx, from: address, data: sellToUniswap('a0') })
  } catch (e) { err = e }
  assertThrows('non-canonical tokens[] offset is rejected', err)
})
