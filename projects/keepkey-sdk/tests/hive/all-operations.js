/**
 * Hive FULL op-table sweep — every operation the device will clear-sign.
 *
 * Covers all 14 ops in the firmware clear-sign table (hive.c
 * hive_parseOperations / fsm_msgHiveSignOperations) through
 * POST /hive/sign-operations, plus the two dedicated paths
 * (/hive/sign-transfer, /hive/sign-message).
 *
 *   phase 1: vote(0) comment(1) custom_json(18)
 *   phase 2: transfer_to_vesting(3) withdraw_vesting(4) convert(8)
 *            comment_options(19) transfer_to_savings(32)
 *            transfer_from_savings(33) claim_reward_balance(39)
 *            delegate_vesting_shares(40) account_update2(43)
 *   phase 3: limit_order_create(5) limit_order_cancel(6)
 *
 * Ops 2/9/10 (transfer, account_create, account_update) are PERMANENTLY
 * excluded from the table — transfer has its own path, and 9/10 would
 * rotate account keys, violating the device-derived-keys invariant. Their
 * exclusion is asserted here, not treated as a gap.
 *
 * Tier rule: one signature cannot satisfy posting- and active-tier ops, so
 * each case signs a single tier. comment_options is the one op that must
 * be paired — it only validates immediately after its own comment.
 *
 * Account names are synthetic. This is a SIGNING test: the device signs the
 * bytes it is given and does not check that an account exists on-chain.
 * Nothing here is broadcast.
 *
 * Requires: firmware >= 7.15.0-rc15, vault hive_enabled=1, live Pioneer for
 * the TaPoS header (/hive/sign-operations fetches it per call).
 *
 * Run: node tests/hive/all-operations.js   (Vault live on :1646)
 */
const { run } = require('../_helpers')

const sig = (r) => r && (r.signature || r.serialized || r.serializedTx)

// SLIP-0048 m/48'/13'/role'/account'/0'
const ROLE = { owner: 0, active: 1, memo: 3, posting: 4 }
const hivePath = (role) =>
  [0x80000030, 0x8000000d, 0x80000000 + ROLE[role], 0x80000000, 0x80000000]

// A comment op that comment_options can legally bind to (same author+permlink).
const COMMENT = {
  parent_author: '', parent_permlink: 'hive',
  author: 'alice', permlink: 'post',
  title: 't', body: 'b', json_metadata: '{}',
}

// Every op in the table: [label, tier, ...ops to sign together]
const CASES = [
  // ── phase 1 ────────────────────────────────────────────────────────
  ['vote', 'posting', ['vote', { voter: 'alice', author: 'bob', permlink: 'p', weight: 10000 }]],
  ['comment', 'posting', ['comment', COMMENT]],
  ['custom_json (posting auth)', 'posting', ['custom_json', {
    required_auths: [], required_posting_auths: ['alice'],
    id: 'follow', json: '{"follow":"bob"}',
  }]],
  ['custom_json (active auth)', 'active', ['custom_json', {
    required_auths: ['alice'], required_posting_auths: [],
    id: 'ssc-mainnet-hive', json: '{"contractName":"tokens"}',
  }]],

  // ── phase 2 ────────────────────────────────────────────────────────
  ['transfer_to_vesting (power up)', 'active',
    ['transfer_to_vesting', { from: 'alice', to: 'bob', amount: '5.000 HIVE' }]],
  ['transfer_to_vesting (power up self, empty to)', 'active',
    ['transfer_to_vesting', { from: 'alice', to: '', amount: '5.000 HIVE' }]],
  ['withdraw_vesting (power down)', 'active',
    ['withdraw_vesting', { account: 'alice', vesting_shares: '1000.000000 VESTS' }]],
  ['withdraw_vesting (0 VESTS = stop power down)', 'active',
    ['withdraw_vesting', { account: 'alice', vesting_shares: '0.000000 VESTS' }]],
  ['convert', 'active',
    ['convert', { owner: 'alice', requestid: 77, amount: '2.500 HBD' }]],
  ['comment + comment_options (no beneficiaries)', 'posting',
    ['comment', COMMENT],
    ['comment_options', {
      author: 'alice', permlink: 'post',
      max_accepted_payout: '1000000.000 HBD', percent_hbd: 10000,
      allow_votes: true, allow_curation_rewards: true, extensions: [],
    }]],
  ['comment + comment_options (2 beneficiaries)', 'posting',
    ['comment', COMMENT],
    ['comment_options', {
      author: 'alice', permlink: 'post',
      max_accepted_payout: '1000000.000 HBD', percent_hbd: 10000,
      allow_votes: true, allow_curation_rewards: true,
      // hived requires strictly ascending account names
      extensions: [[0, { beneficiaries: [
        { account: 'bob', weight: 100 },
        { account: 'skatehive', weight: 500 },
      ] }]],
    }]],
  ['transfer_to_savings', 'active',
    ['transfer_to_savings', { from: 'alice', to: 'alice', amount: '1.000 HBD', memo: 'save' }]],
  ['transfer_from_savings', 'active',
    ['transfer_from_savings', { from: 'alice', request_id: 9, to: 'bob', amount: '1.000 HIVE', memo: '' }]],
  ['claim_reward_balance (3 assets)', 'posting',
    ['claim_reward_balance', {
      account: 'alice', reward_hive: '0.001 HIVE',
      reward_hbd: '0.000 HBD', reward_vests: '1.234567 VESTS',
    }]],
  ['delegate_vesting_shares', 'active',
    ['delegate_vesting_shares', { delegator: 'alice', delegatee: 'bob', vesting_shares: '1000.000000 VESTS' }]],
  ['delegate_vesting_shares (0 = remove delegation)', 'active',
    ['delegate_vesting_shares', { delegator: 'alice', delegatee: 'bob', vesting_shares: '0.000000 VESTS' }]],
  ['account_update2 (posting metadata only)', 'posting',
    ['account_update2', { account: 'alice', json_metadata: '', posting_json_metadata: '{"profile":{}}' }]],
  ['account_update2 (json_metadata = active tier)', 'active',
    ['account_update2', { account: 'alice', json_metadata: '{"x":1}', posting_json_metadata: '' }]],

  // ── phase 3 ────────────────────────────────────────────────────────
  ['limit_order_create', 'active',
    ['limit_order_create', {
      owner: 'alice', orderid: 42,
      amount_to_sell: '1.500 HIVE', min_to_receive: '0.400 HBD',
      fill_or_kill: true, expiration: 1700003600,
    }]],
  ['limit_order_create (fill_or_kill false)', 'active',
    ['limit_order_create', {
      owner: 'alice', orderid: 43,
      amount_to_sell: '0.400 HBD', min_to_receive: '1.500 HIVE',
      fill_or_kill: false, expiration: 1700003600,
    }]],
  ['limit_order_cancel', 'active',
    ['limit_order_cancel', { owner: 'alice', orderid: 42 }]],
]

// Ops that must NEVER reach the device clear-sign table.
const EXCLUDED = [
  ['transfer', { from: 'alice', to: 'bob', amount: '1.000 HIVE', memo: '' }],
  ['account_create', { creator: 'alice', new_account_name: 'mallory' }],
  ['account_update', { account: 'alice', json_metadata: '{}' }],
]

run('Hive FULL op-table sweep (all 14 clear-sign ops + transfer + message)', async (getSdk, assert, assertThrows) => {
  const sdk = await getSdk()

  // ── Role derivation, both tiers ─────────────────────────────────────
  const active = await sdk.address.hiveGetAddress({ address_n: hivePath('active'), show_display: false })
  assert('derives active-role key', !!(active.address || active.public_key))
  const posting = await sdk.address.hiveGetAddress({ address_n: hivePath('posting'), show_display: false })
  assert('derives posting-role key', !!(posting.address || posting.public_key))

  // ── Every op in the table signs ─────────────────────────────────────
  for (const [label, tier, ...operations] of CASES) {
    let res, err
    try { res = await sdk.hive.hiveSignOperations({ operations }) }
    catch (e) { err = e }
    assert(`${label} [${tier}] signs`, !err && !!sig(res))
    if (err) console.error(`     ↳ ${String(err.message || err).slice(0, 180)}`)
  }

  // ── Permanently excluded ops stay excluded ──────────────────────────
  for (const [name, params] of EXCLUDED) {
    let err
    try { await sdk.hive.hiveSignOperations({ operations: [[name, params]] }) }
    catch (e) { err = e }
    assertThrows(`op "${name}" stays out of the clear-sign table`, err, 'Unsupported Hive operation')
  }

  // ── Dedicated path: /hive/sign-transfer ─────────────────────────────
  // Caller supplies the TaPoS header here (unlike sign-operations, which
  // fetches it from Pioneer). amount is integer milli-units: 1000 = 1.000.
  const tapos = { ref_block_num: 0x1234, ref_block_prefix: 0xdeadbeef, expiration: 1700003600 }
  let xferRes, xferErr
  try {
    xferRes = await sdk.hive.hiveSignTransfer({
      ...tapos, from: 'alice', to: 'bob', amount: 1000, asset_symbol: 'HIVE', memo: 'gm',
    })
  } catch (e) { xferErr = e }
  assert('sign-transfer signs HIVE with memo', !xferErr && !!sig(xferRes))
  if (xferErr) console.error(`     ↳ ${String(xferErr.message || xferErr).slice(0, 180)}`)

  let hbdRes, hbdErr
  try {
    hbdRes = await sdk.hive.hiveSignTransfer({
      ...tapos, from: 'alice', to: 'bob', amount: 2500, asset_symbol: 'HBD', memo: '',
    })
  } catch (e) { hbdErr = e }
  assert('sign-transfer signs HBD without memo', !hbdErr && !!sig(hbdRes))
  if (hbdErr) console.error(`     ↳ ${String(hbdErr.message || hbdErr).slice(0, 180)}`)

  // ── Dedicated path: /hive/sign-message (Keychain signBuffer / dApp login) ──
  let msgRes, msgErr
  try {
    msgRes = await sdk.hive.hiveSignMessage({ message: 'login to skatehive' })
  } catch (e) { msgErr = e }
  assert('sign-message signs UTF-8 text (posting role)', !msgErr && !!msgRes?.signature)
  if (msgErr) console.error(`     ↳ ${String(msgErr.message || msgErr).slice(0, 180)}`)
})
