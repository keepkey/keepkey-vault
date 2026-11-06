/**
 * Which REST requests may reach the KeepKey right now.
 *
 * Checked when a message is written (the engine wraps the transport's write),
 * not when the handler starts: a request admitted earlier can reach the device
 * after a wipe or a lock began. Hardware test 2026-10-24: an auto-scan request
 * admitted before a wipe hit the wipe confirmation ("Unknown message", then
 * "Unexpected message"); another, sent during the PIN-failure countdown, timed
 * out after 5 s and closed the connection for everyone.
 *
 * During a wipe nothing but the wipe's own messages goes, whoever sends it.
 * Otherwise only REST requests are gated: rest-api.ts runs each one inside
 * `restRequest`; Desktop's own unlock prompt and setup flows are not REST.
 * Replies to the device's own prompts pass, so a request already running (a
 * sign waiting on its button) is never cut off.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import { WIPE_BUSY_MESSAGE, WIPE_REPLUG_PENDING_MESSAGE } from './device-wipe'
import { HttpError } from './auth'

/** `whileLocked`: set by requireWallet for routes that never ask for the PIN.
 *  `admitted`: this device request's first message already passed the lock check. */
export interface RestRequest { whileLocked: boolean; admitted?: boolean }
export const restRequest = new AsyncLocalStorage<RestRequest>()

export const DEVICE_LOCKED_MESSAGE = 'KeepKey is locked: enter the PIN in KeepKey Desktop, then try again'

const T = Messages.MessageType
const REPLIES = new Set<number>([
  T.MESSAGETYPE_BUTTONACK, T.MESSAGETYPE_PINMATRIXACK, T.MESSAGETYPE_PASSPHRASEACK,
  T.MESSAGETYPE_CHARACTERACK, T.MESSAGETYPE_WORDACK, T.MESSAGETYPE_ENTROPYACK, T.MESSAGETYPE_CANCEL,
])

/** All a wipe sends: Cancel for the PIN prompt, WipeDevice, the ButtonAck for its confirmation. */
const WIPE_OWN = new Set<number>([T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_WIPEDEVICE, T.MESSAGETYPE_BUTTONACK])

export interface GateState {
  wipeInProgress: boolean
  wipeOnReconnect: boolean
  /** Waiting for its PIN, or connected but not read yet: only Desktop's prompt may ask for the PIN. */
  locked: boolean
  /** Desktop holds the device for one flow (why, shown to REST callers); every new REST request is refused. */
  exclusive?: string | null
}

export function restWriteRefusal(state: GateState, messageType: number, rest: RestRequest | undefined) {
  // A wipe owns the device outright, against Desktop's own calls too. hdwallet's cancel()
  // releases every request queued behind the PIN prompt, and one asking for the PIN
  // restarted the countdown under the wipe (hardware test 2026-10-24: "the wipe
  // triggered an additional lock, and after that cooldown still failed to wipe").
  if (state.wipeInProgress) return WIPE_OWN.has(messageType) ? null : { status: 409, message: WIPE_BUSY_MESSAGE }
  if (!rest || REPLIES.has(messageType)) return null
  if (state.exclusive) return { status: 409, message: `KeepKey is busy: ${state.exclusive}. Try again when it finishes.` }
  if (state.wipeOnReconnect) return { status: 409, message: WIPE_REPLUG_PENDING_MESSAGE }
  // Only a request's first message: once it runs, the device may lock mid-flow (its own
  // PIN prompt), and the TxAcks, data chunks and struct acks that follow must still go.
  if (state.locked && !rest.whileLocked && !rest.admitted) return { status: 423, message: DEVICE_LOCKED_MESSAGE }
  return null
}

/** What a KeepKey waiting for its PIN or passphrase reads (firmware pin_sm.c, msg_read_tiny).
 *  Anything else gets Failure "Unknown message", and 7.17 firmware then ends the wait:
 *  the request that was waiting on the PIN fails, and the PIN the user is typing is lost. */
const INPUT_WAIT_REPLIES = new Set<number>([
  T.MESSAGETYPE_PINMATRIXACK, T.MESSAGETYPE_PASSPHRASEACK, T.MESSAGETYPE_CANCEL, T.MESSAGETYPE_INITIALIZE,
])
const INPUT_WAIT_DEBUG = new Set<number>([T.MESSAGETYPE_DEBUGLINKGETSTATE])

export const DEVICE_AWAITING_INPUT_MESSAGE = 'KeepKey is waiting for its PIN or passphrase: enter it in KeepKey Desktop, then try again'

export type AwaitingInput = 'pin' | 'passphrase' | null

/** The device's last message asked for a PIN or passphrase and nothing has answered it yet. */
export function awaitingInput(transport: any): AwaitingInput {
  return transport?.awaitingInput ?? null
}

/**
 * While the device waits for its PIN or passphrase, only the answer (or Cancel/Initialize)
 * goes to it, whoever sends. Requests queued behind the PIN normally wait on hdwallet's
 * call lock, but a read that ends without the device's answer (a delegate timeout,
 * hdwallet's cancel() dropping the call queue) lets the next one out into the wait.
 * Refused here, it fails on its own and the user's PIN still lands.
 * Wraps hdwallet's private per-message read and write, like gateRestWrites.
 */
export function guardInputWait(transport: any) {
  if (transport.inputWaitGuarded) return
  transport.inputWaitGuarded = true
  transport.awaitingInput = null
  const read = transport.read.bind(transport)
  transport.read = async (debugLink: boolean) => {
    const buf: Uint8Array = await read(debugLink)
    // Report id '?', '##', then the big-endian message type.
    if (!debugLink) {
      const type = (buf[3] << 8) | buf[4]
      transport.awaitingInput = type === T.MESSAGETYPE_PINMATRIXREQUEST ? 'pin'
        : type === T.MESSAGETYPE_PASSPHRASEREQUEST ? 'passphrase' : null
    }
    return buf
  }
  const write = transport.write.bind(transport)
  transport.write = async (buf: Uint8Array, debugLink: boolean) => {
    const type = (buf[2] << 8) | buf[3]
    if (transport.awaitingInput && !(debugLink ? INPUT_WAIT_DEBUG : INPUT_WAIT_REPLIES).has(type)) {
      throw new HttpError(423, DEVICE_AWAITING_INPUT_MESSAGE)
    }
    await write(buf, debugLink)
    if (!debugLink && INPUT_WAIT_REPLIES.has(type)) transport.awaitingInput = null
  }
}

/**
 * Wrap hdwallet's per-message write (private, one call per message) once per transport.
 * One device request = a `call` without omitLock, or a `lockDuring` block (multi-message
 * flows send every message, the first included, with omitLock inside one): each gets its
 * own store, so its first write is checked and the rest of its flow is not.
 */
export function gateRestWrites(transport: any, state: () => GateState) {
  if (transport.restGated) return
  transport.restGated = true
  const ownRequest = <T>(run: () => T): T => {
    const rest = restRequest.getStore()
    return rest ? restRequest.run({ whileLocked: rest.whileLocked }, run) : run()
  }
  const call = transport.call.bind(transport)
  transport.call = (type: number, msg: unknown, options?: { omitLock?: boolean }) =>
    options?.omitLock ? call(type, msg, options) : ownRequest(() => call(type, msg, options))
  const lockDuring = transport.lockDuring.bind(transport)
  transport.lockDuring = (action: () => Promise<unknown>) => ownRequest(() => lockDuring(action))
  const write = transport.write.bind(transport)
  transport.write = async (buf: Uint8Array, debugLink: boolean) => {
    const rest = restRequest.getStore()
    // Message buffer: '##', then the big-endian message type (hdwallet toMessageBuffer).
    const refusal = restWriteRefusal(state(), (buf[2] << 8) | buf[3], rest)
    if (refusal) throw new HttpError(refusal.status, refusal.message)
    if (rest) rest.admitted = true
    return write(buf, debugLink)
  }
}
