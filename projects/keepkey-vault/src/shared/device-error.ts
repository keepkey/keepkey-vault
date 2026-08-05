/**
 * Device failures are not Errors.
 *
 * hdwallet throws the decoded protobuf Failure event verbatim — a plain object
 * whose `.message` is itself `{ code, message }`:
 *
 *   { message_type: 'FAILURE', message_enum: 3,
 *     message: { code: 9, message: 'Enable AdvancedMode to blind-sign' },
 *     from_wallet: true }
 *
 * Two things break when that object escapes a handler:
 *
 *  1. Electrobun's RPC dispatcher does `if (!(error instanceof Error)) throw error`,
 *     so it sends NO response packet at all. The renderer's request then hangs
 *     until its own timeout (10 minutes for a swap) and finally reports a
 *     "network error" — the device's actual reason never reaches the user.
 *  2. Rendering it as a React child throws (minified error #31).
 *
 * Normalize at the boundary; never hand-roll the unwrap again.
 */

/** Human-readable text from an Error, a device Failure event, or anything else. */
export function deviceErrorMessage(e: unknown): string {
	if (typeof e === 'string') return e
	const m = (e as any)?.message
	if (typeof m === 'string') return m
	if (typeof m?.message === 'string') return m.message
	return String(e)
}

/** Protobuf FailureType code, when the value is a device Failure. */
export function deviceFailureCode(e: unknown): number | undefined {
	const c = (e as any)?.message?.code ?? (e as any)?.code
	return typeof c === 'number' ? c : undefined
}

/**
 * Coerce anything throwable into a real Error, preserving the device failure
 * code and the original value. Errors pass through untouched.
 */
export function toDeviceError(e: unknown): Error {
	if (e instanceof Error) return e
	const err = new Error(deviceErrorMessage(e))
	const code = deviceFailureCode(e)
	if (code !== undefined) (err as any).deviceFailureCode = code
	;(err as any).cause = e
	return err
}
