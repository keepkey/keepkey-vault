/**
 * Seed-access request that unlocks a PIN-protected KeepKey.
 *
 * Kept out of engine-controller.ts so it can be tested without the USB/HID
 * native import chain.
 *
 * Why not wallet.getPublicKeys({ showDisplay: false })? hdwallet gives that
 * call DEFAULT_TIMEOUT (5 s). After 3+ failed PINs the firmware (pin_sm.c
 * pin_protect) shows "Previous PIN Failures: Wait N seconds" (N = 2^fails,
 * so 8 s, 16 s, ...) BEFORE it sends PinMatrixRequest. With a 5 s timeout the
 * host gives up before the PIN prompt ever arrives, and the failure counter
 * can never be reset by a correct PIN. Keep the first reply open long enough
 * for the firmware countdown on physical hardware.
 * Once PinMatrixRequest arrives, the transport waits for user input and starts
 * a fresh response deadline when the PIN is submitted.
 */
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import * as Types from '@keepkey/device-protocol/lib/types_pb'
import { DeviceOperationError } from './device-operation'

export const UNLOCK_ADDRESS_N = [0x8000002C, 0x80000000, 0x80000000] // m/44'/0'/0'

interface CallTransport {
  call(msgType: number, msg: any, options?: { msgTimeout?: number }): Promise<any>
}

/**
 * The emulator's unlock waits for its first reply with no practical deadline (the
 * largest a timer takes). Hardware uses a finite deadline that covers the
 * reported four-to-five-hour wait and the 18-hour backoff at 16 failures.
 */
export const EMULATOR_UNLOCK_FIRST_REPLY_MS = 2_147_483_647
export const HARDWARE_UNLOCK_FIRST_REPLY_MS = 24 * 60 * 60 * 1000

export async function requestUnlock(transport: CallTransport, msgTimeout = HARDWARE_UNLOCK_FIRST_REPLY_MS): Promise<void> {
  const gpk = new Messages.GetPublicKey()
  gpk.setCoinName('Bitcoin')
  gpk.setAddressNList(UNLOCK_ADDRESS_N)
  gpk.setShowDisplay(false)
  gpk.setEcdsaCurveName('secp256k1')
  gpk.setScriptType(Types.InputScriptType.SPENDADDRESS)
  try {
    await transport.call(Messages.MessageType.MESSAGETYPE_GETPUBLICKEY, gpk, { msgTimeout })
  } catch (err: any) {
    // hdwallet throws the raw Failure event for PinCancelled; the user backed out.
    if ((err?.message?.code ?? err?.code) === Types.FailureType.FAILURE_PINCANCELLED) {
      throw new DeviceOperationError(499, 'PIN entry cancelled')
    }
    throw err
  }
}

export function isTransportTimeout(err: unknown): boolean {
  return (err as any)?.name === 'TransportTimeoutError'
}

export const UNLOCK_TIMEOUT_MESSAGE =
  'Timed out waiting for the KeepKey PIN prompt. If your KeepKey shows a countdown, ' +
  'wait for it to finish. Then reconnect the KeepKey and choose Unlock.'

export const EMULATOR_UNLOCK_TIMEOUT_MESSAGE =
  'The emulator stopped waiting for its PIN. Stop and start the emulator, or switch wallets, to unlock it again.'
