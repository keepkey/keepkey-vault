/**
 * hive-ops serializer — byte-layout + security-rule tests.
 *
 * Expected byte vectors are hand-built here from the condenser layout
 * (varint = LEB128, string = varint len + UTF-8, asset = int64 LE + u8
 * precision + 7-byte NUL-padded symbol) so a serializer regression fails
 * against an independent construction, mirroring the pyk test pattern.
 */
import { describe, expect, test } from 'bun:test'
import { serializeHiveOpsTx, type HiveOpTuple } from './hive-ops'

const HEADER = { refBlockNum: 0x1234, refBlockPrefix: 0xdeadbeef, expirationUnix: 0x60000000 }

function vstr(s: string): Buffer {
  const b = Buffer.from(s, 'utf8')
  if (b.length > 127) throw new Error('test helper: string too long for 1-byte varint')
  return Buffer.concat([Buffer.from([b.length]), b])
}

function vasset(amount: bigint, precision: number, symbol: string): Buffer {
  const out = Buffer.alloc(16)
  out.writeBigInt64LE(amount)
  out.writeUInt8(precision, 8)
  out.write(symbol, 9, 'ascii')
  return out
}

function txBytes(opCount: number, ...body: Buffer[]): Buffer {
  const head = Buffer.alloc(10)
  head.writeUInt16LE(HEADER.refBlockNum & 0xffff, 0)
  head.writeUInt32LE(HEADER.refBlockPrefix, 2)
  head.writeUInt32LE(HEADER.expirationUnix, 6)
  return Buffer.concat([head, Buffer.from([opCount]), ...body, Buffer.from([0])])
}

function sign(...operations: HiveOpTuple[]) {
  return serializeHiveOpsTx({ ...HEADER, operations })
}

describe('phase-2 byte layouts', () => {
  test('transfer_to_vesting (power up)', () => {
    const { serializedTx, tier } = sign(['transfer_to_vesting', { from: 'alice', to: 'bob', amount: '5.000 HIVE' }])
    expect(tier).toBe('active')
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([3]), vstr('alice'), vstr('bob'), vasset(5000n, 3, 'HIVE'),
    ))).toBe(true)
  })

  test('withdraw_vesting — 0 VESTS (stop power down) is valid', () => {
    const { serializedTx } = sign(['withdraw_vesting', { account: 'alice', vesting_shares: '0.000000 VESTS' }])
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([4]), vstr('alice'), vasset(0n, 6, 'VESTS'),
    ))).toBe(true)
  })

  test('withdraw_vesting — VESTS amount above MAX_SAFE_INTEGER survives', () => {
    // 10_000_000_000.000000 VESTS = 1e16 base units > 2^53
    const { serializedTx } = sign(['withdraw_vesting', { account: 'alice', vesting_shares: '10000000000.000000 VESTS' }])
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([4]), vstr('alice'), vasset(10_000_000_000_000_000n, 6, 'VESTS'),
    ))).toBe(true)
  })

  test('convert', () => {
    const { serializedTx } = sign(['convert', { owner: 'alice', requestid: 77, amount: '2.500 HBD' }])
    const rid = Buffer.alloc(4)
    rid.writeUInt32LE(77)
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([8]), vstr('alice'), rid, vasset(2500n, 3, 'HBD'),
    ))).toBe(true)
  })

  test('comment + comment_options with beneficiaries', () => {
    const comment: HiveOpTuple = ['comment', {
      parent_author: '', parent_permlink: 'hive', author: 'alice', permlink: 'post',
      title: 't', body: 'b', json_metadata: '{}',
    }]
    const options: HiveOpTuple = ['comment_options', {
      author: 'alice', permlink: 'post',
      max_accepted_payout: '1000000.000 HBD', percent_hbd: 10000,
      allow_votes: true, allow_curation_rewards: true,
      extensions: [[0, { beneficiaries: [{ account: 'skatehive', weight: 500 }, { account: 'bob', weight: 100 }] }]],
    }]
    const { serializedTx, tier } = sign(comment, options)
    expect(tier).toBe('posting')
    const commentBytes = Buffer.concat([
      Buffer.from([1]), vstr(''), vstr('hive'), vstr('alice'), vstr('post'), vstr('t'), vstr('b'), vstr('{}'),
    ])
    const w1 = Buffer.alloc(2); w1.writeUInt16LE(500)
    const w2 = Buffer.alloc(2); w2.writeUInt16LE(100)
    const pct = Buffer.alloc(2); pct.writeUInt16LE(10000)
    const optionsBytes = Buffer.concat([
      Buffer.from([19]), vstr('alice'), vstr('post'),
      vasset(1_000_000_000n, 3, 'HBD'), pct,
      Buffer.from([1, 1]),          // allow_votes, allow_curation_rewards
      Buffer.from([1]),             // 1 extension
      Buffer.from([0, 2]),          // tag 0, 2 beneficiaries
      vstr('skatehive'), w1, vstr('bob'), w2,
    ])
    expect(serializedTx.equals(txBytes(2, commentBytes, optionsBytes))).toBe(true)
  })

  test('transfer_to_savings / transfer_from_savings', () => {
    const { serializedTx: dep } = sign(['transfer_to_savings', { from: 'alice', to: 'alice', amount: '1.000 HBD', memo: 'm' }])
    expect(dep.equals(txBytes(1,
      Buffer.from([32]), vstr('alice'), vstr('alice'), vasset(1000n, 3, 'HBD'), vstr('m'),
    ))).toBe(true)

    const rid = Buffer.alloc(4)
    rid.writeUInt32LE(9)
    const { serializedTx: wd } = sign(['transfer_from_savings', { from: 'alice', request_id: 9, to: 'bob', amount: '1.000 HIVE', memo: '' }])
    expect(wd.equals(txBytes(1,
      Buffer.from([33]), vstr('alice'), rid, vstr('bob'), vasset(1000n, 3, 'HIVE'), vstr(''),
    ))).toBe(true)
  })

  test('claim_reward_balance — three precisions', () => {
    const { serializedTx, tier } = sign(['claim_reward_balance', {
      account: 'alice', reward_hive: '0.001 HIVE', reward_hbd: '0.000 HBD', reward_vests: '1.234567 VESTS',
    }])
    expect(tier).toBe('posting')
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([39]), vstr('alice'),
      vasset(1n, 3, 'HIVE'), vasset(0n, 3, 'HBD'), vasset(1_234_567n, 6, 'VESTS'),
    ))).toBe(true)
  })

  test('delegate_vesting_shares — 0 VESTS (remove delegation) is valid', () => {
    const { serializedTx } = sign(['delegate_vesting_shares', { delegator: 'alice', delegatee: 'bob', vesting_shares: '0.000000 VESTS' }])
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([40]), vstr('alice'), vstr('bob'), vasset(0n, 6, 'VESTS'),
    ))).toBe(true)
  })

  test('account_update2 — metadata-only, four absent present-flags', () => {
    const posting = sign(['account_update2', { account: 'alice', json_metadata: '', posting_json_metadata: '{"profile":{}}' }])
    expect(posting.tier).toBe('posting')
    expect(posting.serializedTx.equals(txBytes(1,
      Buffer.from([43]), vstr('alice'), Buffer.from([0, 0, 0, 0]), vstr(''), vstr('{"profile":{}}'), Buffer.from([0]),
    ))).toBe(true)

    const active = sign(['account_update2', { account: 'alice', json_metadata: '{"x":1}', posting_json_metadata: '' }])
    expect(active.tier).toBe('active')
  })
})

describe('security rules', () => {
  test('account_update2 rejects every authority present-flag', () => {
    for (const field of ['owner', 'active', 'posting', 'memo_key']) {
      expect(() => sign(['account_update2', {
        account: 'alice', json_metadata: '{}', [field]: field === 'memo_key' ? 'STM...' : { weight_threshold: 1 },
      }])).toThrow(/authority changes/)
    }
  })

  test('account_update2 rejects both metadata fields empty', () => {
    expect(() => sign(['account_update2', { account: 'alice', json_metadata: '', posting_json_metadata: '' }]))
      .toThrow(/requires json_metadata/)
  })

  test('comment_options standalone is rejected', () => {
    expect(() => sign(['comment_options', {
      author: 'alice', permlink: 'post', max_accepted_payout: '1000000.000 HBD',
      percent_hbd: 10000, allow_votes: true, allow_curation_rewards: true, extensions: [],
    }])).toThrow(/immediately follow a comment/)
  })

  test('comment_options after comment with different permlink is rejected', () => {
    expect(() => sign(
      ['comment', { parent_author: '', parent_permlink: 'hive', author: 'alice', permlink: 'other', title: '', body: 'b', json_metadata: '{}' }],
      ['comment_options', {
        author: 'alice', permlink: 'post', max_accepted_payout: '1000000.000 HBD',
        percent_hbd: 10000, allow_votes: true, allow_curation_rewards: true, extensions: [],
      }],
    )).toThrow(/immediately follow a comment/)
  })

  const optionsWith = (extensions: any[]): HiveOpTuple[] => [
    ['comment', { parent_author: '', parent_permlink: 'hive', author: 'alice', permlink: 'post', title: '', body: 'b', json_metadata: '{}' }],
    ['comment_options', {
      author: 'alice', permlink: 'post', max_accepted_payout: '1000000.000 HBD',
      percent_hbd: 10000, allow_votes: true, allow_curation_rewards: true, extensions,
    }],
  ]

  test('comment_options rejects unknown extension tag', () => {
    expect(() => sign(...optionsWith([[1, {}]]))).toThrow(/tag 0/)
  })

  test('comment_options rejects beneficiary weight sum > 10000', () => {
    expect(() => sign(...optionsWith([[0, { beneficiaries: [
      { account: 'a', weight: 6000 }, { account: 'b', weight: 6000 },
    ] }]]))).toThrow(/sum to 12000/)
  })

  test('comment_options rejects more than 8 beneficiaries', () => {
    const bens = Array.from({ length: 9 }, (_, i) => ({ account: `acct${i}`, weight: 100 }))
    expect(() => sign(...optionsWith([[0, { beneficiaries: bens }]]))).toThrow(/1–8 beneficiaries/)
  })
})

describe('validation', () => {
  test('wrong VESTS precision is rejected', () => {
    expect(() => sign(['delegate_vesting_shares', { delegator: 'a', delegatee: 'b', vesting_shares: '1.000 VESTS' }]))
      .toThrow(/6 decimals/)
  })

  test('wrong symbol is rejected', () => {
    expect(() => sign(['transfer_to_vesting', { from: 'a', to: 'b', amount: '1.000 HBD' }]))
      .toThrow(/must be HIVE/)
  })

  test('zero power-up amount is rejected', () => {
    expect(() => sign(['transfer_to_vesting', { from: 'a', to: 'b', amount: '0.000 HIVE' }]))
      .toThrow(/greater than zero/)
  })

  test('all-zero claim_reward_balance is rejected', () => {
    expect(() => sign(['claim_reward_balance', {
      account: 'a', reward_hive: '0.000 HIVE', reward_hbd: '0.000 HBD', reward_vests: '0.000000 VESTS',
    }])).toThrow(/nothing to claim/)
  })

  test('non-boolean allow_votes is rejected', () => {
    expect(() => sign(
      ['comment', { parent_author: '', parent_permlink: 'hive', author: 'a', permlink: 'p', title: '', body: 'b', json_metadata: '{}' }],
      ['comment_options', {
        author: 'a', permlink: 'p', max_accepted_payout: '1000000.000 HBD',
        percent_hbd: 10000, allow_votes: 1, allow_curation_rewards: true, extensions: [],
      }],
    )).toThrow(/must be a boolean/)
  })

  test('savings memo over 440 bytes is rejected', () => {
    expect(() => sign(['transfer_to_savings', { from: 'a', to: 'a', amount: '1.000 HIVE', memo: 'x'.repeat(441) }]))
      .toThrow(/440 bytes/)
  })

  test('mixing posting- and active-tier ops is rejected', () => {
    expect(() => sign(
      ['vote', { voter: 'a', author: 'b', permlink: 'p', weight: 10000 }],
      ['transfer_to_vesting', { from: 'a', to: 'a', amount: '1.000 HIVE' }],
    )).toThrow(/Cannot mix/)
  })

  test('unknown op is rejected', () => {
    expect(() => sign(['set_withdraw_vesting_route', { from_account: 'a', to_account: 'b', percent: 100, auto_vest: false }]))
      .toThrow(/Unsupported Hive operation/)
  })
})
