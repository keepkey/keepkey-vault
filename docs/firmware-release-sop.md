# Firmware Release SOP — Upstream-First Dependency Gating

> Supersedes the Phase-5-last ordering in
> `docs/release-notes/firmware-7.14.0-release-plan.md`, which is **wrong for a
> release** (it pushes the proto/test dependencies upstream *after* fork-develop
> merges). The vault `docs/submodule-pinning-sop.md` covers the desktop-Vault
> submodules only and does not mention `python-keepkey`; this doc governs the
> **firmware** release.

## The rule (read this first)

On a **release**, the firmware is built **UPSTREAM-ONLY**. Nothing merges into
`BitHighlander/keepkey-firmware` `develop` until every proto/test dependency it
needs is **green and merged into the UPSTREAM masters first**:

- `keepkey/device-protocol` `master` (proto / wire format)
- `keepkey/python-keepkey` `master` (integration test harness)

These two upstream merges are **human-peer-review gated** — review latency is
**days**, and a sloppy PR turns days into weeks. They are the critical path.
Submit them first; keep them clean, concise, and clear.

> Contrast: `alpha` (the testbed) pins submodules to the **forks**. A release
> does not. `alpha` = fork pins; `release` = upstream pins. Do not confuse them.

## Order of operations (bottom-up)

```
1. UPSTREAM PROTO + TESTS  (peer-reviewed, days)
   ├─ PR proto changes  → keepkey/device-protocol  master   ── merge
   └─ PR test changes   → keepkey/python-keepkey    master   ── merge
            │ (only after BOTH merged + green)
            ▼
2. PIN firmware fork-develop submodules → those UPSTREAM masters
            ▼
3. MERGE individual firmware fix PRs → fork develop
   (each PR pins upstream masters; each stays green; one at a time)
            ▼
4. UPSTREAM the firmware  → keepkey/keepkey-firmware  develop   (LAST)
   (only after everything is green and merged into fork develop)
```

Why bottom-up: a firmware PR that references a new proto message or relies on a
new integration test **cannot be green** until that proto/test exists on the
upstream master it pins. Merging firmware first (the old Phase-5 order) pins
fork branches / unreviewed SHAs and defers the slow review to the end —
maximizing the chance of a late-cycle, weeks-long stall.

## Staging on fork develop (while upstream PRs are in review)

Each fix is a **singular PR** into fork `develop`, cherry-picked from its
original feature branch (skip the `chore: pin submodules` commits). Order them
**green-first**: firmware-only fixes (no new proto/test) go green immediately on
develop's pins; fixes that need a not-yet-merged proto/test are pinned to the
**current** upstream master and sit **red — intentionally — until their upstream
PR merges**. Red here is the correct signal: "parked behind an upstream PR,"
not "broken." When the upstream PR lands, re-pin to the updated master → green.

To rehearse the eventual pin-swap safely, a fork pin may be used as a *practice*
pin; the production state is always the upstream master.

### Mergability is *in order*, not in isolation

The success criterion is **"the SOP can be followed in order and stay green at
each step,"** not "every branch builds standalone on bare develop." Staging is a
**sequential pipeline**: develop accumulates as batches merge, and each PR is
green *in its turn* — after its predecessors (and the upstream foundation) have
landed. A later-batch PR being **red on today's develop is correct** when its
base isn't there yet; it goes green once the batch it depends on merges.

Practical consequence: stage and merge the **independent, develop-compatible
fixes first** (they're green immediately). Defer **feature stacks that ride the
alpha base** (e.g. EVM clear-signing, Hive, Zcash — which add alpha-only files or
share a base-foundation commit) until their turn in the order; cutting them onto
bare develop early produces low-signal red stubs and heavy reconciles, not
useful PRs.

## Per-firmware-PR merge gate (before merge into fork develop)

- [ ] `deps/device-protocol` pinned to `keepkey/device-protocol` master
      (an ancestor-of or equal-to master commit; never a fork/feature SHA)
- [ ] `deps/python-keepkey` pinned to `keepkey/python-keepkey` master
- [ ] Every proto message / field the PR uses exists on the pinned device-protocol
- [ ] Every integration test the PR needs exists on the pinned python-keepkey
- [ ] CI green (build + unit + python-keepkey integration + test-report.pdf)
- [ ] On-device verification for device-facing changes

## Reconcile-before-PR (python-keepkey)

If the fork is behind upstream, pull `keepkey/python-keepkey` master **into** the
fork and verify green against the **alpha** emulator (which has every feature the
tests exercise) before building the upstream PR. Build the upstream PR from that
green base, not a stale one. Watch for divergence traps: the commit `alpha`
*pins* may not be fork `master` (e.g. firmware-pinned router test vectors can
live only on the pinned commit), so reconcile against what alpha actually pins.

## Clang-format

CI's `lint-format` job pins **clang-format 20** (`clang-format-20`). Format with
that exact version (`clang-format@20`, v20.1.x) — a newer local clang-format
(v22+) over-reformats and still fails CI.
