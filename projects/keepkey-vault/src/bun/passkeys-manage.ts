/**
 * passkeys-manage — list and delete individual KeepKey passkeys over CTAP credential management
 * (firmware 7.17 RC4+), and set the FIDO PIN that authorizes it.
 *
 * The PIN is the separate "security key PIN", never the wallet PIN. It is used for one call and
 * not stored. A PIN token is bound to one HID channel and expires in 30 s on the device, so each
 * action opens its own conversation (token -> work -> done).
 *
 * The device stores only the SHA-256 of each site's name. Names are resolved by Desktop
 * (see passkey-labels.ts); nothing here invents one.
 */
import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac } from 'node:crypto'
import { Channel, PasskeyError, cborDecode, type HidLike } from './passkeys'
import { passkeyErrorMessage, type PasskeyErrorKind } from '../shared/passkey-errors'

const CLIENT_PIN = 0x06
const CRED_MGMT = 0x0a
const PIN_PROTOCOL = 1
const PERMISSION_MANAGE = 0x04
const SUB = { METADATA: 1, RPS: 2, NEXT_RP: 3, CREDENTIALS: 4, NEXT_CREDENTIAL: 5, DELETE: 6 } as const

export interface PasskeySlot { rpHash: string; userName: string; userId: string; credentialId: string }
export interface PasskeyInventory { used: number; remaining: number; slots: PasskeySlot[] }

// ── CBOR writer (requests are tiny: uints, negative ints, bytes, text, maps) ──────────
export function cborEncode(v: unknown): number[] {
  const head = (major: number, n: number): number[] =>
    n < 24 ? [(major << 5) | n]
    : n < 256 ? [(major << 5) | 24, n]
    : n < 65536 ? [(major << 5) | 25, n >> 8, n & 255]
    : [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v]
  if (typeof v === 'string') { const b = new TextEncoder().encode(v); return [...head(3, b.length), ...b] }
  if (v instanceof Map) return [...head(5, v.size), ...[...v].flatMap(([k, x]) => [...cborEncode(k), ...cborEncode(x)])]
  throw new Error('unsupported cbor value')
}

// ── PIN protocol 1 ────────────────────────────────────────────────────────────────────
const aes = (encrypt: boolean, key: Uint8Array, data: Uint8Array): Uint8Array => {
  const iv = new Uint8Array(16)
  const c = encrypt ? createCipheriv('aes-256-cbc', key, iv) : createDecipheriv('aes-256-cbc', key, iv)
  c.setAutoPadding(false)
  return Uint8Array.from([...c.update(data), ...c.final()])
}
const hmac16 = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const h = createHmac('sha256', key); for (const p of parts) h.update(p)
  return new Uint8Array(h.digest().subarray(0, 16))
}

function fail(status: number, retries?: number): never {
  const by: Record<number, [ConstructorParameters<typeof PasskeyError>[0], PasskeyErrorKind]> = {
    0x27: ['denied', 'declined'],
    0x2d: ['denied', 'cancelled'],
    0x2e: ['no_credential', 'noCredential'],
    0x2f: ['timeout', 'noConfirmation'],
    0x30: ['protocol', 'refused'],
    0x31: ['pin_invalid', 'pinInvalid'],
    0x32: ['pin_blocked', 'pinBlocked'],
    0x34: ['pin_auth_blocked', 'pinAuthBlocked'],
    0x35: ['pin_not_set', 'pinNotSet'],
    0x37: ['pin_policy', 'pinTooShort'],
  }
  const known = by[status]
  if (known) throw new PasskeyError(known[0], passkeyErrorMessage(known[1]), retries)
  throw new PasskeyError('protocol', passkeyErrorMessage('status', { code: `0x${status.toString(16)}` }), retries)
}

async function retriesLeft(ch: Channel): Promise<number | undefined> {
  const r = await ch.cbor([CLIENT_PIN, ...cborEncode(new Map([[1, PIN_PROTOCOL], [2, 1]]))])
  return r.status === 0 ? (cborDecode(r.body) as Map<number, number>).get(3) : undefined
}

async function keyAgreement(ch: Channel) {
  const r = await ch.cbor([CLIENT_PIN, ...cborEncode(new Map([[1, PIN_PROTOCOL], [2, 2]]))])
  if (r.status !== 0) fail(r.status)
  const cose = (cborDecode(r.body) as Map<number, Map<number, Uint8Array>>).get(1)
  const x = cose?.get(-2), y = cose?.get(-3)
  if (!x || !y) throw new PasskeyError('protocol', passkeyErrorMessage('noKeyAgreement'))
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  const shared = ecdh.computeSecret(Uint8Array.from([4, ...x, ...y]))
  const pub = ecdh.getPublicKey()
  return {
    secret: new Uint8Array(createHash('sha256').update(new Uint8Array(shared)).digest()),
    cose: new Map<number, unknown>([[1, 2], [3, -25], [-1, 1], [-2, new Uint8Array(pub.subarray(1, 33))], [-3, new Uint8Array(pub.subarray(33, 65))]]),
  }
}

async function managementToken(ch: Channel, pin: string): Promise<Uint8Array> {
  const ka = await keyAgreement(ch)
  const pinHash = new Uint8Array(createHash('sha256').update(pin, 'utf8').digest().subarray(0, 16))
  const req = new Map<number, unknown>([[1, PIN_PROTOCOL], [2, 9], [3, ka.cose], [6, aes(true, ka.secret, pinHash)], [9, PERMISSION_MANAGE]])
  const r = await ch.cbor([CLIENT_PIN, ...cborEncode(req)])
  if (r.status !== 0) fail(r.status, r.status === 0x31 ? await retriesLeft(ch) : undefined)
  const enc = (cborDecode(r.body) as Map<number, Uint8Array>).get(2)
  if (!enc || enc.length !== 32) throw new PasskeyError('protocol', passkeyErrorMessage('badPinToken'))
  return aes(false, ka.secret, enc)
}

export async function setFidoPin(hid: HidLike, pin: string): Promise<void> {
  const bytes = new TextEncoder().encode(pin)
  if (bytes.length < 4 || bytes.length > 63) throw new PasskeyError('pin_policy', passkeyErrorMessage('pinLength'))
  const ch = new Channel(hid); await ch.init()
  const ka = await keyAgreement(ch)
  const padded = new Uint8Array(64); padded.set(bytes)
  const enc = aes(true, ka.secret, padded)
  const req = new Map<number, unknown>([[1, PIN_PROTOCOL], [2, 3], [3, ka.cose], [4, hmac16(ka.secret, enc)], [5, enc]])
  const r = await ch.cbor([CLIENT_PIN, ...cborEncode(req)])
  if (r.status !== 0) fail(r.status)
}

// ── credential management ────────────────────────────────────────────────────────────
async function credman(ch: Channel, token: Uint8Array, sub: number, params?: Map<number, unknown>, timeoutMs = 5000, onKeepalive?: (s: number) => void) {
  const req = new Map<number, unknown>([[1, sub]])
  if (sub !== SUB.NEXT_RP && sub !== SUB.NEXT_CREDENTIAL) {
    const encoded = params ? Uint8Array.from(cborEncode(params)) : new Uint8Array(0)
    if (params) req.set(2, params)
    req.set(3, PIN_PROTOCOL)
    req.set(4, hmac16(token, Uint8Array.from([sub]), encoded))
  }
  const r = await ch.cbor([CRED_MGMT, ...cborEncode(req)], timeoutMs, onKeepalive)
  if (r.status !== 0) fail(r.status)
  return r.body.length ? (cborDecode(r.body) as Map<number, any>) : new Map<number, any>()
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

export async function listPasskeys(hid: HidLike, pin: string): Promise<PasskeyInventory> {
  const ch = new Channel(hid); await ch.init()
  const token = await managementToken(ch, pin)
  const meta = await credman(ch, token, SUB.METADATA)
  const used = Number(meta.get(1) ?? 0), remaining = Number(meta.get(2) ?? 0)
  const slots: PasskeySlot[] = []
  if (used === 0) return { used, remaining, slots }
  const rps: Uint8Array[] = []
  let rp = await credman(ch, token, SUB.RPS)
  const rpTotal = Number(rp.get(5) ?? 1)
  for (let i = 0; ; i++) {
    rps.push(rp.get(4))
    if (i + 1 >= rpTotal) break
    rp = await credman(ch, token, SUB.NEXT_RP)
  }
  for (const rpHash of rps) {
    let c = await credman(ch, token, SUB.CREDENTIALS, new Map([[1, rpHash]]))
    const total = Number(c.get(9) ?? 1)
    for (let i = 0; ; i++) {
      const user = c.get(6) as Map<string, any>, id = (c.get(7) as Map<string, Uint8Array>).get('id')!
      slots.push({ rpHash: hex(rpHash), userName: String(user.get('name') ?? ''), userId: hex(user.get('id') ?? new Uint8Array()), credentialId: hex(id) })
      if (i + 1 >= total) break
      c = await credman(ch, token, SUB.NEXT_CREDENTIAL)
    }
  }
  return { used, remaining, slots }
}

/** Deletes one discoverable passkey. The KeepKey asks for a hold-to-confirm; this waits for it. */
export async function deletePasskey(hid: HidLike, pin: string, credentialIdHex: string, onWaiting?: () => void): Promise<void> {
  if (!/^[0-9a-f]{128}$/.test(credentialIdHex)) throw new PasskeyError('protocol', passkeyErrorMessage('invalidId'))
  const ch = new Channel(hid); await ch.init()
  const token = await managementToken(ch, pin)
  const descriptor = new Map<string, unknown>([['id', new Uint8Array(Buffer.from(credentialIdHex, 'hex'))], ['type', 'public-key']])
  await credman(ch, token, SUB.DELETE, new Map([[2, descriptor]]), 40_000, st => { if (st === 2) onWaiting?.() })
}
