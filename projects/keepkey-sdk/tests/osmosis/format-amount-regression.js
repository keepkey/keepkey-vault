/**
 * Osmosis confirm-screen amount formatting — signing regression.
 *
 * fw #315 / rc15 replaced atof()+"%.6f" with an integer formatter
 * (osmosis_formatAmount, bignum.h bn_format_uint64) on every Osmosis confirm
 * screen — send, delegate, undelegate, LP add/remove, redelegate, swap, IBC
 * transfer. This suite covers 3 of those 7 call sites (send, delegate,
 * undelegate); LP/swap/redelegate/IBC share the exact same formatter and
 * were not re-covered here to avoid hand-building 4 more fragile amino
 * payloads for a formatter already proven correct in the firmware unit
 * tests (Osmosis.FormatAmountIsExactBeyondFloatPrecision, run natively in
 * CI) and in isolation (keepkey-firmware unittests/firmware/osmosis.cpp).
 *
 * WHAT THIS PROVES: signing still succeeds with amounts that overflow a
 * float's ~7 significant digits — i.e. the new formatter doesn't crash or
 * reject where the old one would have silently rounded.
 *
 * WHAT THIS CANNOT PROVE: that the OLED renders the exact digits. An SDK
 * test is blind to the device screen — that's Gate-3 OLED proof, not this.
 *
 * Run: node tests/osmosis/format-amount-regression.js   (Vault on :1646)
 */
const { run } = require('../_helpers')

// m/44'/118'/0'/0/0 — Osmosis uses the Cosmos coin type (118), not its own.
const OSMO_PATH = [0x80000000 + 44, 0x80000000 + 118, 0x80000000, 0, 0]

const sig = (r) => r && (r.signature || r.serialized || r.serializedTx)
const FEE = { amount: [{ denom: 'uosmo', amount: '800' }], gas: '290000' }

function signDoc(address, msg) {
  return {
    chain_id: 'osmosis-1',
    account_number: '0',
    sequence: '0',
    fee: FEE,
    memo: '',
    msgs: [msg],
  }
}

run('osmosis amount-format regression (post fw-315 float removal)', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  const { address } = await sdk.address.osmosisGetAddress({ address_n: OSMO_PATH, show_display: false })
  assert(`derives osmo address (${address})`, !!address && address.startsWith('osmo'))

  // 123456789.123456 uosmo scaled — 16 significant digits, well past a
  // float's ~7. The old atof()+"%.6f" path rendered this rounded to
  // "123456792.000000 OSMO"; it must still sign correctly under the new
  // integer formatter.
  const bigAmount = '123456789123456'

  // ── MsgSend ───────────────────────────────────────────────────────
  let sendRes, sendErr
  try {
    sendRes = await sdk.osmosis.osmosisSignAmino({
      signerAddress: address,
      signDoc: signDoc(address, {
        type: 'cosmos-sdk/MsgSend',
        value: {
          from_address: address,
          to_address: address, // self-send: only signing is under test
          amount: [{ denom: 'uosmo', amount: bigAmount }],
        },
      }),
    })
  } catch (e) { sendErr = e }
  assert('MsgSend signs a beyond-float-precision uosmo amount', !sendErr && !!sig(sendRes))
  if (sendErr) console.error(`     ↳ ${String(sendErr.message || sendErr).slice(0, 200)}`)

  // ── MsgDelegate ───────────────────────────────────────────────────
  let delRes, delErr
  try {
    delRes = await sdk.osmosis.osmosisSignAminoDelegate({
      signerAddress: address,
      signDoc: signDoc(address, {
        type: 'cosmos-sdk/MsgDelegate',
        value: {
          delegator_address: address,
          validator_address: 'osmovaloper1sjllsnramtg3ewxqwwrwjxfgc4n4ef9u2lcnj0', // well-known Osmosis validator, signing only
          amount: { denom: 'uosmo', amount: bigAmount },
        },
      }),
    })
  } catch (e) { delErr = e }
  assert('MsgDelegate signs a beyond-float-precision uosmo amount', !delErr && !!sig(delRes))
  if (delErr) console.error(`     ↳ ${String(delErr.message || delErr).slice(0, 200)}`)

  // ── MsgUndelegate — also exercises the sub-unit tail (osmosis_format-
  //    Amount must not collapse "500" uosmo to "0.000000 OSMO") ───────
  let undelRes, undelErr
  try {
    undelRes = await sdk.osmosis.osmosisSignAminoUndelegate({
      signerAddress: address,
      signDoc: signDoc(address, {
        type: 'cosmos-sdk/MsgUndelegate',
        value: {
          delegator_address: address,
          validator_address: 'osmovaloper1sjllsnramtg3ewxqwwrwjxfgc4n4ef9u2lcnj0',
          amount: { denom: 'uosmo', amount: '500' },
        },
      }),
    })
  } catch (e) { undelErr = e }
  assert('MsgUndelegate signs a sub-unit uosmo amount', !undelErr && !!sig(undelRes))
  if (undelErr) console.error(`     ↳ ${String(undelErr.message || undelErr).slice(0, 200)}`)
})
