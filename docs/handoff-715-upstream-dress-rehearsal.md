# Handoff — 7.15 Upstream Dress Rehearsal (reconstitute ~26 PRs → 4)

**Status:** plan. Nothing reset yet. This defines the next phase per
`firmware-release-sop.md` (upstream-first, bottom-up) and the author's ask:
reset fork develop to upstream develop and re-introduce the 7.15 work as a
*small* number of clean, coherent, reviewable PRs — down from the ~12–26 the
first pass produced. The reconstitution itself is the value: it forces each
feature into a self-contained, human-readable, individually-green diff, which
is what survives upstream peer review.

## What a dress rehearsal is (definition)

1. **Reset** fork `BitHighlander/keepkey-firmware:develop` to **upstream**
   `keepkey/keepkey-firmware:develop` (the clean base everyone will review against).
2. **Reconstitute** the 7.15 delta as **3–4 thematic feature PRs** into a fresh
   fork develop — each self-contained, each green *in its turn* (SOP §"Mergability
   is in order, not in isolation"), each pinning the **upstream** proto/test
   masters (never fork SHAs).
3. It is a *rehearsal*: fork develop is the practice stage; the production target
   is upstream `develop`, gated behind the two upstream-master merges below.

## Current state (measured 2026-07-07)

- Fork `develop` is **107 commits / ~26 merged PRs** ahead of upstream
  `keepkey/keepkey-firmware:develop`. That sprawl (#262–#293) is the 7.15 line.
- **Foundation already staged upstream** (the bottom of the SOP stack):
  - `keepkey/device-protocol:up/release-protocol` @ `33521a8` (PR #111 → master)
  - `keepkey/python-keepkey:reconcile/upstream-sync` @ `1674346` (PR #196 → master)
  - Both are content-complete + CI-green (rc5 built on them). Master merges are
    peer-reviewed + later — they are the **critical path** (SOP §"The rule").
- **Nothing is lost by the reset:** the current tip is preserved on
  `release/7.15.0-rc5` (@ `9372730d`) and every feature branch still exists.

## DECIDED (2026-07-07)
- **5 PRs** — clear-signing split into **1a core** + **1b per-chain** (below).
- **Non-destructive:** build on a fresh `rehearsal/7.15-upstream` branch off
  upstream develop; fork `develop` stays intact until the grouping is proven.
- **Practice-pins:** pin the upstream *branch tips* now (device-protocol
  `up/release-protocol` @ `33521a8`, python-keepkey `reconcile/upstream-sync` @
  `1674346`) so the rehearsal isn't blocked on days-long master review; swap to
  the real master SHAs for the actual upstream PR.

## Proposed regrouping — ~26 PRs → **5 feature PRs**

Each maps a pile of the original stage/** PRs into one coherent, reviewable diff.
The messy bundles get *split by theme* (e.g. #279 mixed zcash + eth-hardening +
insight — that gets torn apart, not preserved).

### PR 1a — EVM clear-signing CORE
The signed-metadata trust system + the EVM hardening it rides on. The marquee diff.
- signed-metadata v1 + **v2 static schema** (#281 warning/phase-1, #284 v2 +
  LoadClearsignSigner + **icon proto**), insight (#257/#258 from #279).
- EVM hardening: eip1559 zero-priority RLP (#275), eip712 security (#263), token
  chain-id (#262), ETH RLP length-strip (#255/#260/#261).
- Pins: device-protocol `up/release-protocol`, python-keepkey `reconcile/upstream-sync`.

### PR 1b — Per-chain clear-sign (rides on 1a)
The application of the metadata system to each non-EVM family. Green only after 1a.
- TRON (#285 clearsign, #266 tip712-gate, #265 blind-sign)
- Solana (#286 v0, #267 token-decimals)
- THOR/Maya (#287 memo-affiliate, #268 maya-evm-display)
- TON (#264 blind-sign)

### PR 2 — New chain support
Net-new chains / address+memo formats, independent of clear-signing.
- Hive SLIP-0048 (#276), Zcash Orchard (zcash half of #279), Ripple memo (#270),
  THORChain any-denom (#269).

### PR 3 — Device robustness & key features
Non-clearsign firmware features + hardening.
- BIP-85 (#273), BIP-39 recovery (#272), fault-injection hardening (#271).

### PR 4 — Build / CI / release infrastructure
Already partly on develop; consolidate as one infra PR (or leave as the small
merged set — these are low-review-risk).
- Build-flag variants btc-only / zcash-privacy (#282), CI variant matrix +
  canonical names (#290, #293), PDF-report harness pin (#288), submodule
  canonical-pin plumbing (#292).

> Rationale for 4: each is a **reviewable story** with a single theme, self-
> contained enough that a reviewer holds it in their head. PR 1 is unavoidably
> large (it's the marquee feature) — keep it coherent, not artificially split;
> offer the 1a/1b split only if a reviewer asks.

## Reconstitution findings (2026-07-07, from starting PR 4)

Attempting PR 4 first surfaced the real structure — worth internalizing before grinding:

1. **The feature branches are STACKED, not isolated.** Every `feat/**` branch was
   authored on top of the accumulated 7.15 develop (clearsign → hive → version-bump
   → …), so its commits' diff *context* assumes that stack. Cherry-picking the
   "isolated" build-flag commits onto bare upstream develop conflicted in **12
   files** (fsm.c, storage.c, CMakeLists, app_confirm, …) — the surrounding lines
   they patch don't exist yet.
2. **Hidden dependency chain:** build-flag variants (bitcoin-only / zcash-privacy)
   touch `storage.c`/`fsm.c` and lean on 7.15 storage-version + message context ⇒
   NOT independent. And the **CI variant matrix depends on the build flags**
   (bitcoin-only / zcash-privacy CMake flags must exist for those jobs to mean
   anything). So the naive "infra PR is green-first" is FALSE: variant-CI → needs
   build-flags → needs 7.15 storage/fsm context.
3. **Consequence — reconstitution is diff-curation, not cherry-pick.** Because
   final fork develop is known-green, the tractable method is: per PR, take that
   feature's **curated diff** and apply it in **true dependency order**, resolving
   the shared-file hunks (fsm.c / storage.c / CMakeLists / messagemap.def) by hand.

### Revised order (dependency-true, replaces the earlier "infra first")
```
PR 1a  clearsign CORE      — the storage/fsm/proto foundation most things touch
PR 2   new chains          — Hive/Zcash/Ripple/THOR-denom (own files + shared CMake/fsm)
PR 3   robustness          — bip85 / bip39-recovery / fault-injection
PR 1b  per-chain clearsign — rides 1a
PR 4   build-flags + CI matrix + report — LAST: it wraps everything (variant
       builds gate the coins/features the earlier PRs added; CI-only bits
       (report harness, release.yml) could split into a tiny green-first PR 0
       if a pure-infra quick win is wanted)
```
Rationale: build the foundation the shared files accrete onto, THEN the wrapper
that depends on all of it. "Infra first" only works for the *pure-CI* slice
(ci.yml report/release, no C) — carveable as an optional PR 0.

## PR 1a execution recipe (clearsign core) — the exact delta map

Base: `pr/rehearsal-1a-clearsign-core` off `rehearsal/7.15-upstream`. Practice-pin
device-protocol `up/release-protocol` (`33521a8`) + python-keepkey
`reconcile/upstream-sync` (`1674346`) first (the proto/tests it needs).

- **NEW (clean add — take fork develop verbatim):**
  `include/keepkey/firmware/signed_metadata.h`, `lib/firmware/signed_metadata.c`,
  `unittests/firmware/signed_metadata.cpp`.
- **EVM-exclusive MODIFIED (take fork develop final state — self-contained on the
  EVM/thorchain/eip712 base already upstream):** `lib/firmware/ethereum.c`,
  `ethereum_contracts.c` + `ethereum_contracts/{saproxy,thortx,zxappliquid,
  zxliquidtx,zxswap,zxtransERC20}.c`, `eip712.c`, `include/.../eip712.h`,
  `ethereum_tokens.h`, `ethereum_contracts/thortx.h`,
  `include/keepkey/transport/messages-ethereum.options` (incl. the `icon`
  max_size:384 line + LoadClearsignSigner entries).
- **SHARED dispatchers — CURATE clearsign hunks only (do NOT take final state; they
  carry hive/zcash/bip85/etc.):** `lib/firmware/fsm.c` (LoadClearsignSigner +
  EthereumTxMetadata dispatch), `lib/firmware/messagemap.def` (msg 115/116/117
  entries), `lib/firmware/CMakeLists.txt` (+signed_metadata.c) and top `CMakeLists.txt`.
- **Verify:** local Docker `make -j kkemu` (init deps/python-keepkey too), then CI.
  ⚠ Some of this may already be on upstream develop from a prior cycle (signed_metadata
  showed both A and pre-existing in probes) — diff each MODIFIED file against
  upstream develop first and take only the *net-new* hunks so the PR is a true
  minimal delta.

## VERIFIED CURATION MAP (workflow wf_b59cd1da, 2026-07-07)

Full spec: `scratchpad/curation-specs.json`. Adversarial synthesizer verified a bijection over all
89 files. Method insight: **each of the 107 commits is cleanly attributable to ONE PR** — so
reconstitution = cherry-pick PR commit-groups in dependency order (not hunk-surgery). End-state must
equal origin/develop (device-protocol `33521a8`, python-keepkey `1674346`, trezor-firmware `56f404e4`).

**Fixes baked into the order below:**
1. Orphan `unittests/firmware/coins.cpp` (1838c56c) → **PR1a**.
2. `thortx.c/.h` double-claim → **PR1a wholesale** (Maya-EVM-display folds into 1a); PR1b drops it.
3. Submodule pins device-protocol `33521a8` + python-keepkey `1674346` + `.gitmodules` → **PR0 base**
   (needed by 2/3/4, not just 1a); pin the final canonical SUPERSET SHA, don't split ~17 intermediate bumps.
4. `deps/crypto/trezor-firmware`: **PR2 bumps → `0ea97b09`** (Orchard/Pallas — else zcash.c won't build);
   **PR4 → `56f404e4`** (AES_SMALL_TABLES superset).
5. `unittests/firmware/CMakeLists.txt` 4-way: PR1a=signed_metadata.cpp, **PR2=thorchain.cpp+zcash.cpp only**,
   **PR1b=tron/solana/mayachain.cpp**, PR4=the KK_BITCOIN_ONLY/#if restructure; drop no-op 28c74a0e.
6. Version bump `b3e38b35` (7.14.1→7.15.0) rides **PR4** (or a base commit if per-PR 7.15 identity matters).
7. Drop all merge commits + folded intermediate re-pins (a8e3ab4e/f38a57fb/28c74a0e/565add6c/etc.).

## Process (per SOP)

1. Confirm the two upstream-master foundation PRs (#111, #196) are **merged**
   (or, for the rehearsal, pin their current branch tips as *practice* pins per
   SOP §"rehearse the pin-swap"; swap to master SHAs for the real thing).
2. `git branch rehearsal/7.15-upstream upstream/develop` — the fresh,
   non-destructive base. Fork `develop` untouched (promote later once proven).
3. Build **PR 4 (infra)** first → into `rehearsal/7.15-upstream` — green
   immediately, unblocks the variant CI everything else runs under.
4. Build **PR 2 (chains)** + **PR 3 (robustness)** next — develop-compatible,
   green on their turn.
5. Build **PR 1a (clearsign core)** then **PR 1b (per-chain)** — pin the upstream
   proto+test *practice* tips; 1b is green only after 1a. Ordering is the SOP's
   green-in-turn pipeline, not standalone-on-bare-develop.
6. Per-PR merge gate: SOP §"Per-firmware-PR merge gate" checklist
   (upstream-master pins, proto/test existence, CI green, on-device verify).
7. Reconcile-before-PR for python-keepkey per SOP §"Reconcile-before-PR".

## Decisions — RESOLVED
1. ~~Split PR 1?~~ **Yes → 1a core + 1b per-chain (5 PRs total).**
2. ~~Rehearse against tips or master?~~ **Practice-pin the upstream branch tips now.**
3. ~~Destructive reset or fresh branch?~~ **Fresh `rehearsal/7.15-upstream` branch.**
4. Still open: **PR 4 scope** — one consolidated infra PR vs leaving the already-
   develop-compatible infra commits to ride the base (decide when building PR 4).

## Safety
- Current 7.15 tip preserved at `release/7.15.0-rc5` (`9372730d`) + all feature
  branches. The reset is reversible.
- No upstream **master** merge happens in the rehearsal — that stays peer-reviewed
  ([[handoff-upstream-pr-staging-strategy]], [[feedback-device-protocol-fork-only]]).

## EXECUTED — final fork dress rehearsal (2026-07-13)

Correction internalized: **dress rehearsals run on the FORK** (SOP step 3);
upstream merge is step 4, LAST. Also measured: upstream **master is stale at
7.14.0** (#421); v7.14.1 tag lives on `release-7141`, fully contained in
upstream develop → **reset base = upstream develop `1af2ffe7`**, never master.

What was done (worktree, no local checkout disturbed):
1. Canonical stack = upstream PRs **#444–#448** heads (`keepkey/release/7.15.0-pr1…pr5`,
   all CI-green, tree ≡ old fork develop mod python-keepkey pin). Old fork
   `pr/rehearsal-*` branches are a stale iteration — dead.
2. Built the two missing PRs on the fork (zero cherry-pick conflicts, file sets disjoint):
   - `release/7.15.0-pr6-persistent-identity` — 10 identity commits (storage v17→18, icons, compass)
   - `release/7.15.0-pr7-emulator-dylib` — 4 emu commits (#249–252)
3. **Fork develop force-reset to `1af2ffe7`** + seven `--no-ff` merges (pr1→pr7),
   mimicking the upstream merge train. Old tip preserved on `release/7.15.0-rc7`.
4. **`release/7.15.0-rc8` cut = new develop tip `c36488fd`** (= merge train
   `110b78ab` + one ci.yml fix: static-analysis timeout 5m→10m — cppcheck runs
   4m30s+ on the 7.15 tree, the 5m budget flaked two rc8 runs as "cancelled";
   the fix rides pr5/#448 when upstreaming). **CI GREEN on all 4 refs**
   (pr6, pr7, develop, rc8 — full 3-variant matrix each).
5. Proven: rc8 tree ≡ rc7 tree **except** `.gitmodules` + python-keepkey pin
   (rc8 pins upstream `560b897` — better SOP hygiene than rc7's fork pin).

Next: fork CI green (develop/rc8/pr6/pr7) → flash rc8, run on-device matrix
(G1–G12 + **7.14.1→v18 storage upgrade preserves wallet** + clearsign/identity
smokes + variant boots) → land #111/#196 upstream masters → pin-swap stack
bottom → upstream PRs 6/7 → merge #444→pr7 → upstream release/7.15.0 → tag.

Related: `docs/firmware-release-sop.md`, `docs/submodule-pinning-sop.md`,
`docs/handoff-firmware-rc-7x-test-matrix.md` (the first rehearsal's on-device
matrix), [[clearsign-identity-icons]], [[fw-715-rc3-release-cut]].
