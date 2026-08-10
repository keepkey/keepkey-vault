# Handoff: OP/ARB Icon CDN Update

**Context**: PR #181 (Vault dashboard redesign by sktbrd/xvlad) is ready to merge.
Vlad's PR description says he uploaded new brand-pack versions of the Optimism and
Arbitrum chain icons to the DigitalOcean Spaces bucket "out of band". The CDN edge
may have cached the old versions.

---

## Icon System Architecture

```
Vault app (AssetIcon component)
  → caipToIcon('eip155:10')
  → https://api.keepkey.info/coins/{base64(caip)}.png   ← Express on Cloudflare
  → 302 redirect →
    https://keepkey.sfo3.cdn.digitaloceanspaces.com/coins/{base64}.png
```

- **Bucket**: `keepkey` in DigitalOcean Spaces, region `sfo3`
- **Key pattern**: `coins/{base64url-no-padding(caip)}.png`
- **CDN endpoint**: `keepkey.sfo3.cdn.digitaloceanspaces.com`

The two files in question:

| Chain     | CAIP          | Spaces object key           |
|-----------|---------------|-----------------------------|
| Optimism  | `eip155:10`   | `coins/ZWlwMTU1OjEw.png`   |
| Arbitrum  | `eip155:42161`| `coins/ZWlwMTU1OjQyMTYx.png`|

---

## What Needs Doing

### Step 1 — Verify the new icons are in the bucket

Using the DO console or `doctl`:

```bash
doctl storage object list keepkey --region sfo3 | grep ZWlwMTU1Oj
```

Or via the DO web console: Spaces → keepkey → coins/ folder → check the two files
above exist and were recently modified (should show Vlad's upload timestamp).

If they're missing, go to Step 2a. If they exist, skip to Step 2b.

### Step 2a — Upload if missing

Get the official brand-pack icons:
- Optimism: https://cryptologos.cc/logos/optimism-ethereum-op-logo.png  
  (or official https://www.optimism.io/brand-kit — use the circular logo variant)
- Arbitrum: https://cryptologos.cc/logos/arbitrum-arb-logo.png  
  (or official https://arbitrum.io/logo — use the circular logo variant)

Upload with public-read ACL:

```bash
doctl storage object put keepkey \
  --region sfo3 \
  --acl public-read \
  --remote-path coins/ZWlwMTU1OjEw.png \
  optimism-logo.png

doctl storage object put keepkey \
  --region sfo3 \
  --acl public-read \
  --remote-path coins/ZWlwMTU1OjQyMTYx.png \
  arbitrum-logo.png
```

### Step 2b — Purge CDN cache

In the DO console: **Spaces → keepkey → CDN → Purge Cache**

Enter these paths (one per line):
```
coins/ZWlwMTU1OjEw.png
coins/ZWlwMTU1OjQyMTYx.png
```

Or via API:
```bash
# Get the CDN endpoint ID first
doctl cdn list

# Then purge
doctl cdn flush <cdn-id> --files "coins/ZWlwMTU1OjEw.png,coins/ZWlwMTU1OjQyMTYx.png"
```

### Step 3 — Verify

```bash
# Should return a PNG (not an AccessDenied XML error)
curl -I -L -A "Mozilla/5.0" \
  "https://api.keepkey.info/coins/ZWlwMTU1OjEw.png"

curl -I -L -A "Mozilla/5.0" \
  "https://api.keepkey.info/coins/ZWlwMTU1OjQyMTYx.png"
```

Look for `content-type: image/png` and `200 OK` at the final redirect destination.

---

## Impact if Skipped

PR #181 can be merged without this. If the CDN still serves old icons, users see
the previous OP/ARB logos until TTL expires naturally. Not a crash, just stale icons
for two chains. The `AssetIcon` component has a letter-bubble fallback if the image
fails entirely.

---

## Credentials

You need DO account access with Spaces write permissions for the `keepkey` bucket.
Check with whoever manages the keepkey DigitalOcean account (bithighlander@gmail.com).
