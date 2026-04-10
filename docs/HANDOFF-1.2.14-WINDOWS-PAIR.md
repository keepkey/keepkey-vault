# Handoff: 1.2.14 Windows Pair Failures

**Date:** 2026-04-08
**Status:** 1 fix in flight upstream, 2 issues open in this repo
**Pin:** documents three distinct failure modes observed on a fresh
`KeepKey-Vault-1.2.14-win-x64-setup.exe` install on Windows 10

---

## TL;DR for the next agent

1. **`Invalid Version: vundefined.undefined.undefined` on WebUSB pair** — fix in
   flight at `keepkey/hdwallet#37`. After it merges, bump the `modules/hdwallet`
   submodule pointer here. See [Finding 1](#finding-1).
2. **Native crash on USB unplug during pair** — open. The bun process dies with
   no JS error after `bad write`. Engine layer needs to catch & recover. See
   [Finding 2](#finding-2).
3. **Splash hangs forever when port 1646 is already bound** — open. The fatal
   exit message is in the backend log but never surfaces to the user. UI needs
   a "Vault is already running" state. See [Finding 3](#finding-3).

All three were diagnosed against the v1.2.14 install at
`%LOCALAPPDATA%\Programs\KeepKeyVault\` with logs at
`%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log`.

---

## Context

`v1.2.14` was the smoke-test build for the Windows cold-start fix (`fd8e90e
fix(windows): strip stale nested @noble/hashes + bump to 1.2.14`). The original
1.2.13 cold-start crash (Worker dying on `@noble/curves` import with `ahash is
not a function`) **is fixed** — verified by inspecting the installed bundle:
no nested `@noble/hashes` copies under `@noble/curves`, `@scure/bip32`, or
`@scure/bip39`. The Worker is alive and the backend completes its boot path.

But three other failure modes surface against a real KeepKey device on
Windows. The defective behavior visible to the user — "splash opens, never
advances" — turns out to be the *common UI symptom* of all three; only the
backend log distinguishes them.

The download itself is **bit-perfect** — SHA-256 of the Downloads installer
matches the published asset digest exactly. There's no point re-downloading.

---

## Finding 1

### `Invalid Version: vundefined.undefined.undefined` on WebUSB pair

#### Symptom

Splash opens, never advances. Backend log ends within ~10 ms of "WebUSB device
found, attempting pairRawDevice".

#### Log evidence

```
[Engine] WebUSB device found, attempting pairRawDevice...
WARN: [Engine] WebUSB pair failed: Invalid Version: vundefined.undefined.undefined
[Engine] Scanning for HID device...
```

The 11 ms gap between "device found" and "pair failed" is too fast to be a
real USB roundtrip — the failure path is synchronous on a stale or
miscast `Features.AsObject`.

#### Root cause

`modules/hdwallet/packages/hdwallet-keepkey/src/keepkey.ts:1190` constructs
the firmware version string from the protobuf `Features` response and
immediately passes it to `semver.gte()`:

```ts
const fwVersion = `v${out.majorVersion}.${out.minorVersion}.${out.patchVersion}`;
this._supportsOsmosis = semver.gte(fwVersion, "v7.7.0");
```

If any version field is `undefined` (wrong-message-type miscast, decode
mismatch, device in unexpected state, etc.), the template literal happily
produces `"vundefined.undefined.undefined"` and `semver.gte()` throws the
opaque error verbatim. There is **zero defense** — no nil check, no
validation that `event.message` is actually a Features (the `as` cast is a
TypeScript fiction).

#### Status: **IN FLIGHT — keepkey/hdwallet#37**

PR adds:
- Validation throw before `fwVersion` is constructed, naming the missing fields
- 4 unit tests in `keepkey-initialize.test.ts` covering all-missing,
  partial-missing, all-present (negative), and an explicit regression assertion
  that the original error string never appears
- Tests deterministically reproduce the original `Invalid Version:
  vundefined.undefined.undefined` against unfixed code; pass against fixed code
- Full `hdwallet-keepkey` suite stays green (13/13)

#### What you need to do

1. Wait for `keepkey/hdwallet#37` to merge into `master`.
2. Bump the submodule pointer here:
   ```sh
   cd modules/hdwallet
   git fetch origin master
   git checkout master
   git pull
   cd ../..
   git add modules/hdwallet
   git commit -m "chore: bump hdwallet to include initialize() Features version validation"
   ```
3. Open a PR to `keepkey-vault` `develop`.
4. After merge, the WebUSB pair path will surface a *clear* error
   (`KeepKey Initialize returned Features without firmware version
   (major=…, minor=…, patch=…). Device may be in bootloader mode, mid-update,
   or returned an unexpected message type.`) instead of the opaque semver
   string. **This does not "fix" pairing** — it just stops the silent splash
   hang and gives you something actionable in the log. The follow-up question
   for whoever owns the engine layer: *why* is the device returning a Features
   without version fields in the first place? The new error message points at
   bootloader mode / stale cache / wrong message type as candidates.

---

## Finding 2

### Native crash on USB unplug during WebUSB pair (`bad write`)

#### Symptom

Splash opens with device connected, hangs ~2 seconds, then the entire app
process disappears the moment the user unplugs the device. No crash dialog,
no JS error, no further log lines. Reproduced on cold launch.

#### Log evidence

```
17:59:42.094  [Engine] WebUSB device found, attempting pairRawDevice...
17:59:44.304  WARN: [Engine] WebUSB pair failed: bad write    ← unplugged here
17:59:44.312  [Engine] Scanning for HID device...
[silence — process gone, port 1646 free, tasklist empty]
```

The 2,210 ms gap between "device found" and "bad write" is a *real* USB
attempt that was interrupted mid-write by the unplug. After the engine
catches the error and falls through to the HID scan, the bun process exits
without writing another log line. The HID adapter never logs success or
failure. This is the signature of a native addon crash, not a JS exception.

#### Root cause (proposed)

The `usb` native addon (libusb wrapper) is receiving a hardware-level
disconnect mid-transfer and segfaulting in native code, taking the entire
bun process down with it. There's already a comment in
`projects/keepkey-vault/src/bun/engine-controller.ts:251-254` warning about
the same family of bug at *attach* time on macOS:

> // Device may already be plugged in. If a KeepKey is present, give
> // libusb the same stabilisation window as the hot-plug attach handler
> // before calling pairRawDevice() — without it, the native addon can
> // SIGTRAP on macOS when the device is connected at launch.

This is the *detach*-time analogue on Windows, hitting during an in-flight
write rather than at startup.

#### Status: **OPEN**

#### Suggested fix direction

This needs an investigation, not a one-line patch. Possibilities, in
roughly increasing order of intrusiveness:

1. **Quick win — process supervisor.** Wrap the bun process in a relauncher
   that restarts on unexpected exit (with an exponential backoff to avoid
   crash loops). Doesn't fix the bug but stops it from being
   user-visible. The relauncher should distinguish "normal exit (window
   closed by user)" from "crash" via exit code so it doesn't fight the
   user.
2. **Native error boundary.** See if the libusb wrapper exposes a way to
   register a fault handler that turns the segfault into a recoverable JS
   error. Likely not — most libusb bindings don't.
3. **Avoid in-flight transfers across detach.** Wrap every `transport.call`
   in a Promise.race against a `usb.on('detach')` listener that aborts the
   call before the native code completes the doomed transfer. Tricky:
   libusb's API is callback-driven and there's no clean cancel for an
   in-flight bulk transfer.
4. **Move USB I/O to a child process.** The cleanest fix: spawn a small
   `usb-helper` child process that owns all libusb interaction. When it
   crashes on unplug, only the helper dies and the main bun process
   restarts it. Most invasive but the only way to make this class of bug
   bounded.

I'd recommend starting with **(1)** (immediate user-visible fix) and
filing **(4)** as a tracked follow-up.

#### How to reproduce

1. Launch v1.2.14 from Start Menu with KeepKey plugged in.
2. As soon as the splash appears (within ~2 sec), yank the USB cable.
3. Process disappears entirely from `tasklist`. `vault-backend.log` ends
   mid-`Scanning for HID device...` with no further entries.

---

## Finding 3

### Splash hangs forever when port 1646 is already bound

#### Symptom

User double-clicks the app while a previous orphaned instance is still
running (e.g. after a crash, or after closing the window without the
process exiting). New instance shows splash, then nothing. No error
dialog, no message, no path forward except killing the orphaned process
via Task Manager.

#### Log evidence

```
=== New session: 2026-04-08T17:27:57.226Z ===
...
[2026-04-08T17:27:57.358Z] [auth] Loaded 1 persisted pairings
[2026-04-08T17:27:57.360Z] ERR: [Vault] FATAL: port 1646 is already in use by another Vault instance. Exiting.
```

The fatal exit message is logged correctly, the second instance exits
cleanly, but **none of this is communicated to the user**. The splash
window appears (it's created before the port-bind check) and then the
process exits, leaving the splash window frozen until the parent process
is reaped by the OS.

#### Root cause

`projects/keepkey-vault/src/bun/index.ts` creates the `BrowserWindow`
*before* `applyRestApiState()` runs the port collision check (around the
`[Vault] REST API started on port 1646` log line). The order is:

```
perf('creating BrowserWindow')         ← splash visible
let mainWindow = new BrowserWindow(...)
perf('window created, starting deferred init')
deferredInit()                         ← async, includes the port check
```

If `deferredInit` then exits the process due to the port collision, the
splash window dies with the process — but not before the user has seen it
appear and assumed the app is loading.

#### Status: **OPEN**

#### Suggested fix direction

Two complementary changes:

1. **Move the port collision check before window creation.** A simple
   `net.createConnection({ port: 1646 })` probe at the very top of
   `index.ts` (before any Electrobun calls) lets you bail out *before*
   showing any UI. On collision, raise the existing instance to the
   foreground (Win32 `SetForegroundWindow` via the same FFI mechanism
   already in use for `WM_SETICON`) and exit silently. This is the
   "single-instance app" pattern most desktop apps use.
2. **Surface a clear error in the splash when init fails.** If for some
   reason you can't move the check earlier, at least catch the failure
   inside `deferredInit` and replace the splash content with a "Vault is
   already running — switch to the existing window" message *before*
   exiting the process.

Option (1) is the right long-term fix; (2) is a sub-1-hour bandaid.

#### How to reproduce

1. Launch v1.2.14 from Start Menu.
2. Wait for full boot (`KeepKey Vault started!` in log) and confirm the
   window is interactive.
3. Force-close just the *window* (e.g. kill the renderer via Task Manager,
   or close it during a hang) — leaving the bun process alive on port 1646.
   Or: launch from the terminal with `&` so the parent process holds the
   port.
4. Double-click the app icon a second time.
5. Splash appears, hangs. Backend log shows the fatal port collision and
   the second-instance exit.

---

## Verification recipes

### How to verify the hdwallet fix landed (after the bump in Finding 1)

```sh
# Inside the installed bundle:
grep -n "KeepKey Initialize returned Features" \
  "$LOCALAPPDATA/Programs/KeepKeyVault/Resources/app/node_modules/@keepkey/hdwallet-keepkey/dist/keepkey.js"
# Expect a hit at ~line 1116
```

Or trigger the validation deterministically by running the unit tests in
the submodule:
```sh
cd modules/hdwallet
yarn jest --config jest.config.js --testPathPattern keepkey-initialize
# Expect: 4 passed
```

### How to capture a fresh failure log

```sh
# Clear the log so the next run is isolated
truncate -s 0 "$LOCALAPPDATA/com.keepkey.vault/vault-backend.log"

# Launch normally, reproduce, then read:
cat "$LOCALAPPDATA/com.keepkey.vault/vault-backend.log"
```

The backend log is the **single source of truth** for diagnosing pair
failures — Windows has no separate Electrobun crash log, no WER dump in
the usual locations, and no `console.log` from the renderer makes it into
the file. If a session ends abruptly mid-`Scanning for HID device...`,
that's a Finding 2 (native crash) signature.

---

## Files to know

| File | Why |
|---|---|
| `modules/hdwallet/packages/hdwallet-keepkey/src/keepkey.ts:1190` | Site of Finding 1; fixed in keepkey/hdwallet#37 |
| `modules/hdwallet/packages/hdwallet-keepkey/src/keepkey-initialize.test.ts` | Regression tests added in keepkey/hdwallet#37 |
| `projects/keepkey-vault/src/bun/engine-controller.ts:220-261` | `start()` — Finding 2 lives in this code path, post-`fetchFirmwareManifest` USB pair flow |
| `projects/keepkey-vault/src/bun/engine-controller.ts:251-254` | Existing comment about libusb SIGTRAP on macOS attach — same family as Finding 2 |
| `projects/keepkey-vault/src/bun/engine-controller.ts:746-840` | `initializeWallet()` — WebUSB → HID fall-through; Finding 2 dies somewhere in here without logging |
| `projects/keepkey-vault/src/bun/index.ts` (`creating BrowserWindow` perf marker → `deferredInit()`) | Finding 3 lives in the ordering of window creation vs. port collision check |
| `%LOCALAPPDATA%\com.keepkey.vault\vault-backend.log` | Single source of truth for all three findings |
| `%LOCALAPPDATA%\Programs\KeepKeyVault\Resources\version.json` | Confirms which build is actually installed (don't trust the installer filename) |

---

## What is NOT broken

So you don't waste time chasing dead ends:

- **The download.** SHA-256 of `KeepKey-Vault-1.2.14-win-x64-setup.exe` matches
  the published asset digest exactly. Re-downloading does nothing.
- **The 1.2.13 cold-start `@noble/hashes` bug.** Verified fixed in 1.2.14 —
  no nested `@noble/hashes` copies under `@noble/curves`, `@scure/bip32`, or
  `@scure/bip39` in the installed bundle. The Electrobun Worker is alive
  and reaches `[PERF] +410ms: boot complete` when no device is plugged in.
- **The protobuf decoder field numbers.** `messages_pb.js` in the installed
  bundle has `field 2 → majorVersion`, matching `messages.proto` in the local
  device-protocol submodule. No schema mismatch.
- **The frontend bundle.** `views/mainview/index.html` references
  `./assets/index.js` which exists at the right size. Old hashed Vite
  filenames from a previous install (`index-DljLeB3V.js` etc.) are
  leftover but unreferenced — harmless.
