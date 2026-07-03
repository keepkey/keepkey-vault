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
