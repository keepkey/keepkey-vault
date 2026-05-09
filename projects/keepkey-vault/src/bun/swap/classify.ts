/**
 * classifySwapOutcome — pure function. Given a Midgard /v2/actions response
 * (Maya or THORChain), produce a truthful classification of what happened.
 *
 * Replaces the Pioneer-trusting `mapPioneerStatus` for the slice we care about.
 * The bug we're closing: a refund returns Pioneer status='completed' but
 * Midgard's action.type='refund' — the truth lives in Midgard. The same
 * mismatch makes us key the explorer URL on `toAsset.chainId` instead of the
 * action's actual outbound chain (refunds outbound on the source chain, not
 * the destination).
 *
 * Pure: no fetches, no side effects, deterministic given the input JSON.
 * Test against real captured fixtures in __tests__/fixtures/swap/.
 */

import { CHAINS } from '../../shared/chains'

export type ClassifiedStatus = 'pending' | 'completed' | 'refunded' | 'failed' | 'unknown'

export interface ClassifiedOutcome {
  status: ClassifiedStatus
  /** Hash of the inbound (user-signed) tx, if discoverable from the action. */
  inboundTxid: string | null
  /** Hash of the outbound (vault-sent) tx — refund hash for refunds, delivery hash for completions. */
  outboundTxid: string | null
  /** Maya/Thor asset string for the outbound, e.g. "ETH.ETH" or "ZEC.ZEC". */
  outboundAsset: string | null
  /** vault chain id (e.g. 'ethereum', 'zcash') for the outbound — keys getExplorerTxUrl. */
  outboundChainId: string | null
  /** Outbound amount in Maya 8-decimal base units (string to avoid float loss). */
  outboundAmount: string | null
  /** Reason text from refund metadata, if present. */
  refundReason: string | null
}

const UNKNOWN: ClassifiedOutcome = {
  status: 'unknown',
  inboundTxid: null,
  outboundTxid: null,
  outboundAsset: null,
  outboundChainId: null,
  outboundAmount: null,
  refundReason: null,
}

/**
 * Map a Maya/Thor asset prefix ("ETH", "ZEC", "BTC", …) to the vault's
 * internal chain id used for explorer URL lookup. Falls back to null if
 * unknown — caller should suppress the explorer link rather than guess.
 */
function assetPrefixToChainId(prefix: string): string | null {
  const sym = prefix.toUpperCase()
  // Try symbol first (matches "BTC", "ZEC", "ETH", etc.)
  const bySymbol = CHAINS.find(c => c.symbol === sym)
  if (bySymbol) return bySymbol.id
  // Then by Maya/Thor "chain" enum value (covers "GAIA"→cosmos, "THOR"→thorchain)
  const byChain = CHAINS.find(c => (c.chain as string) === sym)
  if (byChain) return byChain.id
  // Maya-specific overrides where their naming differs from ours
  switch (sym) {
    case 'GAIA': return 'cosmos'
    case 'THOR': return 'thorchain'
    case 'MAYA': return 'mayachain'
    default: return null
  }
}

/**
 * Extract the chain prefix from a Maya/Thor asset string.
 * Maya uses two separators interchangeably:
 *  - `.` for native assets ("ETH.ETH", "ETH.USDT-0xdac17...", "BTC.BTC")
 *  - `~` for synthetic/trade pool assets ("ZEC~ZEC", "BTC~BTC")
 * Both forms appear in Midgard responses for the same chain — handle both.
 */
function chainPrefixFromAsset(asset: string): string | null {
  if (!asset) return null
  const sep = asset.search(/[.~]/)
  if (sep < 0) return null
  return asset.slice(0, sep)
}

// ─── Subset of Midgard /v2/actions response we actually consume ───
// Defined narrowly so future fields don't accidentally tighten the contract.

interface MidgardCoin { amount: string; asset: string }
interface MidgardLeg { address?: string; coins: MidgardCoin[]; txID: string; height?: string }
interface MidgardAction {
  type?: string                  // 'swap' | 'refund' | …
  status?: string                // 'success' | 'pending' | …
  in?: MidgardLeg[]
  out?: MidgardLeg[]
  metadata?: {
    refund?: { reason?: string; memo?: string }
    swap?: { memo?: string }
  }
}
export interface MidgardActionsResponse {
  actions?: MidgardAction[]
  count?: string
}

/**
 * Given a Midgard /v2/actions response, classify the outcome of the swap.
 *
 * Convention: we only look at `actions[0]`. Midgard returns at most one action
 * per inbound txid; if multiple actions are returned the consumer asked for a
 * different scope (and should pass them in one at a time).
 */
export function classifySwapOutcome(response: MidgardActionsResponse | null | undefined): ClassifiedOutcome {
  if (!response?.actions?.length) return UNKNOWN
  const action = response.actions[0]
  if (!action) return UNKNOWN

  const inboundTxid = action.in?.[0]?.txID ?? null
  const outboundLeg = action.out?.[0] ?? null
  const outboundCoin = outboundLeg?.coins?.[0] ?? null
  const outboundAsset = outboundCoin?.asset ?? null
  const outboundAmount = outboundCoin?.amount ?? null
  const outboundTxid = outboundLeg?.txID ?? null
  const outboundChainId = outboundAsset
    ? assetPrefixToChainId(chainPrefixFromAsset(outboundAsset) || '')
    : null

  const type = (action.type || '').toLowerCase()
  const remoteStatus = (action.status || '').toLowerCase()

  // Refund is the loud-case we keep getting wrong. Detect even when status
  // is 'success' — Midgard reports "refund completed successfully", which
  // we previously mapped to 'completed' and rendered with a green check.
  if (type === 'refund') {
    return {
      status: remoteStatus === 'pending' ? 'pending' : 'refunded',
      inboundTxid,
      outboundTxid,
      outboundAsset,
      outboundChainId,
      outboundAmount,
      refundReason: cleanRefundReason(action.metadata?.refund?.reason ?? null),
    }
  }

  if (type === 'swap') {
    // 'pending' => inbound observed, no outbound yet
    if (remoteStatus === 'pending' || !outboundLeg) {
      return {
        status: 'pending',
        inboundTxid,
        outboundTxid: null,
        outboundAsset: null,
        outboundChainId: null,
        outboundAmount: null,
        refundReason: null,
      }
    }
    if (remoteStatus === 'success') {
      return {
        status: 'completed',
        inboundTxid,
        outboundTxid,
        outboundAsset,
        outboundChainId,
        outboundAmount,
        refundReason: null,
      }
    }
  }

  return { ...UNKNOWN, inboundTxid }
}

/**
 * Midgard prefixes refund reason strings with "MidgardBadUTF8EncodedBase64:"
 * when they contain non-UTF-8 bytes (typically EVM calldata blobs in the
 * memo). Strip the prefix so the surfaced reason is at least readable; the
 * raw blob isn't useful to a user anyway.
 */
function cleanRefundReason(raw: string | null): string | null {
  if (!raw) return null
  return raw.replace(/^MidgardBadUTF8EncodedBase64:\s*/, '').trim() || null
}
