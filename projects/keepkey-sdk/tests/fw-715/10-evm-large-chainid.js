/**
 * fw-715/10-evm-large-chainid.js — the headline 7.15 fix. 3 presses.
 *
 * On 7.14.1 and earlier, an EIP-1559 tx on a chain with chainId >= 256 hashed
 * only the LOW BYTE of the chain id. The signature is valid for that mangled
 * pre-image, so it recovers to a wrong-but-deterministic address and the
 * network drops the transaction.
 *
 *   Base      8453  & 0xFF ==   5   (signs as if it were Goerli)
 *   Arbitrum 42161  & 0xFF == 177
 *   Avalanche 43114 & 0xFF == 106
 *
 * Every other 1559 test in this repo uses chainId 1 — the one value that
 * cannot detect this, since 1 & 0xFF == 1.
 *
 * The check is objective: a wrong pre-image cannot recover to the device's own
 * address by accident.
 */
const { run, ETH_PATH, toHex } = require('../_helpers')
const { Transaction } = require('ethers')

// chainId, name, and the byte 7.14.1 would have hashed instead.
const CHAINS = [
  { id: 8453, name: 'Base' },
  { id: 42161, name: 'Arbitrum' },
  { id: 43114, name: 'Avalanche' },
]

run('fw-715 EVM large chainId — type-2 recovers to the device on chainId >= 256', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`\n  device address: ${address}\n`)

  for (const chain of CHAINS) {
    const lowByte = chain.id & 0xff
    console.log(`  ── ${chain.name} (chainId ${chain.id}, low byte ${lowByte}) ──`)

    const tx = {
      addressNList: ETH_PATH,
      to: address, // send to self: no funds move, nothing to fund
      value: '0x0',
      data: '0x',
      nonce: '0x0',
      gasLimit: '0x5208',
      maxFeePerGas: toHex(30e9),
      maxPriorityFeePerGas: toHex(1.5e9),
      chainId: chain.id,
    }

    let out
    try {
      out = await sdk.eth.ethSignTransaction(tx)
    } catch (e) {
      assert(`${chain.name}: signs`, false)
      console.error(`     ${String(e.message || e).slice(0, 160)}`)
      continue
    }

    const serialized = out.serialized || out.serializedTx
    assert(`${chain.name}: returns a serialized envelope`, !!serialized)
    if (!serialized) continue

    const parsed = Transaction.from(serialized)

    // The envelope must carry the FULL chain id, not the truncated byte.
    assert(`${chain.name}: envelope chainId is ${chain.id}`,
      Number(parsed.chainId) === chain.id)

    // The signature must recover to this device. On broken firmware it recovers
    // to a stranger — deterministically, which is what made it hard to spot.
    const recovered = (parsed.from || '').toLowerCase()
    const expected = address.toLowerCase()
    assert(`${chain.name}: recovers to device address`, recovered === expected)
    if (recovered !== expected) {
      console.error(`     expected:  ${expected}`)
      console.error(`     recovered: ${recovered}`)
      console.error(`     (this is the 7.14.1 truncated-chainId signature)`)
    }
  }
})
