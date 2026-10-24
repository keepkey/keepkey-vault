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

/** `whileLocked`: set by requireWallet for routes that never ask for the PIN. */
export const restRequest = new AsyncLocalStorage<{ whileLocked: boolean }>()

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

export function restWriteRefusal(state: GateState, messageType: number, rest: { whileLocked: boolean } | undefined) {
  if (!rest || REPLIES.has(messageType)) return null
  if (state.wipeInProgress) return { status: 409, message: WIPE_BUSY_MESSAGE }
  if (state.wipeOnReconnect) return { status: 409, message: WIPE_REPLUG_PENDING_MESSAGE }
  if (state.locked && !rest.whileLocked) return { status: 423, message: DEVICE_LOCKED_MESSAGE }
  return null
}

/** Wrap hdwallet's per-message write (private, one call per message) once per transport. */
export function gateRestWrites(transport: any, state: () => GateState) {
  if (transport.restGated) return
  transport.restGated = true
  const write = transport.write.bind(transport)
  transport.write = async (buf: Uint8Array, debugLink: boolean) => {
    // Message buffer: '##', then the big-endian message type (hdwallet toMessageBuffer).
    const refusal = restWriteRefusal(state(), (buf[2] << 8) | buf[3], restRequest.getStore())
    if (refusal) throw new HttpError(refusal.status, refusal.message)
    return write(buf, debugLink)
  }
}
