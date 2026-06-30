// Firmware clear-sign (alpha PR #260): 0x transformERC20 is pinned to the
// ExchangeProxy and bounded by its displayed input/min-output amounts, so it
// clear-signs at ANY calldata size WITHOUT AdvancedMode. The over-broad gate
// previously forced these (the transformations[] tail exceeds one 1024-byte
// chunk) onto the blind-sign path. With AdvancedMode OFF, a correct firmware
// clear-signs it; a regressed one would blind-sign-block and throw.
//
// Requires on-device approval of the "Transform ERC20" screen.
//   KEEPKEY_API_KEY=<key> node tests/evm-firmware/transformerc20-clearsign.js
const { run, ETH_PATH, CHAINS, toHex } = require('../_helpers')
const { Transaction } = require('ethers')

const ZX_EXCHANGE_PROXY = '0xdef1c0ded9bec7f1a1670819833240f027b25eff' // ZXSWAP_ADDRESS
const USDT = 'dac17f958d2ee523a2206206994597c13d831ec7'
const USDC = 'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const word = (h) => h.replace(/^0x/, '').padStart(64, '0')

// transformERC20(inputToken, outputToken, inputAmount, minOutput, transformations[])
// Padded so total calldata > 1024 bytes (streams to the device in chunks),
// exercising the "clear-sign at any size" path. The transformations blob is
// inert (not broadcast); the firmware only reads/display the 4 head words.
const transformERC20 = '0x415565b0'
  + word(USDT)            // inputToken
  + word(USDC)            // outputToken
  + word('0c5c360b9c')    // inputTokenAmount
  + word('0c58cb06ec')    // minOutputTokenAmount
  + word('a0')            // transformations offset (canonical 0xa0)
  + word('1')             // transformations length
  + '00'.repeat(32 * 30)  // pad past 1024 bytes

run('transformERC20 clear-signs without AdvancedMode (any size)', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })

  // Verify the blind-sign gate is active (AdvancedMode off — the device default).
  const adv = (await sdk.system.info.getFeatures()).policies?.find(p => p.policy_name === 'AdvancedMode')
  assert('AdvancedMode is OFF (blind-sign gate active)', !adv || adv.enabled === false)

  const out = await sdk.eth.ethSignTransaction({
    addressNList: ETH_PATH, from: address,
    to: ZX_EXCHANGE_PROXY, value: '0x0', data: transformERC20,
    nonce: '0x1', gasLimit: '0x5140e',
    maxFeePerGas: toHex(30e9), maxPriorityFeePerGas: toHex(1.5e9), chainId: CHAINS.ETH,
  })
  assert('signed (clear-signed, not blind-blocked)', !!(out.serialized || out.serializedTx))
  const parsed = Transaction.from(out.serialized || out.serializedTx)
  assert('recovers to device addr', parsed.from && parsed.from.toLowerCase() === address.toLowerCase())
  assert('calldata exceeded one chunk (>1024 bytes)', (transformERC20.length - 2) / 2 > 1024)
})
