// Provider-aware swap tracker URLs.
//
// Single source of truth for "given a swapper name + source tx hash, where
// can the user watch the swap settle?"
//
// THORChain / Maya / LI.FI can be looked up by the source-chain inbound hash.
// Aggregator routes that complete atomically (0x, Uniswap, 1inch, …) have no
// second leg — the source-chain Explorer link covers them, no provider tracker
// is shown.
// Relay needs its bytes32 request id, which vault now persists at trackSwap
// time (extracted from the deposit calldata) or backfills via api.relay.link.
// CoW / Across still return null (with a one-time console warn) until their
// equivalent IDs are plumbed through.

export type ProviderTracker = {
  url: string
  label: string
  iconUrl?: string
}

export type ProviderTrackerOpts = {
  /** Relay's bytes32 request id, when available. Required for the relay
   *  branch — falls through to null when missing so the lazy-backfill path
   *  in swap-tracker has time to populate it without flashing a dead link. */
  relayRequestId?: string
  /** NEAR transaction hash from 1Click /v0/status polling. Required for the
   *  NEAR Intents branch — falls through to null while polling is in flight. */
  nearTxHash?: string
}

const ICON = {
  thor: 'https://pioneers.dev/coins/thorchain.png',
  maya: 'https://pioneers.dev/coins/mayachain.png',
  near: 'https://pioneers.dev/coins/near.png',
  // Inline orange "R" badge — keeps the tracker button branded without
  // depending on Relay's CDN (which is bot-protected and 429s for this client).
  relay:
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#ff5b22"/><text x="32" y="42" font-family="-apple-system,system-ui,sans-serif" font-size="32" font-weight="700" text-anchor="middle" fill="#fff">R</text></svg>',
    ),
}

const ATOMIC_PROVIDERS = new Set([
  '0x', 'zeroex',
  'uniswap', 'univ2', 'univ3', 'univ4',
  '1inch', 'oneinch',
  'curve',
  'balancer',
  'sushiswap', 'sushi',
])

// Providers that still need a provider-side ID we don't surface yet.
const ID_BLOCKED_PROVIDERS = new Set([
  'cow', 'cowswap',
  'across',
])

const RELAY_KEYS = new Set(['relay', 'relaylink', 'relayexchange'])

function normalize(swapper: string | undefined | null): string {
  return (swapper || '').toLowerCase().replace(/[\s_.-]/g, '')
}

const _warned = new Set<string>()
function warnOnce(key: string, msg: string): void {
  if (_warned.has(key)) return
  _warned.add(key)
  try { console.warn('[trackers]', msg) } catch {}
}

/**
 * Return a provider-specific tracker link for a swap, or null when the
 * source-chain Explorer is sufficient (atomic providers) or when the
 * underlying protocol can't be resolved / needs an ID we don't surface yet.
 *
 * Vault renders the source Explorer link unconditionally, so null = "no
 * second leg to track."
 */
export function providerTrackerUrl(
  swapper: string | undefined | null,
  txid: string | undefined | null,
  opts?: ProviderTrackerOpts,
): ProviderTracker | null {
  if (!txid) return null
  const s = normalize(swapper)
  if (!s) return null

  if (s.includes('thor')) {
    const hash = txid.replace(/^0x/i, '').toUpperCase()
    return { url: `https://track.thorchain.org/${hash}`, label: 'THORChain Track', iconUrl: ICON.thor }
  }
  if (s.includes('maya')) {
    const hash = txid.replace(/^0x/i, '').toLowerCase()
    return { url: `https://www.mayascan.org/tx/${hash}`, label: 'Maya Track', iconUrl: ICON.maya }
  }
  if (s === 'lifi') {
    return { url: `https://scan.li.fi/tx/${txid}`, label: 'LI.FI Track' }
  }

  if (s.includes('near')) {
    const hash = opts?.nearTxHash
    if (!hash) return null // 1Click polling in flight; re-renders when it lands
    return { url: `https://nearblocks.io/txns/${hash}`, label: 'NEAR Intents Track', iconUrl: ICON.near }
  }

  if (RELAY_KEYS.has(s)) {
    const id = opts?.relayRequestId
    if (!id) return null // backfill in flight; UI re-renders when it lands
    return { url: `https://relay.link/transaction/${id}`, label: 'Relay Track', iconUrl: ICON.relay }
  }

  if (ATOMIC_PROVIDERS.has(s)) return null

  if (ID_BLOCKED_PROVIDERS.has(s)) {
    warnOnce(s, `${swapper}: tracker URL needs a provider-side ID Pioneer doesn't surface yet — using source Explorer only.`)
    return null
  }

  warnOnce(s, `Unknown swapper "${swapper}" — no provider tracker registered.`)
  return null
}
