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
 * can never be reset by a correct PIN. LONG_TIMEOUT (5 min) covers the wait
 * up to 8 prior failures; beyond that the timeout is surfaced to the user.
 */
import * as core from '@keepkey/hdwallet-core'
import * as Messages from '@keepkey/device-protocol/lib/messages_pb'
import * as Types from '@keepkey/device-protocol/lib/types_pb'

export const UNLOCK_ADDRESS_N = [0x8000002C, 0x80000000, 0x80000000] // m/44'/0'/0'

interface CallTransport {
  call(msgType: number, msg: any, options?: { msgTimeout?: number }): Promise<any>
}

/**
 * The emulator's unlock waits for its first reply with no practical deadline (the
 * largest a timer takes). That wait is the firmware's backoff countdown (2^fails s:
 * 9 fails is longer than LONG_TIMEOUT), shown on the emulator's screen while the UI
 * shows the PIN pad disabled. An emulator read ends when the user cancels, switches
 * or stops (emulator-transport.ts), so it needs no timeout to come back. Hardware
 * keeps LONG_TIMEOUT: a stuck USB read there only ends by timing out.
 */
export const EMULATOR_UNLOCK_FIRST_REPLY_MS = 2_147_483_647

export async function requestUnlock(transport: CallTransport, msgTimeout = core.LONG_TIMEOUT): Promise<void> {
  const gpk = new Messages.GetPublicKey()
  gpk.setCoinName('Bitcoin')
  gpk.setAddressNList(UNLOCK_ADDRESS_N)
  gpk.setShowDisplay(false)
  gpk.setEcdsaCurveName('secp256k1')
  gpk.setScriptType(Types.InputScriptType.SPENDADDRESS)
  await transport.call(Messages.MessageType.MESSAGETYPE_GETPUBLICKEY, gpk, { msgTimeout })
}

export function isTransportTimeout(err: unknown): boolean {
  return (err as any)?.name === 'TransportTimeoutError'
}

export const UNLOCK_TIMEOUT_MESSAGE =
  'Timed out waiting for the KeepKey PIN prompt. After repeated wrong PINs the device ' +
  'makes you wait before asking again. Unplug and reconnect your KeepKey, then try again.'

export const EMULATOR_UNLOCK_TIMEOUT_MESSAGE =
  'The emulator stopped waiting for its PIN. Stop and start the emulator, or switch wallets, to unlock it again.'
