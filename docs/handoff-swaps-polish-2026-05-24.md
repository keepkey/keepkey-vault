# Handoff: Swaps Polish — 2026-05-24

Branch: `swaps-polish`

---

## State of the World (REST API audit)

```
GET /api/health           → healthy, device connected, version 1.3.6
GET /api/v1/swaps/stats   → total=19, completed=6, failed=3, refunded=0, pending=10
GET /api/debug/portfolio  → 27 chains cached, totalUsd=~$27.44 (BTC=0, no ZEC)
GET /api/portfolio        → STUB — returns total_value_usd=0, "not implemented"
```

**10 of 19 swaps are stuck "pending"** — old swaps that completed on-chain but were never
resolved in the DB. No cleanup job exists.

---

## Active In-Flight Swaps (the user's real funds)

### Swap 1: BTC → ZEC via NEAR Intents
```
txid:        e7f13f90d57e38bac074dcda2d4eb2afe2dfbb518f580c3aec42e0a6a1d6ad3f
fromAmount:  0.00077858 BTC
toAmount:    ~0.0893 ZEC (quoted)
status:      pending (DB) — PENDING_DEPOSIT (1Click)
inbound:     bc1q7c5zyutyscc0gmn4espvf874ltzc49y6dk6a3t
deadline:    2026-05-27T19:11:17Z (valid, 3 days out)
```
**1Click hasn't received the BTC yet** — the tx was broadcast but needs on-chain
confirmations before 1Click detects the deposit. Once confirmed (~6 BTC blocks),
1Click will process it and `nearTxHashes` will populate.

The 0.00077858 BTC shows as ZERO in the dashboard because Pioneer returned zero
(BTC was spent on-chain). The user sees missing funds with no explanation.

### Swap 2: ETH → BTC via NEAR Intents
```
txid:        0x9db8c9af57679711b8209258f89172b00804c7e7b2c4e11e7d345f5a9ca0801d
fromAmount:  0.028789 ETH
status:      pending (DB) — Pioneer registration FAILED (400 "Something went wrong")
```
Pioneer registration failed at broadcast time. The retry logic added this session
will re-attempt on the next `refreshSwap` poll (when user opens the dialog).

---

## What Was Fixed This Session

### 1. Pioneer registration retry (`swap-tracker.ts`)
**Problem:** `CreatePendingSwap` fired once at broadcast. A 400 response meant the
swap was never registered — `GetPendingSwap` returned `not_found` forever, dialog
showed no status updates.

**Fix:** Added `pioneerRegistrationRetry` set + `pioneerRegistrationAttempts` counter.
`refreshSwap()` retries `registerWithPioneer()` on each poll, up to 10 attempts.
On success, removes from retry set.

### 2. NEAR Intents tracker URL (`trackers.ts`)
**Problem:** Was linking to `nearblocks.io` (raw NEAR chain explorer). NEAR Intents
swaps have a dedicated tracker: `explorer.near-intents.org`.

**Fix:** Changed to `https://explorer.near-intents.org/transactions/{nearTxHash}`.
Button still only appears when `nearTxHash` is populated (1Click has settled the swap).

Attempted deposit-address fallback (`?search={deposit}`) — **reverted**: the explorer
returns "No results" for BTC deposit addresses before the swap settles. Showing an
empty search result is worse than showing nothing.

### 3. Dashboard in-flight banner (`Dashboard.tsx`)
**Problem:** When BTC is spent in a swap, Pioneer returns zero BTC. Dashboard shows
the lower balance with no explanation. User sees "missing funds."

**Fix:** Dashboard now fetches `getPendingSwaps` on mount and subscribes to
`swap-update` RPC messages. For each non-terminal swap, renders a teal banner:
```
⏳ 0.00077858 BTC → ZEC swap in progress    pending  ›
```
Clicking opens the SwapDialog for that swap via `setActivityResumeSwap`.
Banners auto-dismiss when a swap reaches `completed`/`failed`/`refunded`.

---

## What Is Still Broken / Not Investigated

### P1 — Explorer button missing for BTC swap
**Symptom:** In the SwapDialog submitted phase, the "Explorer" button (blockchair.com
link for the source BTC tx) is not showing.

**Expected:** `getExplorerTxUrl('bitcoin', txid)` should return a blockchair.com URL.
The DB confirms `from_chain_id = 'bitcoin'` and Bitcoin has `explorerTxUrl` defined.

**Root cause NOT found.** Suspects:
- `fromAsset` is null when the CTA box renders (resume path race condition?)
- `fromAsset.chainId` is something other than `'bitcoin'` for this specific NEAR
  Intents flow (e.g., set to a CAIP-2 string `bip122:...` somewhere)
- The dialog is actually in the completed view (wide 2-column) not in-progress, and
  the user is looking in the wrong section

**To diagnose:** Add `console.log('[explorer-debug]', fromAsset?.chainId, txid)` at
line 2661 of SwapDialog.tsx and restart to see what value `chainId` holds at render time.

### P2 — 10 stuck "pending" swaps in DB
These are old swaps (probably pre-dating reliable Pioneer integration) that completed
on-chain but the status was never updated. They will show as "pending" banners on the
dashboard indefinitely.

**Needs:** A background cleanup job that runs on vault startup — queries
`getSwapHistory({ status: 'pending', limit: 50 })`, calls `refreshSwap` on each one,
and if Pioneer returns `completed`/`failed` or the tx is >7 days old, marks it terminal.

Or: a simpler age-gate — swaps older than `estimatedTimeSeconds * 10` and still
`pending` are auto-marked `failed` with `error: "Timed out — check explorer"`.

### P3 — `/api/portfolio` is a stub
Returns `total_value_usd: 0` with "not implemented" message. The real cached data
lives at `/api/debug/portfolio` (auth required). Pioneer SDK clients that call
`/api/portfolio` get zeroed data.

**Fix:** `/api/portfolio` should proxy the cached balance data from
`getCachedBalances()` same as `/api/debug/portfolio`, formatted appropriately.
The `CLAUDE.md` rule: never return fake values — return `NOT_IMPLEMENTED` or real
data, nothing in between.

### P4 — `chainId` naming is misleading on non-EVM chains
`SwapAsset.chainId`, `PendingSwap.fromChainId`/`toChainId` hold vault slugs like
`'bitcoin'`, `'zcash'` — not EVM chainIds. This conflicts with `ChainDef.chainId`
(which IS the EVM integer, e.g. `'1'`, `'137'`).

No runtime bugs confirmed yet, but the ambiguity is a trap for future devs.
**Rename:** `SwapAsset.chainId` → `chainSlug` or `vaultChainId` (large rename, own PR).

### P5 — NEAR Intents: no tracker until swap settles
While `PENDING_DEPOSIT`, the user has no external verification link beyond:
1. The BTC source tx link (blockchair via the Explorer button — see P1 above)
2. The deposit address on a BTC explorer (shows whether BTC arrived)

The dashboard banner (P fix #3 above) helps but doesn't give the user a
1-click external verification. Once P1 is fixed, the BTC Explorer button is
the primary trust signal during the wait.

---

## Terminology Reference (for next dev)

| Field | Format | Example | Where |
|---|---|---|---|
| `ChainDef.id` / vault slug | string slug | `'bitcoin'` | Internal routing, explorer lookups |
| `ChainDef.networkId` | CAIP-2 | `'bip122:000000000019d6689c085ae165831e93'` | Pioneer API calls |
| `ChainDef.chainId` | EVM integer (string) | `'1'`, `'137'` | EVM tx signing only |
| `SwapAsset.chainId` | **slug** (misleadingly named) | `'bitcoin'` | Swap params, DB |

`getExplorerTxUrl(chainId, txid)` expects a **slug**. Passing a CAIP-2 string will
silently return null and the Explorer button won't render. This is the most likely
cause of P1.

---

## Files Changed This Session

```
src/bun/swap-tracker.ts       Pioneer registration retry logic
src/mainview/lib/trackers.ts  NEAR Intents → explorer.near-intents.org
src/mainview/components/Dashboard.tsx  In-flight swap banners
```

---

## Quick Commands

```bash
# Check 1Click status for BTC→ZEC swap
curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=bc1q7c5zyutyscc0gmn4espvf874ltzc49y6dk6a3t" | python3 -m json.tool

# Audit REST API (pair first)
curl -s -X POST http://localhost:1646/auth/pair -H "Content-Type: application/json" -d '{"name":"audit","url":"http://localhost","imageUrl":""}' | python3 -m json.tool
TOKEN=<apiKey from above>
curl -s http://localhost:1646/api/v1/swaps/stats -H "Authorization: Bearer $TOKEN"
curl -s http://localhost:1646/api/debug/portfolio -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# DB: check pending swaps
sqlite3 "$HOME/Library/Application Support/com.keepkey.vault/dev/vault.db" \
  "SELECT txid, from_chain_id, to_chain_id, integration, status, datetime(created_at/1000,'unixepoch') FROM swap_history WHERE status='pending' ORDER BY created_at DESC;"
```
