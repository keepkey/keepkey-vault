# Windows USB — App-Side Fix Plan

**Companion to:** [`WINDOWS-USB-AUDIT.md`](./WINDOWS-USB-AUDIT.md) (findings) and [`WINDOWS-USB-FIRMWARE-PLAN.md`](./WINDOWS-USB-FIRMWARE-PLAN.md) (device side)
**Scope:** changes shippable in a normal Vault release (`projects/keepkey-vault` + the `hdwallet` submodule). No firmware dependency.
**Guiding principle:** smallest change that meaningfully helps. Each item lists the *simple* fix first; "gold-plated" variants are marked optional.

Effort: **S** ≈ <½ day · **M** ≈ 1–2 days · **L** ≈ ~1 week.

---

## Phase 1 — Targets the reported symptom ("beep, but not detected")

### FIX-1 · Discovery poll: re-probe after attach instead of giving up once  ⭐
**Cause A (timing race).** Effort **S–M** · Risk **low**

**Problem.** On attach the engine waits one fixed `ATTACH_DELAY_MS = 1500` then calls `syncState()` once (`engine-controller.ts:265`). On a hub/dock/slow laptop, WinUSB hasn't finished binding interface 0 yet, so the device is invisible to libusb → `initializeWallet()` returns `usbDetected=false, keepKeyOnBus=false` → `syncState()` falls into the `else if (lastState !== 'disconnected')` branch (`:760`) and sets `disconnected` **with no `lastError`**. Because `scheduleRetry()` only arms on `connected_unpaired && lastError` (`:783`), **nothing ever re-probes**, and `usb.on('attach')` won't fire again. Result: beep, then nothing until app restart.

**Solution (simple).** Add a bounded discovery poll that mirrors the existing `startRebootPoll()` pattern (`:834-855`) — proven, same `syncing` guard:

```ts
private discoveryPollTimer: ReturnType<typeof setInterval> | null = null
private static readonly DISCOVERY_POLL_MS = 1500
private static readonly MAX_DISCOVERY_POLLS = 12  // ~18s of post-attach grace

private startDiscoveryPoll() {
  if (this.discoveryPollTimer) return
  let n = 0
  this.discoveryPollTimer = setInterval(() => {
    // stop once paired, or if we've handed off to another phase
    if (this.wallet || this.updatePhase === 'rebooting' || this.setupInProgress || this.verifyInProgress) {
      this.stopDiscoveryPoll(); return
    }
    if (++n > EngineController.MAX_DISCOVERY_POLLS) { this.stopDiscoveryPoll(); return }
    this.syncState()
  }, EngineController.DISCOVERY_POLL_MS)
}
private stopDiscoveryPoll() {
  if (this.discoveryPollTimer) { clearInterval(this.discoveryPollTimer); this.discoveryPollTimer = null }
}
```
- Call `startDiscoveryPoll()` at the end of the `usb.on('attach')` handler (`:265`) and in `start()` after the initial `syncState()` (`:315`) so a device that binds slowly at launch is still caught.
- Call `stopDiscoveryPoll()` wherever pairing succeeds (`:704-708`) and in `stop()`.
- Reuse the `syncing` guard (already at `:659`) — overlapping ticks are no-ops.

**Optional (gold-plated).** On Windows only, keep a slow always-on poll (every 2–3 s) while `wallet === null`, so the "launch app, *then* plug into a hub that misses attach" case also recovers without restart. Cheap (`getDeviceList()` is a safe enumeration call) — keep the existing try/catch around it.

**Test.** Repro on a USB-3 hub / dock (where it currently fails): plug in after launch → device detected within ~15 s without restart. Confirm `getDeviceList()` is wrapped in try/catch (it already is at `:303`). Verify the poll stops after pairing (no idle CPU).

**Acceptance.** A KeepKey that enumerates (chime plays) is detected within the grace window on hubs/docks, with zero restarts; poll self-stops on pair.

---

### FIX-2 · Windows "present but invisible / claimed" detection + actionable UI
**Cause C (conflicting driver / live app).** Effort **M** · Risk **low**

**Problem.** When a 2B24 device is enumerated by Windows but libusb can't open/see it (wrong driver, libusb-win32/Zadig binding, or a *live* app holding interface 0 → code 19), the engine has no `win32` branch. The permission/remediation path is Linux-only (`:700` checks `process.platform === 'linux'`), so the user gets either silent `disconnected` or a generic `DeviceClaimedDialog` that can't fix a stale *binding*. The HID fallback can't help modern (PID 0x0002) firmware.

**Solution (simple).** Mirror the existing Linux-udev pattern for Windows:
1. **Detect "enumerated but invisible to libusb."** On win32, when `getDeviceList()`/`getDevice()` find nothing but Windows has a 2B24 device, set a `windowsDriverIssue` flag on `DeviceStateInfo`. Cheapest probe: shell out to `Get-PnpDevice -PresentOnly | ? InstanceId -match VID_2B24` (or query SetupAPI). Run it only when we'd otherwise report `disconnected` after an attach, so it's not on the hot path.
2. **Map code 19 explicitly.** `nodewebusb/transport.ts:44-46` already throws `ConflictingApp` on code 19; surface a `deviceBusy` flag distinct from the driver-binding flag.
3. **One Windows help dialog** with the two real remedies: (a) "Close other KeepKey apps / browser tabs using WebUSB" (for `deviceBusy`); (b) "Windows didn't load the driver — click Repair" (for `windowsDriverIssue`), where Repair runs the registry cleanup + rebind from FIX-7.

**Solution (don't).** Don't keep attempting the HID fallback for modern firmware — it's structurally dead (§3 of the audit). Skip straight to the Windows branch.

**Test.** (a) Run an old KeepKey Desktop holding the device → expect the "close other apps" dialog, not a silent hang. (b) Use Zadig to bind libusb-win32 → expect the "Repair driver" dialog.

**Acceptance.** Every "beep but not detected" path ends in a specific, actionable message — never a silent splash.

---

### FIX-7 · Installer/app registry-cache cleanup for poisoned machines
**Cause B, immediate host-side remedy (no firmware needed).** Effort **S** · Risk **med**

**Problem.** Once Windows caches `osvc = 00 00` under `HKLM\SYSTEM\CurrentControlSet\Control\UsbFlags\2B24*`, WinUSB never re-binds — and because firmware `bcdDevice` is frozen, a flash won't fix it. These machines are permanently dead until the cache is cleared.

**Solution (simple).** The Windows installer already runs elevated — have it **delete `HKLM\…\UsbFlags\2B24*` on install/repair**, then the next plug re-queries the MS OS descriptors and binds WinUSB. Expose the same as a **"Repair USB driver"** button in the app that relaunches a tiny elevated helper (UAC prompt) for users who don't reinstall.
- Optional companion: bundle **libwdi** to force-rebind WinUSB to the device (GUID `{0263b512-88cb-4136-9613-5c8e109d8ef5}`) for the conflicting-driver case (FIX-2/Cause C).

**Risk.** Editing `HKLM\SYSTEM` needs elevation — keep it in the installer (already elevated) and a UAC-gated helper, never silently in the backend. Scope the delete to the `2B24*` subkeys only.

**Test.** Manually set `osvc=00 00`, confirm the device is dead, run the cleanup, replug → device binds WinUSB and is detected.

**Acceptance.** A reproducibly-poisoned machine recovers via installer repair or the in-app button, without editing the registry by hand.

---

### FIX-5 · Unconditional single-instance lock before USB init
**Finding P2.** Effort **S** · Risk **low**

**Problem.** The only second-instance guard is an HTTP probe inside `applyRestApiState()`, gated on `restApiEnabled` which is **off by default** (`index.ts:915`, default `:438`) and runs *after* the window is created. Two instances → the second `claimInterface(0)` throws code 19, and the *legit* instance can be the loser.

**Solution (simple, no FFI).** At the very top of boot in `index.ts`, before the window / `engine.start()`, take a loopback lock:
```ts
import net from 'node:net'
const LOCK_PORT = 47824 // dedicated, not the REST port
await new Promise<void>((resolve) => {
  const srv = net.createServer().once('error', () => {
    console.error('[Vault] Another instance is already running. Exiting.')
    process.exit(0)            // optionally ping it first to focus its window
  }).once('listening', () => resolve())
  srv.listen(LOCK_PORT, '127.0.0.1')
})
```
Keep the existing port-1646 probe as a secondary check. Independent of `restApiEnabled`.

**Test.** Launch twice → second exits immediately, first keeps the device. Kill -9 the first → lock frees, relaunch works.

**Acceptance.** Only one Vault can own the device; default-config installs are protected.

---

## Phase 2 — Robustness (the "froze / had to restart" class)

### FIX-3 · Bound every WebUSB transfer; tear down on timeout
**Finding W2.** Effort **M** · Risk **med** (timeout tuning)

**Problem.** `transferIn/transferOut` (`nodewebusb/transport.ts:71-91`) run with no timeout (libusb `timeout=0` = infinite). A wedged/suspended device blocks forever and the orphaned transfer keeps interface 0 claimed → false `ConflictingApp` next time. The `msgTimeout` at `hdwallet-keepkey/transport.ts:288` is dead code.

**Solution (simple, asymmetric timeouts).** Writes should never block long; reads legitimately wait on button presses.
- **Writes:** wrap `transferOut` in a 3–5 s race → on timeout, `clearHalt` + `releaseInterface(0)` + `close()`, then throw `Disconnected`.
- **Reads:** use a *generous* ceiling (~90 s, matching `core.LONG_TIMEOUT` used for button flows) so a truly dead device eventually errors but real confirmations survive. Tear down the interface the same way on timeout.
- Don't try to make the existing `withTimeout()` race fix this — it abandons the native promise but doesn't release the interface. The release must happen in the transport.

**Risk.** Too-short a read timeout breaks long button confirmations — keep it ≥ `LONG_TIMEOUT`. Test PIN entry, passphrase, and a tx-sign that the user lets sit for >60 s.

**Acceptance.** Unplugging mid-operation (or a wedged device) surfaces a clean error and the interface is reclaimable on the next plug — no app restart, no false "in use."

---

### FIX-4 · Fix WebUSB stall recovery (wrong endpoint + returns empty buffer)
**Finding W1.** Effort **S** · Risk **low**

**Problem.** `readChunk` stalls on the IN pipe but calls `clearHalt("out", …)` (`nodewebusb/transport.ts:83`) — wrong endpoint — then falls through and returns the stalled (empty) buffer, which `read()` parses → "message not valid".

**Solution.**
```ts
if (result.status === "stall") {
  await this.usbDevice.clearHalt("in", debugLink ? 2 : 1)
  throw new Error("bad read")   // retryable; do NOT return result.data
}
```
Apply the same fix in the sibling `hdwallet-keepkey-webusb/src/transport.ts:78-80` — but that file destructures the transfer result, so use the bare names (no `result.`): `if (status === "stall") { await this.usbDevice.clearHalt("in", debugLink ? 2 : 1); throw new Error("bad read") }` (its `clearHalt` is at `:79`).

**Test.** Hard to trigger naturally (interrupt EPs NAK, not STALL); add a unit test that feeds a `stall` status and asserts `clearHalt("in", …)` + throw.

**Acceptance.** A stalled IN pipe is reset on the correct endpoint and never yields a garbage packet.

---

### FIX-6 · HID: bounded reads + report-ID byte + detach detection
**Findings H1, H2, H3 — legacy/bootloader HID path only.** Effort **M** · Risk **med**

**Problem.** `readSync()` (`nodehid/transport.ts:41`) blocks the worker with no timeout; `writeChunk` (`:45-50`) doesn't prepend the `0x00` report-ID byte HIDAPI/Windows require; the HID transport never detects removal.

**Solution (simple).**
- **Bound the read:** replace `readSync()` with `readTimeout(ms)`; treat `[]` as a recoverable timeout → throw retryable. Caps the worst-case hang. (Full async-`read()` refactor is the proper fix but larger — defer unless HID stays a primary path.)
- **Report-ID byte:** `const out = [0x00, ...Array.from(buf)]; await this.hidRef!.write(out)`. Cross-platform-correct; satisfies Windows `OutputReportByteLength = report+1`.
- **Detach:** wrap read/write so a native throw clears `this.hidRef` and rethrows `core.Disconnected`.

**Risk.** The report-ID change alters the wire write — **must be tested on Win/mac/Linux against a real legacy-HID or bootloader-mode device** before shipping; if legacy HID currently works on mac/Linux without it, gate behind `process.platform === 'win32'` to be safe.

**Acceptance.** A bootloader-mode firmware update on Windows completes; an unplug during HID I/O surfaces `Disconnected` instead of hanging.

---

### FIX-8 · Release the device handle on shutdown
**Finding E3.** Effort **S** · Risk **low**

**Problem.** `stop()` (`:319-324`) removes USB listeners but never releases interface 0; `clearWallet()`'s `keyring.removeAll()` is fire-and-forget (`:176`).

**Solution.** Make `stop()` async and `await this.wallet?.transport?.disconnect().catch(()=>{})` before exit; have `cleanupAndQuit` (`index.ts:6341-6373`) await `engine.stop()`. Also call `stopDiscoveryPoll()` here.

**Acceptance.** Clean quit releases WinUSB; the next launch never hits a self-inflicted "in use".

---

## Phase 3 — Resilience & CI

### FIX-9 · Crash supervisor (realistic mitigation for the native unplug crash)
**Finding E2.** Effort **M** · Risk **med**

**Problem.** A libusb fault on surprise-unplug-mid-transfer segfaults the whole backend (documented). Full out-of-process USB isolation is the real fix but is **L**/architectural.

**Solution (simple, now).** Don't rewrite — supervise:
- In `cleanupAndQuit`, write a `clean-shutdown` marker (file in userData) so the parent can tell a crash from a user quit.
- Wrap the backend launch in a thin supervisor that relaunches on unexpected exit with exponential backoff (cap ~3 tries/min) and clears the marker on intentional quit.
- FIX-3 reduces how often the crash window is even reached.

**Solution (later, optional, L).** Move `usb`/`node-hid` into a child process that owns the handle and talks over IPC; respawn on crash. Track as a follow-up.

**Acceptance.** An unplug-during-write that previously killed the app now self-recovers (device re-detected via FIX-1) instead of vanishing.

---

### FIX-10 · Windows CI job
**Finding P3.** Effort **S** · Risk **low**

**Problem.** CI is ubuntu + macOS only (`.github/workflows/build.yml:35-43`); the win32 `usb`/`node-hid` prebuild staging is never exercised, so a `require('usb')` regression ships as "no device ever detected."

**Solution.** Add a `windows-latest` matrix entry: `bun install` → collect-externals → `bun -e "require('usb');require('node-hid')"` load test against the staged modules + assert the `win32-x64` prebuild dirs exist. Add repo-root `.gitattributes` with `*.sh text eol=lf`.

**Acceptance.** A broken/missing Windows native addon fails CI, not a user's machine.

---

## Summary

| Fix | Finding / Cause | Phase | Effort | Risk | Needs elevation? |
|---|---|---|---|---|---|
| FIX-1 Discovery poll | A | 1 | S–M | low | no |
| FIX-2 Win driver/busy UI | C / P1 | 1 | M | low | no (Repair calls FIX-7) |
| FIX-7 Registry cleanup | B | 1 | S | med | yes (installer) |
| FIX-5 Single-instance lock | P2 | 1 | S | low | no |
| FIX-3 Transfer timeouts | W2 | 2 | M | med | no |
| FIX-4 clearHalt direction | W1 | 2 | S | low | no |
| FIX-6 HID hardening | H1/H2/H3 | 2 | M | med | no |
| FIX-8 Release on quit | E3 | 2 | S | low | no |
| FIX-9 Crash supervisor | E2 | 3 | M | med | no |
| FIX-10 Windows CI | P3 | 3 | S | low | no |

**Recommended first PR (highest ROI vs. the reported symptom, all app-side, no firmware):** FIX-1 + FIX-5 + FIX-4, then FIX-2 + FIX-7 once the §2 diagnostic confirms how much of the tail is Cause B vs C.
