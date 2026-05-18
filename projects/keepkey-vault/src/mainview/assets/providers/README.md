# Swap provider badges

Used by `<ProviderBadge>` (`src/mainview/components/ProviderBadge.tsx`) to identify
the routing provider in quote, pre-sign, in-flight, and history surfaces.

All marks shown are property of their respective owners. Used here for partner
attribution / nominative identification of the actual service routing the swap.

| File | Source | Format |
|---|---|---|
| `thorchain.png` | pioneers.dev | PNG, downsampled to 64px |
| `mayachain.png` | pioneers.dev | PNG, downsampled to 64px |
| `0x.png` | pioneers.dev | PNG, downsampled to 64px |
| `uniswap.png` | pioneers.dev | PNG, downsampled to 64px |
| `1inch.png` | pioneers.dev | PNG, downsampled to 64px |
| `cow.png` | pioneers.dev | PNG, downsampled to 64px |
| `balancer.png` | pioneers.dev | PNG, downsampled to 64px |
| `sushi.png` | pioneers.dev | PNG, downsampled to 64px |
| `relay.svg` | monogram fallback | SVG, brand color + letter |
| `shapeshift.svg` | monogram fallback | SVG, brand color + letter |
| `lifi.svg` | monogram fallback | SVG, brand color + letters |
| `chainflip.svg` | monogram fallback | SVG, brand color + letter |
| `across.svg` | monogram fallback | SVG, brand color + letter |
| `curve.svg` | monogram fallback | SVG, brand color + letter |

## Replacing a monogram with an official mark

To swap in an officially-licensed brand asset, drop the file at the same path
(matching name + extension if SVG, or update the import in `ProviderBadge.tsx`).
Keep PNGs at 64×64 max — badges render at 12–40 px so anything larger is bloat.

## Optimization

```bash
magick in.png -resize 64x64 -strip out.tmp.png
pngquant --force --quality 65-85 --speed 1 --output out.png out.tmp.png
```

Target <8 KB per file; current set is all <3 KB.
