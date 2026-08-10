# Firmware 7.x Release — Handoff (2026-06-30)

**State:** Release fully scaffolded. The only blocker is **human peer review of the
two upstream PRs**. Tomorrow = review our own PRs, then reach out to keepkey
maintainers to get the upstream proto/test PRs reviewed (the days-long critical path).

---

## TL;DR

- Fork develop was reset to upstream; alpha caught up; 16 stale PRs closed.
- The whole release's **protos** and **tests** are packaged into **one upstream PR each**
  (device-protocol + python-keepkey). These gate everything (SOP = upstream-first).
- **13 firmware staging PRs** opened into fork `develop`. 10 green (ready to merge in
  order), 2 intentionally red (blocked on the device-protocol PR), 1 high-risk needing
  on-device verify.
- SOP documented + corrected in a doc PR.

---

## The model (so reviewers understand the red)

**Release = UPSTREAM-ONLY pins.** Nothing merges to fork `develop` until its proto/test
deps are merged into `keepkey/device-protocol` + `keepkey/python-keepkey` **masters**
first (peer-review gated, days). Mergability is **in order** — develop accumulates, each
PR is green *in its turn*, not standalone on bare develop. A later PR being red because
its base/proto isn't upstream yet is the *correct* signal, not a defect.

Full SOP: `docs/firmware-release-sop.md` (PR keepkey-vault#304).

---

## NEEDS HUMAN ACTION (tomorrow)

| # | PR | What | Action |
|---|----|------|--------|
| 1 | **keepkey/device-protocol#111** | All release protos: thorchain `denom`, ripple `memo`, full Hive (msgs 1600–1609), Zcash clear-sign/Orchard | **Get keepkey maintainer review + merge.** This is the critical path — everything pins it. |
| 2 | **keepkey/python-keepkey#196** (DRAFT) | All release tests (hive/zcash/insight/denom/memo/router vectors). Verified green vs alpha. | Review the test code now; **before merge:** re-pin its `deps/device-protocol` from the fork commit → `keepkey/device-protocol` master (only possible after #1 merges), then un-draft. |
| 3 | **keepkey/keepkey-vault#304** | Firmware-release SOP doc (upstream-first gating + in-order mergability) | Review + merge (internal doc). |
| 4 | **BitHighlander/keepkey-firmware#272** (bip39-recovery) | Restores a 6-yr-old inverted condition in seed-recovery finalize + per-word validation | ⚠️ **HIGH RISK** — touches seed recovery + a `storage_reset()` wipe path. **On-device verify in BOTH strict-BIP39 and loose/import modes + dry-run** before merge. C31 integration test arrives via #196. |

**Human outreach:** ping the keepkey device-protocol + python-keepkey maintainers to
review #111 and #196. These are external-ish reviews with multi-day latency — start the
clock first thing. A sloppy/late PR turns days into weeks, so #111 was kept minimal
(proto-only, no lib/ artifacts, no CI churn).

---

## Firmware staging PR inventory (into `BitHighlander/keepkey-firmware` develop)

### Batch 1 — bugfixes (independent, green-first)
| PR | Fix | CI | Notes |
|----|-----|----|----|
| #262 | token-chain-id (uint8→uint32) | 🟢 | ready |
| #263 | eip712-security | 🟢 | ready |
| #264 | ton-blind-sign | 🟢 | ready |
| #265 | tron-blind-sign | 🟢 | ready |
| #266 | tron-tip712-gate | 🟢 | ready |
| #267 | solana-token-decimals | 🟢 | ready |
| #268 | maya-evm-display | 🟢 | needed a const-qualifier companion fix (`thortx.c`) |
| #271 | fault-injection | 🟢 | ready |
| #272 | bip39-recovery | 🟢 | ⚠️ HIGH-RISK — see action #4 above |
| #269 | **TCY/RUJI** (thorchain any-denom) | 🔴 | **blocked**: needs `ThorchainMsgSend.denom` (device-protocol#111). Pinned to upstream master to show honest red. Re-pin → green after #111. |
| #270 | **ripple-memo** | 🔴 | **blocked**: needs `RippleSignTx.memo` (device-protocol#111). Same. |

### Batch 3 — bip85
| #273 | BIP-85 child mnemonic (display-only) | 🟢 | firmware-only; proto already on keepkey/master; needed a cppcheck fix (`| 0`) |

### Deferred — stage in their turn (after foundation + earlier batches land)
- **Batch 2 — EVM clear-signing** (#255 rlp-strip → #257 insight → #258 → #260 → **#261 CRITICAL drainer**). Adds alpha-only `signed_metadata.c`; needs `ethereum.c` reconcile vs develop's EIP-1559. Insight proto already on keepkey/master.
- **Batch 4 — Hive** and **Batch 5 — Zcash (+ final touches: S.2 transparent digest, PCZT clear-sign)**. Alpha-only, bundled in the base-foundation squash `98526642` (needs split-by-chain). 177–192 commits ahead of develop — cut these *after* the foundation is on develop.

---

## Key artifacts / branches

- Reconciled python-keepkey: `BitHighlander/python-keepkey:reconcile/upstream-sync` (`452ca98`) — upstream merged in + #261 router-pin test fix; verified green (firmware CI run #28422476385 + local docker 426/0).
- device-protocol release branch (= #111 source): `BitHighlander/device-protocol:up/release-protocol` (`f9e6081`).
- Firmware staging branches: `stage/*` on `BitHighlander/keepkey-firmware`.

---

## Next actions when #111 merges
1. Re-pin #269/#270 (and, per SOP, all firmware fixes) `deps/device-protocol` → updated `keepkey/device-protocol` master → they go green.
2. python-keepkey#196: re-pin `deps/device-protocol` → master, un-draft, get merged.
3. Merge batch-1 + bip85 into develop in order.
4. Stage clear-sign → hive → zcash against the accumulated develop (now buildable).
5. Firmware itself goes upstream LAST (keepkey/keepkey-firmware), after all green + merged to fork develop.

---

## RETRO

**What went well**
- The SOP did its job: verifying green *before* trusting a PR caught real defects, not cosmetics.
  - python-keepkey reconcile was based on the wrong commit (fork master vs alpha's actual pin) and silently shipped stale THORChain router test vectors → 4 failures. The green-check caught it; cherry-picking the router-pin commit fixed it.
  - bip39 "fix" interrogated to its 2019 origin — confirmed it's a real 6-yr-old inverted condition, not a non-bug; flagged the wipe-path risk.
  - maya (const-qualifier), bip85 (cppcheck `| 0`) — real build/lint gates surfaced and fixed.
- Clean separation of **independent fixes** (cherry-pick + green now) vs **feature stacks** (defer to their turn) kept the gauge honest and avoided red-stub churn.
- Comprehensive-over-batch upstream PRs (one device-protocol, one python-keepkey) minimize the days-long review cycles.

**What was tricky / cost time**
- **zsh word-splitting** bit twice: `git cherry-pick $cs` with a multi-line var passes all SHAs as one bad-revision arg. Multi-commit branches (fault-injection, ripple-memo) looked like "conflicts" but weren't. Fix: per-commit `while read` loop.
- **Stale worktree → branch-name collision:** an early `/tmp/kk-verify` held `stage/thorchain-any-denom`, so `checkout -B` silently no-op'd and cherry-picks landed on the wrong branch, polluting maya #268. Cost a rebuild. Lesson: clean up worktrees immediately; verify `HEAD` after checkout.
- **Scope correction:** opened two batch device-protocol PRs (#109/#110), user wanted one comprehensive PR (#111). Should have confirmed "comprehensive vs batch" up front.
- **Fork-vs-upstream model:** the "device-protocol = fork only" rule is the *alpha* rule; *releases* go upstream. Took a clarification to get right.

**To improve next time**
- Set `git config --global` safe defaults in scratch worktrees; always `HEAD`-check after branch switches in scripted loops.
- Confirm PR granularity (comprehensive vs per-change) before building.
- Front-load the "what's the release boundary" question (alpha pin `5c2d45f` excludes NEAR) so scoping is settled once.

**Open risks**
- bip39 #272 seed/wipe path — must be device-verified before merge.
- The deferred clear-sign/hive/zcash reconciles (ethereum.c + base-foundation split) are real work, not cherry-picks — budget for them after the foundation lands.
- #111/#196 review latency is the schedule risk; nothing automated speeds it.
