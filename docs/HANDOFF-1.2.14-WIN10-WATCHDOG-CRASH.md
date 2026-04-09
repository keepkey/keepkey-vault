# Handoff: 1.2.14 Win10 Explorer-launch crash (bash watchdog ENOENT)

**Date:** 2026-04-09
**Status:** Fix landed in this PR
**Severity:** Critical — every cold Win10 install crashes on first Start Menu / desktop launch
**Related:** [`HANDOFF-1.2.14-WINDOWS-PAIR.md`](./HANDOFF-1.2.14-WINDOWS-PAIR.md) (the open findings 1, 2, 3 from 2026-04-08 — see "What this does and does not fix" below)

---

## TL;DR

`projects/keepkey-vault/src/bun/index.ts:4246` unconditionally spawns `bash -c '<heartbeat watchdog script>'`. When the app is launched from Explorer / Start Menu on Win10, the bun worker inherits an **empty `PATH`**, libuv can't locate `bash`, and `Bun.spawn` raises an **uncaught async exception** in the worker thread that kills the entire app right around the `[Engine] State → needs_pin` step. The user sees a splash that hangs and then disappears.

The watchdog is POSIX-only (`bash`, `kill -9`, `date +%s`, `sleep`, `cat`), and on Windows it could never have functioned even if `bash` *were* on PATH. The fix is to skip it entirely on win32 and wrap the spawn in a try/catch as defense-in-depth.

This was the dominant Win10 1.2.14 failure mode. Confirmed reproduced twice (2026-04-08 and 2026-04-09 with two different rebuilt 1.2.14 binaries) and confirmed fixed by patching the installed bundle and re-launching from the desktop icon.

---

## How the bug presents to a user

1. User downloads `KeepKey-Vault-1.2.14-win-x64-setup.exe`
2. Runs the installer, ticks "Run KeepKey Vault" (or double-clicks the desktop icon afterwards)
3. The KeepKey Vault splash window appears for ~3 seconds
4. The window vanishes; no error dialog, no Windows Error Reporting prompt, nothing in the visible logs
5. Trying again from the desktop / Start Menu produces the same result every time
6. **Launching from a terminal (PowerShell or bash) works fine** — but no normal user does that

This was diagnosed as a different bug for two days because a buffered logger lost the actual exception line on every crash.

---

## How we found it

The full investigation lives in the conversation history; the short version:

1. **Sync logger landed first.** The previous logger was `fs.createWriteStream(LOG_FILE, {flags:'a'})` whose buffered `.write()` calls never reached disk on a worker-thread crash. Every failed launch left a log that "ended at `[Engine] Merged manifest`" — actually 2-7 seconds *before* the crash. Replacing the buffered stream with `fs.appendFileSync` per call (this PR) was the *single* observability change that unblocked the entire investigation.

2. **Boot environment dump landed alongside.** The first thing the new sync logger writes is a structured snapshot of `process.platform`, `pid`, `ppid`, `cwd`, `argv`, stdio TTY status, and the lengths of `PATH` / `LANG` / Windows-specific env vars. This is what surfaced the smoking gun: `PATH.length=0` in Explorer-launched sessions vs `PATH.length=882` in terminal launches.

3. **The actual exception became visible.** With sync logging in place, the next failed launch produced this final line in `vault-backend.log`:

   ```
   [2026-04-09T22:01:38.479Z] ERR: Uncaught exception in worker: {
     "code": "ENOENT",
     "path": "bash",
     "errno": -4058
   }
   ```

   `errno -4058` is `UV_ENOENT` from libuv. `path: "bash"` is the binary that couldn't be located. A 30-second grep of `src/bun/` for `'bash'` found exactly one call site: the FFI heartbeat watchdog.

4. **The fix was verified by patching the installed bundle.** Wrapping `startHeartbeatWatchdog()` in a `process.platform === 'win32'` early-return and re-launching from the desktop icon produced a clean boot — `[Vault] Heartbeat watchdog skipped on Windows (POSIX-only)` followed by `[PERF] +3876ms: boot complete` and a paired device.

The whole investigation took about an hour once the sync logger could show us what the worker was actually doing. Without sync logging it would have been days more.

---

## What changed (in this PR)

### `projects/keepkey-vault/src/bun/index.ts`

**1. Synchronous file logger** (lines ~1-50). Replaces the buffered `WriteStream` with `fs.appendFileSync` per log call. The `console.log/warn/error` overrides write to disk synchronously inside the call. The buffered `logStream` variable is removed entirely. Throughput hit is negligible at our log volume (~10-100 lines/sec at peak boot); the upside is that the log file is a faithful record of what executed up to a crash, which it categorically was not before.

**2. Boot environment dump** (lines ~51-72). Right after `[Boot] Log file: …`, dumps:
- `platform`, `arch`, `pid`, `ppid`
- `cwd`, `argv`
- `stdin/stdout/stderr.isTTY`
- `PATH.length`, `LANG`, `LC_ALL`
- Windows-only: `USERNAME`, `SESSIONNAME`, `APPDATA`, `LOCALAPPDATA`

The whole thing is wrapped in try/catch so it can never break the boot path. The `PATH.length` field is what surfaced this bug; the rest is for future bugs in the same family.

**3. FFI watchdog: skip on Windows + try/catch.** `startHeartbeatWatchdog()` now returns early on `win32` with a log line, and the `Bun.spawn(['bash', ...])` call is wrapped in a try/catch as defense-in-depth on POSIX hosts where `bash` could conceivably be missing (containers, minimal NixOS, etc). The watchdog script uses `kill -9`, `date +%s`, `sleep`, `cat`, `[ -f ]` — all POSIX — so the early return on Windows is correct: there is nothing to lose, the watchdog could never have functioned on Win32.

A long comment block above the function explains the platform constraint and references this incident, so the next person to touch the watchdog doesn't accidentally re-enable it on Windows.

### `projects/keepkey-vault/src/bun/engine-controller.ts`

Added boundary log lines around the JS↔native transitions in `start()` and `fetchFirmwareManifest()`:

- `[Engine] start() begin — registering USB listeners`
- `[Engine] USB listeners registered`
- `[Engine] calling fetchFirmwareManifest()`
- `[Engine] fetchFirmwareManifest() returned`
- `[Engine] calling usb.getDeviceList() (native)`
- `[Engine] usb.getDeviceList() returned N device(s)`
- `[Engine] alreadyConnected=…`
- `[Engine] calling syncState()`
- `[Engine] start() complete`
- Plus per-step logs inside `fetchFirmwareManifest` (`mergeManifests` boundary, `applyChannel` boundary) and `applyChannel` (which version fields it's about to read).

Each native call is wrapped in try/catch with an explicit `[Engine] FATAL: …` log so a future libusb segfault leaves a clear breadcrumb instead of a silent process exit. These were originally added to catch a `Merged manifest`-area hang that turned out to be a different bug, but the boundary logging is permanently useful — every JS→native transition is now visible in `vault-backend.log`.

### `docs/HANDOFF-1.2.14-WIN10-WATCHDOG-CRASH.md` (this file)

Captures the diagnosis story and references the previous handoff doc.

---

## What this does and does not fix

### Fixed by this PR

**The dominant 1.2.14 Win10 first-launch crash.** Verified reproducible across two distinct binary rebuilds of v1.2.14 (`4f8ec1ba…` and `2111ad61…`), and verified fixed in-place by patching the installed bundle. Every cold Explorer / Start Menu / installer-`Run-now` launch on Win10 was hitting this.

### NOT fixed by this PR

These remain open from `HANDOFF-1.2.14-WINDOWS-PAIR.md`:

1. **Finding 1: `Invalid Version: vundefined.undefined.undefined`** in the `KeepKeyHDWallet.initialize()` semver path. Defensive fix is already in flight upstream as **`keepkey/hdwallet#37`**. After that merges, the `modules/hdwallet` submodule pointer here will need a follow-up bump in a separate PR. This bug is probably triggered by a stale-cache / wrong-message-type path that we still don't fully understand — the fix in #37 just turns the opaque semver throw into a clear runtime error so the *next* time it happens we have something to act on.

2. **Finding 2: native crash on USB unplug during in-flight `pairRawDevice`.** Distinct bug from this PR's fix — the symptom is `bad write` from libusb after a 2-second real USB roundtrip, then the process disappears with no further log lines. With the sync logger landing in this PR, the next reproduction *should* leave the actual death cause in the log. Still needs its own investigation.

3. **Finding 3: splash hangs forever on port 1646 collision.** Already addressed in the official 1.2.14 rebuild from 2026-04-09 with a pre-window port probe — verified working in this conversation.

---

## Verification recipe

### Reproduce the bug (against unfixed code)

Requires an actual Win10 install, since the failure mode depends on launching from Explorer with an empty `PATH`. Cannot be reproduced from a bash terminal.

1. Install `KeepKey-Vault-1.2.14-win-x64-setup.exe`
2. Tick "Run KeepKey Vault" → Finish (or double-click the desktop icon afterwards)
3. Splash appears, hangs ~3 seconds, vanishes
4. Open `%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log` — last line is `[Engine] Loaded bundled manifest` or `[Engine] Merged manifest` (because the OLD buffered logger lost the exception line)

### Verify the fix

After this PR:

1. Same install steps
2. Open `vault-backend.log` — should see:
   ```
   [Boot] env: PATH.length=0 LANG=
   …
   [Vault] Heartbeat watchdog skipped on Windows (POSIX-only)
   …
   [PERF] +XXXms: boot complete
   ```
3. The window stays open and the device pair flow proceeds normally.

### Smoke check that observability works on every platform

After this PR, the *first* thing in `vault-backend.log` on every launch should be the `[Boot] platform=…` line. If it's not there, the sync logger is broken and we have a regression in this PR's logger code.

---

## Why this stays in once the watchdog is fixed

The watchdog fix is a 4-line change. The observability changes are ~120 lines and add a small per-call cost for synchronous logging. The case for keeping the observability changes regardless:

- **Without sync logging, this bug would still be unfixed.** Two days of investigation produced wrong root-cause hypotheses (libusb segfault on detach, semver throw in initialize, port-1646 collision) every one of which was downstream of a buffered log losing the actual exception. Sync logging is the difference between "the user is reporting a Win10 crash" being a 1-hour bug and a 2-week bug.
- **The throughput cost is negligible** at our log volume. We're not logging in hot loops; we're logging boot events and engine state transitions.
- **The boot env dump is what made the launch-context theory testable.** Without that single `PATH.length=0` field, the only evidence was "splash hangs" which is consistent with twenty different root causes.
- **The engine boundary logs will pay for themselves the first time libusb crashes again.** The Finding 2 native crash from yesterday is still open; the boundary logs are exactly what's needed to figure out which native call dies.

If perf becomes a concern in a hot path later, the right fix is to keep sync logging and *reduce log volume*, not to revert to async/buffered logging.

---

## Files

| File | Why |
|---|---|
| `projects/keepkey-vault/src/bun/index.ts:1-72` | Sync logger + boot env dump (this PR) |
| `projects/keepkey-vault/src/bun/index.ts:~4230-4290` | FFI watchdog with `process.platform === 'win32'` early return + try/catch (this PR) |
| `projects/keepkey-vault/src/bun/engine-controller.ts:~218-300, ~410-440, ~540-580` | JS↔native boundary logging (this PR) |
| `docs/HANDOFF-1.2.14-WINDOWS-PAIR.md` | Previous handoff doc with the three open Win10 findings (yesterday) |
| `%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log` | Single source of truth for all backend events. With this PR, contains the boot env dump on the first lines of every session. |
