# Handoff — Upstream PR Staging Strategy (7.15.0 → keepkey upstream)

**Status:** PLAN ONLY. Nothing here is executed. Executing ANY step requires explicit
per-step human authorization (see the ⚠ below).

> ⚠ **This contradicts a standing rule.** Two prior directives on record:
> - *device-protocol = FORK only* — never push/PR `keepkey/device-protocol` upstream.
> - *firmware PRs* — always `--repo BitHighlander/keepkey-firmware`, never upstream.
>
> This document exists because the author explicitly asked to prepare an **upstream** landing
> strategy. It does NOT override those rules by itself. Before any push/PR to a `keepkey/*` repo,
> confirm out loud that the fork-only rule is being intentionally lifted for this landing, and get
> a human review + go at EACH merge gate. Until then this is a paper plan.

---

## Goal

Land the 7.15.0 line (v2 static-schema clearsign, LoadClearsignSigner, Hive, bip85, zcash, etc.)
into **upstream** `keepkey/keepkey-firmware@develop`, with its two submodule deps
(`device-protocol`, `python-keepkey`) landed upstream first so the firmware PR pins **upstream**
commits, not fork commits. Green on **both** CI systems throughout.

## Dependency order (why deps land first)

The firmware PR pins exact submodule SHAs. If it pins fork SHAs, an upstream merge would import
fork-only history. So the deps must exist on their **upstream** default branches first; then the
firmware PR is re-pinned to those upstream SHAs and re-verified before merge.

```
device-protocol (upstream)  ──▶ merged to master
python-keepkey  (upstream)  ──▶ merged to master, green on CircleCI + GitHub
                                        │
firmware PR → upstream/develop  ── re-pin submodules to the two upstream master SHAs
                                        │
                                 verify still green (both CIs)
                                        │
                                 merge into upstream/develop
```

## Stages / groups

### Group A — device-protocol upstream
1. Open PR: upstream device-protocol branch → `keepkey/device-protocol:master`.
2. **Human review** (proto changes are wire-contract; review msg 117 + any field additions).
3. Merge to `master`. Record the merge SHA → this is a firmware pin target.

### Group B — python-keepkey upstream
1. Open PR: upstream python-keepkey branch → `keepkey/python-keepkey:master`.
2. Verify **green on BOTH**:
   - **GitHub Actions** on the PR.
   - **CircleCI** — note there are **two** CircleCI projects with different `$FIRMWARE_REPO`;
     feature tests MUST version-gate to SKIP where the firmware feature isn't present, or the
     wrong-firmware project goes red (see `pyk-ci-firmware-gating` memory). Confirm BOTH pass.
3. **Human review** → merge to `master`. Record the merge SHA → firmware pin target.
   - ⚠ pyk `origin` push often points at keepkey UPSTREAM while fetch is the fork — pushing pyk can
     trigger BOTH CircleCI projects and an upstream-red masks fork-green. Verify remote before push.

### Group C — firmware PR re-pin + land
1. On the firmware PR (`<upstream branch>` → `keepkey/keepkey-firmware:develop`), update the two
   submodule pins:
   - `deps/device-protocol` → Group A master SHA.
   - `deps/python-keepkey` → Group B master SHA.
   - Fix `.gitmodules` URLs/branches to the upstream repos if they still point at the fork
     (`clearsign-v2-static-schema` memory flags the pyk `.gitmodules` url as fork-only — resolve).
2. Push the pin bump. **Verify still green** on the firmware PR after the pins change (build-arm,
   build-emulator, unit-tests, python-integration, static-analysis, lint-format clang-format-20,
   secret-scan, generate-test-report, check-submodules).
3. **Human review** → merge into `keepkey/keepkey-firmware:develop`.

## Verification gates (must be green before each merge)
- device-protocol: proto-gen + whatever upstream CI runs.
- python-keepkey: GitHub Actions **and** both CircleCI projects (version-gated skips correct).
- firmware: all ~11 checks, re-run AFTER the pin bump (a pin change can flip check-submodules /
  integration).

## Pre-flight checklist
- [ ] Fork-only rule intentionally lifted for this landing (explicit human confirmation).
- [ ] `develop` (fork) == rc4 confirmed (identical trees, 7.15.0) — release content frozen.
- [ ] Upstream branches for device-protocol + python-keepkey identified and pushed.
- [ ] `.gitmodules` URLs point upstream, not fork.
- [ ] Storage version / migration NOT changed by any post-freeze work (would need re-test).
- [ ] Each merge has a named human reviewer.

## Rollback
- Each group is independently revertable (revert the merge commit). The firmware PR is the last
  gate — nothing lands in upstream develop until deps are green on master and the re-pinned PR is
  green. If a pin bump goes red, revert the pin, keep the PR open.

Related: [[pyk-ci-firmware-gating]], [[clearsign-v2-static-schema]], [[fw-715-rc3-release-cut]],
[[device-protocol-workflow]], [[feedback-device-protocol-fork-only]], [[feedback-near-firmware-pr-target]].
