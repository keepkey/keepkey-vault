# Handoff — Swap Provider Animation Set

**For:** content / motion-design agent
**Owner:** Vault swap UX
**Date:** 2026-05-10

## Project root

All paths in this handoff are absolute. The vault project root is:

```
/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/
```

## What this is for

The "Confirm" screen of every swap renders a centerpiece route map (`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/components/v3/RouteMap.tsx`): from-token → **swapper centerpiece** → to-token, with a gradient curve and a gold value-dot animating along the path. The centerpiece is the visual identity of the swap — it tells the user *who* is routing their value.

We need one branded looping animation per supported swapper. Until each lands we render the existing ShapeShift animation (`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/assets/swap/shifting.gif`) as the universal fallback.

## Production spec (every animation)

| Field | Value |
| --- | --- |
| Format | GIF (animated; transparent background or matched to the dark UI `#13131A` ink-2) |
| Dimensions | **256×256** (rendered at 128×128, supplied 2× for retina) |
| Frame rate | 24fps |
| Duration | 2.0–3.6s, **must seamlessly loop** |
| File size budget | ≤ 400 KB each (the centerpiece is on the swap-confirm critical path) |
| Safe area | Keep brand mark inside the inner 80% — the centerpiece is rendered inside an SVG circle clip-path |
| Motion vibe | Subtle continuous motion (rotation, pulse, particle drift). Avoid hard cuts or text — the SVG already prints the protocol name beneath |
| Color | Lead with the brand accent in the table below; respect each protocol's existing brand identity |

Place finished files at `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/assets/providers/animations/<key>.gif` using the **key** column below. Once a file exists, the wire-up in `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/lib/swapper-animations.ts` is a one-line `import` swap (replace `shapeshiftFallback` with `import x from "../assets/providers/animations/<key>.gif"`).

## Provider list — the centerpiece roster

Listed in priority order: native vault routes first (these are the largest swap volume), aggregator next, then the AMMs we surface as ShapeShift sub-routes.

### Tier 1 — native vault integrations (always shown)

| Key | Display label | Brand accent | Notes for the animation |
| --- | --- | --- | --- |
| `thorchain` | THORChain | `#33ff99` | Cross-chain native swaps. Existing brand: rune/diamond glyph, runic motifs. The dominant Bitcoin-side route. |
| `mayachain` | Maya | `#15c6c2` | Maya fork of Thor. Brand uses teal feathered/serpent motif. ZEC-on-Maya is a marquee route — keep the animation legible at small sizes. |

### Tier 2 — ShapeShift aggregator + executor

| Key | Display label | Brand accent | Notes |
| --- | --- | --- | --- |
| `shapeshift` | ShapeShift | `#386ff9` | The aggregator that surfaces most non-native routes. Branded fox / shifting motif. **Currently the universal fallback (`shifting.gif`) — when you produce a final ShapeShift centerpiece, drop it at `animations/shapeshift.gif` and update the fallback import.** |
| `relay` | Relay | `#ff5b22` | EVM cross-chain executor (Relay aggregator router on Ethereum). Brand: orange/red ripple wave. **This is what triggered the handoff — see screenshot showing a placeholder "REL" glyph.** |
| `0x` | 0x | `#000000` | EVM RFQ executor. Minimalist black/white brand. |
| `1inch` | 1inch | `#1f2937` | EVM aggregator. Brand: slate/red unicorn mark. |
| `cow` | CoW Swap | `#cb73a4` | Batch-auction executor. Brand: pink cow / "moo" motif. |
| `lifi` | LI.FI | `#f5b5fc` | Cross-chain aggregator. Brand: pink/lavender pyramid. |
| `chainflip` | Chainflip | `#46da93` | Native cross-chain (BTC/ETH/DOT/SOL). Brand: green chevrons. |
| `across` | Across | `#6cf9d8` | Cross-chain bridge. Brand: cyan/teal. |

### Tier 3 — AMMs (surfaced via ShapeShift)

| Key | Display label | Brand accent | Notes |
| --- | --- | --- | --- |
| `uniswap` | Uniswap | `#ff007a` | EVM AMM. Brand: pink unicorn. |
| `curve` | Curve | `#a4c8ff` | Stable-pair AMM. Brand: rainbow gradients on dark. |
| `balancer` | Balancer | `#536dfe` | Multi-asset AMM. Brand: blue B / petals. |
| `sushi` | Sushi | `#fa52a0` | EVM AMM. Brand: pink sushi/cat. |

## Resolution rules (so the right animation plays)

The picker normalizes the swapper string with `lowercase + strip [\s_.-]` and then matches:

- `*thor*` → `thorchain`
- `*maya*` → `mayachain`
- `relay` / `relaylink` / `relayexchange` → `relay`
- `shapeshift` / `ss` / `ssquote` → `shapeshift`
- `0x` / `zeroex` → `0x`
- `uniswap` / starts with `univ` → `uniswap`
- `oneinch` / `1inch` → `1inch`
- `cow` / `cowswap` → `cow`
- `lifi` / `lifip` / `lifiquote` → `lifi`
- `chainflip` / `cf` → `chainflip`
- `across` → `across`
- `curve` / `curvefi` → `curve`
- `balancer` → `balancer`
- `sushi` / `sushiswap` → `sushi`

Anything that doesn't match falls back to `shapeshift` (which itself currently falls back to `shifting.gif`). When a quote arrives with both `swapper` and `integration`, `swapper` wins — that's the actual executor.

## Source-of-truth references

- Provider brand registry (logos + accents): `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/components/ProviderBadge.tsx`
- Animation registry (where the new files plug in): `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/lib/swapper-animations.ts`
- Centerpiece component: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/components/v3/RouteMap.tsx`
- Call site (RouteMap usage in the Confirm screen): `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/components/SwapDialog.tsx`
- Existing fallback: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/assets/swap/shifting.gif`

## Drop-in checklist

1. Save GIF as `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/assets/providers/animations/<key>.gif` using the table key.
2. In `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/lib/swapper-animations.ts`, replace `shapeshiftFallback` on that key's row with `import branded from "../assets/providers/animations/<key>.gif"`, then reference `branded`.
3. Verify on a real swap (Confirm screen, rendered by `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/mainview/components/SwapDialog.tsx`) — the integration label below the centerpiece should match the animation; the gold value-dot should still travel through cleanly.

That's the whole loop — once the assets exist the wire-up is mechanical.
