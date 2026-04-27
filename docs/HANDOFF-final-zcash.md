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

### 1k. Per-session full rescan on Privacy tab open (the actual cure)

After patching five distinct symptoms (1e-1i) we still hit `could not validate orchard proof`. Empirical inspection of `~/.keepkey/zcash_wallet.db`:
- 8 notes accumulated across multiple sessions
- All `position: NULL` (computed at build time, never persisted)
- `tree_state` table empty (never cached)
- 6 marked `is_spent`, 2 unspent — the unspent set carried into every send untouched

The test `test_witness_recomputes_root_after_frontier_extension` proved tree construction is correct. So the bug isn't in our witness math — it's in the cached note data. Rather than chase whichever specific row was inconsistent, distrust the entire cached set on first open and re-derive from chain.

**Fix** — added `zcashVerifiedThisSession` flag (default false). Three points kick the validation:
- `zcashShieldedStatus` (Privacy tab open) → fires `maybeStartBackgroundWalletVerification()` once per session, asynchronously. Frontend already gets `scan-progress` events, so a "Validating wallet…" UX comes for free.
- `zcashShieldedScan` (manual refresh) → marks verified after success.
- `ensureZcashScanFresh` (pre-send) → upgraded to do a full rescan on first call this session (incremental thereafter).
- `zcashShieldedInit` (FVK loaded) → resets verified=false, since notes for a different ak shouldn't carry over.

Cost: ~30s once on first Privacy tab access. Trade-off accepted vs. the symptom-chasing alternative.

### 1j. Witness re-derivation tests (pczt_builder)

Added 4 tests that close the most dangerous gap — existing tests asserted `witness_at_checkpoint_id` returns `Some(_)`, but never that applying the path to its leaf actually re-computes the tree root. The chain's verifier checks the same invariant; without a test we'd see "could not validate orchard proof" with no local repro.

- `test_witness_recomputes_root_pure_append` — sanity, all-append tree
- `test_witness_recomputes_root_incomplete_shard_with_marked_note` — note in unfinished shard
- `test_witness_recomputes_root_after_frontier_extension` — production shape (insert N-1 roots, walk shard with note, ephemeral frontier)
- `test_witness_recomputes_root_two_marked_notes_split` — marked note in a walked shard with ephemeral frontier above it

All four pass — so tree code is correct. Run takes 31s in release (large shard sizes); could be sped up with smaller `ShardTree<_, 8, 4>` test trees if it becomes a CI bottleneck.

### 1i. Min-confirmations gate on spendable notes

**Cause** — after fix 1h caught the stale-state double-spend, the next deshield attempt failed at broadcast with `could not validate orchard proof`. Auto-scan ran (visible after the always-log fix below), local tree's anchor matched the chain's at lwd_tip_height, witness was extracted — yet the chain's verifier rejected the Halo2 proof. The shielded note we tried to spend was the one we'd received from a shield tx broadcast ~21 minutes earlier (~17 blocks). Notes that recent are vulnerable to: small reorgs shifting their on-chain position, lightwalletd's tree-state lag behind raw cmx scans, and indexer races between the shield tx's mining and tree-state availability.

**Fix** — added `MIN_CONFIRMATIONS = 10` gate to `wallet_db::get_spendable_notes(max_block_height)`. Both spend builders (`handle_build_pczt`, `handle_build_deshield_pczt`) now ask lightwalletd for the tip first and pass `tip - 10` as the cutoff. If every unspent note is too recent, the user gets an actionable error: `All N unspent notes are within 10 confirmations of the chain tip (X). Wait a few minutes and retry.` instead of a misleading "no spendable notes" or a doomed broadcast. 10 matches zcashd / ywallet / zecwallet defaults.

Files: `zcash-cli/src/wallet_db.rs`, `zcash-cli/src/main.rs`. `cargo check` clean.

### 1j. Auto-scan log always prints

The auto-scan in `ensureZcashScanFresh` previously logged only when `notes_found > 0`. During the post-1h failure debug, we couldn't tell whether the auto-scan had actually run or not. Made the `[zcash-presend] Scan complete: synced_to=X, new_notes=Y` line unconditional. Cheap, makes future debugging trivially observable.

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

## 4.5) Retro — six failed cycles on `could not validate orchard proof`

Five "fixes" landed today; deshield broadcast still fails with `could not
validate orchard proof` after every one. This section is the post-mortem so
the next session doesn't repeat the same patches.

### What we ruled out

- **Tree construction bug** — `test_witness_recomputes_root_after_frontier_extension` and three siblings prove our tree assembly produces witnesses that recompute the local root. (1.5s `cargo test`, all green.)
- **Anchor mismatch** — sidecar verifies our local tree's root equals `lwd_client.get_orchard_anchor(lwd_tip_height)` before generating the proof. No mismatch in any failing run.
- **Stale wallet DB** — full rescan from KeepKey release block re-derives the unspent set from chain + FVK. Bug persists.
- **Note recency / reorg risk** — `MIN_CONFIRMATIONS=10` gate; bug reproduces with the same input note at depth 57.
- **Auto-rescan was breaking the UX** — reverted; trust the cached DB, only do incremental.

### Repro from the last session

```
Inputs:  2840000 ZAT from 2 notes
  Note 0: block=3282982, pos=49847628 (depth ~38 980, well-confirmed change note)
  Note 1: block=3321905, pos=49936404 (depth 57, shield output)
Amount:  100000 ZAT → transparent (t1...)
Anchor:  fa0eca618953365b881b11a64f894dc83e92b2675b6850dfd5ec27a5a6956f0c
         (verified to match lightwalletd at lwd_tip_height=3321962)
Proof generation: success
Device signatures: 2 of 2 returned
Finalize: success, txid b31343f64d71f667ef5a678bb2894f818957a15709e2e61f4bc02929d594a035
Broadcast: REJECTED — could not validate orchard proof
```

### Hypotheses, ranked

1. **Note field inconsistency (most likely).** The scanner stored `cmx_chain` alongside decrypted `{recipient, value, rho, rseed}`. The chain's verifier recomputes `cmx_check = commitment(recipient, value, rho, rseed)` and checks it matches the leaf at the witnessed position. If our stored fields don't actually produce `cmx_chain`, proof fails. Could happen if:
   - Decryption used a slightly-different IVK than the chain expects (firmware FVK has the historical sign-bit bug; we auto-clear it, but maybe the scanner uses one form and the proof another)
   - Scanner stored fields from a different output of the same tx
2. **Spend authorizing signature mismatch.** Device's RedPallas signature is computed under an `ask` derived from the FVK + diversifier path. If the firmware derives `ask` differently from what the verifier expects (possibly the same sign-bit issue rearing in another place), the spendAuthSig is invalid. The Halo2 proof itself contains the public `rk` (randomized verification key), so this would manifest as "proof rejected" in the redjubjub layer (note the error includes `Downcast from BoxError to redjubjub::Error failed`).
3. **Witness path subtle divergence.** Possible but unlikely given the witness tests pass and the anchor matches.
4. **PCZT signature application order.** `Applying Orchard signatures in full-action mode: 2 signatures for 2 actions (2 real spends)` — sigs are applied positionally. If the device returns them in a different order than the actions were sent, sig 0 would authorize action 1 and vice versa. The hdwallet adapter sends actions in `sorted_notes` order (by position), but device replies might come back in submission order; need to verify.

The error string `Downcast from BoxError to redjubjub::Error failed` is interesting — it says zebra's error wrapping couldn't downcast to a `redjubjub::Error`, but the original error was "could not validate orchard proof". So the failure path goes through redjubjub before the Halo2 verifier even runs. **That points strongly at hypothesis 2: spendAuthSig invalid.** If Halo2 verification was the issue, the error would be from the proof verifier, not redjubjub.

### Concrete next moves (suggested order)

**Step 1: Add an in-process verifier in the sidecar.** Right after `build_for_pczt` produces the bundle and before returning to vault, run `orchard::Verifier` (or whatever the librustzcash equivalent is) on the unsigned bundle to confirm the proof is valid against the public inputs. This rules out hypothesis 1 (note field inconsistency) — if local verification fails, the bundle's `(recipient, value, rho, rseed) → cmx` chain is broken and we know to look at the scanner. If local verification passes but chain rejects, hypothesis 2 (spendAuthSig) is confirmed. Estimate: ~50 LOC, ~1h of work.

**Step 2: Verify spendAuthSig against the action's `rk` locally.** After the device returns each signature, the sidecar should `redjubjub::SpendAuthSig::verify(rk, sighash, sig)` before applying. If verification fails per-signature, the firmware is producing a sig that doesn't bind to `rk`. That's a firmware bug, not a sidecar bug. Estimate: ~20 LOC.

**Step 3: Bypass note 1 entirely with coin selection.** Implement min-set-covering in `get_spendable_notes` callers — sort notes by value desc, take until covered. For the user's 0.001 ZEC deshield, Note 0 alone (2.74 ZEC) covers; Note 1 wouldn't be selected. Tests this whole hypothesis: if deshield-with-only-note-0 succeeds, the bug is specific to recent notes (or specific to Note 1's data). Estimate: ~30 LOC + tests.

**Step 4: Diagnostic dump on broadcast failure.** When the chain rejects, log everything we can about the failed tx — sigs hex, action cmxs, witnessed positions, note fields hex, anchor. Lets the next round of investigation start from a captured artifact instead of needing to re-trigger.

**Step 5: Compare the firmware FVK derivation against an external reference.** Use a known seed → derive Orchard FVK + spend key in Rust → derive `ask` for action 0 → compare against device output. If they diverge, firmware bug isolated.

**If all of step 1-2 confirm the bundle + signatures are correct**, the problem is wire format (PCZT serialization, action ordering, or the v5 tx encoder). At that point the right move is **Plan C** from the earlier handoff — migrate to `zcash_client_sqlite::WalletDb` + the `librustzcash` PCZT path which is battle-tested by ywallet and zecwallet.

### Pattern to break

Every fix this session was driven by symptom + plausible hypothesis, not localized evidence. We've now exhausted what symptom-chasing can do. Steps 1 + 2 above produce **localized evidence** — they tell us which layer is wrong (sidecar's note storage, sidecar's bundle construction, firmware's signature derivation, or wire format). After that, we fix the actual layer instead of patching upstream.

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

---

## 7) Resolution

Fixed in commits `a2cbf80` and `a27a152`. First successful deshield broadcast:

```
txid 15dff751aa3bd591138ab76ae344899280dd4ae1bdb362214b3754691ef72e8b
     1 spend (0.02730000 ZEC change note) → 0.001 ZEC transparent + 0.0262 ZEC change
```

### Two real bugs, both in the sidecar's ZIP-244/ZIP-317 implementation

**Bug A — ZIP-244 §4.10b (the "could not validate orchard proof" failure)**

`digest_transparent_sig_for_orchard` always built the full S.2 form
(`hash_type || prevouts || amounts || scripts || sequence || outputs ||
txin_sig_digest`). But ZIP-244 §4.10b says: when a transaction has no
transparent inputs (or only a coinbase input), `transparent_sig_digest`
is identical to the txid form — `prevouts || sequence || outputs`, three
sub-digests, no hash_type byte, no per-input digest.

Deshield is the only path with transparent outputs but no transparent
inputs. Every broadcast hit a sighash mismatch:

| Path | Layer | Has transparent inputs? | Sig digest form | Worked? |
|---|---|---|---|---|
| Private send | bun → sidecar → device | no, none at all | EMPTY (short-circuit on both sides) | ✅ |
| Shield | bun → sidecar → device | yes | full S.2 (matches both sides) | ✅ |
| **Deshield** | bun → sidecar → device | **no** (outputs only) | ours: full S.2; chain: §4.10b txid form | ❌ |

The device signed under our wrong sighash, the chain re-derived the right
sighash, the redpallas verification failed, consensus rejected the proof.

**Fix**: short-circuit `digest_transparent_sig_for_orchard` to return
`digest_transparent_txid` when `inputs.is_empty()`. Same commit also
fixed a (cosmetic) bug in `digest_transparent_txid` itself — it was
including amounts + scripts (sighash-only fields per §4.10) in the txid
digest input, contradicting ZIP-244 §4.5.

**Bug B — ZIP-317 fee for post-padding orchard action count**

After Bug A was fixed, the next broadcast got past orchard proof
validation but was rejected with "Unpaid actions is higher than the
limit". ZIP-317 §3 logical_actions counts the FINAL orchard
`action_count` (post-padding), not the pre-padding `max(n_spends,
n_outputs)`. `BundleType::DEFAULT` pads to a 2-action minimum for the
anonymity set. Old code computed fee against the pre-padding count and
underpaid by exactly one action (5000 ZAT) on the standard 1-spend
deshield.

**Fix**: `zip317_deshield_fee` now floors orchard action count at 2.

### What broke the symptom-chasing pattern

Section 4.5 of this handoff (the retro after six failed cycles) called
out the pattern: every fix was symptom-driven, not evidence-driven.
What worked this time was a different methodology:

1. **Empirical constraint first.** Confirmed private sends still work →
   bug is unique to the deshield code path or its interaction with
   chain validation. That single data point cut the hypothesis space
   roughly in half.

2. **Localized evidence before code changes.** Instead of writing
   another fix patched upstream of the failure, wrote round-trip tests
   in the sidecar that compared our v5 serializer + ZIP-244 digests
   against `zcash_primitives::transaction::Transaction::read` — the
   canonical reference. This is exactly the "Step 1 + 2" the prior
   retro proposed but didn't execute.

3. **The canary mattered.** The `roundtrip_v5_shielded_only` test
   passed before the others were even run, validating the test
   infrastructure (synthetic bundle, fixture bytes, comparison
   helpers). When `roundtrip_v5_hybrid_*` failed, we knew it was a
   real divergence, not a test bug.

4. **The first failure pointed at the wrong bug.** Both hybrid
   round-trip tests failed on `txid` mismatch. The instinct was "this
   is the bug" — but the chain doesn't validate our reported txid, it
   computes its own. Reading the canonical implementation
   (`zcash_primitives::transaction::sighash_v5`) is what surfaced
   §4.10b: the chain's `transparent_sig_digest` has a special case for
   empty vin that we'd missed. The txid mismatch was a symptom of a
   broader "we got the digest formulas wrong" problem; §4.10b was the
   root cause for broadcast.

5. **One bug at a time.** Fixed the §4.10b sighash, rebuilt, tried
   broadcast. New error (ZIP-317 fee) — different layer. Resisted the
   urge to bundle a speculative fix; localized evidence again ("Unpaid
   actions" is a fee message, not a sighash one), one-line fix, test,
   ship.

### Specifically what NOT to do next time

- **Don't propose "Plan C / migrate to `zcash_client_sqlite::WalletDb`"
  as a remedy for spec bugs.** Migration would have required a
  multi-week rewrite to fix two bugs that were ultimately ~10 lines
  changed across two files. Plan C is still the right move if and when
  the wallet's note-storage assumptions break under multi-account or
  reorg-handling pressure — but it's the wrong tool for "our digest
  function is missing a special case."

- **Don't trust per-sig local verification as proof of correctness.**
  `finalize_*_pczt` already does `rk.verify(&sighash, &sig)` per action,
  and that always passed — because we verified against the SAME wrong
  sighash we sent the device. The chain re-derives sighash from the
  wire bytes; if our bytes-to-sighash function diverges from canonical,
  local verify and chain verify disagree silently.

- **Don't write your own ZIP-244 implementation when a reference
  exists.** Our `digest_transparent_sig_for_orchard` got both §4.5
  (txid) and §4.10b (empty-vin special case) wrong. The standalone
  Rust `zcash_primitives::transaction::sighash_v5` is ~150 lines and
  comprehensively tested by the librustzcash maintainers. We should
  consider replacing the `zip244` module entirely with calls into
  `zcash_primitives` — but that's coupled to the `Authorization` trait
  and the `TransparentAuthorizingContext` plumbing, so it's a clean-up
  arc, not a quick fix. Until then, the round-trip tests added in
  `pczt_builder.rs` give us a regression net against future drift.

### Regression coverage

- `zip244::tests::test_transparent_sig_digest_uses_txid_form_when_vin_empty`
  — direct unit test for §4.10b
- `pczt_builder::roundtrip_v5_tests::roundtrip_v5_shielded_only`
- `pczt_builder::roundtrip_v5_tests::roundtrip_v5_hybrid_shield`
- `pczt_builder::roundtrip_v5_tests::roundtrip_v5_hybrid_deshield`
- `pczt_builder::tests::test_zip317_deshield_fee_post_padding`

All run in <1.5s, no device, no network. CI-safe.
