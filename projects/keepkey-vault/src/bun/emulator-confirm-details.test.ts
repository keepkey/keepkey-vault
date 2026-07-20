/**
 * The emulator confirm dialog must not MISREPRESENT a Hive operation.
 *
 * /hive/sign-operations hands the device a pre-serialized blob, so the dialog
 * has nothing to read amounts out of unless the caller passes the op array. It
 * previously showed "Hive Sign Operations / Chain: HIVE" and nothing else — the
 * user approved a claim, a market order and a power-down through an identical
 * prompt. These tests pin the two properties that matter: the op is named, and
 * no row is invented for an op that has no counterparty.
 */
import { describe, it, expect } from 'bun:test'
import { hiveConfirmDetails, hiveMessagePreview } from './emulator-confirm-details'

describe('hiveConfirmDetails', () => {
  it('names the operation instead of a bare chain header', () => {
    const d = hiveConfirmDetails('hiveSignOperations', [
      ['claim_reward_balance', {
        account: 'alice',
        reward_hive: '1.500 HIVE',
        reward_hbd: '0.000 HBD',
        reward_vests: '1000.000000 VESTS',
      }],
    ])
    expect(d.opLabel).toBe('Claim Rewards')
    expect(d.chain).toBe('Hive')
  })

  it('omits zero rewards so the real amount is not buried', () => {
    const d = hiveConfirmDetails('hiveSignOperations', [
      ['claim_reward_balance', {
        account: 'alice',
        reward_hive: '1.500 HIVE',
        reward_hbd: '0.000 HBD',
        reward_vests: '1000.000000 VESTS',
      }],
    ])
    expect(d.value).toContain('1.500 HIVE')
    expect(d.value).toContain('1000.000000 VESTS')
    expect(d.value).not.toContain('0.000 HBD')
  })

  it('does not forge a recipient for an op that has none', () => {
    // Claim/cancel/profile act on the signer's own account. A "To:" row here
    // would be a claim the operation does not make.
    for (const op of [
      ['claim_reward_balance', { account: 'alice', reward_hive: '1.500 HIVE' }],
      ['limit_order_cancel', { owner: 'alice', orderid: 1 }],
      ['account_update2', { account: 'alice', posting_json_metadata: '{}' }],
    ] as Array<[string, any]>) {
      const d = hiveConfirmDetails('hiveSignOperations', [op])
      expect(d.to, `${op[0]} invented a To row`).toBeUndefined()
    }
  })

  it('labels the counterparty by its real role', () => {
    const del = hiveConfirmDetails('hiveSignOperations', [
      ['delegate_vesting_shares', { delegator: 'alice', delegatee: 'bob', vesting_shares: '1000.000000 VESTS' }],
    ])
    expect(del.to).toBe('@bob')
    expect(del.toLabel).toBe('Delegatee')

    const vote = hiveConfirmDetails('hiveSignOperations', [
      ['vote', { voter: 'alice', author: 'bob', permlink: 'a-post', weight: 10000 }],
    ])
    expect(vote.toLabel).toBe('Post')
    expect(vote.to).toContain('@bob')
  })

  it('says "self" for a self power-up rather than showing an empty row', () => {
    const d = hiveConfirmDetails('hiveSignOperations', [
      ['transfer_to_vesting', { from: 'alice', to: '', amount: '1.500 HIVE' }],
    ])
    expect(d.to).toBe('self')
    expect(d.value).toBe('1.500 HIVE')
  })

  it('shows both sides of a market order', () => {
    const d = hiveConfirmDetails('hiveSignOperations', [
      ['limit_order_create', {
        owner: 'alice', orderid: 1,
        amount_to_sell: '1.500 HIVE', min_to_receive: '0.400 HBD',
        fill_or_kill: false, expiration: 1700003600,
      }],
    ])
    expect(d.opLabel).toBe('Market Order')
    expect(d.value).toBe('1.500 HIVE → 0.400 HBD')
  })

  it('never claims a single recipient for a batch', () => {
    const d = hiveConfirmDetails('hiveSignOperations', [
      ['comment', { author: 'alice', permlink: 'p', title: 'T', body: 'b', json_metadata: '{}' }],
      ['comment_options', { author: 'alice', permlink: 'p', percent_hbd: 10000 }],
    ])
    expect(d.opLabel).toBe('2 Hive operations')
    expect(d.to).toBeUndefined()
    expect(d.memo).toContain('Post / Comment')
    expect(d.memo).toContain('Payout Options')
  })

  it('asserts nothing when the op array is missing or unparseable', () => {
    // Better a bare dialog than a fabricated one — the OLED is still correct.
    for (const bad of [undefined, null, [], 'nonsense', [{ not: 'an op' }]]) {
      const d = hiveConfirmDetails('hiveSignOperations', bad)
      expect(d.chain).toBe('Hive')
      expect(d.opLabel).toBeUndefined()
      expect(d.to).toBeUndefined()
      expect(d.value).toBeUndefined()
    }
  })
})

describe('hiveMessagePreview', () => {
  it('shows the login message a dApp is asking to sign', () => {
    const msg = Buffer.from('{login: "bithighlander22"}', 'utf8')
    expect(hiveMessagePreview(msg)).toBe('{login: "bithighlander22"}')
  })

  it('collapses whitespace and truncates rather than flooding the dialog', () => {
    const long = Buffer.from('a'.repeat(200), 'utf8')
    const out = hiveMessagePreview(long)
    expect(out.length).toBeLessThanOrEqual(65)
    expect(out.endsWith('…')).toBe(true)
    expect(hiveMessagePreview(Buffer.from('a\n\n  b', 'utf8'))).toBe('a b')
  })

  it('reports binary payloads as bytes instead of mojibake', () => {
    // Keychain signs a serialized Buffer as raw bytes; those are not text.
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x01])
    expect(hiveMessagePreview(bin)).toBe('4 bytes (binary)')
  })
})
