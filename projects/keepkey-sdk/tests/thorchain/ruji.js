/**
 * THORChain RUJI / secured-asset / custom-denom signing tests.
 *
 * Proves (against the running Vault + whatever device/emulator is attached)
 * that the firmware signs THORChain `MsgSend` with ARBITRARY denoms (TCY,
 * RUJIRA, secured assets like `btc-btc`) and `MsgDeposit` with arbitrary memos
 * — the two operations RUJI / secured assets actually need.
 *
 * It also asserts the firmware's denom charset guard rejects injection denoms.
 *
 * Run: node tests/thorchain/ruji.js   (Vault must be live on :1646)
 */
const { run } = require('../_helpers')

// m/44'/931'/0'/0/0
const THOR_PATH = [0x80000000 + 44, 0x80000000 + 931, 0x80000000, 0, 0]
const CHAIN_ID = 'thorchain-1'

const sig = (r) => r && (r.signature || r.serialized || r.serializedTx)

function transferDoc(from, denom) {
  return {
    fee: { gas: '500000000', amount: [{ denom: 'rune', amount: '0' }] },
    msgs: [{
      type: 'thorchain/MsgSend',
      value: {
        from_address: from,
        to_address: from, // self-send: we only care that it signs
        amount: [{ denom, amount: '1000000' }],
      },
    }],
    memo: '',
    sequence: '0',
    chain_id: CHAIN_ID,
    account_number: '0',
  }
}

function depositDoc(from, asset, memo) {
  return {
    fee: { gas: '500000000', amount: [{ denom: 'rune', amount: '0' }] },
    msgs: [{
      type: 'thorchain/MsgDeposit',
      value: {
        coins: [{ asset, amount: '1000000' }],
        memo,
        signer: from,
      },
    }],
    memo,
    sequence: '0',
    chain_id: CHAIN_ID,
    account_number: '0',
  }
}

run('thorchain RUJI / secured-asset / custom-denom signing', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  // ── Address sanity ──────────────────────────────────────────────────
  const { address } = await sdk.address.thorchainGetAddress({ address_n: THOR_PATH, show_display: false })
  assert(`derives thor address (${address})`, !!address && address.startsWith('thor'))

  // ── MsgSend with arbitrary denoms (the RUJI / secured-asset feature) ─
  // 'rune' is the baseline; the rest exercise firmware "allow any denom".
  const denoms = [
    ['rune', 'baseline RUNE'],
    ['tcy', 'TCY token'],
    ['rujira', 'RUJI / Rujira token'],
    ['btc-btc', 'secured asset BTC-BTC'],
    ['eth-usdc', 'secured asset ETH-USDC'],
  ]
  for (const [denom, label] of denoms) {
    let res, err
    try { res = await sdk.thorchain.thorchainSignAminoTransfer({ signDoc: transferDoc(address, denom), signerAddress: address }) }
    catch (e) { err = e }
    assert(`MsgSend signs denom "${denom}" (${label})`, !err && !!sig(res))
    if (err) console.error(`     ↳ ${denom}: ${String(err.message || err).slice(0, 160)}`)
  }

  // ── MsgDeposit with memo (mint/redeem/trade routing) ────────────────
  let depRes, depErr
  try {
    depRes = await sdk.thorchain.thorchainSignAminoDeposit({
      signDoc: depositDoc(address, 'THOR.RUNE', 'SECURE+:BTC.BTC'),
      signerAddress: address,
    })
  } catch (e) { depErr = e }
  assert('MsgDeposit signs with secured-asset memo', !depErr && !!sig(depRes))
  if (depErr) console.error(`     ↳ deposit: ${String(depErr.message || depErr).slice(0, 160)}`)

  // ── Negative: firmware denom charset guard rejects injection ────────
  let injErr
  try {
    await sdk.thorchain.thorchainSignAminoTransfer({
      signDoc: transferDoc(address, 'rune"},{"x'),
      signerAddress: address,
    })
  } catch (e) { injErr = e }
  assertThrows('rejects JSON-injection denom (charset guard)', injErr)
})
