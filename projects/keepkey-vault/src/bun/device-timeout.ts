/**
 * A KeepKey that stops answering, and the connection it leaves behind.
 *
 * hdwallet quarantines a transport whose read or write outlives its deadline
 * (5 s for a plain request): every later call on it throws the same
 * TransportTimeoutError at once, and the USB handle is closed. Nothing reopened
 * it, so the device stayed "ready" with a dead transport. Wallet watch and the
 * seed fingerprint kept asking it, failing instantly (156 times in 15 minutes,
 * vault-backend.log 2026-11-18 18:06 and 18:32), and only a replug helped.
 *
 * Reopening is not enough by itself. The device may still answer the request
 * that timed out, and that late reply waits in the USB IN pipe. The next
 * connection's Initialize would read it as its Features, and every reply after
 * it would answer the request before: an address request would get the answer
 * to an earlier one. So before pairing again, a Ping carrying a random nonce
 * is sent and everything is read and discarded up to its echo.
 */
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { isTransportTimeout } from './pin-unlock'

const T = Messages.MessageType
const MESSAGE_NAMES = new Map<number, string>(
  Object.entries(T).map(([name, value]) => [value as number, name.replace(/^MESSAGETYPE_/, '')]),
)
export const messageName = (type: number) => MESSAGE_NAMES.get(type) ?? String(type)

export interface TransportTimeoutInfo {
  /** hdwallet's own words: which phase timed out, after how long. */
  message: string
  /** The last message written to the device before it went quiet. */
  request: string | null
}

/**
 * Report the first timeout on this transport, once. The calls queued behind it fail
 * with the same quarantine error, so later ones carry no news. Install it before the
 * other write wrappers (device-gate.ts), so a write they refuse is never recorded as sent.
 */
export function watchTransportTimeouts(transport: any, onTimeout: (info: TransportTimeoutInfo) => void): void {
  if (!transport || transport.timeoutWatched) return
  transport.timeoutWatched = true
  let request: string | null = null
  let reported = false
  const report = (error: unknown) => {
    if (reported || !isTransportTimeout(error)) return
    reported = true
    try { onTimeout({ message: (error as Error).message, request }) } catch (e) {
      console.warn('[device-timeout] Timeout handler failed:', e instanceof Error ? e.message : e)
    }
  }
  const write = transport.write.bind(transport)
  transport.write = (buf: Uint8Array, debugLink: boolean) => {
    // hdwallet's message buffer: '##', then the big-endian message type.
    if (!debugLink) request = messageName((buf[2] << 8) | buf[3])
    return write(buf, debugLink)
  }
  for (const method of ['call', 'lockDuring'] as const) {
    const original = transport[method].bind(transport)
    transport[method] = (...args: unknown[]) => {
      let result: unknown
      try { result = original(...args) } catch (error) { report(error); throw error }
      return Promise.resolve(result).catch((error: unknown) => { report(error); throw error })
    }
  }
}

/** How many times the Vault reopens a timed-out KeepKey on its own before it asks for a replug. */
export function createReconnectBudget({ max = 3, windowMs = 10 * 60_000, now = Date.now }: {
  max?: number; windowMs?: number; now?: () => number
} = {}) {
  let attempts: number[] = []
  return {
    /** Spend one automatic reconnect. False: the device keeps timing out; stop retrying. */
    take(): boolean {
      const at = now()
      attempts = attempts.filter(t => at - t < windowMs)
      if (attempts.length >= max) return false
      attempts.push(at)
      return true
    },
    reset() { attempts = [] },
  }
}

export interface RawDelegate {
  writeChunk(buf: Uint8Array, debugLink?: boolean): Promise<void>
  readChunk(debugLink?: boolean): Promise<Uint8Array>
  disconnect(): Promise<void>
}

const PROMPTS = new Set<number>([
  T.MESSAGETYPE_BUTTONREQUEST, T.MESSAGETYPE_PINMATRIXREQUEST, T.MESSAGETYPE_PASSPHRASEREQUEST,
  T.MESSAGETYPE_CHARACTERREQUEST, T.MESSAGETYPE_WORDREQUEST,
])

function frames(type: number, body: Uint8Array): Uint8Array[] {
  const message = new Uint8Array(8 + body.length)
  const view = new DataView(message.buffer)
  view.setUint8(0, 0x23); view.setUint8(1, 0x23)
  view.setUint16(2, type); view.setUint32(4, body.length)
  message.set(body, 8)
  const out: Uint8Array[] = []
  for (let i = 0; i < message.length; i += 63) {
    const report = new Uint8Array(64)
    report[0] = 0x3f
    report.set(message.slice(i, i + 63), 1)
    out.push(report)
  }
  return out
}

async function send(delegate: RawDelegate, type: number, body = new Uint8Array()) {
  for (const report of frames(type, body)) await delegate.writeChunk(report, false)
}

async function receive(delegate: RawDelegate): Promise<{ type: number; body: Uint8Array }> {
  const first = await delegate.readChunk(false)
  if (first.length < 9 || first[0] !== 0x3f || first[1] !== 0x23 || first[2] !== 0x23) throw new Error('KeepKey sent an invalid report')
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength)
  const type = view.getUint16(3), length = view.getUint32(5)
  if (length > 64 * 1024) throw new Error('KeepKey sent an oversized reply')
  const body = new Uint8Array(length)
  body.set(first.subarray(9, 9 + Math.min(length, first.length - 9)))
  for (let offset = first.length - 9; offset < length;) {
    const next = (await delegate.readChunk(false)).subarray(1)
    body.set(next.subarray(0, Math.min(next.length, length - offset)), offset)
    offset += next.length
  }
  return { type, body }
}

function nonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Bring a freshly opened connection back in step with the device: Ping with a nonce,
 * discard every reply until its echo. A device found in a prompt (a late ButtonRequest)
 * is cancelled first and pinged again. Resolves with the number of replies discarded.
 * A device that stays silent past `timeoutMs` is disconnected (ending the pending read)
 * and the promise rejects: the caller must not pair over it.
 */
export async function resyncKeepKey(delegate: RawDelegate, { timeoutMs = 5_000, maxReplies = 8 } = {}): Promise<number> {
  let expected = nonce()
  const ping = (message: string) => {
    const m = new Messages.Ping(); m.setMessage(message)
    return send(delegate, T.MESSAGETYPE_PING, m.serializeBinary())
  }
  const bounded = async <V>(action: Promise<V>): Promise<V> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([action, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`KeepKey did not answer within ${timeoutMs}ms while reconnecting`)), timeoutMs)
      })])
    } catch (error) {
      action.catch(() => undefined)
      try { await delegate.disconnect() } catch { /* the read is abandoned either way */ }
      throw error
    } finally { clearTimeout(timer) }
  }
  await bounded(ping(expected))
  for (let discarded = 0; discarded < maxReplies; discarded++) {
    const reply = await bounded(receive(delegate))
    if (reply.type === T.MESSAGETYPE_SUCCESS && Messages.Success.deserializeBinary(reply.body).getMessage() === expected) return discarded
    if (PROMPTS.has(reply.type)) {
      // A prompt for a request nobody waits on any more: close it, then ask again.
      expected = nonce()
      await bounded(send(delegate, T.MESSAGETYPE_CANCEL))
      await bounded(ping(expected))
    }
  }
  try { await delegate.disconnect() } catch { /* nothing more goes through this handle */ }
  throw new Error(`KeepKey sent more than ${maxReplies} unexpected replies while reconnecting`)
}
