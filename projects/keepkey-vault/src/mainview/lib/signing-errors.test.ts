import { describe, expect, test } from 'bun:test'
import { describeSigningError } from './signing-errors'

// Echo the key so the test sees which message was chosen, not its English copy.
const t = (key: string) => key

describe('describeSigningError', () => {
	// Exact failure strings the firmware returns for a recipient it cannot decode.
	test.each([
		'Invalid THORChain recipient address',
		'Invalid MAYAChain recipient address',
		'Invalid Cosmos recipient address',
		'Invalid Tendermint recipient address',
		'Invalid recipient address',
		'Invalid TON destination address',
	])('maps firmware "%s" to an address error with no reconnect hint', (message) => {
		const out = describeSigningError(new Error(message), t)
		expect(out).toBe('signingInvalidAddress')
		expect(out).not.toContain('signingReconnectHint')
	})

	test('keeps the reconnect hint for unrecognised failures', () => {
		expect(describeSigningError(new Error('Failure_Other'), t)).toBe('Failure_Other\n\nsigningReconnectHint')
	})

	test('a client-side RPC timeout is not reported as a dead KeepKey', () => {
		// The device can still be showing its confirm screen: no unplug/restart advice.
		const out = describeSigningError(new Error('RPC request timed out: ethSignTx'), t)
		expect(out).toBe('signingNoAnswer')
	})

	test('device and cancel classes are unchanged', () => {
		expect(describeSigningError(new Error('LIBUSB_ERROR_PIPE'), t)).toBe('signingDeviceLost')
		expect(describeSigningError(new Error('Action cancelled by user'), t)).toBe('signingCancelled')
	})
})
