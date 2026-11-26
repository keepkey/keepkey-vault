/**
 * Does this KeepKey's firmware have HiveSignOperations? Answered without
 * putting anything on the device screen, and never from the version string.
 *
 * Why not a version: 7.16.0 and 7.17.0-rc8 (a6ee7dd) lack the message while
 * the 7.17.0 alpha (378cf30) has it. The feature lives on one line of the
 * fork, so "version >= X" gives false positives.
 *
 * THE PROBE. Send HiveSignOperations with an empty serialized_tx and classify
 * the Failure. Checked against the firmware source:
 *  - Without the handler (rc8 a6ee7dd, 7.16): the message id is not in the
 *    firmware's message map; lib/board/messages.c answers
 *    Failure_UnexpectedMessage "Unknown message" before any handler or screen.
 *  - With it (alpha 378cf30, lib/firmware/fsm_msg_hive.h:697): the handler
 *    runs CHECK_INITIALIZED, then CHECK_PIN, then rejects the empty payload
 *    with Failure_SyntaxError "Missing serialized transaction" and returns to
 *    the home screen. No confirmation is shown, nothing is derived or signed.
 *
 * The one prompt it could cause is CHECK_PIN on a locked device (it asks for
 * the PIN). So the probe only runs when the device is initialized and its PIN
 * is cached (or it has no PIN); otherwise the answer is 'unknown' and the
 * caller asks again after unlock. The measured-build allowlist in
 * shared/magi-config.ts answers first, without touching the device.
 *
 * The device's own error stays the backstop at signing time.
 */
import { knownHiveOpsCapability, type HiveOpsCapability } from '../shared/magi-config'

/** FailureType values (device-protocol types.proto). */
const FAILURE_UNEXPECTED_MESSAGE = 1
const FAILURE_SYNTAX_ERROR = 3

export interface ProbeDeviceState {
	deviceId?: string
	firmwareHash?: string
	initialized?: boolean
	pinProtection?: boolean
	pinCached?: boolean
	bootloaderMode?: boolean
}

export interface HiveOpsProbeWallet {
	hiveSignOperations(msg: { addressNList: number[]; serializedTx: Uint8Array }): Promise<unknown>
}

/** Read a device Failure out of whatever hdwallet threw. hdwallet throws the
 *  raw response for a Failure: { message_type: 'Failure', message: { code, message } }. */
function failureOf(err: any): { code?: number; message?: string } | null {
	const msg = err?.message
	if (err?.message_type === 'Failure' && msg && typeof msg === 'object') return { code: msg.code, message: msg.message }
	if (msg && typeof msg === 'object' && 'code' in msg) return { code: msg.code, message: msg.message }
	return null
}

/** Classify the probe's outcome. Anything not clearly one of the two known
 *  answers is 'unknown': a wrong 'supported' would let a deposit through. */
export function classifyHiveOpsProbe(outcome: { error?: unknown; resolved?: boolean }): HiveOpsCapability {
	if (outcome.resolved) return 'unknown' // an empty tx must never sign
	const f = failureOf(outcome.error)
	if (!f) return 'unknown'
	if (f.code === FAILURE_UNEXPECTED_MESSAGE && /unknown message/i.test(f.message ?? '')) return 'unsupported'
	if (f.code === FAILURE_SYNTAX_ERROR && /missing serialized transaction/i.test(f.message ?? '')) return 'supported'
	return 'unknown'
}

/** Whether probing now could show a prompt. */
export function probeIsPromptless(state: ProbeDeviceState): boolean {
	if (state.bootloaderMode || !state.initialized) return false
	if (state.pinProtection && !state.pinCached) return false
	return true
}

const cache = new Map<string, Exclude<HiveOpsCapability, 'unknown'>>()
const cacheKey = (s: ProbeDeviceState) => `${s.deviceId ?? '?'}:${(s.firmwareHash ?? '?').toLowerCase()}`

/** Test hook. */
export function clearHiveOpsCapabilityCache() { cache.clear() }

/**
 * Capability for the connected device. Order: measured-build allowlist, then
 * the cache (deviceId + firmware hash, so a reflash re-probes), then the probe
 * when it cannot prompt. Never throws.
 */
export async function getHiveOpsCapability(wallet: HiveOpsProbeWallet | null | undefined, state: ProbeDeviceState): Promise<HiveOpsCapability> {
	const known = knownHiveOpsCapability(state.firmwareHash)
	if (known !== 'unknown') return known
	const key = cacheKey(state)
	const cached = state.deviceId && state.firmwareHash ? cache.get(key) : undefined
	if (cached) return cached
	if (!wallet || !probeIsPromptless(state)) return 'unknown'

	let result: HiveOpsCapability
	try {
		await wallet.hiveSignOperations({ addressNList: [], serializedTx: new Uint8Array(0) })
		result = classifyHiveOpsProbe({ resolved: true })
	} catch (error) {
		result = classifyHiveOpsProbe({ error })
	}
	if (result !== 'unknown' && state.deviceId && state.firmwareHash) cache.set(key, result)
	return result
}
