/**
 * Per-chain address validation: format AND checksum.
 * A typo in one character must not pass. Every encoding that carries a
 * checksum is verified here: EIP-55 (mixed-case EVM, error 'invalidEvmChecksum'), base58check
 * (BTC/LTC/DOGE/DASH/DGB/BCH-legacy/Zcash-t/Tron), XRP's base58check,
 * bech32 / bech32m (BIP-173 / BIP-350 segwit, Cosmos, Zcash shielded) and
 * Bitcoin Cash cashaddr. Solana has no checksum: it must decode to 32 bytes.
 */
import { base58, base58xrp, bech32, bech32m, createBase58check } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import type { ChainDef } from './chains'
import { eip55 } from './safe-tx'
import { evmTokenIdentity } from './evm-contract-identity'

interface ValidationResult {
  valid: boolean
  error?: string  // i18n key (send namespace)
}

const OK: ValidationResult = { valid: true }
const fail = (error: string): ValidationResult => ({ valid: false, error })
/** Right shape for the chain, but the checksum does not match: a typo. */
const BAD_CHECKSUM = fail('invalidChecksum')

const HEX40 = /^0x[0-9a-fA-F]{40}$/
const b58check = createBase58check(sha256)

/** Validate address format and checksum for a specific chain */
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

// ── Checksum primitives ─────────────────────────────────────────────────

/** base58check payload (version bytes + hash), or null on a bad checksum / charset. */
function base58checkPayload(addr: string): Uint8Array | null {
  try { return b58check.decode(addr) } catch { return null }
}

/** True when `addr` is base58check with one of the given version prefixes and a 20-byte hash. */
function isBase58Hash(addr: string, versions: number[][]): boolean | 'checksum' {
  const payload = base58checkPayload(addr)
  if (!payload) {
    // Distinguish "looks right, checksum wrong" from "not this kind of address at all".
    try { base58.decode(addr) } catch { return false }
    return 'checksum'
  }
  return versions.some(v => payload.length === v.length + 20 && v.every((b, i) => payload[i] === b))
}

/** BIP-173 / BIP-350 segwit address for `hrp`: v0 uses bech32, v1+ uses bech32m. */
function segwitCheck(addr: string, hrp: string): boolean | 'checksum' {
  const lower = addr.toLowerCase()
  if (addr !== lower && addr !== addr.toUpperCase()) return false // mixed case is never valid bech32
  if (!lower.startsWith(hrp + '1')) return false
  const decoded = bech32.decodeUnsafe(lower) || bech32m.decodeUnsafe(lower)
  if (!decoded) return 'checksum'
  if (decoded.prefix !== hrp || decoded.words.length < 1) return false
  const version = decoded.words[0]
  // Each witness version must use its own checksum algorithm (BIP-350).
  const expected = version === 0 ? bech32 : bech32m
  if (!expected.decodeUnsafe(lower)) return 'checksum'
  const program = expected.fromWordsUnsafe(decoded.words.slice(1))
  if (!program || version > 16) return false
  if (version === 0) return program.length === 20 || program.length === 32
  return program.length >= 2 && program.length <= 40
}

/** Plain bech32 (not segwit): Cosmos-family accounts, Zcash Sapling. */
function bech32Payload(addr: string, hrp: string, codec = bech32): Uint8Array | null | 'checksum' {
  const lower = addr.toLowerCase()
  if (addr !== lower && addr !== addr.toUpperCase()) return null
  if (!lower.startsWith(hrp + '1')) return null
  const decoded = codec.decodeUnsafe(lower, false)
  if (!decoded) return 'checksum'
  if (decoded.prefix !== hrp) return null
  return codec.fromWordsUnsafe(decoded.words) ?? null
}

// ── UTXO chains ─────────────────────────────────────────────────────────

const result = (check: boolean | 'checksum', error: string): ValidationResult =>
  check === true ? OK : check === 'checksum' ? BAD_CHECKSUM : fail(error)

function validateUtxoAddress(addr: string, chain: ChainDef): ValidationResult {
  switch (chain.id) {
    case 'bitcoin':
      if (/^bc1/i.test(addr)) return result(segwitCheck(addr, 'bc'), 'invalidBtcAddress')
      // P2PKH (1…) 0x00, P2SH (3…) 0x05
      return result(isBase58Hash(addr, [[0x00], [0x05]]), 'invalidBtcAddress')

    case 'litecoin':
      if (/^ltc1/i.test(addr)) return result(segwitCheck(addr, 'ltc'), 'invalidLtcAddress')
      // L… 0x30, M… 0x32, legacy P2SH 3… 0x05
      return result(isBase58Hash(addr, [[0x30], [0x32], [0x05]]), 'invalidLtcAddress')

    case 'dogecoin':
      // D… 0x1e, P2SH 9…/A… 0x16
      return result(isBase58Hash(addr, [[0x1e], [0x16]]), 'invalidDogeAddress')

    case 'bitcoincash': {
      if (/^[13]/.test(addr)) return result(isBase58Hash(addr, [[0x00], [0x05]]), 'invalidBchAddress')
      return result(cashaddrCheck(addr), 'invalidBchAddress')
    }

    case 'dash':
      // X… 0x4c, P2SH 7… 0x10
      return result(isBase58Hash(addr, [[0x4c], [0x10]]), 'invalidDashAddress')

    case 'zcash':
      // Transparent t1… (0x1cb8) and t3… (0x1cbd)
      return result(isBase58Hash(addr, [[0x1c, 0xb8], [0x1c, 0xbd]]), 'invalidZecAddress')

    case 'digibyte':
      if (/^dgb1/i.test(addr)) return result(segwitCheck(addr, 'dgb'), 'invalidDgbAddress')
      // D… 0x1e, S… 0x3f, legacy P2SH 3… 0x05
      return result(isBase58Hash(addr, [[0x1e], [0x3f], [0x05]]), 'invalidDgbAddress')

    default: {
      // Generic UTXO: any base58check hash or any bech32 checksum.
      if (base58checkPayload(addr)) return OK
      const lower = addr.toLowerCase()
      if (lower.includes('1') && (bech32.decodeUnsafe(lower) || bech32m.decodeUnsafe(lower))) return OK
      return fail('invalidAddress')
    }
  }
}

// ── Bitcoin Cash cashaddr ───────────────────────────────────────────────

const CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function cashaddrPolymod(values: number[]): bigint {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n]
  let c = 1n
  for (const d of values) {
    const c0 = c >> 35n
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d)
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i]
  }
  return c ^ 1n
}

/** CashAddr with or without the "bitcoincash:" prefix; checksum covers the prefix. */
function cashaddrCheck(addr: string): boolean | 'checksum' {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return false
  const lower = addr.toLowerCase()
  const body = lower.startsWith('bitcoincash:') ? lower.slice('bitcoincash:'.length) : lower
  if (!/^[qp]/.test(body) || body.length !== 42) return false // P2PKH / P2SH, 160-bit hash
  const data: number[] = []
  for (const ch of body) {
    const v = CASHADDR_CHARSET.indexOf(ch)
    if (v < 0) return false
    data.push(v)
  }
  const prefix = [...'bitcoincash'].map(ch => ch.charCodeAt(0) & 0x1f)
  return cashaddrPolymod([...prefix, 0, ...data]) === 0n ? true : 'checksum'
}

// ── EVM ─────────────────────────────────────────────────────────────────

/** A 0x address whose letters, when mixed-case, match their EIP-55 checksum.
 *  All-lower or all-upper carries no checksum; a mixed-case typo would send to
 *  an address nobody controls. */
export function isEvmAddress(addr: string): boolean {
  if (!HEX40.test(addr)) return false
  const hex = addr.slice(2)
  return hex === hex.toLowerCase() || hex === hex.toUpperCase() || eip55(addr) === addr
}

function validateEvmAddress(addr: string): ValidationResult {
  if (HEX40.test(addr)) return isEvmAddress(addr) ? OK : fail('invalidEvmChecksum')
  // No ENS resolver exists yet: a name must not pass as a recipient.
  if (/\.eth$/i.test(addr)) return fail('ensNotSupported')
  return fail('invalidEvmAddress')
}

// ── Cosmos family ───────────────────────────────────────────────────────

const COSMOS_HRP: Record<string, string> = {
  cosmos: 'cosmos',
  thorchain: 'thor',
  mayachain: 'maya',
  osmosis: 'osmo',
}

function validateCosmosAddress(addr: string, chain: ChainDef): ValidationResult {
  const hrp = COSMOS_HRP[chain.id]
  if (hrp) {
    if (!addr.toLowerCase().startsWith(hrp + '1')) return fail('invalidCosmosPrefix')
    const payload = bech32Payload(addr, hrp)
    if (payload === 'checksum') return BAD_CHECKSUM
    // Accounts are 20 bytes; module/contract accounts are 32.
    if (!payload || (payload.length !== 20 && payload.length !== 32)) return fail('invalidCosmosLength')
    return OK
  }
  // Unknown cosmos chain — any valid bech32 account.
  const lower = addr.toLowerCase()
  const decoded = lower.includes('1') ? bech32.decodeUnsafe(lower) : undefined
  if (decoded) return OK
  return fail('invalidCosmosAddress')
}

// ── XRP ─────────────────────────────────────────────────────────────────

function validateXrpAddress(addr: string): ValidationResult {
  if (!addr.startsWith('r')) return fail('invalidXrpAddress')
  let raw: Uint8Array
  try { raw = base58xrp.decode(addr) } catch { return fail('invalidXrpAddress') }
  // 0x00 account prefix + 20-byte account ID + 4-byte double-SHA256 checksum.
  if (raw.length !== 25 || raw[0] !== 0x00) return fail('invalidXrpAddress')
  const check = sha256(sha256(raw.slice(0, 21)))
  return check.slice(0, 4).every((b, i) => b === raw[21 + i]) ? OK : BAD_CHECKSUM
}

// ── Solana ──────────────────────────────────────────────────────────────

function validateSolanaAddress(addr: string): ValidationResult {
  // No checksum in the format: require a real 32-byte public key.
  try { if (base58.decode(addr).length === 32) return OK } catch { /* not base58 */ }
  return fail('invalidSolanaAddress')
}

// ── Tron ────────────────────────────────────────────────────────────────

function validateTronAddress(addr: string): ValidationResult {
  if (!addr.startsWith('T')) return fail('invalidTronAddress')
  return result(isBase58Hash(addr, [[0x41]]), 'invalidTronAddress')
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
  // Unified addresses: bech32m, hrp "u" (longer than the 90-char bech32 limit).
  if (/^u1/i.test(addr)) {
    const payload = bech32Payload(addr, 'u', bech32m)
    if (payload === 'checksum') return BAD_CHECKSUM
    return payload && payload.length >= 48 ? OK : fail('invalidZcashShieldedAddress')
  }
  // Sapling: bech32, hrp "zs", 43-byte payload.
  if (/^zs1/i.test(addr)) {
    const payload = bech32Payload(addr, 'zs')
    if (payload === 'checksum') return BAD_CHECKSUM
    return payload && payload.length === 43 ? OK : fail('invalidZcashShieldedAddress')
  }
  // Transparent fallback (some wallets send from shielded tab to transparent)
  if (/^t[13]/.test(addr)) return result(isBase58Hash(addr, [[0x1c, 0xb8], [0x1c, 0xbd]]), 'invalidZcashShieldedAddress')
  return fail('invalidZcashShieldedAddress')
}

// ── Recipient risk (no network calls) ───────────────────────────────────

const EVM_BURN = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000000000000000000000000',
  '0xdead000000000000000042069420694206942069',
])
// Well-known sinks that are not an all-zero payload.
const NAMED_BURN = new Set([
  '1nc1nerator11111111111111111111111111111111', // Solana incinerator
  'rrrrrrrrrrrrrrrrrrrrBZbvji', // XRP ACCOUNT_ONE
])

const allZero = (bytes: Uint8Array | null | undefined, skip = 0) =>
  !!bytes && bytes.length > skip && bytes.slice(skip).every(b => b === 0)

/**
 * A zero or burn address on any chain: funds sent there are gone. Chain-agnostic:
 * EVM zero/dead sinks, and any base58check / XRP / bech32 / Solana address whose
 * payload is all zeros (e.g. BTC 1111111111111111111114oLvT2, Tron T9yD14Nj…).
 */
export function isBurnAddress(address: string): boolean {
  const addr = address.trim()
  if (!addr) return false
  if (HEX40.test(addr)) return EVM_BURN.has(addr.toLowerCase())
  if (NAMED_BURN.has(addr)) return true
  const b58 = base58checkPayload(addr)
  if (b58) return allZero(b58, b58.length - 20) // version byte(s) + 20-byte hash
  if (addr.startsWith('r')) {
    try {
      const raw = base58xrp.decode(addr)
      if (raw.length === 25) return allZero(raw.slice(0, 21))
    } catch { /* not XRP */ }
  }
  const lower = addr.toLowerCase()
  const bech = lower.includes('1') ? bech32.decodeUnsafe(lower) || bech32m.decodeUnsafe(lower) : undefined
  if (bech) {
    // Segwit programs carry a witness-version word first.
    const words = ['bc', 'ltc', 'dgb'].includes(bech.prefix) ? bech.words.slice(1) : bech.words
    return allZero(bech32.fromWordsUnsafe(words) || null)
  }
  try {
    const raw = base58.decode(addr)
    if (raw.length === 32) return allZero(raw) // Solana system program 1111…1
  } catch { /* not base58 */ }
  return false
}

/** The token whose contract this EVM address is, from the bundled catalog (never a network lookup). */
export function knownTokenContract(address: string, chain: ChainDef): { symbol: string; decimals: number } | undefined {
  const addr = address.trim()
  if (chain.chainFamily !== 'evm' || !HEX40.test(addr)) return undefined
  const chainId = Number(chain.chainId)
  return Number.isFinite(chainId) ? evmTokenIdentity(chainId, addr) : undefined
}

/**
 * Address-book save check: the send validator, then refuse zero/burn addresses
 * and one of the wallet's own addresses (`existing` is the matchAddress result).
 */
export function validateContactAddress(address: string, chain: ChainDef, existing?: { kind: string } | null): ValidationResult {
  const check = validateAddress(address, chain)
  if (!check.valid) return check
  if (isBurnAddress(address)) return fail('burnAddress')
  if (existing?.kind === 'own') return fail('contactIsOwnAddress')
  return OK
}

/**
 * validateContactAddress across every chain that shares one networkId (zcash
 * and zcash-shielded do): valid on any of them is a valid contact.
 */
export function validateContactOnNetwork(address: string, chains: ChainDef[], existing?: { kind: string } | null): ValidationResult {
  const fits = chains.find(c => validateAddress(address, c).valid) ?? chains[0]
  return fits ? validateContactAddress(address, fits, existing) : fail('invalidAddress')
}

/** Two spellings of one address: hex and bech32 ignore case, base58 does not; BCH's cashaddr prefix is optional. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const bare = (v: string) => /^bitcoincash:/i.test(v) ? v.slice('bitcoincash:'.length) : v
  const x = bare(a?.trim() || ''), y = bare(b?.trim() || '')
  if (!x || !y) return false
  const caseless = (v: string) => /^0x[0-9a-f]+$/i.test(v) || /^[a-z]{1,83}1[02-9ac-hj-np-z]+$/i.test(v)
  return caseless(x) && caseless(y) ? x.toLowerCase() === y.toLowerCase() : x === y
}
