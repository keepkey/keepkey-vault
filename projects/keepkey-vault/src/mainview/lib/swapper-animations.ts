// Resolves a swapper/integration string to the GIF that should play in the
// route-map center node. Right now every swapper points at shifting.gif —
// the Motion-Fox mascot reads as "value moving through a routing layer"
// regardless of which DEX/aggregator is actually executing the leg.
//
// Per-provider GIFs (THORChain-specific, Relay-specific, etc.) can plug in
// here later by branching on the normalized swapper key.

import shiftingGif from "../assets/swap/shifting.gif"

function normalize(raw: string | undefined | null): string {
  return (raw || "").toLowerCase().replace(/[\s_.-]/g, "")
}

export function getSwapperAnimation(
  swapper?: string | null,
  integration?: string | null,
): string {
  // Resolve so we can branch on the canonical key when per-provider art lands.
  const _key = normalize(swapper) || normalize(integration)
  return shiftingGif
}
