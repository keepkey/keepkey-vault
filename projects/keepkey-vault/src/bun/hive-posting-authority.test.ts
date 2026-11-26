import { describe, expect, test } from 'bun:test'
import { secp256k1 } from '@noble/curves/secp256k1'
import {
  CLIENT_CIPHER_FLAGS, CLIENT_CIPHER_MAX_BYTES, PostingAuthorityError, assertSignedMatchesPlan, parseClientCipherRequest,
  parseSignedAccountUpdate, planPostingAuthority, pubToStm, signedAccountUpdateJson, stmToPub,
} from './hive-posting-authority'
import type { HiveAccountAuthorities, HiveAuthority } from '../shared/hive-onboarding'

const key = (n: number) => pubToStm(secp256k1.getPublicKey(new Uint8Array(32).fill(n), true))
const DEVICE = { owner: key(1), active: key(2), posting: key(3), memo: key(4) }
const CLIENT = key(9)
const single = (k: string): HiveAuthority => ({ weight_threshold: 1, account_auths: [], key_auths: [[k, 1]] })
const chain = (over: Partial<HiveAccountAuthorities> = {}): HiveAccountAuthorities => ({
  name: 'sopadevs', owner: single(DEVICE.owner), active: single(DEVICE.active), posting: single(DEVICE.posting),
  memo_key: DEVICE.memo, json_metadata: '', posting_json_metadata: '', pending_claimed_accounts: 0, balance: '1.000 HIVE', ...over,
})
const refused = (fn: () => unknown, status: number, text: RegExp) => {
  try { fn() } catch (e) {
    expect(e).toBeInstanceOf(PostingAuthorityError)
    expect((e as PostingAuthorityError).status).toBe(status)
    expect((e as Error).message).toMatch(text)
    return e as PostingAuthorityError
  }
  throw new Error('expected a refusal')
}

describe('restricted cipher-key-value', () => {
  const ok = { key: 'keepkey-client:hive-posting:sopadevs', value: '00'.repeat(32), iv: '11'.repeat(16) }
  test('accepts the client namespace, fixed sizes', () => {
    const r = parseClientCipherRequest({ ...ok, decrypt: true })
    expect(r.key).toBe(ok.key)
    expect(r.value.length).toBe(32)
    expect(r.decrypt).toBe(true)
  })
  test('refuses any other key name (password bank, volume key, free-form)', () => {
    for (const k of ['KeepKey Password Bank locate private bank', 'keepkey-client:hive-posting:', 'keepkey-client:other:x', 'x']) {
      refused(() => parseClientCipherRequest({ ...ok, key: k }), 403, /namespace/)
    }
  })
  test('flags are fixed: encrypting a fresh wrapping key needs no button, unwrapping always does', () => {
    expect(CLIENT_CIPHER_FLAGS).toEqual({ askOnEncrypt: false, askOnDecrypt: true })
    expect(Object.isFrozen(CLIENT_CIPHER_FLAGS)).toBe(true)
  })
  test('refuses caller-set paths or ask flags', () => {
    refused(() => parseClientCipherRequest({ ...ok, address_n_list: [1] }), 400, /fixed by the vault/)
    refused(() => parseClientCipherRequest({ ...ok, ask_on_decrypt: false }), 400, /fixed by the vault/)
  })
  test('refuses odd sizes and oversize payloads', () => {
    refused(() => parseClientCipherRequest({ ...ok, value: '00'.repeat(15) }), 400, /multiple of 16/)
    refused(() => parseClientCipherRequest({ ...ok, value: '00'.repeat(CLIENT_CIPHER_MAX_BYTES + 16) }), 400, /multiple of 16/)
    refused(() => parseClientCipherRequest({ ...ok, iv: '00'.repeat(8) }), 400, /16 bytes/)
  })
})

describe('HiveSignAccountUpdate locks', () => {
  test('dedicates posting when owner/active/memo are exactly this KeepKey', () => {
    const plan = planPostingAuthority({ chain: chain(), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true })
    expect(plan.after).toEqual(single(CLIENT))
    expect(plan.before).toEqual(single(DEVICE.posting))
    expect(plan.droppedApps).toEqual([])
  })
  test('refuses if owner, active or memo differ on chain — never lock the account', () => {
    refused(() => planPostingAuthority({ chain: chain({ owner: single(key(7)) }), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 409, /owner/)
    refused(() => planPostingAuthority({ chain: chain({ active: single(key(7)) }), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 409, /active/)
    refused(() => planPostingAuthority({ chain: chain({ memo_key: key(7) }), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 409, /memo/)
  })
  test('refuses a multisig or shared owner/active even if this KeepKey is among the keys', () => {
    const shared: HiveAuthority = { weight_threshold: 1, account_auths: [], key_auths: [[DEVICE.active, 1], [key(7), 1]] }
    refused(() => planPostingAuthority({ chain: chain({ active: shared }), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 409, /active/)
    const withApp: HiveAuthority = { weight_threshold: 1, account_auths: [['someapp', 1]], key_auths: [[DEVICE.owner, 1]] }
    refused(() => planPostingAuthority({ chain: chain({ owner: withApp }), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 409, /owner/)
  })
  test('posting apps are dropped only with explicit confirmation, and listed', () => {
    const posting: HiveAuthority = { weight_threshold: 1, account_auths: [['ecency.app', 1], ['peakd.app', 1]], key_auths: [[DEVICE.posting, 1]] }
    const e = refused(() => planPostingAuthority({ chain: chain({ posting }), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 409, /ecency\.app, peakd\.app/)
    expect(e.details?.droppedApps).toEqual(['ecency.app', 'peakd.app'])
    expect(planPostingAuthority({ chain: chain({ posting }), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: true, firmwareAcceptsExternalPosting: true }).droppedApps).toEqual(['ecency.app', 'peakd.app'])
  })
  test('revoke only hands posting back to the KeepKey posting key', () => {
    const plan = planPostingAuthority({ chain: chain({ posting: single(CLIENT) }), device: DEVICE, postingKey: DEVICE.posting, change: 'revoke', allowDropApps: false })
    expect(plan.after).toEqual(single(DEVICE.posting))
    refused(() => planPostingAuthority({ chain: chain(), device: DEVICE, postingKey: CLIENT, change: 'revoke', allowDropApps: false }), 400, /back to this KeepKey/)
  })
  test('refuses a missing account, a bad key, or reusing a KeepKey key as the browser key', () => {
    refused(() => planPostingAuthority({ chain: null, device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 404, /not found/)
    refused(() => planPostingAuthority({ chain: chain(), device: DEVICE, postingKey: 'STMbad', change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 400, /public key/)
    refused(() => planPostingAuthority({ chain: chain(), device: DEVICE, postingKey: DEVICE.active, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true }), 400, /separate key/)
  })
})

// Encoder for test fixtures only (the vault never builds op 10 itself — the device does).
const enc = {
  u16: (n: number) => [n & 0xff, n >> 8],
  u32: (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff],
  str: (s: string) => { const b = [...new TextEncoder().encode(s)]; return [b.length, ...b] },
  auth: (a: HiveAuthority) => [...enc.u32(a.weight_threshold), a.account_auths.length, ...a.account_auths.flatMap(([n, w]) => [...enc.str(n), ...enc.u16(w)]),
    a.key_auths.length, ...a.key_auths.flatMap(([k, w]) => [...stmToPub(k), ...enc.u16(w)])],
}
const accountUpdateTx = (o: { account: string; owner: HiveAuthority; active: HiveAuthority; posting: HiveAuthority; memo: string }, trailing: number[] = []) =>
  Uint8Array.from([...enc.u16(4660), ...enc.u32(0xdeadbeef), ...enc.u32(0x5fffab20), 1, 10, ...enc.str(o.account),
    1, ...enc.auth(o.owner), 1, ...enc.auth(o.active), 1, ...enc.auth(o.posting), ...stmToPub(o.memo), ...enc.str(''), 0, ...trailing])

describe('device-signed bytes are parsed back and compared before broadcast', () => {
  const plan = planPostingAuthority({ chain: chain(), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true })
  test('the exact plan passes and yields the broadcast JSON', () => {
    const tx = accountUpdateTx({ account: 'sopadevs', owner: single(DEVICE.owner), active: single(DEVICE.active), posting: single(CLIENT), memo: DEVICE.memo })
    const signed = parseSignedAccountUpdate(tx)
    expect(signed.refBlockNum).toBe(4660)
    expect(() => assertSignedMatchesPlan(signed, plan, DEVICE)).not.toThrow()
    expect(signedAccountUpdateJson(signed)).toEqual(['account_update', {
      account: 'sopadevs', owner: single(DEVICE.owner), active: single(DEVICE.active), posting: single(CLIENT), memo_key: DEVICE.memo, json_metadata: '',
    }])
  })
  test('a device that changed owner/active/memo or the posting key is not broadcast', () => {
    for (const bad of [
      { owner: single(key(7)), active: single(DEVICE.active), posting: single(CLIENT), memo: DEVICE.memo },
      { owner: single(DEVICE.owner), active: single(key(7)), posting: single(CLIENT), memo: DEVICE.memo },
      { owner: single(DEVICE.owner), active: single(DEVICE.active), posting: single(key(7)), memo: DEVICE.memo },
      { owner: single(DEVICE.owner), active: single(DEVICE.active), posting: single(CLIENT), memo: key(7) },
    ]) {
      const signed = parseSignedAccountUpdate(accountUpdateTx({ account: 'sopadevs', ...bad }))
      refused(() => assertSignedMatchesPlan(signed, plan, DEVICE), 502, /differs from the plan/)
    }
  })
  test('malformed signed bytes are refused', () => {
    const good = accountUpdateTx({ account: 'sopadevs', owner: single(DEVICE.owner), active: single(DEVICE.active), posting: single(CLIENT), memo: DEVICE.memo })
    refused(() => parseSignedAccountUpdate(good.slice(0, 40)), 502, /truncated/)
    refused(() => parseSignedAccountUpdate(Uint8Array.from([...good, 0])), 502, /trailing/)
  })
})

describe('firmware 378cf30: HiveSignAccountUpdate installs the device keys, ignoring new_*_key', () => {
  // Exactly what hive_serialize_account_update produces: the four DEVICE-derived
  // keys (owner/active/posting/memo), json_metadata "".
  const firmwareBytes = accountUpdateTx({ account: 'sopadevs', owner: single(DEVICE.owner), active: single(DEVICE.active), posting: single(DEVICE.posting), memo: DEVICE.memo })

  test('dedicate is refused up front (no vault approval, no button), with a clear firmware message', () => {
    const e = refused(() => planPostingAuthority({ chain: chain(), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false }), 501, /firmware/)
    expect(e.details).toEqual({ firmwareSupportsDedicate: false })
  })

  test('the real failure: a dedicate plan vs the firmware-signed bytes → refused, diagnostics show planned vs signed posting', () => {
    const plan = planPostingAuthority({ chain: chain(), device: DEVICE, postingKey: CLIENT, change: 'dedicate', allowDropApps: false, firmwareAcceptsExternalPosting: true })
    const e = refused(() => assertSignedMatchesPlan(parseSignedAccountUpdate(firmwareBytes), plan, DEVICE), 502, /differs from the plan \(posting\)/)
    expect(e.details?.mismatch).toEqual(['posting'])
    expect((e.details as any).planned.posting.key_auths).toEqual([[CLIENT, 1]])
    expect((e.details as any).signed.posting.key_auths).toEqual([[DEVICE.posting, 1]])
    expect((e.details as any).signed.json_metadata).toBe('')
    expect(JSON.stringify(e.details)).not.toMatch(/^5[1-9A-HJ-NP-Za-km-z]{50}$/) // public data only
  })

  test('revoke matches what the firmware signs (posting back to the KeepKey) and still passes the byte check', () => {
    const plan = planPostingAuthority({ chain: chain({ posting: single(CLIENT) }), device: DEVICE, postingKey: DEVICE.posting, change: 'revoke', allowDropApps: false })
    expect(() => assertSignedMatchesPlan(parseSignedAccountUpdate(firmwareBytes), plan, DEVICE)).not.toThrow()
  })
})
