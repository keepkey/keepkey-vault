# CDN icon backfill

Vault asks `https://api.keepkey.info/coins/<base64(caip)>.png` for every asset
without a bundled logo; that redirects to the DigitalOcean Spaces bucket
`keepkey` (sfo3) at `coins/<base64(caip), no padding>.png`. When the object is
missing the bucket answers **403 AccessDenied** and the UI falls back to the
letter avatar.

These scripts find those gaps, collect the logos from public sources, and
upload them. Only the last step needs bucket credentials.

| Step | Script | Needs creds |
|---|---|---|
| 1. Find missing logos | `node scripts/cdn-icons/scan.ts` → `missing.json` | no |
| 2. Collect + normalize | `python3 scripts/cdn-icons/collect.py` → `icons/`, `manifest.json`, `unresolved.json` | no |
| 2b. Placeholders for the rest | `uv run --no-project --with pillow python scripts/cdn-icons/generic.py` → `generic/`, `manifest-generic.json` | no |
| 3. Upload | `bun run scripts/cdn-icons/upload.ts` (dry run), then `--apply` | **yes** (`DO_SPACES_KEY`, `DO_SPACES_SECRET` in `.env`) |
| 4. Verify | `node scripts/cdn-icons/scan.ts --from scripts/cdn-icons/missing.json` (exit 0 = no failures), and `--sample 300` to re-run the audit sample | no |

`icons/`, `generic/`, the two manifests and `unresolved.json` in this PR are the
output of steps 1–2b, so step 3 can run directly.

## Notes

- `scan.ts` mirrors `caipToIcon()` in
  `projects/keepkey-vault/src/shared/assetLookup.ts` (bundled icons, explicit
  `icon` fields and `ICON_CAIP_ALIASES` are excluded/applied). Keep the two in
  sync.
- Every collected image is re-encoded as a real 128×128 PNG, so nothing goes
  up as a JPEG under `.png` again.
- `upload.ts` checks each file against the sha256 in `manifest.json`, never
  overwrites an existing object, and uploads with `content-type: image/png`.
- Existing objects are never touched. If step 4 still shows 403 for keys the
  upload reported as done, the CDN edge cached the old 403: purge those paths
  (see `docs/handoff-cdn-icon-purge.md`).
- `unresolved.json` lists assets with no public logo, plus any download that
  failed. `generic.py` gives each of them a grey disc with the symbol's
  initial (same look as the app's letter fallback), so nothing 403s.
- A placeholder on the bucket blocks a real logo later, because uploads never
  overwrite. To swap one, delete that object and upload the real file.
- `collect.py --workers 2` keeps the IPFS gateways from rate-limiting (429)
  on retries; chain icons fall back to DefiLlama's mirror (`icons.llamao.fi`).
