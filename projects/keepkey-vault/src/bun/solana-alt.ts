/**
 * Solana Address Lookup Table (ALT) resolver.
 *
 * V0 transactions reference accounts by (ALT_pubkey, index_in_ALT) instead of
 * listing every account inline. Clear-signing needs the real pubkeys to show
 * the user what they're signing, so before rendering the instruction list we
 * fetch each referenced ALT via Solana's `getMultipleAccounts` RPC and index
 * into its address array.
 *
 * ALT account layout (see
 * `solana-sdk/address-lookup-table/program/src/state.rs`):
 *
 *     discriminator      :  4 bytes  (program-enum tag, 1 = LookupTable, 0 = Uninitialized)
 *     deactivation_slot  :  8 bytes  (u64 LE — Slot)
 *     last_extended_slot :  8 bytes  (u64 LE)
 *     last_extended_slot_start_index : 1 byte
 *     authority_option   :  1 byte   (0 = none, 1 = Some)
 *     authority          : 32 bytes  (present regardless — zeros when option=0)
 *     padding            :  2 bytes  (align to 56)
 *     addresses          :  N * 32 bytes  (the lookup array itself)
 *
 * The fixed header is **56 bytes**; addresses follow contiguously to the end
 * of the account. Validators enforce that the data length past offset 56 is a
 * multiple of 32 — we enforce the same, because a non-multiple would mean the
 * ALT is corrupt or we're reading the wrong account type.
 *
 * Ownership check: a valid ALT account is owned by the Address Lookup Table
 * program. Without this check, any account that happens to have the right
 * length (56 + 32N) would be accepted and the approval UI would render
 * attacker-controlled bytes as "resolved accounts". So we fetch the owner
 * alongside the data and reject anything not owned by {@link ALT_PROGRAM_ID}.
 *
 * We don't validate authority or deactivation_slot in the UI sense —
 * decoders are information-only. If deactivation is a concern, a follow-up
 * can surface it in the preview.
 */

import bs58 from 'bs58'

export const ALT_HEADER_LEN = 56

/** Base58 pubkey of Solana's Address Lookup Table program. */
export const ALT_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111'

/** Discriminator tag for the `LookupTable` variant of the ALT program state. */
export const ALT_DISCRIMINATOR_LOOKUP_TABLE = 1

/** A single account returned by the fetcher. Owner is base58-encoded. */
export interface AltAccountData {
  data: Uint8Array
  owner: string
}

export class SolanaAltResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolanaAltResolveError'
  }
}

/**
 * Parse an ALT account's raw bytes into the list of base58-encoded pubkeys
 * it stores. Throws {@link SolanaAltResolveError} when the layout doesn't
 * match (wrong discriminator, impossible option tag, corrupt trailing
 * bytes, etc.).
 *
 * The caller is responsible for verifying the account owner before calling
 * this — see {@link resolveAlts}.
 */
export function parseAltAccountData(bytes: Uint8Array): string[] {
  if (bytes.length < ALT_HEADER_LEN) {
    throw new SolanaAltResolveError(
      `ALT account too short: ${bytes.length}B < ${ALT_HEADER_LEN}B header`,
    )
  }
  const addrBytes = bytes.length - ALT_HEADER_LEN
  if (addrBytes % 32 !== 0) {
    throw new SolanaAltResolveError(
      `ALT account body length ${addrBytes}B is not a multiple of 32`,
    )
  }
  // Discriminator is a u32 LE bincode enum tag. LookupTable = 1.
  const discriminator =
    bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  if (discriminator !== ALT_DISCRIMINATOR_LOOKUP_TABLE) {
    throw new SolanaAltResolveError(
      `ALT discriminator ${discriminator} ≠ LookupTable (${ALT_DISCRIMINATOR_LOOKUP_TABLE})`,
    )
  }
  // authority_option (bincode Option tag) must be 0 or 1 — any other value
  // means we're reading the wrong account type.
  const authorityOption = bytes[21]
  if (authorityOption !== 0 && authorityOption !== 1) {
    throw new SolanaAltResolveError(
      `ALT authority_option byte ${authorityOption} is not a valid Option tag`,
    )
  }
  const addresses: string[] = []
  for (let off = ALT_HEADER_LEN; off < bytes.length; off += 32) {
    addresses.push(bs58.encode(bytes.subarray(off, off + 32)))
  }
  return addresses
}

/**
 * Minimal fetcher abstraction so tests can inject a fake RPC responder
 * without network. Must return {@link AltAccountData} (including the owner
 * pubkey) for each input, in the same order, with `null` where the account
 * wasn't found.
 */
export type AltAccountFetcher = (altPubkeysBase58: string[]) => Promise<(AltAccountData | null)[]>

/**
 * Build an `AltAccountFetcher` backed by a Solana JSON-RPC endpoint using
 * the standard `getMultipleAccounts` method with base64 encoding. The
 * response's `owner` field is returned alongside the data so
 * {@link resolveAlts} can reject anything not owned by the ALT program.
 */
export function createRpcAltFetcher(endpoint: string): AltAccountFetcher {
  return async (altPubkeysBase58: string[]) => {
    if (altPubkeysBase58.length === 0) return []
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getMultipleAccounts',
        params: [altPubkeysBase58, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    })
    if (!res.ok) {
      throw new SolanaAltResolveError(`Solana RPC ${endpoint} returned HTTP ${res.status}`)
    }
    const body = await res.json() as {
      error?: { message: string }
      result?: { value?: Array<{ data: [string, string]; owner: string } | null> }
    }
    if (body.error) {
      throw new SolanaAltResolveError(`Solana RPC error: ${body.error.message}`)
    }
    const value = body.result?.value ?? []
    return value.map((v) => {
      if (!v || !v.data) return null
      const [b64, encoding] = v.data
      if (encoding !== 'base64') {
        throw new SolanaAltResolveError(`Unexpected ALT account encoding: ${encoding}`)
      }
      return {
        data: Uint8Array.from(Buffer.from(b64, 'base64')),
        owner: v.owner,
      }
    })
  }
}

/**
 * Resolve a list of ALT pubkeys to their address arrays. Returns a Map
 * keyed by base58 ALT pubkey; missing, non-ALT-owned, or malformed ALTs
 * are omitted (the caller decides whether to error or surface a warning).
 *
 * Ownership verification is *required* for safety: without it, a v0
 * transaction could point at any attacker-controlled account whose length
 * happens to be 56 + 32N and the approval preview would render attacker
 * bytes as "resolved accounts".
 */
export async function resolveAlts(
  altPubkeysBase58: string[],
  fetcher: AltAccountFetcher,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (altPubkeysBase58.length === 0) return out
  const accounts = await fetcher(altPubkeysBase58)
  if (accounts.length !== altPubkeysBase58.length) {
    throw new SolanaAltResolveError(
      `Fetcher returned ${accounts.length} accounts, expected ${altPubkeysBase58.length}`,
    )
  }
  for (let i = 0; i < altPubkeysBase58.length; i++) {
    const acct = accounts[i]
    if (!acct) continue
    if (acct.owner !== ALT_PROGRAM_ID) continue
    try {
      out.set(altPubkeysBase58[i], parseAltAccountData(acct.data))
    } catch {
      // Skip malformed entries — caller decides whether a missing ALT is fatal.
    }
  }
  return out
}

export const DEFAULT_SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com'
