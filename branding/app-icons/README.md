# KeepKey app-icon family

One shared black wordmark tile, one badge per product. The badge sits in the
corner where the original pie chart lived.

| Icon | Badge |
| --- | --- |
| `keepkey-main.png` | none — base wordmark |
| `keepkey-vault.png` | gold laptop, blue pie chart on screen |
| `keepkey-vault-btc.png` | gold laptop, solid orange disc (BTC-only holds one asset, so no pie) |
| `keepkey-bex.png` | gold generalized browser mark (browser extension) |
| `keepkey-mobile.png` | gold phone (mobile companion) |

All masters are 512×512 PNG with transparent rounded corners.

## Size-aware rendering

Desktop icons are pre-rendered at every slot the OS uses rather than letting it
downscale one master (which mangles thin strokes). Each size is resampled with
Lanczos.

- **≥ 48 px** — full wordmark tile with the corner badge.
- **≤ 32 px** — the wordmark is dropped and the glyph alone fills the tile, so
  each app stays identifiable where text can no longer survive.

The Vault app icon in `../../projects/keepkey-vault/icon.iconset/` already bakes
this split in: the 16, 16@2x and 32 slots are glyph-only; 32@2x and up carry the
wordmark. `electrobun.config.ts` consumes that `.iconset` directly, so the
per-size variants ship as authored — do not regenerate the iconset from a single
master or the split is lost.

## Glyph masters

`laptop-vault-glyph.svg`, `laptop-btc-glyph.svg`, `browser-glyph.svg` and
`phone-glyph.svg` are the 24×24 badge sources, for rescaling or recoloring.

## Other products

`keepkey-vault-btc.*` (icns / ico / iconset) are ready for a BTC-only build.
`keepkey-bex.png` and `keepkey-mobile.png` are the app icons for the browser
extension and mobile companion, kept here so the family stays in one place.
