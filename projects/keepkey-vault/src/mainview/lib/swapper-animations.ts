// Resolves a swapper/integration string to the GIF that plays in the
// route-map center node. Pre-signing (Confirm Quote) is "thinking" — the
// calculating gif — because at this point we're previewing a route, not
// moving anything yet. Post-signing (Submitted) uses shifting.gif from
// the SwapDialog directly. Per-provider art can branch here later.

import calculatingGif from "../assets/swap/calculating.gif"
import relayLogo from "../assets/providers/relay.svg"

function normalize(raw: string | undefined | null): string {
  return (raw || "").toLowerCase().replace(/[\s_.-]/g, "")
}

export function getSwapperAnimation(
  swapper?: string | null,
  integration?: string | null,
): string {
  const key = normalize(swapper) || normalize(integration)
  // SVG provider marks are inlined by Vite, so they remain reliable inside
  // WKWebView's SVG foreignObject. Emitted GIF URLs can be unavailable under
  // the packaged views:// scheme and must not leave a broken-image glyph.
  if (key === "relay" || key === "relaylink" || key === "relayexchange") return relayLogo
  return calculatingGif
}
