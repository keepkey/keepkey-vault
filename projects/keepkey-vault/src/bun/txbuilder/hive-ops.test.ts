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
      // beneficiaries MUST be sorted ascending by account (hived requirement)
      extensions: [[0, { beneficiaries: [{ account: 'bob', weight: 100 }, { account: 'skatehive', weight: 500 }] }]],
    }]
    const { serializedTx, tier } = sign(comment, options)
    expect(tier).toBe('posting')
    const commentBytes = Buffer.concat([
      Buffer.from([1]), vstr(''), vstr('hive'), vstr('alice'), vstr('post'), vstr('t'), vstr('b'), vstr('{}'),
    ])
    const wBob = Buffer.alloc(2); wBob.writeUInt16LE(100)
    const wSkate = Buffer.alloc(2); wSkate.writeUInt16LE(500)
    const pct = Buffer.alloc(2); pct.writeUInt16LE(10000)
    const optionsBytes = Buffer.concat([
      Buffer.from([19]), vstr('alice'), vstr('post'),
      vasset(1_000_000_000n, 3, 'HBD'), pct,
      Buffer.from([1, 1]),          // allow_votes, allow_curation_rewards
      Buffer.from([1]),             // 1 extension
      Buffer.from([0, 2]),          // tag 0, 2 beneficiaries (sorted: bob, skatehive)
      vstr('bob'), wBob, vstr('skatehive'), wSkate,
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

describe('TaPoS header validation (finding #5)', () => {
  const op: HiveOpTuple = ['vote', { voter: 'a', author: 'b', permlink: 'p', weight: 100 }]
  test('negative refBlockNum is rejected, not masked to 0xffff', () => {
    expect(() => serializeHiveOpsTx({ refBlockNum: -1, refBlockPrefix: 1, expirationUnix: 1, operations: [op] })).toThrow(/refBlockNum/)
  })
  test('refBlockNum above uint16 is rejected', () => {
    expect(() => serializeHiveOpsTx({ refBlockNum: 0x10000, refBlockPrefix: 1, expirationUnix: 1, operations: [op] })).toThrow(/refBlockNum/)
  })
  test('negative expirationUnix is rejected, not coerced to 0xffffffff', () => {
    expect(() => serializeHiveOpsTx({ refBlockNum: 1, refBlockPrefix: 1, expirationUnix: -1, operations: [op] })).toThrow(/expirationUnix/)
  })
  test('refBlockPrefix above uint32 is rejected', () => {
    expect(() => serializeHiveOpsTx({ refBlockNum: 1, refBlockPrefix: 0x100000000, expirationUnix: 1, operations: [op] })).toThrow(/refBlockPrefix/)
  })
})

describe('comment_options beneficiary rules (finding #6)', () => {
  const withExt = (extensions: any[]): HiveOpTuple[] => [
    ['comment', { parent_author: '', parent_permlink: 'hive', author: 'a', permlink: 'p', title: '', body: 'b', json_metadata: '{}' }],
    ['comment_options', { author: 'a', permlink: 'p', max_accepted_payout: '1000000.000 HBD', percent_hbd: 10000, allow_votes: true, allow_curation_rewards: true, extensions }],
  ]
  test('two beneficiary extensions are rejected (no 16-beneficiary / 200% smuggling)', () => {
    expect(() => sign(...withExt([
      [0, { beneficiaries: [{ account: 'x', weight: 5000 }] }],
      [0, { beneficiaries: [{ account: 'y', weight: 5000 }] }],
    ]))).toThrow(/at most one extension/)
  })
  test('unsorted beneficiaries are rejected', () => {
    expect(() => sign(...withExt([[0, { beneficiaries: [{ account: 'bob', weight: 100 }, { account: 'alice', weight: 100 }] }]])))
      .toThrow(/sorted ascending/)
  })
  test('duplicate beneficiary accounts are rejected', () => {
    expect(() => sign(...withExt([[0, { beneficiaries: [{ account: 'bob', weight: 100 }, { account: 'bob', weight: 100 }] }]])))
      .toThrow(/sorted ascending and unique/)
  })
  test('sorted unique beneficiaries within limits are accepted', () => {
    expect(() => sign(...withExt([[0, { beneficiaries: [{ account: 'alice', weight: 100 }, { account: 'bob', weight: 200 }] }]])))
      .not.toThrow()
  })
})

describe('limit_order_create expiration (Graphene time_point_sec)', () => {
  // hived's JSON form is a zone-less ISO string, and that is what real dApps
  // send. The whole phase-3 suite below uses unix ints, so this shape was never
  // exercised until a live hivehub.dev market order hit
  // "expiration out of uint32 range: NaN".
  const ISO = '2026-08-16T21:44:55'
  const UNIX = Math.floor(Date.UTC(2026, 7, 16, 21, 44, 55) / 1000)
  const base = {
    owner: 'bithighlander22', orderid: 1784583895,
    amount_to_sell: '1.000 HIVE', min_to_receive: '0.048 HBD',
    fill_or_kill: true,
  }
  const withExp = (expiration: any) => sign(['limit_order_create', { ...base, expiration }]).serializedTx

  test('the exact payload that failed in the field now serializes', () => {
    expect(() => withExp(ISO)).not.toThrow()
  })

  test('ISO and its unix equivalent produce identical bytes', () => {
    expect(withExp(ISO).equals(withExp(UNIX))).toBe(true)
  })

  test('a zone-less timestamp is UTC, not host-local', () => {
    // The bug this guards: JS parses the zone-less date-time form as LOCAL
    // time, so on a non-UTC host the signed expiration would silently drift by
    // the UTC offset. TZ is set for the whole run in the package script; assert
    // against an explicitly-UTC constant so a local-time regression fails here
    // regardless of where the test runs.
    // expiration is the op's last field; one trailing varint(0) (tx extensions)
    // follows it, so it sits at [-5, -1).
    const bytes = withExp(ISO)
    expect(bytes.subarray(bytes.length - 5, bytes.length - 1).readUInt32LE()).toBe(UNIX)
  })

  test('an explicit offset is honored, not double-shifted', () => {
    expect(withExp('2026-08-16T21:44:55Z').equals(withExp(UNIX))).toBe(true)
    // +02:00 means the same instant is two hours EARLIER in UTC.
    expect(withExp('2026-08-16T23:44:55+02:00').equals(withExp(UNIX))).toBe(true)
  })

  test('numeric strings are accepted as unix seconds', () => {
    expect(withExp(String(UNIX)).equals(withExp(UNIX))).toBe(true)
  })

  test('an unparseable expiration is rejected with a message that says what is wanted', () => {
    for (const bad of [undefined, null, '', 'tomorrow', {}, NaN]) {
      expect(() => withExp(bad), `accepted ${JSON.stringify(bad)}`)
        .toThrow(/expiration must be unix seconds or an ISO 8601 UTC timestamp|out of uint32 range/)
    }
  })

  test('a pre-1970 timestamp is rejected rather than wrapping to a huge uint32', () => {
    expect(() => withExp('1969-12-31T23:59:59')).toThrow(/out of uint32 range/)
  })

  // Date.parse is permissive in ways that CHANGE the value being signed. A
  // timestamp the user never wrote must be rejected, not normalised.
  test('impossible calendar dates are rejected, not rolled forward', () => {
    // Date.parse('2026-02-30T12:00:00') silently yields 2026-03-02.
    expect(() => withExp('2026-02-30T12:00:00')).toThrow(/not a real calendar date/)
    expect(() => withExp('2026-04-31T12:00:00')).toThrow(/not a real calendar date/)
    expect(() => withExp('2026-13-01T12:00:00')).toThrow(/month out of range/)
    expect(() => withExp('2026-00-10T12:00:00')).toThrow(/month out of range/)
    expect(() => withExp('2026-01-00T12:00:00')).toThrow(/not a real calendar date/)
  })

  test('leap years are judged correctly, not by a blanket Feb-29 rule', () => {
    expect(() => withExp('2028-02-29T12:00:00')).not.toThrow()   // divisible by 4
    expect(() => withExp('2000-02-29T12:00:00')).not.toThrow()   // 400-year exception
    expect(() => withExp('2026-02-29T12:00:00')).toThrow(/not a real calendar date/)
    expect(() => withExp('2100-02-29T12:00:00')).toThrow(/not a real calendar date/) // century, not leap
  })

  test('out-of-range times are rejected', () => {
    expect(() => withExp('2026-08-16T24:00:00')).toThrow(/time out of range/)
    expect(() => withExp('2026-08-16T21:60:00')).toThrow(/time out of range/)
    expect(() => withExp('2026-08-16T21:44:60')).toThrow(/time out of range/)
  })

  test('non-ISO date formats are rejected rather than guessed at', () => {
    // All of these are accepted by Date.parse despite the promised ISO form —
    // and 08/16/2026 vs 16/08/2026 is ambiguous between locales.
    for (const bad of [
      'August 16, 2026', '08/16/2026', '2026/08/16', '16-08-2026',
      'Sun Aug 16 2026', '2026-08-16T21:44:55 GMT+0200',
    ]) {
      expect(() => withExp(bad), `accepted ${JSON.stringify(bad)}`)
        .toThrow(/must be unix seconds or an ISO 8601 UTC timestamp/)
    }
  })

  test('a two-digit year is not silently mapped into the 1900s', () => {
    // Date.UTC(26, …) means 1926. The 4-digit grammar rejects the short form
    // outright rather than signing a century-old expiration.
    expect(() => withExp('26-08-16T21:44:55')).toThrow(/must be unix seconds or an ISO/)
  })

  test('seconds are optional and fractional seconds are tolerated', () => {
    // hived does not emit either, but neither changes the instant.
    expect(withExp('2026-08-16T21:44').equals(
      withExp(Math.floor(Date.UTC(2026, 7, 16, 21, 44, 0) / 1000)))).toBe(true)
    expect(withExp('2026-08-16T21:44:55.123').equals(withExp(UNIX))).toBe(true)
  })

  test('a non-integer number of seconds is rejected', () => {
    expect(() => withExp(1700003600.5)).toThrow(/whole number of seconds/)
  })
})

describe('phase-3: internal market (limit orders)', () => {
  // Same vector as the firmware unit test Hive.LimitOrderCreateRetainsEveryDisplayedField
  const CREATE = {
    owner: 'alice', orderid: 42,
    amount_to_sell: '1.500 HIVE', min_to_receive: '0.400 HBD',
    fill_or_kill: true, expiration: 1700003600,
  }
  const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }

  test('limit_order_create byte layout', () => {
    const { serializedTx, tier } = sign(['limit_order_create', CREATE])
    expect(tier).toBe('active')
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([5]), vstr('alice'), u32le(42),
      vasset(1500n, 3, 'HIVE'), vasset(400n, 3, 'HBD'),
      Buffer.from([1]), u32le(1700003600),
    ))).toBe(true)
  })

  test('limit_order_cancel byte layout', () => {
    const { serializedTx, tier } = sign(['limit_order_cancel', { owner: 'alice', orderid: 42 }])
    expect(tier).toBe('active')
    expect(serializedTx.equals(txBytes(1,
      Buffer.from([6]), vstr('alice'), u32le(42),
    ))).toBe(true)
  })

  test('fill_or_kill false serializes as 0', () => {
    const { serializedTx } = sign(['limit_order_create', { ...CREATE, fill_or_kill: false }])
    expect(serializedTx[serializedTx.length - 6]).toBe(0)
  })

  // Degenerate orders the firmware rejects — mirrored host-side for a clearer error
  test('same symbol on both sides is rejected', () => {
    expect(() => sign(['limit_order_create', { ...CREATE, min_to_receive: '0.400 HIVE' }]))
      .toThrow(/symbols must differ/)
  })
  test('zero amount_to_sell is rejected', () => {
    expect(() => sign(['limit_order_create', { ...CREATE, amount_to_sell: '0.000 HIVE' }]))
      .toThrow(/greater than zero/)
  })
  test('zero min_to_receive is rejected', () => {
    expect(() => sign(['limit_order_create', { ...CREATE, min_to_receive: '0.000 HBD' }]))
      .toThrow(/greater than zero/)
  })
  test('VESTS never trades on the internal market', () => {
    expect(() => sign(['limit_order_create', { ...CREATE, amount_to_sell: '1.500000 VESTS' }]))
      .toThrow(/must be HIVE or HBD/)
  })
  test('non-boolean fill_or_kill is rejected', () => {
    expect(() => sign(['limit_order_create', { ...CREATE, fill_or_kill: 1 }]))
      .toThrow(/must be a boolean/)
  })
  test('cannot share a tx with posting-tier ops', () => {
    expect(() => sign(
      ['limit_order_cancel', { owner: 'alice', orderid: 1 }],
      ['vote', { voter: 'alice', author: 'bob', permlink: 'p', weight: 10000 }],
    )).toThrow(/Cannot mix posting-tier and active-tier/)
  })
})
