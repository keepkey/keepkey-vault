/**
 * Browser posting key support (KeepKey Client): the KeepKey stays the vault
 * (owner + active); the client holds a posting key so long posts the firmware
 * cannot fit (2048-byte tx buffer) can still be published.
 *
 * Two device-backed services, both deliberately narrow:
 *
 *  1. CipherKeyValue for the client's wrapping key only. Fixed path, a key
 *     name in the 'keepkey-client:hive-posting:<account>' namespace, flags
 *     fixed by the vault (ask_on_encrypt=false: wrapping a fresh random key
 *     reveals nothing; ask_on_decrypt=true: unwrapping always needs the
 *     button), small fixed sizes. A paired app can never unwrap anything
 *     silently, nor reach the password bank's or volume key's derivations
 *     (different path/name; the flags are part of the derivation too).
 *
 *  2. HiveSignAccountUpdate to dedicate (or give back) the posting authority.
 *     That message rewrites ALL FOUR authorities with one key each, signed
 *     by the OWNER key — a mistake can lock an account forever. So it is
 *     refused unless owner, active and memo are exactly this KeepKey's keys
 *     both on chain and on the device, and the bytes the device signed are
 *     parsed back and compared before anything is broadcast.
 */
import bs58 from 'bs58'
import { ripemd160 } from '@noble/hashes/ripemd160'
import type { HiveAccountAuthorities, HiveAuthority } from '../shared/hive-onboarding'

const H = 0x80000000
/** SLIP-0011 symmetric key-value root (m/10016'), KeepKey-client branch. */
export const CLIENT_CIPHER_PATH = [H + 10016, H + 0x4b4b, H + 1]
/** Fixed for both directions (the device derives the key from them). */
export const CLIENT_CIPHER_FLAGS = Object.freeze({ askOnEncrypt: false, askOnDecrypt: true })
export const CLIENT_CIPHER_KEY = /^keepkey-client:hive-posting:[a-z][a-z0-9.-]{2,15}$/
/** The client wraps a 32-byte random key; padded payloads stay ≤ 64 bytes. */
export const CLIENT_CIPHER_MAX_BYTES = 64

export class PostingAuthorityError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, unknown>) {
    super(message)
  }
}

export type CipherRequest = { key: string; value: Uint8Array; iv: Uint8Array; decrypt: boolean }

/** Validate the restricted /system/cipher-key-value body. Ask flags are not
 *  accepted from the caller at all: the route always forces them on. */
export function parseClientCipherRequest(body: any): CipherRequest {
  if (!body || typeof body !== 'object') throw new PostingAuthorityError(400, 'Invalid body')
  const key = String(body.key ?? '')
  if (!CLIENT_CIPHER_KEY.test(key)) throw new PostingAuthorityError(403, 'Key name outside the keepkey-client:hive-posting namespace')
  for (const forbidden of ['address_n_list', 'addressNList', 'address_n', 'ask_on_encrypt', 'ask_on_decrypt']) {
    if (body[forbidden] !== undefined) throw new PostingAuthorityError(400, `${forbidden} is fixed by the vault and cannot be set`)
  }
  const hex = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !/^([0-9a-f]{2})+$/i.test(v)) throw new PostingAuthorityError(400, `${what} must be hex`)
    return Uint8Array.from(Buffer.from(v, 'hex'))
  }
  const value = hex(body.value, 'value')
  const iv = hex(body.iv, 'iv')
  if (iv.length !== 16) throw new PostingAuthorityError(400, 'iv must be 16 bytes')
  if (value.length === 0 || value.length % 16 !== 0 || value.length > CLIENT_CIPHER_MAX_BYTES) {
    throw new PostingAuthorityError(400, `value must be 16–${CLIENT_CIPHER_MAX_BYTES} bytes, a multiple of 16`)
  }
  return { key, value, iv, decrypt: body.decrypt === true }
}

export function stmToPub(stm: string): Uint8Array {
  if (typeof stm !== 'string' || !/^STM[1-9A-HJ-NP-Za-km-z]{48,52}$/.test(stm)) throw new PostingAuthorityError(400, 'Not a Hive public key')
  const raw = bs58.decode(stm.slice(3))
  if (raw.length !== 37) throw new PostingAuthorityError(400, 'Not a Hive public key')
  const pub = raw.slice(0, 33)
  const sum = ripemd160(pub).slice(0, 4)
  if (!sum.every((b, i) => b === raw[33 + i])) throw new PostingAuthorityError(400, 'Public key checksum does not match')
  return pub
}

export function pubToStm(pub: Uint8Array): string {
  const full = new Uint8Array(37)
  full.set(pub)
  full.set(ripemd160(pub).slice(0, 4), 33)
  return 'STM' + bs58.encode(full)
}

const isOnlyKey = (a: HiveAuthority, key: string) =>
  a.weight_threshold === 1 && a.account_auths.length === 0 && a.key_auths.length === 1 && a.key_auths[0][0] === key && a.key_auths[0][1] >= 1

export type DeviceRoleKeys = { owner: string; active: string; posting: string; memo: string }

/**
 * Firmware capability. Through v7.17.0-alpha-378cf30 HiveSignAccountUpdate
 * IGNORES new_owner/active/posting/memo_key: hive_prepare_account_keys derives
 * the four role keys on the device and hive_serialize_account_update always
 * installs those ("Use KeepKey keys for @%s?"). So the device can give posting
 * BACK to itself (revoke) but cannot authorize an external browser key
 * (dedicate) — that needs a firmware change. Flip only for a firmware that
 * serializes the requested posting key.
 */
export const FIRMWARE_ACCOUNT_UPDATE_ACCEPTS_EXTERNAL_POSTING = false
export const DEDICATE_UNSUPPORTED_MESSAGE =
  "This KeepKey firmware always installs its own keys when it updates a Hive account, so it can't authorize a browser posting key yet. It needs a firmware update."

/** Public-key view of an authority, for diagnostics (no secrets exist here). */
export const describeAuthority = (a?: HiveAuthority) =>
  a ? { weight_threshold: a.weight_threshold, account_auths: a.account_auths, key_auths: a.key_auths } : null
export type PostingChange = 'dedicate' | 'revoke'

export type PostingAuthorityPlan = {
  account: string
  change: PostingChange
  before: HiveAuthority
  after: HiveAuthority
  /** Apps (account_auths) on posting that the single-key authority drops. */
  droppedApps: string[]
}

/**
 * The locks. Refuses unless owner, active and memo on chain are EXACTLY this
 * KeepKey's keys (single key, threshold 1, no account auths), so the rewrite
 * can only change posting. Revoke must hand posting back to the KeepKey's own
 * posting key.
 */
export function planPostingAuthority(input: {
  chain: HiveAccountAuthorities | null
  device: DeviceRoleKeys
  postingKey: string
  change: PostingChange
  allowDropApps: boolean
  /** Defaults to the known firmware behaviour (see FIRMWARE_ACCOUNT_UPDATE_ACCEPTS_EXTERNAL_POSTING). */
  firmwareAcceptsExternalPosting?: boolean
}): PostingAuthorityPlan {
  const { chain, device, postingKey, change, allowDropApps } = input
  const capable = input.firmwareAcceptsExternalPosting ?? FIRMWARE_ACCOUNT_UPDATE_ACCEPTS_EXTERNAL_POSTING
  if (change === 'dedicate' && !capable) {
    // Refuse before the vault approval and the device button: the device would
    // sign its own posting key instead, and the byte check would then refuse it.
    throw new PostingAuthorityError(501, DEDICATE_UNSUPPORTED_MESSAGE, { firmwareSupportsDedicate: false })
  }
  if (!chain) throw new PostingAuthorityError(404, 'Hive account not found')
  stmToPub(postingKey)
  const mismatch: string[] = []
  if (!isOnlyKey(chain.owner, device.owner)) mismatch.push('owner')
  if (!isOnlyKey(chain.active, device.active)) mismatch.push('active')
  if (chain.memo_key !== device.memo) mismatch.push('memo')
  if (mismatch.length) {
    throw new PostingAuthorityError(
      409,
      `Refusing: the ${mismatch.join(', ')} key on chain is not exactly this KeepKey's. Signing would replace it and could lock @${chain.name}.`,
      { mismatch },
    )
  }
  if (change === 'revoke' && postingKey !== device.posting) {
    throw new PostingAuthorityError(400, "Revoke hands posting back to this KeepKey's posting key")
  }
  if (change === 'dedicate' && [device.owner, device.active, device.memo, device.posting].includes(postingKey)) {
    throw new PostingAuthorityError(400, 'The browser posting key must be a separate key')
  }
  const droppedApps = chain.posting.account_auths.map(([name]) => name)
  if (droppedApps.length && !allowDropApps) {
    throw new PostingAuthorityError(409, `Posting access for ${droppedApps.join(', ')} would be removed. Confirm to continue.`, { droppedApps })
  }
  return {
    account: chain.name,
    change,
    before: chain.posting,
    after: { weight_threshold: 1, account_auths: [], key_auths: [[postingKey, 1]] },
    droppedApps,
  }
}

// ── Parse back what the device signed (account_update, op 10) ─────────────

class Reader {
  o = 0
  constructor(private b: Uint8Array) {}
  u8() {
    if (this.o >= this.b.length) throw new PostingAuthorityError(502, 'Signed tx truncated')
    return this.b[this.o++]
  }
  u16() { return this.u8() | (this.u8() << 8) }
  u32() { return (this.u8() | (this.u8() << 8) | (this.u8() << 16)) + this.u8() * 0x1000000 }
  varint() {
    let n = 0, shift = 0, b
    do { b = this.u8(); n += (b & 0x7f) * 2 ** shift; shift += 7 } while (b & 0x80)
    return n
  }
  bytes(n: number) {
    if (this.o + n > this.b.length) throw new PostingAuthorityError(502, 'Signed tx truncated')
    const out = this.b.slice(this.o, this.o + n); this.o += n; return out
  }
  str() { return new TextDecoder().decode(this.bytes(this.varint())) }
  done() { return this.o === this.b.length }
}

function readAuthority(r: Reader): HiveAuthority {
  const weight_threshold = r.u32()
  const account_auths: [string, number][] = []
  for (let n = r.varint(); n > 0; n--) account_auths.push([r.str(), r.u16()])
  const key_auths: [string, number][] = []
  for (let n = r.varint(); n > 0; n--) key_auths.push([pubToStm(r.bytes(33)), r.u16()])
  return { weight_threshold, account_auths, key_auths }
}

export type SignedAccountUpdate = {
  refBlockNum: number
  refBlockPrefix: number
  expirationUnix: number
  op: { account: string; owner?: HiveAuthority; active?: HiveAuthority; posting?: HiveAuthority; memo_key: string; json_metadata: string }
}

export function parseSignedAccountUpdate(tx: Uint8Array): SignedAccountUpdate {
  const r = new Reader(tx)
  const refBlockNum = r.u16(), refBlockPrefix = r.u32(), expirationUnix = r.u32()
  if (r.varint() !== 1) throw new PostingAuthorityError(502, 'Signed tx must carry exactly one operation')
  if (r.varint() !== 10) throw new PostingAuthorityError(502, 'Signed operation is not account_update')
  const account = r.str()
  const opt = () => (r.u8() ? readAuthority(r) : undefined)
  const owner = opt(), active = opt(), posting = opt()
  const memo_key = pubToStm(r.bytes(33))
  const json_metadata = r.str()
  if (r.varint() !== 0) throw new PostingAuthorityError(502, 'Signed tx has extensions')
  if (!r.done()) throw new PostingAuthorityError(502, 'Signed tx has trailing bytes')
  return { refBlockNum, refBlockPrefix, expirationUnix, op: { account, owner, active, posting, memo_key, json_metadata } }
}

/** The device must have signed exactly the plan: owner/active/memo unchanged, posting = new key. */
export function assertSignedMatchesPlan(signed: SignedAccountUpdate, plan: PostingAuthorityPlan, device: DeviceRoleKeys): void {
  const { op } = signed
  const single = (a: HiveAuthority | undefined, key: string) => !!a && isOnlyKey(a, key)
  const bad: string[] = []
  if (op.account !== plan.account) bad.push('account')
  if (!single(op.owner, device.owner)) bad.push('owner')
  if (!single(op.active, device.active)) bad.push('active')
  if (!single(op.posting, plan.after.key_auths[0][0])) bad.push('posting')
  if (op.memo_key !== device.memo) bad.push('memo')
  if (bad.length) {
    // Public keys only: enough to see what the device signed instead.
    const diagnostics = {
      mismatch: bad,
      planned: {
        account: plan.account,
        owner: describeAuthority({ weight_threshold: 1, account_auths: [], key_auths: [[device.owner, 1]] }),
        active: describeAuthority({ weight_threshold: 1, account_auths: [], key_auths: [[device.active, 1]] }),
        posting: describeAuthority(plan.after),
        memo_key: device.memo,
      },
      signed: {
        account: op.account,
        owner: describeAuthority(op.owner),
        active: describeAuthority(op.active),
        posting: describeAuthority(op.posting),
        memo_key: op.memo_key,
        json_metadata: op.json_metadata,
      },
    }
    throw new PostingAuthorityError(502, `Device-signed account_update differs from the plan (${bad.join(', ')}) — not broadcast`, diagnostics)
  }
}

/** The JSON hived re-serializes to the exact signed bytes. */
export const signedAccountUpdateJson = (s: SignedAccountUpdate): ['account_update', Record<string, unknown>] => [
  'account_update',
  {
    account: s.op.account,
    ...(s.op.owner ? { owner: s.op.owner } : {}),
    ...(s.op.active ? { active: s.op.active } : {}),
    ...(s.op.posting ? { posting: s.op.posting } : {}),
    memo_key: s.op.memo_key,
    json_metadata: s.op.json_metadata,
  },
]

export const hiveTimeIso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, '')
