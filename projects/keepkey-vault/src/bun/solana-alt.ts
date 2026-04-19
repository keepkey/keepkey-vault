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
 *     discriminator      :  4 bytes  (program-enum tag, normally 1 for initialized)
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
 * We don't validate authority or deactivation_slot here — decoders are
 * information-only (what addresses does this ALT currently list?), and we
 * already gave the user a clear-signing preview backed by the same RPC they
 * trust for broadcast. If deactivation is a concern, a follow-up can surface
 * it in the UI.
 */

import bs58 from 'bs58'

export const ALT_HEADER_LEN = 56

export class SolanaAltResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolanaAltResolveError'
  }
}

/**
 * Parse an ALT account's raw bytes into the list of base58-encoded pubkeys
 * it stores. Throws {@link SolanaAltResolveError} when the layout doesn't
 * match (not an ALT account, corrupt trailing bytes, etc.).
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
  const addresses: string[] = []
  for (let off = ALT_HEADER_LEN; off < bytes.length; off += 32) {
    addresses.push(bs58.encode(bytes.subarray(off, off + 32)))
  }
  return addresses
}

/**
 * Minimal fetcher abstraction so tests can inject a fake RPC responder
 * without network. Must return the account data as raw bytes for each ALT,
 * in the same order as the input, with `null` where the account wasn't
 * found.
 */
export type AltAccountFetcher = (altPubkeysBase58: string[]) => Promise<(Uint8Array | null)[]>

/**
 * Build an `AltAccountFetcher` backed by a Solana JSON-RPC endpoint using
 * the standard `getMultipleAccounts` method with base64 encoding.
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
    const body = await res.json() as { error?: { message: string }; result?: { value?: Array<{ data: [string, string] } | null> } }
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
      return Uint8Array.from(Buffer.from(b64, 'base64'))
    })
  }
}

/**
 * Resolve a list of ALT pubkeys to their address arrays. Returns a Map
 * keyed by base58 ALT pubkey; missing or malformed ALTs are omitted (the
 * caller decides whether to error or fall back to a warning).
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
    const data = accounts[i]
    if (!data) continue
    try {
      out.set(altPubkeysBase58[i], parseAltAccountData(data))
    } catch {
      // Skip malformed entries — caller decides whether a missing ALT is fatal.
    }
  }
  return out
}

export const DEFAULT_SOLANA_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com'
