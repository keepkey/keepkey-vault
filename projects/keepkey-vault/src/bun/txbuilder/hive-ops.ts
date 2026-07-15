/**
 * Graphene serializer for HiveSignOperations (fw msg 1616).
 *
 * Phase-1 ops: vote (0), comment (1), custom_json (18).
 * Phase-2 ops (handoff-hive-sign-operations-phase2.md): transfer_to_vesting
 * (3), withdraw_vesting (4), convert (8), comment_options (19),
 * transfer_to/from_savings (32/33), claim_reward_balance (39),
 * delegate_vesting_shares (40), account_update2 (43, metadata-only).
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
      const extBufs: Buffer[] = []
      for (const ext of extensions) {
        // condenser static_variant: [0, { beneficiaries: [...] }] — only
        // comment_payout_beneficiaries (tag 0) is accepted
        if (!Array.isArray(ext) || ext.length !== 2 || ext[0] !== 0) {
          throw new Error('comment_options: only comment_payout_beneficiaries extensions (tag 0) are supported')
        }
        const bens: any[] = ext[1]?.beneficiaries ?? []
        if (!bens.length || bens.length > 8) {
          throw new Error(`comment_options: 1–8 beneficiaries required per extension (got ${bens.length})`)
        }
        let weightSum = 0
        const benBufs = bens.map((b: any) => {
          const weight = Number(b?.weight)
          if (!b?.account || typeof b.account !== 'string') throw new Error('comment_options: beneficiary account missing')
          if (!Number.isInteger(weight) || weight < 0 || weight > 10000) {
            throw new Error(`comment_options: beneficiary weight out of range: ${b?.weight}`)
          }
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
  const head = Buffer.alloc(10)
  head.writeUInt16LE(params.refBlockNum & 0xffff, 0)
  head.writeUInt32LE(params.refBlockPrefix >>> 0, 2)
  head.writeUInt32LE(params.expirationUnix >>> 0, 6)
  const serializedTx = Buffer.concat([
    head,
    varint(params.operations.length),
    ...ops.map(o => o.bytes),
    varint(0), // extensions
  ])
  if (serializedTx.length > 2048) throw new Error('Serialized Hive tx exceeds 2048 bytes')
  return { serializedTx, tier: tiers.values().next().value as 'posting' | 'active' }
}
