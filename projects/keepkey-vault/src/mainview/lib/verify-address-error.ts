import { isLocalDeviceAccessError } from '../../shared/device-access-error'
import { classifyDeviceError, deviceErrorText } from './signing-errors'

// Loose on purpose: i18next TFunction overloads do not fit a narrow signature.
type Translate = (...args: any[]) => unknown

// The host gave up waiting while the KeepKey may still be showing the address (device-operation.ts).
const HOST_WAIT_TIMEOUT = /^Timed out waiting for the KeepKey request\. Try again\.$/
// The OS refused the USB device: not a cancel on the KeepKey, even though the text says "denied".
const HOST_PERMISSION = /\bEACCES\b|permission denied|access denied/i

/**
 * Message for a failed "Verify on device". Every variant says the address was not
 * confirmed, so a failure never reads as a completed check (audit v6 U3).
 */
export function describeVerifyAddressError(e: unknown, t: Translate): string {
	const detail = deviceErrorText(e)
	if (HOST_WAIT_TIMEOUT.test(detail)) return String(t('verifyNoAnswer', { ns: 'receive' }))
	if (HOST_PERMISSION.test(detail)) return String(t('verifyDeviceLost', { ns: 'receive' }))
	// Device gate messages (busy, locked, not ready) are already worded for the user.
	if (isLocalDeviceAccessError(e)) return String(t('verifyNotConfirmedAfter', { ns: 'receive', detail }))
	switch (classifyDeviceError(e)) {
		case 'cancelled': return String(t('verifyCancelled', { ns: 'receive' }))
		case 'noAnswer': return String(t('verifyNoAnswer', { ns: 'receive' }))
		case 'deviceLost': return String(t('verifyDeviceLost', { ns: 'receive' }))
		default:
			return detail
				? String(t('verifyFailedDetail', { ns: 'receive', detail }))
				: String(t('verifyFailed', { ns: 'receive' }))
	}
}
