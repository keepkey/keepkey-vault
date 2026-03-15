/**
 * Per-chain address format validation.
 * Lightweight format checks — no external dependencies, no checksum verification.
 * Catches obvious typos and cross-chain address mistakes before hitting the network.
 */
import type { ChainDef } from './chains'

const BASE58 = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/
const HEX40 = /^0x[0-9a-fA-F]{40}$/
const BECH32 = /^[a-z]+1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/i

interface ValidationResult {
  valid: boolean
  error?: string  // i18n key
}

const OK: ValidationResult = { valid: true }
const fail = (error: string): ValidationResult => ({ valid: false, error })

/** Validate address format for a specific chain */
export function validateAddress(address: string, chain: ChainDef): ValidationResult {
  const trimmed = address.trim()
  if (!trimmed) return fail('addressEmpty')

  switch (chain.chainFamily) {
    case 'utxo':
      return validateUtxoAddress(trimmed, chain)
    case 'evm':
      return validateEvmAddress(trimmed)
    case 'cosmos':
      return validateCosmosAddress(trimmed, chain)
    case 'xrp':
      return validateXrpAddress(trimmed)
    case 'solana':
      return validateSolanaAddress(trimmed)
    case 'tron':
      return validateTronAddress(trimmed)
    case 'ton':
      return validateTonAddress(trimmed)
    case 'zcash-shielded':
      return validateZcashShieldedAddress(trimmed)
    default:
      return OK // Unknown chain family — don't block
  }
}

// ── UTXO chains ─────────────────────────────────────────────────────────

function validateUtxoAddress(addr: string, chain: ChainDef): ValidationResult {
  switch (chain.id) {
    case 'bitcoin':
      // Legacy (1...), P2SH (3...), Bech32 (bc1...)
      if (addr.startsWith('1') && addr.length >= 25 && addr.length <= 34 && BASE58.test(addr)) return OK
      if (addr.startsWith('3') && addr.length === 34 && BASE58.test(addr)) return OK
      if (addr.toLowerCase().startsWith('bc1') && addr.length >= 42 && addr.length <= 62 && BECH32.test(addr)) return OK
      return fail('invalidBtcAddress')

    case 'litecoin':
      // Legacy (L/M...), P2SH (3...), Bech32 (ltc1...)
      if ((addr.startsWith('L') || addr.startsWith('M')) && addr.length >= 25 && addr.length <= 34 && BASE58.test(addr)) return OK
      if (addr.startsWith('3') && addr.length === 34 && BASE58.test(addr)) return OK
      if (addr.toLowerCase().startsWith('ltc1') && addr.length >= 42 && BECH32.test(addr)) return OK
      return fail('invalidLtcAddress')

    case 'dogecoin':
      if (addr.startsWith('D') && addr.length >= 25 && addr.length <= 34 && BASE58.test(addr)) return OK
      return fail('invalidDogeAddress')

    case 'bitcoincash':
      // Legacy (1...) or CashAddr (q..., bitcoincash:q...)
      if (addr.startsWith('1') && addr.length >= 25 && addr.length <= 34 && BASE58.test(addr)) return OK
      const stripped = addr.replace(/^bitcoincash:/i, '')
      if ((stripped.startsWith('q') || stripped.startsWith('p')) && stripped.length >= 42) return OK
      return fail('invalidBchAddress')

    case 'dash':
      if (addr.startsWith('X') && addr.length === 34 && BASE58.test(addr)) return OK
      return fail('invalidDashAddress')

    case 'zcash':
      // Transparent: t1... (34 chars) or t3... (34 chars)
      if ((addr.startsWith('t1') || addr.startsWith('t3')) && addr.length === 35 && BASE58.test(addr)) return OK
      return fail('invalidZecAddress')

    case 'digibyte':
      if (addr.startsWith('D') && addr.length >= 25 && addr.length <= 34 && BASE58.test(addr)) return OK
      if (addr.toLowerCase().startsWith('dgb1') && BECH32.test(addr)) return OK
      return fail('invalidDgbAddress')

    default:
      // Generic UTXO — just check reasonable length + base58 or bech32
      if (addr.length >= 25 && addr.length <= 62 && (BASE58.test(addr) || BECH32.test(addr))) return OK
      return fail('invalidAddress')
  }
}

// ── EVM ─────────────────────────────────────────────────────────────────

function validateEvmAddress(addr: string): ValidationResult {
  if (HEX40.test(addr)) return OK
  // ENS names — let them through (resolver handles it)
  if (addr.endsWith('.eth') && addr.length >= 7) return OK
  return fail('invalidEvmAddress')
}

// ── Cosmos family ───────────────────────────────────────────────────────

const COSMOS_PREFIXES: Record<string, string> = {
  cosmos: 'cosmos1',
  thorchain: 'thor1',
  mayachain: 'maya1',
  osmosis: 'osmo1',
}

function validateCosmosAddress(addr: string, chain: ChainDef): ValidationResult {
  const expectedPrefix = COSMOS_PREFIXES[chain.id]
  if (expectedPrefix) {
    if (!addr.startsWith(expectedPrefix)) return fail('invalidCosmosPrefix')
    // Bech32: prefix + "1" + data chars (typically 38-59 total)
    if (addr.length < 39 || addr.length > 65) return fail('invalidCosmosLength')
    return OK
  }
  // Unknown cosmos chain — just check bech32 format
  if (BECH32.test(addr) && addr.length >= 39) return OK
  return fail('invalidCosmosAddress')
}

// ── XRP ─────────────────────────────────────────────────────────────────

function validateXrpAddress(addr: string): ValidationResult {
  if (addr.startsWith('r') && addr.length >= 25 && addr.length <= 35 && BASE58.test(addr)) return OK
  return fail('invalidXrpAddress')
}

// ── Solana ──────────────────────────────────────────────────────────────

function validateSolanaAddress(addr: string): ValidationResult {
  if (BASE58.test(addr) && addr.length >= 32 && addr.length <= 44) return OK
  return fail('invalidSolanaAddress')
}

// ── Tron ────────────────────────────────────────────────────────────────

function validateTronAddress(addr: string): ValidationResult {
  if (addr.startsWith('T') && addr.length === 34 && BASE58.test(addr)) return OK
  return fail('invalidTronAddress')
}

// ── TON ─────────────────────────────────────────────────────────────────

function validateTonAddress(addr: string): ValidationResult {
  // Raw: 0:hex (66 chars), User-friendly: EQ/UQ + base64 (48 chars), or raw hex
  if (/^0:[0-9a-fA-F]{64}$/.test(addr)) return OK
  if ((addr.startsWith('EQ') || addr.startsWith('UQ')) && addr.length === 48) return OK
  // Newer formats
  if (/^[A-Za-z0-9_-]{46,48}$/.test(addr)) return OK
  return fail('invalidTonAddress')
}

// ── Zcash shielded ──────────────────────────────────────────────────────

function validateZcashShieldedAddress(addr: string): ValidationResult {
  // Unified addresses start with 'u1'
  if (addr.startsWith('u1') && addr.length >= 70) return OK
  // Sapling addresses start with 'zs1'
  if (addr.startsWith('zs1') && addr.length >= 70) return OK
  // Transparent fallback (some wallets send from shielded tab to transparent)
  if ((addr.startsWith('t1') || addr.startsWith('t3')) && addr.length === 35 && BASE58.test(addr)) return OK
  return fail('invalidZcashShieldedAddress')
}
