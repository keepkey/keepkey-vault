// Firmware liquidity recipient guard (alpha PR #260, MEDIUM). addLiquidityETH
// routes the LP tokens to its `to` recipient. A non-self recipient was only
// soft-warned; it now fails closed. Recipient == signer signs; a third-party
// recipient is rejected.
//
// Both cases prompt on-device (the handler shows its liquidity screens). For
// case (b) the device shows "Liquidity recipient is NOT this wallet" and then
// refuses to sign — approve the screens and confirm it ends in rejection.
//   KEEPKEY_API_KEY=<key> node tests/evm-firmware/uniswap-liquidity-recipient.js
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')
const { Transaction } = require('ethers')

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D' // UNISWAP_ROUTER_ADDRESS
const USDC = 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const word = (h) => h.replace(/^0x/, '').padStart(64, '0')

// addLiquidityETH(token, amountTokenDesired, amountTokenMin, amountETHMin, to, deadline)
function addLiquidityETH(recipient) {
  return '0xf305d719'
    + word(USDC)                 // token
    + word('5f5e100')            // amountTokenDesired
    + word('5b8d80')             // amountTokenMin
    + word('38d7ea4c68000')      // amountETHMin
    + word(recipient)            // to (LP recipient)
    + word('ffffffff')           // deadline
}

const baseTx = {
  addressNList: ETH_PATH, to: UNISWAP_V2_ROUTER, value: toHex(0.05e18),
  nonce: '0x0', gasLimit: '0x30000', gasPrice: toHex(20e9), chainId: CHAINS.ETH,
}

run('Uniswap addLiquidityETH recipient must be the signer', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  // Verify the blind-sign gate is active (AdvancedMode off — the device default).
  const adv = (await sdk.system.info.getFeatures()).policies?.find(p => p.policy_name === 'AdvancedMode')
  assert('AdvancedMode is OFF (blind-sign gate active)', !adv || adv.enabled === false)

  // (a) recipient == device address → signs (approve on-device)
  const out = await sdk.eth.ethSignTransaction({ ...baseTx, from: address, data: addLiquidityETH(address) })
  assert('self-recipient liquidity signs', !!(out.serialized || out.serializedTx))
  const parsed = Transaction.from(out.serialized || out.serializedTx)
  assert('recovers to device addr', parsed.from && parsed.from.toLowerCase() === address.toLowerCase())

  // (b) recipient == a third party → fail closed (rejected after the recipient screen)
  let err
  try {
    await sdk.eth.ethSignTransaction({
      ...baseTx, from: address,
      data: addLiquidityETH('000000000000000000000000000000000000dEaD'),
    })
  } catch (e) { err = e }
  assertThrows('non-self liquidity recipient is rejected', err)
})
