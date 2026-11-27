/**
 * passkeys — status + reset for the KeepKey's built-in FIDO2 authenticator (firmware 7.16+).
 *
 * Passkeys are CTAP over the device's FIDO HID interface, not wallet protobuf, so this
 * speaks CTAPHID directly. It never touches the browser's ceremonies: sites talk to the
 * device themselves. Firmware 7.17 has no credential management, so the honest surface is
 * status and a full reset; listing/deleting one passkey needs firmware work.
 *
 * ponytail: hand-rolled CTAPHID framing + a ~40-line CBOR reader for GetInfo — pulling in
 * a CTAP library for two commands would be bigger than this file.
 */
import type { PasskeyStatus, PasskeyResetResult } from '../shared/types'
import { passkeyErrorMessage } from '../shared/passkey-errors'

export const KEEPKEY_VID = 0x2b24
const FIDO_USAGE_PAGE = 0xf1d0
const CID_BROADCAST = 0xffffffff
const CMD = { INIT: 0x86, CBOR: 0x90, ERROR: 0xbf, KEEPALIVE: 0xbb } as const
const CTAP2 = { GET_INFO: 0x04, CLIENT_PIN: 0x06, RESET: 0x07 } as const
const PACKET = 64

/** Minimal blocking-with-timeout HID handle: what node-hid's HID class offers. */
export interface HidLike {
  write(data: number[]): number
  readTimeout(ms: number): number[]
  close(): void
}

export type PasskeyErrorCode = 'no_device' | 'busy' | 'timeout' | 'denied' | 'protocol' | 'replug'
  | 'pin_invalid' | 'pin_blocked' | 'pin_auth_blocked' | 'pin_not_set' | 'pin_policy' | 'no_credential'
export class PasskeyError extends Error {
  constructor(readonly code: PasskeyErrorCode, message: string, readonly retries?: number) { super(message) }
}

// ── CBOR (just enough for GetInfo / ClientPIN responses) ──────────────────────────────
export function cborDecode(buf: Uint8Array): unknown {
  let o = 0
  const arg = (info: number): number => {
    if (info < 24) return info
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 0
    if (!n) throw new Error('unsupported cbor length')
    let v = 0; for (let i = 0; i < n; i++) v = v * 256 + buf[o++]
    return v
  }
  const item = (): unknown => {
    const b = buf[o++]; const major = b >> 5; const info = b & 31
    if (major === 7) { if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new Error('unsupported cbor simple') }
    const n = arg(info)
    if (major === 0) return n
    if (major === 1) return -1 - n
    if (major === 2) { const s = buf.slice(o, o + n); o += n; return s }
    if (major === 3) { const s = new TextDecoder().decode(buf.slice(o, o + n)); o += n; return s }
    if (major === 4) return Array.from({ length: n }, item)
    if (major === 5) { const m = new Map<unknown, unknown>(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()) } return m }
    throw new Error('unsupported cbor type')
  }
  return item()
}

// ── CTAPHID ───────────────────────────────────────────────────────────────────────────
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]

export function frames(cid: number, cmd: number, payload: number[]): number[][] {
  const out: number[][] = []
  const first = [...u32(cid), cmd, payload.length >> 8, payload.length & 255, ...payload.slice(0, 57)]
  out.push(first.concat(new Array(PACKET - first.length).fill(0)))
  for (let seq = 0, at = 57; at < payload.length; seq++, at += 59) {
    const p = [...u32(cid), seq, ...payload.slice(at, at + 59)]
    out.push(p.concat(new Array(PACKET - p.length).fill(0)))
  }
  return out
}

export class Channel {
  cid = CID_BROADCAST
  constructor(private hid: HidLike) {}
  /** node-hid wants a leading report id byte on write. */
  private send(cmd: number, payload: number[]) { for (const f of frames(this.cid, cmd, payload)) this.hid.write([0, ...f]) }
  /** Reads one whole message for this channel; keepalives are surfaced, other channels ignored. */
  private async recv(deadline: number, onKeepalive?: (status: number) => void): Promise<{ cmd: number; data: number[] }> {
    let cmd = -1; let want = 0; let data: number[] = []; let nextSeq = 0
    for (;;) {
      if (Date.now() > deadline) throw new PasskeyError('timeout', passkeyErrorMessage('noAnswer'))
      const p = this.hid.readTimeout(50)
      if (!p.length) { await new Promise(r => setTimeout(r, 0)); continue }
      const cid = ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]
      if (cid !== this.cid) continue
      if (p[4] & 0x80) {
        if (p[4] === CMD.KEEPALIVE) { onKeepalive?.(p[7]); continue }
        cmd = p[4]; want = (p[5] << 8) | p[6]; data = p.slice(7, 7 + want); nextSeq = 0
      } else if (cmd >= 0) {
        if (p[4] !== nextSeq++) throw new PasskeyError('protocol', passkeyErrorMessage('outOfOrder'))
        data = data.concat(p.slice(5, 5 + (want - data.length)))
      } else continue
      if (cmd >= 0 && data.length >= want) return { cmd, data }
    }
  }
  async call(cmd: number, payload: number[], timeoutMs: number, onKeepalive?: (status: number) => void) {
    this.send(cmd, payload)
    const r = await this.recv(Date.now() + timeoutMs, onKeepalive)
    if (r.cmd === CMD.ERROR) throw new PasskeyError(r.data[0] === 0x06 ? 'busy' : 'protocol', passkeyErrorMessage('ctaphid', { code: `0x${(r.data[0] ?? 0).toString(16)}` }))
    return r.data
  }
  /** One CBOR request: returns the CTAP status byte and the decoded-ready body. */
  async cbor(payload: number[], timeoutMs = 5000, onKeepalive?: (status: number) => void) {
    const data = await this.call(CMD.CBOR, payload, timeoutMs, onKeepalive)
    return { status: data[0] ?? 0xff, body: Uint8Array.from(data.slice(1)) }
  }
  async init() {
    const nonce = Array.from({ length: 8 }, () => Math.floor(Math.random() * 256))
    this.cid = CID_BROADCAST
    // Retry: a previous holder's late reply can arrive first; match on our nonce.
    this.send(CMD.INIT, nonce)
    const deadline = Date.now() + 3000
    for (;;) {
      const p = this.hid.readTimeout(100)
      if (Date.now() > deadline) throw new PasskeyError('timeout', passkeyErrorMessage('fidoNoAnswer'))
      if (p.length && (p[4] & 0xff) === CMD.INIT && nonce.every((b, i) => p[7 + i] === b)) {
        this.cid = ((p[15] << 24) >>> 0) + (p[16] << 16) + (p[17] << 8) + p[18]
        return { deviceVersion: `${p[20]}.${p[21]}.${p[22]}` }
      }
    }
  }
}

function ctapStatus(data: number[]): number { return data[0] ?? 0xff }

export async function readStatus(hid: HidLike): Promise<PasskeyStatus> {
  const ch = new Channel(hid)
  const { deviceVersion } = await ch.init()
  const info = await ch.call(CMD.CBOR, [CTAP2.GET_INFO], 5000)
  if (ctapStatus(info) !== 0) throw new PasskeyError('protocol', passkeyErrorMessage('getInfo', { code: `0x${ctapStatus(info).toString(16)}` }))
  const m = cborDecode(Uint8Array.from(info.slice(1))) as Map<number, any>
  const options = (m.get(4) as Map<string, boolean>) ?? new Map()
  const aaguid = m.get(3) instanceof Uint8Array ? Array.from(m.get(3) as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('') : ''
  let pinRetries: number | undefined
  // ClientPIN getRetries: {1: protocol 1, 2: subCommand 1}
  const pin = await ch.call(CMD.CBOR, [CTAP2.CLIENT_PIN, 0xa2, 0x01, 0x01, 0x02, 0x01], 5000)
  if (ctapStatus(pin) === 0) { const r = cborDecode(Uint8Array.from(pin.slice(1))) as Map<number, number>; pinRetries = r.get(3) }
  return {
    available: true,
    deviceVersion,
    ctapVersions: (m.get(1) as string[]) ?? [],
    aaguid,
    discoverable: options.get('rk') === true,
    credMgmt: options.get('credMgmt') === true,
    pinSet: options.get('clientPin') === true,
    pinRetries,
  }
}

export async function runReset(hid: HidLike, onWaiting?: () => void): Promise<PasskeyResetResult> {
  const ch = new Channel(hid)
  await ch.init()
  // The device shows "Reset Passkeys" and waits for the user to hold the button; keepalives arrive while it waits.
  const data = await ch.call(CMD.CBOR, [CTAP2.RESET], 40_000, st => { if (st === 2) onWaiting?.() })
  const s = ctapStatus(data)
  if (s === 0) return { reset: true }
  // CTAP allows reset only shortly after the authenticator powers up (RC4: 10 s).
  if (s === 0x30) throw new PasskeyError('replug', passkeyErrorMessage('resetNeedsReplug'))
  if (s === 0x27 || s === 0x2d) throw new PasskeyError('denied', passkeyErrorMessage('resetDeclined'))
  if (s === 0x2f) throw new PasskeyError('timeout', passkeyErrorMessage('resetNoPress'))
  throw new PasskeyError('protocol', passkeyErrorMessage('reset', { code: `0x${s.toString(16)}` }))
}

// ── node-hid binding (kept out of the pure functions above so they test without hardware) ──
// One HID conversation at a time: the tab's status load can fire twice at once, so queue, never reject.
let chain: Promise<unknown> = Promise.resolve()
export function withKeepKeyFido<T>(fn: (hid: HidLike) => Promise<T>): Promise<T> {
  const run = chain.then(() => openAndRun(fn), () => openAndRun(fn))
  chain = run.catch(() => {})
  return run
}
async function openAndRun<T>(fn: (hid: HidLike) => Promise<T>): Promise<T> {
  let hid: HidLike | undefined
  try {
    const lib = await hidLib()
    const fido = findFido(lib)
    if (!fido?.path) throw new PasskeyError('no_device', passkeyErrorMessage('noDevice'))
    hid = new lib.HID(fido.path) as HidLike
    return await fn(hid)
  } finally {
    try { hid?.close() } catch { /* already closed */ }
  }
}
async function hidLib(): Promise<any> {
  const HID = (await import('node-hid')) as any
  return HID.default ?? HID
}
function findFido(lib: any): { path?: string } | undefined {
  // ponytail: usagePage match works on macOS; Linux hidraw reports 0, so fall back to the
  // second KeepKey interface. Add an interface check if a Linux machine disagrees.
  const all = (lib.devices() as any[]).filter(d => d.vendorId === KEEPKEY_VID)
  return all.find(d => d.usagePage === FIDO_USAGE_PAGE) ?? (all.every(d => !d.usagePage) && all.length > 1 ? all[all.length - 1] : undefined)
}

/** Waits for the KeepKey's FIDO interface to disappear and come back (an unplug/replug), so the
 * caller can use CTAP's short post-power-up window. Polls; node-hid has no hotplug events. */
export async function waitForReplug(timeoutMs = 60_000, poll = 250): Promise<void> {
  const lib = await hidLib()
  const deadline = Date.now() + timeoutMs
  let gone = !findFido(lib)
  while (Date.now() < deadline) {
    const present = !!findFido(lib)
    if (!present) gone = true
    else if (gone) return
    await new Promise(r => setTimeout(r, poll))
  }
  throw new PasskeyError('timeout', passkeyErrorMessage('replugTimeout'))
}
