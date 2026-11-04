import bs58 from 'bs58'

import type { ParsedSolanaMessage } from './solana-tx'
import { SolanaAltResolveError, resolveAlts, type AltAccountFetcher } from './solana-alt'
import { versionCompare } from '../shared/firmware-versions'

/**
 * Canonical LUT account resolution for the certified Solana ClearSign path.
 *
 * Firmware's KKSOLSW1 attestation preimage requires the resolved accounts in
 * exactly the Solana runtime's own order: all writable lookup keys first,
 * then all readonly lookup keys, walking the message's `address table
 * lookups` (ALT entries) in their on-wire order, and each entry's indices in
 * their own order. This mirrors `message.addressTableLookups` resolution in
 * the Solana runtime itself — never reorder by instruction usage, and never
 * accept extra keys the message doesn't actually reference (either would let
 * a resolved account silently apply to the wrong instruction slot).
 *
 * Firmware's current cap is 8 accounts total (SOL_MAX_LUT_ACCOUNTS).
 */

export const SOL_MAX_LUT_ACCOUNTS = 8

/**
 * Firmware 7.17.0+ also accepts the host's own resolution with no signature
 * (SolanaSignTx.lut_account alone): it decodes the instructions, marks every
 * resolved key "from lookup table, not verified by KeepKey", and keeps the
 * blind-sign gate. Up to 64 accounts, static plus resolved.
 */
export const HOST_LUT_ACCOUNTS_MIN_FW = '7.17.0'
export const SOL_MAX_HOST_LUT_ACCOUNTS = 64

/** Unknown firmware counts as unsupported. Before 7.17 the device ignores a
 * short unsigned list and cannot decode one over 8 keys. */
export function supportsHostLutAccounts(firmwareVersion?: string): boolean {
  return !!firmwareVersion && versionCompare(firmwareVersion, HOST_LUT_ACCOUNTS_MIN_FW) >= 0
}

export class SolanaLutCanonicalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolanaLutCanonicalizationError'
  }
}

export interface CanonicalLutResolution {
  /** Raw 32-byte account keys, writable-then-readonly, in canonical order. */
  accounts: Buffer[]
  writableCount: number
  readonlyCount: number
}

/**
 * Resolve every ALT entry in a parsed v0 message to the canonical account
 * list firmware will attest and bind to. Throws on anything that would make
 * the certified proof ambiguous or wrong: a missing/unresolvable table, an
 * index the table doesn't have, a duplicate resolved key, or a count over
 * the firmware cap.
 */
export async function resolveCanonicalLutAccounts(
  message: ParsedSolanaMessage,
  fetcher: AltAccountFetcher,
  maxAccounts = SOL_MAX_LUT_ACCOUNTS,
): Promise<CanonicalLutResolution> {
  if (message.altEntries.length === 0) {
    throw new SolanaLutCanonicalizationError('message has no address table lookups to resolve')
  }

  const tableKeysBase58 = message.altEntries.map((entry) => bs58.encode(entry.accountKey))
  const resolved = await resolveAlts(tableKeysBase58, fetcher)

  const writable: Buffer[] = []
  const readonly: Buffer[] = []
  const seen = new Set<string>()

  for (let i = 0; i < message.altEntries.length; i++) {
    const entry = message.altEntries[i]
    const tableKey = tableKeysBase58[i]
    const addresses = resolved.get(tableKey)
    if (!addresses) {
      throw new SolanaAltResolveError(
        `lookup table ${tableKey} is missing, inactive, or not owned by the ALT program`,
      )
    }

    for (const idx of entry.writableIndices) {
      if (idx < 0 || idx >= addresses.length) {
        throw new SolanaAltResolveError(`lookup table ${tableKey}: writable index ${idx} out of range (table has ${addresses.length})`)
      }
      const key = addresses[idx]
      if (seen.has(key)) throw new SolanaLutCanonicalizationError(`account ${key} resolved more than once (ambiguous)`)
      seen.add(key)
      writable.push(Buffer.from(bs58.decode(key)))
    }
    for (const idx of entry.readonlyIndices) {
      if (idx < 0 || idx >= addresses.length) {
        throw new SolanaAltResolveError(`lookup table ${tableKey}: readonly index ${idx} out of range (table has ${addresses.length})`)
      }
      const key = addresses[idx]
      if (seen.has(key)) throw new SolanaLutCanonicalizationError(`account ${key} resolved more than once (ambiguous)`)
      seen.add(key)
      readonly.push(Buffer.from(bs58.decode(key)))
    }
  }

  const accounts = [...writable, ...readonly]
  if (accounts.length === 0) {
    throw new SolanaLutCanonicalizationError('address table lookups resolved to zero accounts')
  }
  if (accounts.length > maxAccounts) {
    throw new SolanaLutCanonicalizationError(
      `resolved ${accounts.length} lookup accounts, exceeding firmware's ${maxAccounts}-account cap`,
    )
  }
  return { accounts, writableCount: writable.length, readonlyCount: readonly.length }
}
