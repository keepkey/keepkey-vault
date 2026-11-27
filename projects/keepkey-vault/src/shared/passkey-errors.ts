/** Errors of the KeepKey passkey interface (src/bun/passkeys*.ts): thrown in English,
 *  which the logs read as they are, and shown translated on the Passkeys tab (KEEPKEY-179).
 *
 *  Only the message crosses the RPC, so the bun side builds every PasskeyError text
 *  from this list and the tab reads it back here. passkey-errors.test.ts fails if a
 *  PasskeyError is thrown with a text of its own. */

export const PASSKEY_ERRORS = {
  // Reaching the device
  noDevice: 'No KeepKey FIDO interface found. Connect the KeepKey (firmware 7.16 or newer).',
  noAnswer: 'The KeepKey did not answer in time',
  fidoNoAnswer: 'The KeepKey FIDO interface did not answer',
  // Confirmation on the device
  declined: 'Declined on the KeepKey',
  cancelled: 'Cancelled on the KeepKey',
  noConfirmation: 'No confirmation on the KeepKey in time',
  refused: 'The KeepKey refused the request',
  // Security key PIN
  pinInvalid: 'Wrong security key PIN',
  pinBlocked: 'The security key PIN is blocked. Erasing passkeys is the only way to clear it',
  pinAuthBlocked: 'Too many wrong PINs. Unplug and replug the KeepKey, then try again',
  pinNotSet: 'No security key PIN is set yet',
  pinTooShort: 'The PIN must be at least 4 characters',
  pinLength: 'The PIN must be 4 to 63 characters',
  // Single passkeys
  noCredential: 'That passkey is no longer on the KeepKey',
  invalidId: 'Invalid passkey id',
  // Erase all
  resetNeedsReplug: 'Reset is only allowed within 10 seconds of the KeepKey powering up',
  resetDeclined: 'Reset was declined on the KeepKey',
  resetNoPress: 'No button press on the KeepKey in time',
  replugTimeout: 'The KeepKey was not unplugged and plugged back in in time',
  // Unexpected answers; {code} is the status byte, e.g. 0x2b
  outOfOrder: 'Out-of-order CTAPHID packet',
  noKeyAgreement: 'The KeepKey sent no key agreement key',
  badPinToken: 'The KeepKey sent an unexpected PIN token',
  ctaphid: 'CTAPHID error {code}',
  getInfo: 'GetInfo failed ({code})',
  reset: 'Reset failed ({code})',
  status: 'The KeepKey returned error {code}',
} as const

export type PasskeyErrorKind = keyof typeof PASSKEY_ERRORS

/** Deleting a passkey waits for Desktop's device traffic; this is the text device-operation.ts
 *  and engine-controller.ts throw when it is busy. */
export const DEVICE_BUSY = 'KeepKey is busy with another request. Wait for it to finish, then try again.'

/** The device-namespace key of each kind. Low-level protocol detail stays in the logs:
 *  people read one "unexpected answer" text, with the status byte when there is one. */
const KEYS: Record<PasskeyErrorKind, string> = {
  noDevice: 'noDevice',
  noAnswer: 'noAnswer',
  fidoNoAnswer: 'noAnswer',
  declined: 'declined',
  cancelled: 'cancelled',
  noConfirmation: 'noConfirmation',
  refused: 'refused',
  pinInvalid: 'pinInvalid',
  pinBlocked: 'pinBlocked',
  pinAuthBlocked: 'pinAuthBlocked',
  pinNotSet: 'pinNotSet',
  pinTooShort: 'pinTooShort',
  pinLength: 'pinLength',
  noCredential: 'noCredential',
  invalidId: 'invalidId',
  resetNeedsReplug: 'resetNeedsReplug',
  resetDeclined: 'resetDeclined',
  resetNoPress: 'resetNoPress',
  replugTimeout: 'replugTimeout',
  outOfOrder: 'unexpected',
  noKeyAgreement: 'unexpected',
  badPinToken: 'unexpected',
  ctaphid: 'unexpectedCode',
  getInfo: 'unexpectedCode',
  reset: 'unexpectedCode',
  status: 'unexpectedCode',
}

/** The English message the bun side throws, e.g. passkeyErrorMessage('status', { code: '0x2b' }). */
export function passkeyErrorMessage(kind: PasskeyErrorKind, params: Record<string, string> = {}): string {
  return PASSKEY_ERRORS[kind].replace(/\{(\w+)\}/g, (_, name: string) => {
    if (!(name in params)) throw new Error(`passkeyErrorMessage(${kind}) is missing {${name}}`)
    return params[name]
  })
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PATTERNS = (Object.keys(PASSKEY_ERRORS) as PasskeyErrorKind[]).map(kind => ({
  kind,
  re: new RegExp(`^${PASSKEY_ERRORS[kind].split(/(\{\w+\})/).map(part => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1]
    return name ? `(?<${name}>0x[0-9a-f]+)` : escape(part)
  }).join('')}$`),
}))

/** Which passkey error a message is, with its values, or null. */
export function parsePasskeyError(message: string): { kind: PasskeyErrorKind; params: Record<string, string> } | null {
  for (const { kind, re } of PATTERNS) {
    const match = re.exec(message.trim())
    if (match) return { kind, params: { ...match.groups } }
  }
  return null
}

/** The device-namespace text for a passkey or device-busy error, or null for any other error. */
export function describePasskeyError(message: string, t: (key: any, options?: any) => any): string | null {
  if (message.trim() === DEVICE_BUSY) return t('passkeys.busy', { ns: 'device' })
  const parsed = parsePasskeyError(message)
  if (!parsed) return null
  return t(`passkeys.${KEYS[parsed.kind]}`, { ns: 'device', ...parsed.params })
}
