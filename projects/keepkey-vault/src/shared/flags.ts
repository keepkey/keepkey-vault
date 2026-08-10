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
