# 10 — RUJI dashboard icon (CDN)

**What:** RUJI showed a broken "?" icon on the dashboard. Two causes: (1) the
icon was never uploaded to the coin-icon CDN, and (2) `assetData.json` keyed RUJI
under the old CAIP (`cosmos:thorchain-1/slip44:ruji`) while the runtime CAIP is
`cosmos:thorchain-mainnet-v1/denom:x/ruji`. Uploaded `ruji.png` to DO Spaces
under **both** base64 keys (200 now).

**Where:** CDN only (no code change). Source PNG:
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-website-v7/public/images/chains/ruji.png`.
CDN keys: `coins/Y29zbW9zOnRob3JjaGFpbi1tYWlubmV0LXYxL2Rlbm9tOngvcnVqaQ.png` +
`coins/Y29zbW9zOnRob3JjaGFpbi0xL3NsaXA0NDpydWpp.png`.

## Test / Verify
- [ ] `curl -sIL https://api.keepkey.info/coins/Y29zbW9zOnRob3JjaGFpbi1tYWlubmV0LXYxL2Rlbm9tOngvcnVqaQ.png`
      → 200 image/png (both keys).
- [ ] RUJI shows its real logo on the Vault dashboard (no "?" box) — next load,
      no rebuild needed.

## Status / gotchas
- Dashboard `<Image>` tags have no `onError` fallback (unlike `AssetIcon.tsx`) →
  a missing CDN icon renders the browser's raw broken-image glyph. Separate
  follow-up if you want a graceful letter-bubble there too.
</content>
