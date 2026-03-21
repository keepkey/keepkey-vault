/**
 * evm-adversarial/value-in-token-call.js — ETH value sent WITH a token transfer
 *
 * Attack scenario: attacker wraps a legitimate-looking ERC-20 transfer()
 * but includes a non-zero ETH value. The calldata says "transfer 100 USDC"
 * but the tx also sends 1 ETH to the contract address.
 *
 * A naive user only sees "transfer 100 USDC" in the decoded view and
 * misses the 1 ETH being sent to the contract (likely lost forever).
 *
 * Vault UI SHOULD clearly show BOTH:
 *   - Decoded calldata: transfer 100 USDC to recipient
 *   - ETH value: 1.0 ETH sent to contract address (WARNING!)
 */
const { run, ETH_PATH, CHAINS, toHex, erc20Transfer } = require('../_helpers')

run('Adversarial: ETH value hidden in token call', async (getSdk, assert) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`  Sender: ${address}`)

  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const recipient = '0x742d35Cc6634C0532950a20547b231011e30c8e7'

  // Legitimate-looking ERC-20 transfer
  const data = erc20Transfer(recipient, 100000000n) // 100 USDC

  const tx = {
    addressNList: ETH_PATH,
    to: USDC,
    value: toHex(1000000000000000000n), // 1.0 ETH — hidden in the call!
    data,
    nonce: '0x3',
    gasLimit: toHex(100000),
    gasPrice: toHex(20000000000),
    chainId: CHAINS.ETH,
  }

  console.log('\n  Payload:', JSON.stringify(tx, null, 4))
  console.log('\n  ATTACK: tx sends 1 ETH to the USDC contract + calls transfer()')
  console.log('  The 1 ETH goes to the contract address, NOT the token recipient')
  console.log('  This ETH is likely LOST forever (USDC contract has no withdraw)')
  console.log('\n  Expected vault UI:')
  console.log('    Decoded: transfer 100 USDC to 0x742d...')
  console.log('    VALUE: 1.000000000000000000 ETH (MUST be prominently displayed)')
  console.log('    WARNING: Sending ETH to a token contract')
  console.log('\n  >>> REJECT this — review what the vault shows <<<\n')

  const result = await sdk.eth.ethSignTransaction(tx)
  assert('Tx was signed (user chose to approve despite warning)', !!result)
})
