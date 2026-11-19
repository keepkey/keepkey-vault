import { describe, expect, test } from 'bun:test'
import { describeVerifyAddressError } from './verify-address-error'
import { classifyDeviceError, describeSigningError } from './signing-errors'

// Echo the key (and detail) so the test sees which message was chosen.
const t = (key: string, opts?: Record<string, unknown>) => opts?.detail ? `${key}:${opts.detail}` : key

describe('describeVerifyAddressError', () => {
	test.each([
		['Action cancelled by user', 'verifyCancelled'],
		['RPC request timed out: btcGetAddress', 'verifyNoAnswer'],
		['LIBUSB_ERROR_PIPE', 'verifyDeviceLost'],
		['Device not connected', 'verifyDeviceLost'],
		['Failure_Other', 'verifyFailedDetail:Failure_Other'],
		['', 'verifyFailed'],
		// Host-side wait timeout: the device may still be showing the address.
		['Timed out waiting for the KeepKey request. Try again.', 'verifyNoAnswer'],
		// OS refused the USB device: not a cancel, despite "denied".
		["EACCES: permission denied, open '/dev/hidraw0'", 'verifyDeviceLost'],
		// Gate messages are already worded for the user: shown as-is, not wrapped in "Could not show…".
		['KeepKey is locked: enter the PIN in KeepKey Desktop, then try again', 'verifyNotConfirmedAfter:KeepKey is locked: enter the PIN in KeepKey Desktop, then try again'],
		['KeepKey is busy with another request. Wait for it to finish, then try again.', 'verifyNotConfirmedAfter:KeepKey is busy with another request. Wait for it to finish, then try again.'],
	])('maps "%s" to %s', (message, expected) => {
		expect(describeVerifyAddressError(new Error(message), t)).toBe(expected)
	})

	test('a non-Error rejection still yields a message', () => {
		expect(describeVerifyAddressError(undefined, t)).toBe('verifyFailed')
		expect(describeVerifyAddressError('busy', t)).toBe('verifyFailedDetail:busy')
	})
})

describe('classifyDeviceError stays in step with describeSigningError', () => {
	// describeSigningError picks one message key per class; the classifier must agree on every class.
	const MESSAGE: Record<string, string> = { cancelled: 'signingCancelled', invalidAddress: 'signingInvalidAddress', noAnswer: 'signingNoAnswer', deviceLost: 'signingDeviceLost' }
	test.each([
		'Action cancelled by user', 'PIN rejected', 'Invalid THORChain recipient address', 'RPC request timed out: ethSignTx',
		'LIBUSB_ERROR_PIPE', 'Device not connected', 'Failure_Other', '',
	])('"%s"', (message) => {
		const kind = classifyDeviceError(new Error(message))
		const signing = describeSigningError(new Error(message), (key: string) => key)
		if (kind === 'other') expect(Object.values(MESSAGE)).not.toContain(signing)
		else expect(signing).toBe(MESSAGE[kind])
	})
})
