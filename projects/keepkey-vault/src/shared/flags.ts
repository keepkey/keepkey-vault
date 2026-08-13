/**
 * Build-time feature flags — plain in-code constants (flip + rebuild, no env vars).
 * Importable by both the bun/ backend (`../shared/flags`) and mainview/ frontend
 * (`../../shared/flags`).
 */

/**
 * EVM clear-signing "insight": fetch a Pioneer-signed calldata metadata blob and
 * attach it to EthereumSignTx so the device renders decoded contract-call pages
 * instead of raw hex. Default OFF; every call site additionally requires the
 * connected device's firmware to be >= 7.15.0.
 */
export const EVM_INSIGHT = false

/**
 * Bitcoin-only onboarding: during OOB setup on a fresh device, let the user pick
 * Bitcoin-only vs Multi-coin firmware. Bitcoin-only flashes the BITCOIN_ONLY
 * firmware variant (smaller attack surface) and is effectively ONE-WAY — a
 * bitcoin-only seed is locked to bitcoin-only firmware (storage band 10017).
 *
 * Default OFF. Do NOT flip on until a signed btc-only asset is actually
 * published in a firmware release (see BTC_ONLY_FIRMWARE_ASSET) and shipped,
 * then enable in the release AFTER that.
 */
export const BITCOIN_ONLY_ONBOARDING = false

/**
 * True when the connected device runs bitcoin-only firmware, per its Features
 * `firmware_variant` string (set in firmware fsm_msg_common.h). Drives the
 * BTC-only UI restriction. NOT gated by BITCOIN_ONLY_ONBOARDING — the UI must
 * restrict to Bitcoin whenever btc-only firmware is actually detected, however
 * it got there. ("bitcoin-only-locked" is multi-chain firmware refusing a
 * btc-only seed — a different state, not handled here.)
 */
export const isBitcoinOnlyVariant = (variant?: string): boolean =>
  variant === 'KeepKeyBTC' || variant === 'EmulatorBTC'

/**
 * Idle auto-lock delay written to the device at setup, in milliseconds.
 *
 * This is an IDLE timer that only runs while the device is powered: after this
 * long with no interaction, the device clears its cached PIN and re-prompts.
 * Unplugging locks the device immediately regardless — the PIN cache lives in
 * RAM and dies with power — so this value has no bearing on a disconnected
 * device.
 *
 * Firmware clamps to a 30s minimum (storage.c storage_setAutoLockDelayMs) and
 * has no maximum below the uint32 millisecond ceiling (~49 days). Users can
 * change it per-device in Settings → Security; this constant is only the value
 * a freshly set-up or recovered device starts with.
 */
export const DEFAULT_AUTO_LOCK_MS = 3_600_000 // 1 hour

/** Choices offered in Settings → Security. Firmware minimum is 30s. */
export const AUTO_LOCK_CHOICES: ReadonlyArray<{ ms: number; labelKey: string }> = [
	{ ms: 60_000, labelKey: '1 minute' },
	{ ms: 600_000, labelKey: '10 minutes' },
	{ ms: 1_800_000, labelKey: '30 minutes' },
	{ ms: 3_600_000, labelKey: '1 hour' },
	{ ms: 14_400_000, labelKey: '4 hours' },
	{ ms: 86_400_000, labelKey: '24 hours' },
]
