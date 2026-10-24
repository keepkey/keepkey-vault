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
 * Only REST requests are gated: rest-api.ts runs each one inside `restRequest`.
 * Desktop's own unlock prompt, wipe and setup flows are not REST. Replies to
 * the device's own prompts always pass, so a request already running (a sign
 * waiting on its button) is never cut off.
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

export interface GateState {
  wipeInProgress: boolean
  wipeOnReconnect: boolean
  /** Waiting for its PIN, or connected but not read yet: only Desktop's prompt may ask for the PIN. */
  locked: boolean
}

export function restWriteRefusal(state: GateState, messageType: number, rest: RestRequest | undefined) {
  if (!rest || REPLIES.has(messageType)) return null
  if (state.wipeInProgress) return { status: 409, message: WIPE_BUSY_MESSAGE }
  if (state.wipeOnReconnect) return { status: 409, message: WIPE_REPLUG_PENDING_MESSAGE }
  // Only a request's first message: once it runs, the device may lock mid-flow (its own
  // PIN prompt), and the TxAcks, data chunks and struct acks that follow must still go.
  if (state.locked && !rest.whileLocked && !rest.admitted) return { status: 423, message: DEVICE_LOCKED_MESSAGE }
  return null
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
