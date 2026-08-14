/**
 * fw-715/11-evm-1559-chunked-data.js — the chunked access-list fix. 1 press.
 *
 * Firmware hashed the empty access-list byte 0xC0 BETWEEN data chunks whenever
 * `data` exceeded the 1024-byte single-USB-chunk threshold:
 *
 *   keccak( 0x02 || ... || data[0..1024] || 0xC0 || data[1024..end] )
 *                                           ^^^^ must be last
 *
 * The signature is valid for that pre-image, so it recovers to a
 * wrong-but-deterministic address and the network silently drops the tx. Every
 * Uniswap Universal Router swap, Permit2 batch, and large multicall hit it.
 * Transactions at or under 1024 bytes escape, because the misplaced byte lands
 * at the end anyway — which is why this needs calldata deliberately over the
 * threshold.
 *
 * Fixed by finalize_eip1559_and_send_signature() in lib/firmware/ethereum.c.
 *
 * Related: tests/evm-tx-1559/recover-fixture.js replays a blob captured from
 * the BROKEN firmware and can never pass — a stored signature is not changed by
 * fixing the signer. This test is the live equivalent that can.
 *
 * WHY THIS SKIPS BY DEFAULT
 * ------------------------
 * Calldata past 1024 bytes is, by definition, more than the device can decode,
 * so it lands on the blind-sign gate: "contains contract data the device cannot
 * fully parse. Enable Advanced Mode to sign." That gate is correct and we do
 * NOT want it disabled — with AdvancedMode ON, several suites' "rejected
 * correctly" results become false greens, because the rejection was a human
 * pressing cancel rather than the gate firing.
 *
 * So this suite requires an explicit opt-in. Enable AdvancedMode on the device,
 * then run with KK_ALLOW_BLIND=1:
 *
 *     KK_ALLOW_BLIND=1 node tests/fw-715/11-evm-1559-chunked-data.js
 *
 * On firmware that scopes AdvancedMode to the session it disarms itself when the
 * device locks or is unplugged, so there is nothing to turn back off. On older
 * firmware the policy persists — turn it off by hand there.
 *
 * Skipping is not a coverage hole: python-keepkey drives the same chunked path
 * against the emulator with no gate in the way.
 */
const { run, ETH_PATH, toHex, SEL } = require('../_helpers')
const { Transaction } = require('ethers')

const CHUNK = 1024

if (!process.env.KK_ALLOW_BLIND) {
  console.log('\n=== EVM 1559 chunked data — SKIPPED (needs blind-sign opt-in) ===\n')
  console.log('  Calldata over 1024 bytes cannot be decoded on-device, so this tx')
  console.log('  hits the blind-sign gate. Do not disable that gate casually.')
  console.log('  To run: enable AdvancedMode, re-run with KK_ALLOW_BLIND=1.')
  console.log('  Session-scoped firmware disarms it on lock/unplug by itself.')
  console.log('  No device interaction performed.\n')
  process.exit(0)
}

/** ERC-20 transfer selector + `words` 32-byte words. Shape is irrelevant to the
 *  hash; only the total length matters, so this stays readable. */
function calldataOfWords(words) {
  return SEL.transfer + '11'.repeat(32 * words)
}

/** byte length of a 0x-prefixed hex string */
const byteLen = (hex) => (hex.replace(/^0x/, '').length) / 2

run('fw-715 EVM 1559 chunked data — access list stays last across chunk boundary', async (getSdk, assert) => {
  const sdk = await getSdk()
  const { address } = await sdk.address.ethGetAddress({ address_n: ETH_PATH })
  console.log(`\n  device address: ${address}`)

  // 40 words = 1280 bytes + 4 selector bytes: comfortably past the boundary, so
  // the tail lands in a second chunk.
  const data = calldataOfWords(40)
  console.log(`  calldata:       ${byteLen(data)} bytes (threshold ${CHUNK})\n`)
  assert(`calldata exceeds the ${CHUNK}-byte chunk threshold`, byteLen(data) > CHUNK)

  const tx = {
    addressNList: ETH_PATH,
    to: address, // self: nothing moves, no funds needed
    value: '0x0',
    data,
    nonce: '0x0',
    gasLimit: '0x30D40',
    maxFeePerGas: toHex(30e9),
    maxPriorityFeePerGas: toHex(1.5e9),
    chainId: 1,
  }

  let out
  try {
    out = await sdk.eth.ethSignTransaction(tx)
  } catch (e) {
    assert('signs multi-chunk type-2 tx', false)
    console.error(`  ${String(e.message || e).slice(0, 200)}`)
    return
  }

  const serialized = out.serialized || out.serializedTx
  assert('returns a serialized envelope', !!serialized)
  if (!serialized) return

  const parsed = Transaction.from(serialized)
  assert('envelope is type-2', parsed.type === 2)
  assert('calldata survives the round trip', parsed.data === data)

  const recovered = (parsed.from || '').toLowerCase()
  const expected = address.toLowerCase()
  assert('recovers to device address', recovered === expected)
  if (recovered !== expected) {
    console.error(`     expected:  ${expected}`)
    console.error(`     recovered: ${recovered}`)
    console.error(`     (0xC0 hashed mid-stream — the pre-1024-byte-fix pre-image)`)
  }
})
