# HANDOFF — `final-zcash` branch

Branched from `develop` (b186c2d, post-PR #132). Two surgical fixes already in. Unfinished work + a tech-debt arc below.

---

## 1) Done this session

### 1a. REST gate for Zcash endpoints (bug — every `/api/zcash/shielded/*` was returning 503)

**Cause** — `rest-api.ts:2653` read `engine.state?.firmwareVersion`. `EngineController` has no `state` property; the actual accessor is `engine.getDeviceState()`. The undefined value passed `isChainSupported(chain, undefined)` → `versionCompare(undefined, '7.15.0')` → -1 → false. Every Zcash REST endpoint was gated off regardless of firmware.

**Fix** — `engine.state?.firmwareVersion` → `engine.getDeviceState().firmwareVersion`. Also derived the error string from `zcashShieldedDef.minFirmware` so the message can't drift again (it was hard-coded to `7.11.0` while the actual minFirmware is `7.15.0`).

**Verified** — `GET /api/zcash/shielded/status` now returns `{ready: true}`; `GET /api/zcash/shielded/balance` returns `{confirmed: 2860000, ...}` (= 0.0286 ZEC) with bearer auth.

### 1c. Cache-health detector ignored Zcash → no auto-refresh ever fired for it

**Cause** — `index.ts:3393` filtered with `!c.hidden`, but Zcash is `hidden: true` (un-hidden by the privacy flag). So the "missing chain" detection set silently excluded Zcash, even when the privacy flag was on. Newly-enabled chains never triggered the dashboard's `needsAutoRefresh = true` path.

**Fix** — replaced the filter with a small block that mirrors the user-facing dashboard filter: `zcash-shielded` always excluded (it's a token-on-native), `zcash` included iff the privacy flag is on, every other hidden chain stays out.

### 1d. Shielded ZEC on dashboard (feature, not a bug)

User wanted shielded balance visible on the Dashboard like a token sub-row. See section 3 below.

### 1e. Shielded send wedged the emulator → SIGKILL (signal 9 / exit 137)

**Cause** — the three Zcash send paths (`sendShielded`, `shieldZec`, `deshieldZec`) called `wallet.zcashSignPczt` directly with no `emuSigningOp` wrapper. On the emulator the firmware enters `confirm_helper()` waiting for ButtonAck + DebugLinkDecision, but vault never pre-writes them. `kkemu_poll()` blocks the Bun event loop. The `EmuWatchdog` (60s) fires SIGKILL on the bun process. User's log: `Child process terminated by signal: 9` after `[zcash-shield] Requesting device signatures...`.

**Fix** — added optional `signWrap?: DeviceSignWrap` to all three sign builders. The RPC handler in `index.ts` constructs a wrap from `emuSigningOp` when `engine.isEmulator`, passing the relevant tx details (chain, recipient, amount, memo) so the user-approval window populates correctly. Wrap applies *only* to the device-signing call — sidecar PCZT build, finalize, and broadcast are still outside the wrap (correct: only the device-side step needs emulator confirm machinery).

Files: `txbuilder/zcash-shielded.ts`, `txbuilder/zcash-shield.ts`, `txbuilder/zcash-deshield.ts`, `index.ts:~2412-2467`.

### 1f. Shielded balance icon on dashboard

The synthetic shielded token now renders as a special `+ {amount} private` sub-row with a shield icon (instead of the generic `1 token` count). Other tokens (if any) still render via the existing `tokensCount` line below it. `Dashboard.tsx:892-911` has the special-case.

### 1h. Pre-send auto-scan to prevent stale-note double-spends

**Cause** — first deshield attempt with the anchor fix in place produced a valid PCZT, the device signed, the sidecar finalized — but the broadcast was rejected with `orchard double-spend: duplicate nullifier (in finalized state: true)`. The sidecar's local note set was 38,933 blocks behind the chain (`synced_to=3282973`, tip=3321906); 2 of the 4 "unspent" notes the builder selected had actually been spent in the unscanned window. There was no in-app indicator the wallet was behind tip, and no automatic catch-up before sends.

**Fix** — added `ensureZcashScanFresh()` helper at `index.ts:~563` and called it at the top of `zcashShieldedSend`, `zcashShieldZec`, and `zcashDeshieldZec`. The helper invokes `scanOrchardNotes()` which is a no-op when at tip (~tens of ms IPC roundtrip) and incremental from `synced_to` when behind. Failure throws — we'd rather surface "scan failed" than burn a device confirm + Halo2 proof on a doomed tx.

User-session validation: rescan from the failure state ran in 11.7s, caught up 38,935 blocks, found 2 new notes (from this session's earlier shield), and revealed `notes_unspent` had dropped 4→2 (so the previous deshield was correctly rejected).

### 1g. Deshield (Orchard → transparent) failed with "Orchard anchor mismatch"

**Cause** — `pczt_builder.rs::build_deshield_pczt` reconstructs the Orchard commitment tree to extract Merkle witnesses for the input notes:

1. Inserts every completed subtree root EXCEPT shards containing input notes
2. For shards containing input notes, fetches all leaves and appends them
3. Validates the locally-computed root matches `lwd_client.get_orchard_anchor(lwd_tip_height)`

Step 3 always failed when input notes lived in completed shards (the common case). The local tree only extended to the end of the last note-bearing shard — but the lightwalletd anchor at `lwd_tip_height` includes every commitment after that, including the partial frontier of the next incomplete shard. The two roots can't match by construction. The shield path already handles this (lines 998-1063 of the same file: walks the incomplete-shard frontier to the tip), but the deshield path was missing the equivalent extension pass.

**Fix** — added a frontier-extension pass after the per-note-shard loop in `build_deshield_pczt` (`pczt_builder.rs:~1677`). Mirrors the shield path's `plan_incomplete_shard_fetch` + leaf-walk, appending each frontier leaf with `Retention::Ephemeral` (we only need them to make the root match — never need to spend them). Runs only when the latest incomplete shard is **not** in `note_shards`, since per-note-shard already extends to the tip in that case (`shard_end_pos = u64::MAX`, `shard_end_height = lwd_tip_height`) and a second pass would double-append.

User's session evidence:
- Shield (1 transparent input → 2 Orchard outputs/dummies) succeeded — txid `9293fb3ec1b858b7c07b1da99970802ede7c38e83b41e4a6d83ea6b9c2c0a84e`
- Deshield (4 Orchard notes → transparent) failed at build with `computed=e46d8739… vs expected=6abf09a7…` — local tree was at end of shard 760, lightwalletd anchor was at the tip (~27,180 blocks later)

Files: `zcash-cli/src/pczt_builder.rs` (one block added). `cargo check` clean — only pre-existing warnings.

### 1b. Spurious `AUTO-RELOAD VERIFY FAIL` log noise (4 minutes after `ready`)

**Cause** — `engine-controller.ts:1085-1104` races a 3s deadline against `getEmulatorMnemonic()` so the foreground proceeds. But the underlying `readChunk` (in `emulator-transport.ts`, `READ_TIMEOUT_MS = 240_000`) cannot be cancelled, so the `.then` callback fires ~4 minutes later and logs `AUTO-RELOAD VERIFY FAIL — firmware returned no mnemonic`. Cosmetic, not functional — but confused us into thinking something was broken.

**Fix** — `verifyAbandoned` flag set when the 3s race wins. The `.then`/`.catch` checks the flag and returns before logging.

**Better long-term fix (not done)** — plumb an `AbortSignal` through `transport.call → readChunk` so the abandoned read actually stops, instead of wasting 240s of 5ms-poll work.

---

## 2) Open: dashboard shows "no balance" for Zcash transparent — ROOT CAUSE CORRECTED

Initial diagnosis blamed Pioneer's `/portfolio` for dropping ZEC. **That was wrong.** Empirical recheck:

| Source | Endpoint | Result |
|---|---|---|
| Vault REST → device | `POST /addresses/utxo` (Zcash, m/44'/133'/0'/0/0) | `t1gwwyCfbRMyQdwo8xXrMGDj3ZqVjhsHWTh` |
| Vault REST → device | `POST /api/pubkeys/batch` (Zcash p2pkh) | `xpub6CKNxyxUckJaggvmby1J1U5jR9zmRBd7aQh6LdaNsAdPJ6A6tfUqeesERcjHsQsLtzcG8mT3EUxroeBP6CrkucELXbqH5dQkQSyPgSxdFfX` |
| Pioneer UTXO indexer | `GET /api/v1/utxo/balance/bip122:00040fe8…/<xpub>` | `{"balance":"2911530","confirmedBalance":2911530}` ← 0.0291 ZEC |
| Pioneer dispatcher (legacy) | `GET /api/v1/getPubkeyBalance/zcash/<xpub>` | `{"error":"Network not supported: zcash"…}` |
| **Pioneer batch** | **`POST /api/v1/portfolio`** with full CAIP | **Returns full Zcash entry: balance, priceUsd, valueUsd, networkId, decimals, dataSource. Works.** |
| Vault local cache | `SELECT * FROM balances WHERE chain_id='zcash'` | Has a row: `0.02911530 ZEC / $7.35` — **but for device `282DE83…`, not for active device `5E4E6B69…`** |

### Actual root cause — split into three independent things

1. **Pioneer's legacy `/getPubkeyBalance/<slug>/<pubkey>` dispatcher only knows 11 networks**, and Zcash isn't one. `/portfolio` (the one vault actually uses) is fine. **Out of scope for this branch — owner is pioneer-server repo, narrow fix incoming there.**

2. **Vault's cache-health staleness detector excluded Zcash from "missing chain" checks**, because `index.ts:3393` filtered with `!c.hidden` and Zcash is `hidden: true` (un-hidden by the privacy flag). So even when Zcash was missing for the active device, no auto-refresh ever fired. ✅ **Fixed this session** — `index.ts:~3393` now mirrors the user-facing dashboard filter (`!c.hidden || (c.id==='zcash' && zcashPrivacyEnabled)` semantics; `zcash-shielded` always excluded since it's a token-on-native).

3. **Stale device caches accumulating** — the vault.db `balances` table had 8 distinct `device_id`s. Each emulator wipe + reseed yields a different device_id, and old rows are never pruned. Not blocking the user-visible bug, but worth a separate cleanup pass (TTL-based prune, or "drop on engine.disconnectEmulator" hook).

After fix (2), the next time the dashboard loads with the active device, cache-health flags Zcash as missing → `needsAutoRefresh = true` → `refreshBalances()` fires → Pioneer returns the Zcash entry → cache writes a `zcash` row for the active device → dashboard shows 0.0291 ZEC. Confirmed via raw `POST /portfolio` probe that Pioneer returns valid data — vault's existing matching at `index.ts:1454` handles it correctly (`d.caip === entry.caip` matches).

---

## 3) Done: shielded balance on dashboard (token-on-native)

✅ Implemented this session at `index.ts:~1499` — after `getBalances` builds `results`, if `zcashPrivacyEnabled && hasFvkLoaded()` we race `getShieldedBalance()` against a 5s deadline (sidecar IPC, normally <100ms but bounded so a wedged sidecar doesn't block the whole getBalances). On success, look up the Zcash native entry in `results`, derive the per-ZEC USD price from the Pioneer-returned `priceUsd` field on the corresponding `pureNatives` entry, and append a synthetic token:

```ts
{
  symbol: 'zZEC',
  name: 'Shielded ZEC',
  balance: zecAmount.toFixed(8),
  balanceUsd: shieldedUsd,
  priceUsd: zecPrice,
  caip: 'bip122:00040fe8ec8471911baa1db1266ea15d/orchard:shielded',
  contractAddress: 'orchard',
  networkId: 'bip122:00040fe8ec8471911baa1db1266ea15d',
  decimals: 8,
  type: 'shielded',
}
```

Then bump `zcashEntry.balanceUsd += shieldedUsd` so the chain card's total reflects both halves. `nativeBalanceUsd` is left alone (only transparent counts as native).

### Pre-conditions

Both must be true at the moment `getBalances` runs, otherwise the shielded row is silently skipped:
- privacy flag on — `zcashPrivacyEnabled === true`
- sidecar has the FVK loaded — `hasFvkLoaded() === true`

Both are verified at runtime — no failure mode beyond "user doesn't see shielded yet".

### What this depends on

This only renders correctly **after** issue (2) above lands and the active device's cache gets a Zcash native row. Without a transparent entry to attach the token to, the synthetic shielded token has nowhere to go (the find at `results.find(r => r.chainId === 'zcash')` returns `undefined`). The cache-health fix is what makes the transparent row materialize.

### Trade-off accepted

Misuses `tokens[]` semantically (shielded isn't an ERC20-style token), but reuses every existing token render path on dashboard + AssetPage. The alternative — un-hiding `zcash-shielded` as its own dashboard card — would touch sort/filter, watch-only, swap eligibility, and 4–5 other special-cases. User explicitly chose the token-on-native shape.

---

## 4) Tech-debt arc — migrate everything to caip / networkId

This session exposed the underlying problem: **multiple competing chain identifiers** flowing through the stack, each with its own coverage gaps.

### Identifiers in play

| Identifier | Where | Coverage |
|---|---|---|
| `chain.id` (vault internal: `'zcash'`, `'zcash-shielded'`, `'bitcoin'`, …) | `shared/chains.ts`, dashboard, RPC handlers | full (we own it) |
| `chain.networkId` (CAIP-2: `bip122:00040fe8…`) | from `pioneer-caip` | full (canonical) |
| `chain.caip` (CAIP-19: `bip122:…/slip44:133`) | from `pioneer-caip` | full (canonical) |
| `chain.coin` (KeepKey hdwallet name: `'Zcash'`, `'Bitcoin'`) | hdwallet, firmware coin table | per firmware |
| Pioneer **network slug** (`'zcash'`, `'utxo'`, `'ethereum'`, …) | Pioneer dispatcher, `/getPubkeyBalance/<network>/<pubkey>` | **11 networks today, no Zcash** |

The Pioneer slug is the broken one. CAIP/networkId are canonical. The fix is to standardize on networkId end-to-end and stop letting per-chain string slugs leak into transport boundaries.

### Concrete migration targets (in priority order)

1. **Pioneer server** — kill the `network` path param in `getPubkeyBalance` and dispatch on networkId. UTXO chains all share an indexer, so the dispatcher becomes "if `networkId.startsWith('bip122:')` route to UTXO". Solves Zcash and removes a class of "Network not supported" bugs forever.
2. **`pioneer.GetPortfolioBalances` in vault** — already takes `caip` per pubkey (good). Verify nothing downstream re-derives the slug from `caip.split('/')` and reintroduces the dispatcher gap.
3. **Pioneer SDK regenerate** — once the spec changes, regenerate the typed client. `node_modules/@pioneer-platform/...` will need a bump.
4. **Vault internal `chain.id`** — keep it for UI affordances (icon path, color, label key), but stop using it as a transport identifier. Anywhere we currently key dispatch on `chain.id`, switch to `chain.networkId`.
5. **`chain.coin`** — keep this one. It's the firmware-side coin name and isn't going anywhere.
6. **Drop the dual `'zcash'` + `'zcash-shielded'` chain entries** if shielded becomes a token-on-native (option 3 above). One ChainDef per network, shielded is a token row. Cleans up `index.ts:1136`, `:1255`, `:2484` and a few other special cases.

### Why this is worth doing now

- We shipped Zcash transparent + shielded, and the dashboard still says "no balance" for transparent. That's the third user-visible bug from the same root cause this quarter (Pioneer dispatcher gap → silent skip → "no balance" UX).
- Every new chain we add (TON, TRON were the recent ones) goes through the same audit: "is the slug in Pioneer's dispatcher?" — easy to forget.
- The CAIP layer already exists and is maintained. The slug layer is parallel and contributes no information.

### Estimate

- Pioneer server change: half-day.
- SDK regen + vault adoption: half-day.
- Drop `chain.id` from dispatch sites in vault: 1 day (mostly grep + replace + test).
- Drop dual zcash chain entries (optional): 1 day, gated on dashboard token-on-native landing first.

Maybe 2–3 days of focused work for permanent removal of an entire class of bugs.

---

## 5) Branch state

- `final-zcash` is at the HEAD of `develop` + the two surgical fixes above (uncommitted in working tree).
- Submodule pointers: `modules/keepkey-firmware` bumped to `alpha @ 11d97d40` via PR #132.
- Working tree carries pre-existing untracked content: `.claude/`, `emulator.img`, `projects/keepkey-sdk/tests/ton/`.

### Suggested next commits

1. **One commit, four fixes** — REST gate + verify-leak silencer + cache-health detector + shielded-as-token. All small, all in two files (`bun/index.ts`, `bun/rest-api.ts`, `bun/engine-controller.ts`). Body should mention each.
2. **Verify** — restart dev build, confirm: shielded REST endpoints return ready, dashboard refresh shows `0.0291 ZEC` transparent + `0.0286 zZEC` token row under it, `[cache-health]` no longer logs `0 missing` when Zcash is missing.
3. **Pioneer slug fix** — separate PR in pioneer-server (you're on it).
4. **Stale device cache prune** — small follow-up. Either drop on `engine.disconnectEmulator`, or TTL-based sweep at startup. Currently 8 device IDs in the cache.
5. **Tech-debt migration to caip/networkId** — separate branch when 1–3 are stable. See section 4.

---

## 6) Useful one-liners for next session

```bash
# Pair to vault REST and store the bearer token (UI must be open to approve)
TOKEN=$(curl -s -X POST :1646/auth/pair -H 'Content-Type: application/json' \
  -d '{"name":"debug","url":"http://localhost"}' | jq -r .apiKey)

# Probe Zcash sidecar
curl -s :1646/api/zcash/shielded/status                          # ready?
curl -s -H "Authorization: Bearer $TOKEN" :1646/api/zcash/shielded/balance

# Get device's Zcash xpub for direct Pioneer probing
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST :1646/api/pubkeys/batch \
  -d '{"paths":[{"address_n":[2147483692,2147483781,2147483648],"coin":"Zcash","script_type":"p2pkh"}]}'

# Confirm Pioneer has the data (UTXO indexer, no auth)
curl -s "https://api.keepkey.info/api/v1/utxo/balance/bip122:00040fe8ec8471911baa1db1266ea15d/<xpub>"

# Reproduce the dispatcher gap
curl -s "https://api.keepkey.info/api/v1/getPubkeyBalance/zcash/<xpub>"
```
