# Release Control — 7.15 cycle (firmware → vault → bex)

**Generated 2026-07-16 from live repo state** (gh/git verified, not memory). Single source of truth for the 7.15 firmware release + vault + bex releases. Supersedes the scattered `handoff-*` docs.

---

## State of play (the honest version)

You are closer to shipping than the handoff pile suggests. Four releases are **chained**, and the long pole is entirely **upstream firmware**.

- **Firmware 7.15.0** — cut to **rc10** on the fork (`develop == release/7.15.0-rc10 == 183a2b93`, CMakeLists already 7.15.0). No `v7.15.0` tag. Fork develop is **100 commits ahead** of upstream (still 7.14.0). The upstream path is **already live and CI-green**: a clean 5-PR stack **#444–#448** + repro script **#449** on `keepkey/keepkey-firmware`, blocked only on (a) two foundation PRs merging first, (b) upstream human review, (c) Gate-3 OLED. My late fix **#309** (thorchain per-chain clearsign) is on fork develop but **not yet folded into upstream #447**.
- **Vault** — users have **v1.4.10**; **v1.4.11** is an un-promoted pre-release; develop is **105 commits ahead** with one clean open PR (**#364**). One bump + notarization away from a release. **Does not gate on firmware.**
- **BEX / keepkey-client** — at **v0.0.35** with 16 merged-but-unreleased commits (hive + MCP). Its headline features are **hard-gated** on firmware 7.15.0 + a vault release + a Pioneer deploy shipping first. **Must be last.**
- **Already merged** (ignore any handoff saying otherwise): hdwallet #55, pioneer #170, client #108, vault #361 (mcp 401) + #363 (zod fix).

### Two genuine hard blockers (beyond sequencing)
1. **Clearsign trust anchor** — `METADATA_PUBKEYS` is intentionally all-zero (`signed_metadata.c:45-54`). Warning-free clearsign is impossible without a key ceremony. **Product decision.** Does *not* block a warning-gated 7.15.0.
2. **Upstream firmware is human-review-gated** — the #444–#448 stack is MERGEABLE + green but needs keepkey maintainer sign-off. Budget days.

---

## Critical path (dependency-ordered)

```
#309 (+Gate-3 OLED) ──► fork develop ──► fold into upstream #447
       │
       └─ vault #364 (lockstep)                    LOCAL TEST SWEEP (verify-locally SOP)
                                                          │
  device-protocol #111  ─┐                                │
  python-keepkey  #196  ─┴─► merge to UPSTREAM masters ──►│
                                                          ▼
                               re-pin fw deps ► upstream review ► merge #444→#448 in order
                                                          │
                                          [DECISION: trust anchor]  [DECISION: upstream this cycle?]
                                                          ▼
                                        cut v7.15.0 FINAL (3/5 airgapped signers, hash-compare)

  ── PARALLEL, does NOT wait on firmware ──
  vault #364 merge ► bump 1.4.11→1.4.12 ► notarization creds ► make preflight ► make release

  ── LAST, gated on firmware-on-device + vault release + pioneer deploy ──
  bex 0.0.36: release/0.0.36 ► master ► tag ► zip ► GitHub release ► master→develop sync
```

---

## Phase board

### Phase 1 — Land the clearsign fix (fw #309 + vault #364) — *in flight*
- [ ] Capture **Gate-3 OLED** of an AVAX THORChain deposit clear-signing (router/amount shown, not a blind-sign warning). SOP: no firmware PR approval without OLED proof.
- [ ] Attach screenshots → merge **#309** to fork develop (all CI green).
- [ ] Merge **#364** to vault develop in lockstep. Keep it single-file (`calldata-decoder.ts`); **do NOT** commit the drifted firmware submodule gitlink (`715c173e`).
- **Exit:** both merged with Gate-3 attached; submodule gitlink not bumped on #364.

### Phase 2 — Full LOCAL test sweep (verify-locally, not CI)
Run in order (see full command list at bottom). Record pass/fail.
- [ ] firmware docker unit + pyk/OLED
- [ ] vault **`bun test __tests__/`** (whole dir — `make test-unit` silently covers only ~16 of ~35 files, skips `firmware-clearsign-gate.test.ts`)
- [ ] vault emu / rest / sign-gating
- [ ] bex `pnpm vitest run`
- **Exit:** every layer green at the rc10 SHA, recorded.

### Phase 3 — Firmware 7.15.0 FINAL to UPSTREAM (long pole)
- [ ] **Foundation first (bottom-up SOP):** get **device-protocol #111** + **python-keepkey #196** reviewed + merged to their **upstream masters** (these are the sanctioned upstream exceptions to fork-only).
- [ ] Re-pin firmware `deps/device-protocol` + `deps/python-keepkey` to the merged master SHAs; confirm `check-submodules` stays green. *(Verify pins are actually on master, not just ancestor of a branch.)*
- [ ] Fold **#309** into upstream **#447**; re-verify CI.
- [ ] Upstream review → merge **#444→#445→#446→#447→#448** in order (#448 carries the version bump, lands last). #449 merges independently.
- [ ] Resolve **trust-anchor decision** (see Decisions).
- [ ] Cut **v7.15.0 FINAL** per `docs/Release.md`: local unit+pyk, CMakeLists==7.15.0, tag off `release/7.15.0` (**not** the stale branch), publish GPL source, multi-machine hash compare, **3/5 airgapped signers**, storage-upgrade key-preservation check on a production device.
- **Exit:** #111+#196 on masters; #444–#448 merged with #309 folded; signed `v7.15.0` tag; upstream develop reads 7.15.0.

### Phase 4 — Vault release v1.4.12 (PARALLEL with Phase 3)
- [ ] Merge #364.
- [ ] Bump `projects/keepkey-vault/package.json` **1.4.11 → 1.4.12** (else `make release` re-cuts the existing pre-release).
- [ ] Decide fork-pin questions (proto-tx-builder on `fix/cosmjs-freegrant-typo-shim`, device-protocol fork pin `98ca1e2`): accept or land on main.
- [ ] Confirm **ELECTROBUN_* creds** + signing cert (`security find-identity -v -p codesigning`). Never read `.env`.
- [ ] `make preflight` → `make release`. Leave the firmware submodule gitlink untouched (excluded from vault gating).
- **Exit:** v1.4.12 draft release with signed+notarized DMG + update.json; users have a path off v1.4.10.

### Phase 5 — BEX 0.0.36 (LAST — cross-repo gated)
- [ ] Confirm all three gates live: firmware 7.15.0 **on devices** (`requireHiveFirmware` blocks <7.15.0), vault release exposing `/hive/*` + `/bex-bridge`, Pioneer deploy with broadcast + vesting-pool.
- [ ] Decide scope (see Decisions); strip the mis-placed 0.0.36 bump from `feature/hive-network-listing` (commit b49745f bumped all 10 package.jsons on a feature branch).
- [ ] Triage dependabot: merge safe minors #101/#102/#103; **hold** risky majors #104 (TS 5→6) / #105 (vitest 2→4) — they touch CI gates.
- [ ] RELEASE.md 8 steps: type-check/test/lint/build → `release/0.0.36` → bump → PR→master → tag → zip → GitHub release → **PR master→develop (don't skip step 8)**.
- [ ] `make e2e` against device + vault + live Pioneer (only automated hive/mcp check).
- **Exit:** v0.0.36 tagged, zip on a GitHub release, master→develop sync opened, hive/mcp verified on-device.

### Phase 6 — Cleanup & upstream tidy
- [ ] Close fork rehearsal PRs **#294–#298** once #444–#448 land (superseded staging, no CI).
- [ ] Delete stale branch `keepkey-firmware release/7.15.0` (63 ahead / **133 behind** rc10 — releasing off it ships pre-rc10 firmware).
- [ ] Triage the untracked `docs/handoff-*.md` pile at the repo root — archive the merged/stale ones (cross-check each against `gh` before deleting).
- [ ] Watch fork↔upstream divergence drop toward 0 as the stack lands.

---

## Open PR ledger (all repos)

| PR | Repo | Status | Next action |
|----|------|--------|-------------|
| **#309** | BitHighlander/keepkey-firmware | OPEN, green | Gate-3 OLED → merge fork develop → fold into upstream #447 |
| **#364** | keepkey/keepkey-vault | OPEN, clean | Merge lockstep w/ #309; single-file; no submodule bump |
| **#111** | keepkey/device-protocol | OPEN, mergeable | **CRITICAL** — review + merge to master (upstream exception) |
| **#196** | keepkey/python-keepkey | OPEN, mergeable | **CRITICAL** — review + merge to master alongside #111 |
| **#444–#448** | keepkey/keepkey-firmware | OPEN, green, review-gated | Solicit upstream review; merge in order after #111/#196 |
| #447 | keepkey/keepkey-firmware | — | Fold #309 in before final merge |
| #449 | keepkey/keepkey-firmware | OPEN, green | Merge independently; run repro-build locally |
| #294–#298 | BitHighlander/keepkey-firmware | OPEN, no CI | **Do not merge** — close after upstream stack lands |
| #101–#103 | keepkey/keepkey-client | Dependabot | Merge if green before 0.0.36 |
| #104–#105 | keepkey/keepkey-client | Dependabot major | Hold/vet — touch CI gate toolchain |

---

## Hard blockers

| Blocker | Blocks | Unblock | Type |
|---------|--------|---------|------|
| Trust anchor `METADATA_PUBKEYS` all-zero | Warning-free clearsign in 7.15.0 | Key ceremony → slot 0, **or** decide to ship warning-gated | **DECISION** |
| device-protocol #111 + python-keepkey #196 unmerged | Entire upstream fw stack | Review + merge to upstream masters, re-pin | exec (days) |
| Upstream stack review-gated | 7.15.0 reaching upstream + FINAL tag | Request keepkey maintainer review | exec (days) |
| Gate-3 OLED outstanding | Merging #309; cutting FINAL | Run flows on device, screenshot | exec (manual) |
| Vault package.json still 1.4.11 | New vault release | Bump to 1.4.12 | exec |
| ELECTROBUN_* signing creds | Any signed/notarized vault build | Export vars + confirm cert | **DECISION** (human gate) |
| 3/5 airgapped signers + storage-upgrade check | Publishing signed v7.15.0 fw | Schedule airgapped signing session | **DECISION** (logistics) |
| bex deps not shipped | Functioning 0.0.36 | Ship fw→vault→pioneer first, or feature-flag off | exec (sequencing) |

---

## Decisions

**SETTLED 2026-07-16:**
1. **Trust anchor → SHIP WARNING-GATED in 7.15.0.** Clearsign goes out via the warning-screened LoadClearsignSigner path; production key ceremony deferred to phase-2 / 7.15.1. → Key ceremony is OFF the FINAL critical path; the `METADATA_PUBKEYS` blocker no longer gates 7.15.0.
2. **7.15.0 FINAL → UPSTREAM this cycle** via the #444–#448 stack (after #111/#196 land on masters). Budget days for maintainer review.
3. **Vault → CUT v1.4.12 IN PARALLEL NOW** (does not wait on firmware). v1.4.11 superseded straight to v1.4.12.

**Still open (lower-stakes, decide before their phase):**
4. **BEX scope:** ship develop as-is, or first fold in the 2 read-only Hive-listing commits? Chrome Web Store publish, or GitHub-release-zip only?
5. **Vault fork pins:** accept proto-tx-builder + device-protocol fork pins for this vault release, or land them on main/master first?
6. **7.15.0 feature set:** confirm the shipped set (EVM clearsign, Hive, Zcash Orchard, Ripple memos, THORChain any-denom, TRON/Solana v0/TON/Maya affiliate) — anything deferred?

---

## Local test sweep — exact commands (Phase 2)

```bash
FW=/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/modules/keepkey-firmware
V11=/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11
BEX=/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-client

# 1. firmware unit (docker ONLY — native macOS fails StorageRoundTrip Linux golden)
cd $FW/scripts/emulator && docker compose up --build --exit-code-from firmware-unit firmware-unit
# 2. firmware pyk integration + OLED regression (UDP kkemu = only confirm-flow path)
cd $FW/scripts/emulator && docker compose up --build --exit-code-from python-keepkey python-keepkey
# 3. vault FULL host suite (the true "test everything" — bun test dir, not make test-unit)
cd $V11/projects/keepkey-vault && bun test __tests__/
# 4. vault emulator smokes (dylib FFI, no device)
make -C $V11 test-emu
# 5. vault aggregate (zcash-cli + curated unit)
make -C $V11 test
# 6. vault REST + sign-gating (needs `make vault` running on :1646)
make -C $V11 test-rest && make -C $V11 test-sign-gating
# 7. vault live Hive sign smoke (device press, after restart)
RUN_LIVE_SIGN=1 make -C $V11 test-sign-gating
# 8. vault preflight (judge typecheck by ~619 baseline, not 0 — minimatch false-green)
make -C $V11 preflight
# 9-10. bex
cd $BEX/chrome-extension && pnpm vitest run
make -C $BEX type-check && make -C $BEX test && make -C $BEX lint && make -C $BEX build
# 11. pioneer
make -C /Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer start && make -C .../pioneer test
# 12. DEVICE Gate-3 (manual): get_features → AVAX clearsign OLED → Hive sign-ops OLED → recovery+wipe (replug!) → swap clearsign — screenshot each
# 13. bex device e2e (device + vault hive endpoints + live pioneer)
make -C $BEX e2e
```

## Docs to archive/delete (stop the noise competing with truth)
- `keepkey-client/HANDOFF_vault_mcp_401.md` — fixed by merged vault #361. Delete.
- `keepkey-client/HANDOFF_vault_hive_sign_operations_zod.md` — fixed by merged vault #363 (verified in source). Delete.
- Untracked `docs/handoff-*.md` pile at v11 root (30+) — archive the ones whose PRs are merged; cross-check each against `gh` first.
