# Handoff — 7.15 Dress Rehearsal, Round 2 (firmware only)

**Status:** plan, ready to execute from a cold context. Nothing destructive done. Every SHA/count verified live via `git`/`gh` on **2026-07-16** — not from memory (memory has been stale before; re-derive in STEP 0 anyway).

**Scope:** firmware only. BEX/client owned by another agent. Vault ships in parallel (`RELEASE-CONTROL-7.15.md`).

---

## 0. The SOP (as clarified by the author, 2026-07-16)

> First we make PRs into the upstream branches that are themselves PR'd to master. We make a branch and PR it **into the branch PR'ing into master**. **The PR into master becomes the canonical pin** for all work done in the fork going forward. The branch-into-branch PR is **for review purposes**. The PR into the PR-into-master **can come from the fork**.

```
<feature branch, may live on the fork>
        │  PR  ← review vehicle
        ▼
up/release-protocol      ──PR #111──►  keepkey/device-protocol : master  ─┐
reconcile/upstream-sync  ──PR #196──►  keepkey/python-keepkey  : master  ─┴─► CANONICAL PINS
        │                                    (firmware re-pins to these merged master SHAs)
        ▼
keepkey/keepkey-firmware : develop  ◄── the 7.15 stack #444–#448 ◄── round-2 PRs 6..N
```

**Bottom-up rule:** proto + tests land on their masters first; firmware pins them after. Nothing in the firmware stack finalizes before that.

Other binding rules (`firmware-release-sop.md`, `handoff-715-upstream-dress-rehearsal.md`):
- **Mergability is in order, not in isolation** — each PR green *in its turn*, on the full 3-variant matrix.
- **Non-destructive** — never move a shared branch until the new state is proven.
- **Dependency-true order, infra/build-flags LAST** (round 1 replaced "infra first" after a 12-file conflict storm). The SRAM gate must measure the **final** tree.
- **Never pin a fork/feature SHA in an upstreamable PR** (SOP:80-81: "an ancestor-of or equal-to master commit; never a fork/feature SHA").
- **Gate-3**: no firmware PR approval without on-device OLED proof. Emulator 28/28 is not a substitute.
- pyk pushes go to the **fork** remote (`bithighlander`); `origin`/`upstream` are both keepkey.

---

## 1. THE REFRAME — the proposal is already half-done ⚠️

The proposal was: *"checkout step 5 of the 1/5 upstream firmware PRs, bring that into fork develop, and practice our dress rehearsal on the firmware updates after that point."*

**"Bring #448 into fork develop" is a NO-OP — and as a reset it would be destructive.**

```
git merge-base --is-ancestor dada55e9 bithighlander/develop   → YES
git rev-list --left-right --count dada55e9...bithighlander/develop → 0   48
```

#448's head is **already an ancestor** of fork develop; the upstream stack was cut *from* fork develop. Fork develop is just **48 commits ahead**. Executing it as `reset --hard` would move develop **backward** and regress `deps/device-protocol` **f0b45498 → 33521a8**, un-defining Hive msgs 1614–1617 while `hive.c`/`fsm_msg_hive.h` remain — the exact failure hit on 2026-07-16 ("Unknown message (code 1)" + wedged transport, which *looks* like a firmware bug but is a pin regression).

**Round 2 = EXTEND the #448 stack with PRs 6..N. No reset, no rebase of #444–#448.**

Round 1's "diff-curation, not cherry-pick" lesson was a consequence of rebasing 107 sprawled commits onto a **bare** upstream base lacking context. **That condition is absent here** — the base (dada55e9) already contains every dependency the delta assumes, and 14 of the 33 non-merge commits are already isolated on ready-made fork branches. Round 2 is **thematic-append**, with hand-curation only where shared files actually collide.

### The real structure: the fork ran **7 parts**; upstream got **5**

| Fork merge | Upstream | Status |
|---|---|---|
| `bac4cdd4` 7.15 (1/7) EVM clear-signing core | #444 | ✅ open upstream |
| `9d09955a` 7.15 (2/7) New chains — Hive **(phase-1 only)**, Zcash Orchard, Ripple, THOR any-denom | #445 | ✅ open upstream |
| `e28688a7` 7.15 (3/7) Device robustness | #446 | ✅ open upstream |
| `c3c9e4b8` 7.15 (4/7) Per-chain clear/blind-sign | #447 | ✅ open upstream |
| `9844ef4e` 7.15 (5/7) Build variants + seed-lock + version 7.15.0 | #448 | ✅ open upstream |
| `9e9652d5` **7.15 (6/7) Persistent clear-sign identities + icons (STORAGE_VERSION 18)** | — | ❌ **branch exists, not upstream** |
| `110b78ab` **7.15 (7/7) Emulator dylib — Windows cross-compile** | — | ❌ **branch exists, not upstream** |

Verified linear ancestry:
```
upstream/develop 1af2ffe7 → bd49ac17(#444) → a53eca0e(#445) → f8fc0a73(#446)
   → 8c6c24ff(#447) → dada55e9(#448) → 871505ac(pr6) → e87c2591(pr7) → 183a2b93(fork develop == rc10)
```

---

## 2. 🔴 LIVE RELEASE BLOCKER FOUND — same-name branch collision

**There are two different branches named `up/release-protocol`:**

| Ref | SHA | What |
|---|---|---|
| `BitHighlander:up/release-protocol` | **2ec999a9** | **#111's HEAD** (`gh pr view 111 --json headRefOid`) |
| `keepkey:up/release-protocol` | **33521a8** | `feat(clearsign): identity icon + persist` — **this is what #448 PINS** |

device-protocol ancestry (linear off keepkey master `f2c3c005`):
```
f2c3c005(master) → 2ec999a9(#111 head) → 33521a8(icon+persist; #448's pin)
   → 9e46aeb(HiveSignMessage 1614/1615) → a793934(docs) → f0b4549(HiveSignOperations 1616/1617; fork develop's pin)
```

**So #111 is ONE COMMIT BEHIND what #448 already pins.** Merging #111 as-is produces a master on which **#448's pin is unreachable** — and #448 already ships `LoadClearsignSigner.icon max_size:384` in its `.options`, which would be an **orphan nanopb option** → build break.

Separately: **fork develop pins `f0b45498`, which exists ONLY on BitHighlander/device-protocol** (`git ls-remote keepkey/device-protocol | grep f0b45498` → no match) — a live violation of SOP:80-81.

**Both are fixed by PR #36 below.**

---

## 3. ✅ DONE 2026-07-16 (Phase 0 — bottom of the SOP stack)

Both stack into the branches that PR to master, exactly per the SOP. **Awaiting third-party review.**

| PR | Base → | Commits | Diff | Fixes |
|---|---|---|---|---|
| **[BitHighlander/device-protocol#36](https://github.com/BitHighlander/device-protocol/pull/36)** | `up/release-protocol` → #111 → master | 4 | **+79 / −0**, 5 files | Advances #111 `2ec999a9 → f0b4549`: `33521a8` icon+persist (**closes the blocker above**) · `9e46aeb` 1614/1615 · `a793934` docs · `f0b4549` 1616/1617 |
| **[BitHighlander/python-keepkey#27](https://github.com/BitHighlander/python-keepkey/pull/27)** | `reconcile/upstream-sync` → #196 → master | 17 | +1429 / −92, 17 files | Advances #196 `e728e311 → 15d95ec`: closes the 10-commit gap to `560b897` (#448's pin) **and** adds hive suites (+465) + clearsign v2 harness (+240) |

These two PRs collapse what the raw plan listed as four separate foundation steps. Chosen as **PRs** rather than silent fast-forwards of the open PRs' heads — reviewable, and matches the author's SOP.

---

## 4. Round-2 PR groups (dependency-true order)

Build & prove each **on the fork first** (that *is* the rehearsal); promote to upstream only after green-in-turn.

| ID | Upstream title | Source | Depends on | Size |
|----|---|---|---|---|
| **R2-A** | `7.15 (6/N)` Persistent clear-sign identities + icons (**STORAGE_VERSION 17→18**) | fork branch `release/7.15.0-pr6-persistent-identity` @ **871505ac** — **already built**, verified ancestor of develop; lift verbatim | base `dada55e9`; **HARD**: dp pinned ≥ `33521a8` (sole consumer of icon/persist fields) | 10 commits / 11 files / **+877 −236** — largest, highest review risk (storage migration). Keep standalone. |
| **R2-B** | `7.15 (7/N)` Emulator dylib (Windows cross-compile, poll-thread confirm gating) | fork branch `release/7.15.0-pr7-emulator-dylib` @ **e87c2591** — already built; lift verbatim | R2-A | 4 commits / 13 files / +590 −88. **DECISION: may be legitimately fork-only** (dev tooling, no upstream device consumer). |
| **R2-C** | `7.15 (8/N)` **Hive phase-2** — SignMessage 1614/1615 + SignOperations 1616/1617 + SLIP-48 hardening | new branch `release/7.15.0-pr8-hive` off e87c2591; cherry-pick linear chain `005cc023 91a63617 f22b56da ddade55d cbf33967 b5ddeb09 767276d2` | R2-B; **HARD-BLOCKED on #36 + #27 reaching master** (needs dp f0b4549 + pyk 15d95ec) | 7 commits / ~6 files / ~+690 −35. Strict **superset** of #445's hive phase-1 (5→7 handlers) — additive, **zero rework of #445**. |
| **R2-D** | `7.15 (9/N)` Zcash shielded-signing progress UX + emulator privacy default | new branch off pr8; `b9a778c4 e50f1f4c 5ce715b9 c81ec389 33c2f379` | R2-C. Pin-neutral. | 5 commits / 5-7 files / ~+174 −8. Display-affecting → **Gate-3 re-capture**. |
| **R2-E** | `7.15 (10/N)` SRAM frame arena + 16KiB reserve gate + CI timeouts | new branch off pr9; `424d9eb4 8a50729e c36488fd da8a23ec` | R2-D. **MUST BE LAST** — the reserve gate must measure the final tree. | 4 commits / ~17 files / ~+590 −115. **Heaviest curation.** |
| **R2-F** | `7.15 (11/N)` THORChain clear-sign on every EVM chain | fork **PR #309** @ `715c173e` (**OPEN, not merged**) | Independent — R2-E or standalone off #448 | 1 commit / 3 files / +236 −14. **Security-adjacent.** |

### Hand-curation map (only where shared files actually collide)
- **R2-C**: `include/keepkey/firmware/fsm.h` (forward decls ×2), `lib/firmware/messagemap.def` (MSG_IN/OUT 1614–1617), `messages-hive.options`.
- **R2-D**: `lib/board/layout.c/.h` (collide with R2-A's icon render), `CMakeLists.txt` (collides with R2-B/R2-E). Ordering resolves most.
- **R2-E**: heaviest — `signed_metadata.c` (R2-A/#444 territory), `fsm_msg_bip85.h`, `reset.c`, `recovery_cipher.c`, `lib/board/usb.c`, `CMakeLists.txt`, `ci.yml`.
- **R2-A / R2-B**: no collisions with each other.

---

## 5. Execution (cold-start)

- **STEP 0 — RE-VERIFY.** `git fetch keepkey && git fetch bithighlander`; re-derive every SHA above. Do not trust prose.
- **STEP 1 — PRESERVE.** rc10 is branch-preserved (`refs/heads/release/7.15.0-rc10` == develop == `183a2b93`) but **NOT tag-preserved**. Branches are force-updatable/prunable — weak for a release tip. Also tag the **fork-only** dp pin so it can't be GC'd:
  ```bash
  git tag -a fork-develop-preround2-183a2b93 183a2b93 -m 'fork develop/rc10 tip entering round-2' && git push bithighlander fork-develop-preround2-183a2b93
  cd deps/device-protocol && git tag -a fw-develop-dp-pin-f0b4549 f0b4549 -m 'dp pin of fw fork develop (Hive 1614-1617)' && git push origin fw-develop-dp-pin-f0b4549
  ```
- **STEP 2 — DECIDE.** Answer §7 (they gate the rest).
- **STEP 3 — FOUNDATION.** Get **#36** and **#27** reviewed + merged → then **#111** and **#196** → **master**. Record the merged master SHAs = the canonical pins. *(Everything below is hard-blocked on this.)*
- **STEP 4 — RE-PIN #444–#448** from practice-pins (`33521a8`/`560b897`) to the merged **master** SHAs; verify by hand the pins are on master (CI may only check ancestor-of-a-known-branch). Merge the stack **#444→#445→#446→#447→#448** in order; #449 independently.
- **STEPS 5-9 — BUILD R2-A…R2-E on the fork**, in order, each: local Docker verify **first** (SOP: verify-locally-not-CI), then 3-variant CI green **in its turn**.
- **STEP 10 — ACCEPTANCE TEST** (round 1's bijection proof): the R2-E tip's tree must be **identical** to fork develop:
  ```bash
  git diff --stat release/7.15.0-pr10-sram-ci 183a2b93   # MUST be empty (modulo submodule pins)
  ```
- **STEP 11 — GATE-3.** OLED proof for display-affecting deltas: R2-A identity icons, R2-D zcash progress bar, R2-C hive display budget (`ddade55d`), R2-F (#309). Plus storage-migration proof if R2-A ships (flash v17 → upgrade → keys preserved).
- **STEP 12 — PROMOTE** (needs explicit author OK; pushes to keepkey/keepkey-firmware): push each proven branch upstream with the same name, open PRs bottom-up. Retitle #444–#448 `(N/5)` → `(N/9)` via `gh pr edit` — touches no git, resets no CI.
- **STEP 13 — DOC HYGIENE.** In `handoff-715-upstream-dress-rehearsal.md`, delete the dangling `scratchpad/curation-specs.json` citation at :149 — **that file does not exist anywhere on disk**; nothing should plan around it.

### 🚫 NEVER
`git push --force bithighlander develop` · `git reset --hard` on develop · rebase/force-push #444–#448 (burns 5 green CI runs + in-flight review on PRs open since 2026-07-08) · `git submodule update --remote/--force` on the vault's firmware submodule (the vault pins `ddade55d`, *inside* the hive stack) · move the dp pin backward.

---

## 6. Risks & guards

| Risk | Guard |
|---|---|
| Reset regresses dp pin → hive breaks | **Don't reset.** #448 is already an ancestor. |
| #111 merges one commit short → #448's pin unreachable → orphan nanopb option → build break | **PR #36** (merge before #111). |
| Deep stacking (9-10 PRs) on an unreviewed 5-stack; upstream develop moves → full-train rebase | Timing decision in §7. |
| R2-E measured too early | It goes **last**, by construction. |
| Gate-3 captured mid-stack | Capture at the final rc only. |
| #309's memo fix lost | Tracked as R2-F; exploitable on shipped mainnet firmware. |

---

## 7. Decisions needed before executing

1. **CONFIRM THE REFRAME** — round 2 = extend #448 with PRs 6..N, **no reset**. This contradicts the literal proposal; needs explicit sign-off. *(blocks everything)*
2. **R2-A in 7.15.0?** Persistent identities + STORAGE_VERSION 17→18. You chose **warning-gated clearsign, key ceremony deferred** — if identities are only meaningful with a real trust anchor, R2-A may defer to 7.15.1, which also removes the riskiest storage migration from this release.
3. **R2-B upstream at all?** Emulator dylib is dev tooling with no upstream device consumer. If fork-only, round 2 shrinks by 4 commits and R2-C re-bases on `871505ac`.
4. **R2-F (#309) in or out?** Security-adjacent: non-mainnet EVM THORChain deposits blind-sign today. Fold into #447, or ship standalone (separate may review better)?
5. **Renumber #444–#448** `(N/5)` → `(N/9)`? Free, clearer for reviewers.
6. **Timing** — open round-2 PRs now (stacked deep on an unreviewed 5-stack), or wait for #444–#448 to merge?
7. **Disclosure** — the thortx 64-byte memo read is exploitable on *shipped* firmware. Handle disclosure before a public PR description explains it?
