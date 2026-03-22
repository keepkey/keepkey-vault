# Firmware Update & Device Detection — Retrospective

**Branch:** `hotfix/windows`
**Date:** 2026-02-26
**Commits:** `48333d2`, `214f317`, `cac5c21`

---

## Summary

Three bugs were found and fixed during testing of the Windows production build. All three relate to the firmware/bootloader update flow in the OOB (out-of-box) setup wizard and the engine's device state derivation.

---

## Bug 1: Bootloader Update Infinite Loop

**Commit:** `48333d2`

**Symptom:** After a successful bootloader update, the wizard immediately re-entered the bootloader update step, showing "Current v2.1.4 → Latest v2.1.4" in a loop.

**Root Cause:** In `engine-controller.ts`, the `needsBootloaderUpdate` field used this fallback logic:

```typescript
const needsBl = blVersion
  ? this.versionLessThan(blVersion, this.latestBootloader)
  : bootloaderMode   // ← BUG: always true after BL update reboot
```

After a bootloader update, the device reboots into bootloader mode. In bootloader mode, the `blVersion` field is unavailable (null), so the code falls back to `bootloaderMode`, which is `true` — creating an infinite loop: update → reboot → bootloaderMode=true → needsBl=true → update again.

**Fix (engine-controller.ts):** Changed `needsBl` to use a three-tier strategy:
1. If `blVersion` is available, compare versions directly
2. In normal mode (not bootloader): look up the on-device bootloader hash in the manifest to resolve a version, then compare
3. In bootloader mode (no hash available): default to `false` — prevents the loop

**Fix (OobSetupWizard.tsx):** Added `bootloaderDoneRef` and `firmwareDoneRef` (React refs) to track step completion. Once a step completes, `handleGetStarted()` skips it even if `needsBootloader`/`needsFirmware` are still true from a stale device state during reconnection.

---

## Bug 2: Bootloader Update Incorrectly Skipped

**Commit:** `214f317`

**Symptom:** After installing with the "fixed" build from Bug 1, the device showed a "bootloader has a known security issue" warning — meaning the old bootloader (v1.0.3) was never updated.

**Root Cause:** The initial fix for Bug 1 used `bootloaderVerified === false` as the fallback, but `bootloaderVerified` only means the hash is *recognized* in the manifest (i.e., it's a known version), NOT that it's the *latest* version. The old bootloader hash `cb2225...` IS in the manifest as v1.0.3 — a known old version — so `bootloaderVerified=true`, making `needsBl=false`, skipping the update entirely.

**Key Insight:** `bootloaderVerified` answers "is this hash known?" not "is this the latest version?". These are fundamentally different questions.

**Fix:** Instead of checking `bootloaderVerified`, look up the actual version string from the on-device hash using `manifest.hashes.bootloader` (a map of SHA-256 hash → version string, e.g., `"cb222548..." → "v1.0.3"`), then compare that version to the latest:

```typescript
let needsBl = false
if (blVersion) {
  needsBl = this.versionLessThan(blVersion, this.latestBootloader)
} else if (!bootloaderMode && hashes.bootloaderHash && this.manifest?.hashes?.bootloader) {
  const blVersionFromHash = this.manifest.hashes.bootloader[hashes.bootloaderHash]
  if (blVersionFromHash) {
    needsBl = this.versionLessThan(blVersionFromHash.replace(/^v/, ''), this.latestBootloader)
  } else {
    needsBl = true  // Unknown hash → not in manifest → needs update
  }
}
// In bootloader mode: needsBl stays false (prevents loop from Bug 1)
```

---

## Bug 3: Device Not Detected in Production Build

**Commit:** `cac5c21`

**Symptom:** Signed installed build showed the splash screen with "not detected" permanently. Device was never recognized despite multiple replug attempts.

**Root Cause:** In `engine.start()`, the code called `await fetchFirmwareManifest()` BEFORE registering USB listeners. The fetch had no timeout. If the network was slow or unreachable, the fetch would hang indefinitely, and USB listeners would never be registered — meaning device attach/detach events were silently dropped.

```typescript
// BEFORE (broken)
async start() {
  await this.fetchFirmwareManifest()  // ← hangs here, USB events lost
  usb.on('attach', ...)               // never reached
  usb.on('detach', ...)
  await this.syncState()
}
```

**Fix:** Two changes:
1. **Moved USB listener registration before the manifest fetch** — device detection works even if the fetch is slow
2. **Added `AbortSignal.timeout(10000)` to the fetch** — network issues can't hang the engine indefinitely

```typescript
// AFTER (fixed)
async start() {
  usb.on('attach', ...)               // registered first
  usb.on('detach', ...)
  await this.fetchFirmwareManifest()   // 10s timeout, won't block USB
  await this.syncState()
}
```

---

## Files Changed

| File | Changes |
|------|---------|
| `src/bun/engine-controller.ts` | `needsBl` hash-to-version lookup, USB listener ordering, 10s fetch timeout |
| `src/mainview/components/OobSetupWizard.tsx` | `bootloaderDoneRef`/`firmwareDoneRef` step completion tracking |

---

## Lessons Learned

1. **"Verified" ≠ "Latest"** — Hash verification (is this hash recognized?) and version comparison (is this the latest?) are different operations. Never conflate them.

2. **USB listeners must be registered before any async work** — Any `await` that could hang (network fetch, file I/O) between `start()` and USB listener registration creates a window where device events are silently lost.

3. **Always add timeouts to network fetches** — `AbortSignal.timeout()` prevents indefinite hangs. Firmware manifest is important but not critical; the engine should gracefully degrade.

4. **Step completion tracking is essential in hardware wizard flows** — Devices disconnect and reconnect during firmware updates. Without tracking which steps are done, the wizard re-enters completed steps when the device reconnects with a stale state.

5. **Bootloader mode is a trap for state derivation** — In bootloader mode, many device fields (`blVersion`, `bootloaderHash`) are unavailable. Fallback logic that uses `bootloaderMode` as a signal creates loops because the device enters bootloader mode during normal update workflows.

6. **Test the signed/installed build, not just dev** — The connection bug (Bug 3) only manifested in the production build where network conditions differed from the dev environment.

---

## Testing Checklist (for future firmware update changes)

- [ ] Device with old bootloader → detects need for BL update
- [ ] Bootloader update completes → wizard advances to firmware (no loop)
- [ ] Device with latest bootloader → skips BL update
- [ ] Device with old firmware → detects need for FW update
- [ ] Firmware update completes → wizard advances to init
- [ ] Full flow: bootloader → firmware → init (no bouncing)
- [ ] Device detection works with slow/no network (manifest fetch timeout)
- [ ] Signed/installed build detects device on plug-in
- [ ] Device replug during wizard → resumes at correct step
