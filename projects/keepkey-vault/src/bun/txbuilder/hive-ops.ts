/**
 * Graphene serializer for HiveSignOperations (fw msg 1616).
 *
 * Phase-1 ops: vote (0), comment (1), custom_json (18).
 * Phase-2 ops (handoff-hive-sign-operations-phase2.md): transfer_to_vesting
 * (3), withdraw_vesting (4), convert (8), comment_options (19),
 * transfer_to/from_savings (32/33), claim_reward_balance (39),
 * delegate_vesting_shares (40), account_update2 (43, metadata-only).
 * Phase-3 ops: limit_order_create (5), limit_order_cancel (6) — the internal
 * market, required for in-wallet HIVE/HBD swaps.
 *
 * Byte-exact mirror of hived's condenser serialization and the independent
 * python-keepkey test serializer (test_msg_hive.py _op_* helpers). The
 * firmware PARSES these bytes and re-displays every field before signing,
 * so a bug here yields a node rejection or firmware reject — never a silent
 * wrong-sign. Ops 2/9/10 (transfer, account create/update) are permanently
 * excluded (dedicated paths / device-derived-keys invariant); the same
 * invariant applies field-level inside account_update2 (authority fields
 * must be absent — only the profile-metadata form is allowed).
 */

const OP_VOTE = 0
const OP_COMMENT = 1
const OP_TRANSFER_TO_VESTING = 3
const OP_WITHDRAW_VESTING = 4
const OP_LIMIT_ORDER_CREATE = 5
const OP_LIMIT_ORDER_CANCEL = 6
const OP_CONVERT = 8
const OP_CUSTOM_JSON = 18
const OP_COMMENT_OPTIONS = 19
const OP_TRANSFER_TO_SAVINGS = 32
const OP_TRANSFER_FROM_SAVINGS = 33
const OP_CLAIM_REWARD_BALANCE = 39
const OP_DELEGATE_VESTING_SHARES = 40
const OP_ACCOUNT_UPDATE2 = 43

const MEMO_MAX_BYTES = 440 // same cap as the dedicated transfer path / firmware

function varint(n: number): Buffer {
  const out: number[] = []
  let v = n >>> 0
  for (;;) {
    const b = v & 0x7f
    v >>>= 7
    if (v) out.push(b | 0x80)
    else { out.push(b); return Buffer.from(out) }
  }
}

function str(s: string): Buffer {
  const b = Buffer.from(s ?? '', 'utf8')
  return Buffer.concat([varint(b.length), b])
}

function u16(n: number, what: string): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error(`${what} out of uint16 range: ${n}`)
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}

function u32(n: number, what: string): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`${what} out of uint32 range: ${n}`)
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function boolByte(v: any, what: string): Buffer {
  if (typeof v !== 'boolean') throw new Error(`${what} must be a boolean (got ${typeof v})`)
  return Buffer.from([v ? 1 : 0])
}

/**
 * Graphene `time_point_sec` → unix seconds.
 *
 * On the wire it is a uint32, but hived's JSON representation — and therefore
 * what every Hive library and dApp sends — is an ISO 8601 string with NO zone
 * suffix: "2026-08-16T21:44:55". Number() on that is NaN, which is what a real
 * hivehub.dev market order hit.
 *
 * The 'Z' is appended deliberately. Graphene timestamps are always UTC, but JS
 * parses the zone-less date-time form as LOCAL time (ES2015+), so on a host in
 * e.g. America/Denver a naive Date.parse would sign an expiration six hours off
 * the one the user was shown. Wrong-but-plausible is worse than rejected.
 *
 * Integers and numeric strings are accepted as unix seconds — the SDK tests and
 * some direct REST callers use that form.
 *
 * The grammar is matched explicitly rather than handed to Date.parse, which is
 * permissive in ways that silently change the value being signed:
 *   "2026-02-30T12:00:00" → Date.parse rolls it to 2026-03-02
 *   "August 16, 2026" / "08/16/2026" → accepted despite not being ISO at all
 * A timestamp the user never wrote must be rejected, not normalised.
 */
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/

function daysInMonth(year: number, month: number): number {
  // month is 1-12. Feb: Gregorian leap rule.
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

function timePointSec(v: any, what: string): number {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v
    // NaN/Infinity are "numbers" that say nothing about intent — they fall
    // through to the generic message below alongside null/undefined/{}.
    if (Number.isFinite(v)) throw new Error(`${what} must be a whole number of seconds (got ${v})`)
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^\d+$/.test(s)) return Number(s)

    const m = ISO_TIMESTAMP.exec(s)
    if (m) {
      const [, yy, mo, dd, hh, mi, ss, zone] = m
      const year = Number(yy), month = Number(mo), day = Number(dd)
      const hour = Number(hh), minute = Number(mi), second = Number(ss ?? '0')

      // Calendar-component validation. Without this, 2026-02-30 matches the
      // grammar and Date would roll it forward into March.
      if (month < 1 || month > 12) throw new Error(`${what}: month out of range in "${s}"`)
      if (day < 1 || day > daysInMonth(year, month)) {
        throw new Error(`${what}: "${s}" is not a real calendar date`)
      }
      if (hour > 23 || minute > 59 || second > 59) {
        throw new Error(`${what}: time out of range in "${s}"`)
      }

      // A caller that specified an offset means it and must not be shifted
      // again; a zone-less timestamp is UTC, because Graphene timestamps
      // always are. JS would parse the zone-less form as LOCAL time, so on a
      // host in e.g. America/Denver a naive parse signs an expiration six
      // hours off the one the user was shown.
      let offsetMinutes = 0
      if (zone && zone !== 'Z') {
        const sign = zone[0] === '-' ? -1 : 1
        const digits = zone.slice(1).replace(':', '')
        offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
      }

      // setUTCFullYear rather than Date.UTC: the latter maps years 0-99 into
      // 1900+year, so "0026-08-16T…" would silently become 1926.
      const dt = new Date(0)
      dt.setUTCFullYear(year, month - 1, day)
      dt.setUTCHours(hour, minute, second, 0)
      return Math.floor(dt.getTime() / 1000) - offsetMinutes * 60
    }
  }
  throw new Error(`${what} must be unix seconds or an ISO 8601 UTC timestamp (got ${JSON.stringify(v)})`)
}

// int64 LE amount + u8 precision + 7-byte NUL-padded symbol (append_asset
// layout). Precisions are fixed per symbol: HIVE/HBD = 3, VESTS = 6.
const ASSET_PRECISION: Record<string, number> = { HIVE: 3, HBD: 3, VESTS: 6 }

function asset(input: any, allowed: string[], what: string): Buffer {
  const m = /^(\d+)\.(\d+) ([A-Z]+)$/.exec(String(input ?? ''))
  if (!m) throw new Error(`${what}: malformed asset "${input}" — expected "0.000 SYMBOL"`)
  const [, whole, frac, symbol] = m
  if (!allowed.includes(symbol)) throw new Error(`${what} must be ${allowed.join(' or ')} (got ${symbol})`)
  const precision = ASSET_PRECISION[symbol]
  if (frac.length !== precision) {
    throw new Error(`${what}: ${symbol} requires exactly ${precision} decimals (got "${input}")`)
  }
  // BigInt: total VESTS supply in base units exceeds Number.MAX_SAFE_INTEGER
  const amount = BigInt(whole) * 10n ** BigInt(precision) + BigInt(frac)
  if (amount > 0x7fffffffffffffffn) throw new Error(`${what}: amount overflows int64`)
  const out = Buffer.alloc(16)
  out.writeBigInt64LE(amount)
  out.writeUInt8(precision, 8)
  out.write(symbol, 9, 'ascii')
  return out
}

function assetIsZero(b: Buffer): boolean {
  return b.readBigInt64LE(0) === 0n
}

function positiveAsset(input: any, allowed: string[], what: string): Buffer {
  const b = asset(input, allowed, what)
  if (assetIsZero(b)) throw new Error(`${what} must be greater than zero`)
  return b
}

function memoStr(input: any, what: string): Buffer {
  const s = typeof input === 'string' ? input : input == null ? '' : null
  if (s === null) throw new Error(`${what} must be a string`)
  if (Buffer.byteLength(s, 'utf8') > MEMO_MAX_BYTES) {
    throw new Error(`${what} exceeds ${MEMO_MAX_BYTES} bytes`)
  }
  return str(s)
}

function metadataStr(input: any): string {
  if (input == null) return ''
  return typeof input === 'string' ? input : JSON.stringify(input)
}

export type HiveOpTuple = [string, Record<string, any>]

function serializeOp([name, p]: HiveOpTuple): { bytes: Buffer; tier: 'posting' | 'active' } {
  switch (name) {
    case 'vote': {
      const weight = Number(p.weight)
      if (!Number.isInteger(weight) || weight < -10000 || weight > 10000) {
        throw new Error(`vote weight out of range: ${p.weight}`)
      }
      const w = Buffer.alloc(2)
      w.writeInt16LE(weight)
      return {
        bytes: Buffer.concat([varint(OP_VOTE), str(p.voter), str(p.author), str(p.permlink), w]),
        tier: 'posting',
      }
    }
    case 'comment':
      return {
        bytes: Buffer.concat([
          varint(OP_COMMENT),
          str(p.parent_author ?? ''), str(p.parent_permlink),
          str(p.author), str(p.permlink),
          str(p.title ?? ''), str(p.body),
          str(typeof p.json_metadata === 'string' ? p.json_metadata : JSON.stringify(p.json_metadata ?? '')),
        ]),
        tier: 'posting',
      }
    case 'custom_json': {
      const auths: string[] = p.required_auths ?? []
      const postingAuths: string[] = p.required_posting_auths ?? []
      const json = typeof p.json === 'string' ? p.json : JSON.stringify(p.json ?? {})
      return {
        bytes: Buffer.concat([
          varint(OP_CUSTOM_JSON),
          varint(auths.length), ...auths.map(str),
          varint(postingAuths.length), ...postingAuths.map(str),
          str(p.id), str(json),
        ]),
        tier: auths.length > 0 ? 'active' : 'posting',
      }
    }
    case 'transfer_to_vesting':
      return {
        bytes: Buffer.concat([
          varint(OP_TRANSFER_TO_VESTING),
          str(p.from), str(p.to),
          positiveAsset(p.amount, ['HIVE'], 'transfer_to_vesting amount'),
        ]),
        tier: 'active',
      }
    case 'withdraw_vesting':
      // 0.000000 VESTS is valid — it stops an active power-down
      return {
        bytes: Buffer.concat([
          varint(OP_WITHDRAW_VESTING),
          str(p.account),
          asset(p.vesting_shares, ['VESTS'], 'withdraw_vesting vesting_shares'),
        ]),
        tier: 'active',
      }
    case 'limit_order_create': {
      const sell = positiveAsset(p.amount_to_sell, ['HIVE', 'HBD'], 'limit_order_create amount_to_sell')
      const recv = positiveAsset(p.min_to_receive, ['HIVE', 'HBD'], 'limit_order_create min_to_receive')
      // A same-symbol order is a no-op trade on screen but still burns the
      // fill; firmware refuses it, reject here for a clearer message.
      if (sell.subarray(9, 16).equals(recv.subarray(9, 16))) {
        throw new Error('limit_order_create: amount_to_sell and min_to_receive symbols must differ')
      }
      // expiration is unbounded here: the device has no RTC and the only cost
      // of a stale/far-future value is an on-chain rejection, not a bad sign.
      return {
        bytes: Buffer.concat([
          varint(OP_LIMIT_ORDER_CREATE),
          str(p.owner),
          u32(Number(p.orderid), 'limit_order_create orderid'),
          sell, recv,
          boolByte(p.fill_or_kill, 'limit_order_create fill_or_kill'),
          u32(timePointSec(p.expiration, 'limit_order_create expiration'), 'limit_order_create expiration'),
        ]),
        tier: 'active',
      }
    }
    case 'limit_order_cancel':
      return {
        bytes: Buffer.concat([
          varint(OP_LIMIT_ORDER_CANCEL),
          str(p.owner),
          u32(Number(p.orderid), 'limit_order_cancel orderid'),
        ]),
        tier: 'active',
      }
    case 'convert':
      return {
        bytes: Buffer.concat([
          varint(OP_CONVERT),
          str(p.owner),
          u32(Number(p.requestid), 'convert requestid'),
          positiveAsset(p.amount, ['HBD'], 'convert amount'),
        ]),
        tier: 'active',
      }
    case 'comment_options': {
      // Validity relative to the preceding comment op is enforced in
      // serializeHiveOpsTx (needs cross-op context).
      const percentHbd = Number(p.percent_hbd ?? p.percent_steem_dollars)
      if (!Number.isInteger(percentHbd) || percentHbd < 0 || percentHbd > 10000) {
        throw new Error(`comment_options percent_hbd out of range: ${p.percent_hbd ?? p.percent_steem_dollars}`)
      }
      const extensions: any[] = p.extensions ?? []
      // Hive allows at most ONE comment_payout_beneficiaries extension per
      // comment_options; two extensions could smuggle 16 beneficiaries / 200%
      // weight past a per-extension check.
      if (extensions.length > 1) {
        throw new Error('comment_options: at most one extension (comment_payout_beneficiaries) is allowed')
      }
      const extBufs: Buffer[] = []
      for (const ext of extensions) {
        // condenser static_variant: [0, { beneficiaries: [...] }] — only
        // comment_payout_beneficiaries (tag 0) is accepted
        if (!Array.isArray(ext) || ext.length !== 2 || ext[0] !== 0) {
          throw new Error('comment_options: only comment_payout_beneficiaries extensions (tag 0) are supported')
        }
        const bens: any[] = ext[1]?.beneficiaries ?? []
        if (!bens.length || bens.length > 8) {
          throw new Error(`comment_options: 1–8 beneficiaries required (got ${bens.length})`)
        }
        let weightSum = 0
        let prevAccount = ''
        const benBufs = bens.map((b: any) => {
          const weight = Number(b?.weight)
          if (!b?.account || typeof b.account !== 'string') throw new Error('comment_options: beneficiary account missing')
          if (!Number.isInteger(weight) || weight < 0 || weight > 10000) {
            throw new Error(`comment_options: beneficiary weight out of range: ${b?.weight}`)
          }
          // hived requires beneficiaries strictly ascending by account name,
          // which also enforces uniqueness — an unsorted or duplicate list is
          // rejected on-chain, so reject it here rather than silently signing it.
          if (b.account <= prevAccount) {
            throw new Error(`comment_options: beneficiaries must be sorted ascending and unique (got "${b.account}" after "${prevAccount}")`)
          }
          prevAccount = b.account
          weightSum += weight
          return Buffer.concat([str(b.account), u16(weight, 'beneficiary weight')])
        })
        if (weightSum > 10000) throw new Error(`comment_options: beneficiary weights sum to ${weightSum} > 10000`)
        extBufs.push(Buffer.concat([varint(0), varint(bens.length), ...benBufs]))
      }
      return {
        bytes: Buffer.concat([
          varint(OP_COMMENT_OPTIONS),
          str(p.author), str(p.permlink),
          asset(p.max_accepted_payout, ['HBD'], 'comment_options max_accepted_payout'),
          u16(percentHbd, 'comment_options percent_hbd'),
          boolByte(p.allow_votes, 'comment_options allow_votes'),
          boolByte(p.allow_curation_rewards, 'comment_options allow_curation_rewards'),
          varint(extBufs.length), ...extBufs,
        ]),
        tier: 'posting',
      }
    }
    case 'transfer_to_savings':
      return {
        bytes: Buffer.concat([
          varint(OP_TRANSFER_TO_SAVINGS),
          str(p.from), str(p.to),
          positiveAsset(p.amount, ['HIVE', 'HBD'], 'transfer_to_savings amount'),
          memoStr(p.memo, 'transfer_to_savings memo'),
        ]),
        tier: 'active',
      }
    case 'transfer_from_savings':
      return {
        bytes: Buffer.concat([
          varint(OP_TRANSFER_FROM_SAVINGS),
          str(p.from),
          u32(Number(p.request_id), 'transfer_from_savings request_id'),
          str(p.to),
          positiveAsset(p.amount, ['HIVE', 'HBD'], 'transfer_from_savings amount'),
          memoStr(p.memo, 'transfer_from_savings memo'),
        ]),
        tier: 'active',
      }
    case 'claim_reward_balance': {
      const hive = asset(p.reward_hive, ['HIVE'], 'claim_reward_balance reward_hive')
      const hbd = asset(p.reward_hbd, ['HBD'], 'claim_reward_balance reward_hbd')
      const vests = asset(p.reward_vests, ['VESTS'], 'claim_reward_balance reward_vests')
      if (assetIsZero(hive) && assetIsZero(hbd) && assetIsZero(vests)) {
        throw new Error('claim_reward_balance: all rewards are zero — nothing to claim')
      }
      return {
        bytes: Buffer.concat([varint(OP_CLAIM_REWARD_BALANCE), str(p.account), hive, hbd, vests]),
        tier: 'posting',
      }
    }
    case 'delegate_vesting_shares':
      // 0.000000 VESTS is valid — it removes an existing delegation
      return {
        bytes: Buffer.concat([
          varint(OP_DELEGATE_VESTING_SHARES),
          str(p.delegator), str(p.delegatee),
          asset(p.vesting_shares, ['VESTS'], 'delegate_vesting_shares vesting_shares'),
        ]),
        tier: 'active',
      }
    case 'account_update2': {
      // SECURITY: this op can rotate account keys. Only the profile-metadata
      // form is allowed — any authority/memo-key field present is a hard
      // reject (the ops-9/10 exclusion invariant applied field-level; do NOT
      // soften without the J12 authority-management design review).
      for (const k of ['owner', 'active', 'posting', 'memo_key']) {
        if (p[k] != null) throw new Error('account_update2 with authority changes is not supported')
      }
      if (Array.isArray(p.extensions) && p.extensions.length > 0) {
        throw new Error('account_update2 extensions are not supported')
      }
      const jsonMetadata = metadataStr(p.json_metadata)
      const postingJsonMetadata = metadataStr(p.posting_json_metadata)
      if (!jsonMetadata && !postingJsonMetadata) {
        throw new Error('account_update2 requires json_metadata or posting_json_metadata')
      }
      return {
        bytes: Buffer.concat([
          varint(OP_ACCOUNT_UPDATE2),
          str(p.account),
          Buffer.from([0, 0, 0, 0]), // owner/active/posting/memo_key present-flags: absent
          str(jsonMetadata), str(postingJsonMetadata),
          varint(0), // extensions
        ]),
        // json_metadata changes need the active key; posting-metadata-only is a posting-tier profile update
        tier: jsonMetadata ? 'active' : 'posting',
      }
    }
    default:
      throw new Error(`Unsupported Hive operation "${name}" — not in the device clear-sign table`)
  }
}

export function serializeHiveOpsTx(params: {
  refBlockNum: number
  refBlockPrefix: number
  expirationUnix: number
  operations: HiveOpTuple[]
}): { serializedTx: Buffer; tier: 'posting' | 'active' } {
  if (!params.operations.length || params.operations.length > 4) {
    throw new Error('Hive ops tx must contain 1–4 operations')
  }
  // SECURITY: comment_options binds to its comment — silent beneficiary
  // redirection is the realistic attack. Only valid immediately after a
  // comment op with identical author+permlink.
  params.operations.forEach(([name, p], i) => {
    if (name !== 'comment_options') return
    const prev = params.operations[i - 1]
    if (!prev || prev[0] !== 'comment' || prev[1]?.author !== p.author || prev[1]?.permlink !== p.permlink) {
      throw new Error('comment_options must immediately follow a comment op with the same author and permlink')
    }
  })
  const ops = params.operations.map(serializeOp)
  const tiers = new Set(ops.map(o => o.tier))
  if (tiers.size > 1) {
    // One signature cannot satisfy posting- and active-tier ops post-HF28;
    // firmware rejects this too — fail fast with a clearer message.
    throw new Error('Cannot mix posting-tier and active-tier operations in one transaction')
  }
  // Validate the TaPoS header as bounded integers rather than silently masking
  // (& 0xffff) / coercing (>>> 0). A malformed or custom Pioneer sending -1 or
  // an out-of-range value would otherwise be signed as 0xffff/0xffffffff while
  // the caller's response echoes the original — reconstructing a DIFFERENT tx.
  const head = Buffer.concat([
    u16(params.refBlockNum, 'refBlockNum'),
    u32(params.refBlockPrefix, 'refBlockPrefix'),
    u32(params.expirationUnix, 'expirationUnix'),
  ])
  const serializedTx = Buffer.concat([
    head,
    varint(params.operations.length),
    ...ops.map(o => o.bytes),
    varint(0), // extensions
  ])
  if (serializedTx.length > 2048) throw new Error('Serialized Hive tx exceeds 2048 bytes')
  return { serializedTx, tier: tiers.values().next().value as 'posting' | 'active' }
}
