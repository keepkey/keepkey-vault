// Provider-aware swap tracker URLs.
//
// Single source of truth for "given a swapper name + source tx hash, where
// can the user watch the swap settle?"
//
// THORChain / Maya / LI.FI can be looked up by the source-chain inbound hash.
// Aggregator routes that complete atomically (0x, Uniswap, 1inch, …) have no
// second leg — the source-chain Explorer link covers them, no provider tracker
// is shown.
// Some providers (Relay, CoW, Across) need a provider-side quote/order ID
// that Pioneer doesn't yet plumb through CreatePendingSwap. Those return null
// (with a one-time console warn) until the Pioneer side lands.

export type ProviderTracker = {
  url: string
  label: string
  iconUrl?: string
}

const ICON = {
  thor: 'https://pioneers.dev/coins/thorchain.png',
  maya: 'https://pioneers.dev/coins/mayachain.png',
}

const ATOMIC_PROVIDERS = new Set([
  '0x', 'zeroex',
  'uniswap', 'univ2', 'univ3', 'univ4',
  '1inch', 'oneinch',
  'curve',
  'balancer',
  'sushiswap', 'sushi',
])

const ID_BLOCKED_PROVIDERS = new Set([
  'relay',
  'cow', 'cowswap',
  'across',
])

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

  if (ATOMIC_PROVIDERS.has(s)) return null

  if (ID_BLOCKED_PROVIDERS.has(s)) {
    warnOnce(s, `${swapper}: tracker URL needs a provider-side ID Pioneer doesn't surface yet — using source Explorer only.`)
    return null
  }

  warnOnce(s, `Unknown swapper "${swapper}" — no provider tracker registered.`)
  return null
}
