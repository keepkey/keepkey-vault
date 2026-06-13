// Shared classification of device-signing failures into actionable, user-facing
// messages.
//
// Why this exists: every signing flow (Send, Staking, Name registration) used to
// surface the raw error from hdwallet/the device — typically a cryptic
// "failed to sign transaction" — with no recovery guidance. The most common
// real cause is a stale or unresponsive device session, especially right after
// a firmware update (the KeepKey does NOT auto-reboot; it needs a manual
// unplug/replug). Users were left stranded with reads working but signing dead.
//
// This helper recognises the device-communication / disconnect class of errors
// and tells the user exactly what to do. For anything it doesn't recognise it
// preserves the underlying detail but still appends a reconnect hint, since
// reconnecting is always a safe recovery step for a hardware signer.

type Translate = (key: string, opts?: { defaultValue?: string }) => string

// User cancelled / rejected on the device — not a failure, don't nag them.
const CANCEL_PATTERNS = [/cancel/i, /reject/i, /denied/i]

// Device is unreachable or in a bad/stale session (transport/USB/timeout/etc).
const DEVICE_PATTERNS = [
	/disconnect/i,
	/no device|device not|device unavailable|device is not/i,
	/\busb\b/i,
	/libusb/i,
	/transport/i,
	/\bpipe\b/i,
	/timed?\s*out|timeout/i,
	/econnreset/i,
	/enodev/i,
	/\beio\b/i,
	/endpoint/i,
	/not responding/i,
	/failed to (open|claim)|cannot (open|read|claim)/i,
]

/**
 * Turn a thrown signing error into a localized, actionable message.
 * Pass the component's `t` so the strings live in i18n (English defaults inline
 * until translated).
 */
export function describeSigningError(e: unknown, t: Translate): string {
	const raw = ((e as any)?.message ?? String(e ?? '')).toString().trim()

	if (CANCEL_PATTERNS.some(r => r.test(raw))) {
		return t('signingCancelled', { defaultValue: 'Transaction cancelled on your KeepKey.' })
	}

	if (DEVICE_PATTERNS.some(r => r.test(raw))) {
		return t('signingDeviceLost', {
			defaultValue:
				'Your KeepKey stopped responding. Unplug it, plug it back in, then restart the app and try again — this is often needed right after a firmware update.',
		})
	}

	const detail = raw || t('signingFailed', { defaultValue: 'Signing failed' })
	const hint = t('signingReconnectHint', {
		defaultValue:
			'Still failing? Unplug your KeepKey, reconnect it, then restart the app and try again.',
	})
	return `${detail}\n\n${hint}`
}
