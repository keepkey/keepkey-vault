# Windows Release Blocker - v1.2.5 and Electrobun Control

## Purpose

This document captures the current understanding of the Windows release failure
that blocked the `1.2.5` cycle, the branch/release context around it, and the
decision points before we change packaging, updater behavior, or dependency
ownership.

It is intentionally split into:

- confirmed facts from this repository
- likely failure chains inferred from user symptoms and Electrobun behavior
- open questions that still need direct Windows reproduction or source review

This is the working record for `release-cycle` as of 2026-03-21.

## Release and Branch Context

### Confirmed

- `release-cycle` was created from `develop`.
- `develop` currently points at commit `c42cb81`.
- `release/1.2.5` currently points at commit `b4d5c84`.
- The checked-in diff from `develop` to `release/1.2.5` is only a version bump:
  - `projects/keepkey-vault/package.json`: `1.2.1 -> 1.2.5`
  - `projects/keepkey-vault/electrobun.config.ts`: `1.2.1 -> 1.2.5`

### Important implication

The Windows regression was not introduced by a unique code delta living only on
`release/1.2.5`. If users hit a poisoned install from the `1.2.5` artifact, the
root cause is more likely in the packaging/runtime/update path already present
on `develop` at the time that release was cut.

### Unverified / missing from current refs

The branches discussed during investigation are not present in the current local
or visible remote refs in this repo:

- `feature/windows-startup-optimization`
- `fix/lazy-load-swagger-defer-engine`

That does not prove they never existed. It only means the current checkout does
not give us those branches as evidence sources.

## What Is Confirmed in This Repo

### 1. Windows installer identity is stable across installs

`scripts/installer.iss` uses a fixed `AppId`:

- `{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}`

That means reinstalls and upgrades are tied to the same Windows installer
identity, which is correct for normal upgrades but also means stale local state
can survive across uninstall/reinstall cycles if it lives outside Inno's owned
install directory.

### 2. The installer does not currently clean user-local runtime state

The installer currently has:

- one `[InstallDelete]` rule for stale hashed frontend assets under `{app}`
- no `[UninstallDelete]` entries
- no `[UninstallRun]` cleanup hooks
- no process-kill or preflight cleanup code in `[Code]`

So uninstall currently removes the Inno-managed install tree, but there is no
checked-in cleanup for:

- `%LOCALAPPDATA%` Electrobun app/runtime state
- WebView2 profile/user-data state
- scheduled tasks or updater leftovers

### 3. Windows runtime state is already known to be fragile

Existing docs in this repo already record Windows-specific fragility around:

- WebView2 profile locking
- stale `_build/` directories due to locked files
- Electrobun dev mode creating broken process trees on Windows
- direct launcher behavior differing from wrapper/dev behavior

Relevant docs:

- `docs/WINDOWS-QUIRKS.md`
- `docs/WINDOWS-DEV-MODE.md`
- `projects/keepkey-vault/docs/ELECTROBUN.md`

### 4. We already replaced part of Electrobun's native update path

The merge history on `develop` includes:

- PR #39: GitHub API update checks
- PR #41: open releases/download path instead of relying on the native updater

That strongly suggests the team had already found Electrobun's built-in update
behavior unreliable enough to route around it, at least on parts of the update
flow.

## User-Observed Failure

The reported Windows symptom set is:

1. install `1.2.5`
2. machine enters a bad state for future installs
3. KeepKey Vault can be uninstalled from Installed Apps
4. reinstall still fails because files/state are still present
5. Bun appears impossible to fully remove from the user perspective
6. the machine remains "poisoned" for future KeepKey Vault installs

This is the operational problem we need to solve, whether the underlying cause
is a single updater bug or a combination of installer, runtime, and cleanup
gaps.

## Likely Failure Chain

The sequence below is plausible and consistent with the code/docs, but parts of
it are still inferred and should not yet be treated as proven fact.

### Likely chain

1. Electrobun or wrapper/runtime leaves behind user-local state outside the
   Inno install directory.
2. One or more processes or WebView2-related file handles remain active or
   leave locked state behind.
3. Uninstall succeeds only for `{app}` files that Inno owns.
4. Reinstall lands on an environment that still contains stale local state or
   updater residue.
5. The next install or first launch fails, making the machine look permanently
   poisoned to the user.

### Why this is credible

- the checked-in installer has no uninstall cleanup for local runtime state
- Windows docs already describe file locking and stale profile problems
- the project has prior fixes that route around Electrobun updater behavior

### What is still not proven here

- the exact leftover directories on affected machines
- whether scheduled tasks are definitely involved
- whether an `update.bat` file is definitely left behind in production installs
- whether Bun itself is broken system-wide versus only the Vault runtime path
- whether the trigger was install-time, update-time, first launch, or uninstall

## Installer and Packaging Gaps We Can State Confidently

These are concrete shortcomings in the current checked-in Windows installer:

### Missing uninstall hygiene

- no deletion of app-local runtime data under `%LOCALAPPDATA%`
- no cleanup of WebView2 user-data folders
- no cleanup of updater residue outside `{app}`

### Missing pre-install hygiene

- no process-kill step for running Vault processes
- no preflight detection of stale/locked runtime state
- no repair path for a partially broken previous install

### Missing ownership of the framework layer

Electrobun is currently consumed as an npm dependency, not as a repo-controlled
submodule or vendored source tree. That means:

- Windows packaging behavior is upstream-controlled
- fixes are harder to audit and carry
- postinstall patching is not a durable control point for a release-critical app

## Electrobun Control Problem

This repo already depends on Electrobun in places where platform bugs matter to
release quality. The broader problem is not just "fix one installer bug"; it is
"own the code path that creates and updates the Windows desktop binary."

That points to two strategic tracks:

### Track A: Immediate release stabilization

- harden `scripts/installer.iss`
- add uninstall cleanup
- add pre-install cleanup
- add Windows repair/unpoison instructions
- verify that fresh install, uninstall, and reinstall work on a contaminated box

### Track B: Framework ownership

- fork or vendor Electrobun
- patch Windows packaging/update behavior in code we control
- stop relying on opaque npm-package internals for release-critical fixes

Track A is the shortest path to user relief.
Track B is the shortest path to long-term control.

We likely need both, in that order.

## Recommended Working Order

Before merging any architectural change, the lowest-risk order is:

1. Document the incident and evidence.
2. Reproduce on a Windows machine with a clean logging checklist.
3. Add installer uninstall/preflight cleanup in this repo first.
4. Validate reinstall on a previously contaminated machine.
5. Only then decide whether the next move is:
   - an Electrobun fork
   - a vendored packaging layer
   - or a larger framework exit plan

## Open Questions

These need direct investigation before we call the root cause closed:

1. Which exact directories remain after uninstall on an affected machine?
2. Are any scheduled tasks, temp scripts, or background processes left behind?
3. Does the first broken state happen after install, after update, or after uninstall?
4. Is the "cannot uninstall Bun" symptom a real Bun installation issue or just
   user-visible residue from the packaged runtime?
5. Can we reproduce the contamination with the current `release/1.2.5` artifact
   on a fresh Windows VM?
6. Are the missing branches/PRs materially important, or was their work already
   folded into other commits/docs?

## Related Documentation

- `docs/electrobun-windows-internals.md` -- deep technical reference for how
  Electrobun packages, installs, updates, and runs on Windows. Covers the
  update.bat mechanism, runtime state locations, and failure modes.
- `docs/windows-unpoison-guide.md` -- step-by-step recovery instructions for
  affected users and support staff.
- `docs/electrobun-fork-plan.md` -- decision document for forking Electrobun,
  integration options, specific fixes needed, and risk assessment.

## Evidence Pointers

- `scripts/installer.iss`
- `projects/keepkey-vault/electrobun.config.ts`
- `projects/keepkey-vault/package.json`
- `docs/WINDOWS-QUIRKS.md`
- `docs/WINDOWS-DEV-MODE.md`
- `projects/keepkey-vault/docs/ELECTROBUN.md`
- `projects/keepkey-vault/docs/electrobun-windows-internals.md`
- `projects/keepkey-vault/docs/windows-unpoison-guide.md`
- `projects/keepkey-vault/docs/windows-antidote-evidence-guide.md`

## Current Working Position

The cleanest present interpretation is:

- `1.2.5` shipped from the same core code as `develop`, with a release version bump
- Windows packaging/runtime cleanup is insufficient in the checked-in installer
- the "poisoned install" is credible as a stale-state and file-locking problem
- Electrobun is too deep in the release path for us to leave Windows behavior as
  an upstream black box

That is enough to justify documenting the incident and beginning remediation on
`release-cycle`, but not enough yet to claim a single proven root cause.
