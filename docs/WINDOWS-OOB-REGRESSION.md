# Windows OOB Wizard Regression — Investigation & Fix

## Problem

On Windows, the Out-of-Box (OOB) setup wizard breaks when the user unplugs the
KeepKey to enter bootloader mode. Instead of staying on the bootloader step and
waiting for reconnection, the wizard unmounts entirely and the user is returned
to the splash screen. When the device reconnects in bootloader mode, the wizard
may restart from the beginning or skip directly to "Create New Wallet".

This does NOT occur on macOS.

---

## Root Causes (Two Independent Bugs)

### Bug 1: `needsInit=true` when features are unknown

**File**: `src/bun/engine-controller.ts` line 617

**Before**:
```typescript
const initialized = features?.initialized ?? false
```

When the device detaches, `cachedFeatures` is cleared. On the next `getDeviceState()`
call, `features` is null, so `initialized` defaults to `false`, making `needsInit = true`.
Meanwhile, `needsBootloader` and `needsFirmware` default to `false` (nothing to compare).

The wizard's step routing checks:
```
if (needsBootloader) → bootloader step
else if (needsFirmware) → firmware step
else if (needsInit) → init-choose step  ← HITS THIS
```

Result: wizard jumps straight to "Create New Wallet" during the featureless gap.

**Evidence from logs**:
```
[Engine] KeepKey USB detached
[Engine] State → disconnected
[Engine:getDeviceState] hasFeatures=false initialized=false
[Engine:getDeviceState] → needsBl=false needsFw=false needsInit=true  ← BUG
```

**Fix**: Default `initialized` to `true` when features are unavailable:
```typescript
const initialized = features ? (features.initialized ?? false) : true
```

This means "unknown state = don't claim init is needed". The wizard waits for
real features before making routing decisions.

---

### Bug 2: Wizard unmounts on disconnect (phase lock race)

**File**: `src/mainview/App.tsx` line 435-444

App.tsx determines the UI phase:
```typescript
!wizardComplete && setupInProgress ? "setup"     // ← should keep wizard alive
: ["disconnected", ...].includes(state) ? "splash" // ← kills wizard
: ["bootloader", "needs_firmware", ...] ? "setup"  // ← opens wizard
```

The `setupInProgress` state is set by the wizard's `useEffect` after mount. On
Windows, USB detach/reattach is faster than macOS and can cause a React render
cycle where:

1. Device detaches → state = `disconnected`
2. App re-renders, evaluates phase
3. `setupInProgress` may still be `false` (useEffect hasn't fired yet)
4. Phase = `"splash"` → wizard unmounts

Even when `setupInProgress` IS true, there are edge cases where React batching
can evaluate the phase before the state setter propagates.

**Evidence**: The wizard visually disappears on unplug. When the device reconnects
in bootloader mode, the wizard either doesn't reopen or starts from welcome.

**Fix**: Add a ref-based lock that persists across renders without timing issues:
```typescript
const oobEnteredRef = useRef(false)

// Set when any OOB state is seen
if (!wizardComplete && ["bootloader", "needs_firmware", "needs_init"].includes(deviceState.state)) {
    oobEnteredRef.current = true
}
if (wizardComplete) {
    oobEnteredRef.current = false
}

const oobLock = !wizardComplete && (setupInProgress || oobEnteredRef.current)

const phase: AppPhase = oobLock ? "setup" : ...
```

Refs update synchronously during render — no useEffect timing dependency. Once
the device enters OOB, the wizard stays mounted until `wizardComplete` is set.

---

## Why Windows Only

| Factor | macOS | Windows |
|--------|-------|---------|
| USB detach event | Reliable, single event | May not fire (Win10), uses polling fallback |
| USB reattach timing | ~500ms | 1500ms + 5s polling interval |
| `usb.on('attach')` | Always fires | May not fire after device reboot |
| State update frequency | Stable | Rapid churn during polling |
| React render batching | Rarely hits the race | Hits it frequently due to timing gaps |

The 5-second reboot polling on Windows (`engine-controller.ts` line 448) causes
multiple `getDeviceState()` calls during the featureless gap, each emitting
`needsInit=true` to the frontend. macOS gets a clean attach event and pairs in
one shot.

---

## Files Changed

| File | Change |
|------|--------|
| `src/bun/engine-controller.ts` | Default `initialized=true` when no features |
| `src/mainview/App.tsx` | Add `oobEnteredRef` lock for wizard persistence |

---

## Test Plan

1. Connect factory-fresh KeepKey (fw 4.0.0) on Windows
2. Wizard should open at welcome step
3. Click "Get Started" → bootloader step
4. Unplug device (to enter bootloader by holding button)
5. **Wizard must stay visible** on bootloader step
6. Plug in while holding button → bootloader mode detected
7. Bootloader update should proceed normally
8. After BL update, wizard advances to firmware step
9. Repeat unplug/replug cycle for firmware flash
10. After firmware, wizard shows init-choose (Create/Recover)
11. Verify same flow works on macOS (no regression)

---

## Raw Debug Logs

### Before fix — needsInit=true on disconnect:
```
[Engine] KeepKey USB detached
[Engine] State → disconnected
[Engine:getDeviceState] bootloaderMode=false initialized=false fwVersion=undefined blVersion=undefined updatePhase=idle state=disconnected hasFeatures=false
[Engine:getDeviceState] → needsBl=false needsFw=false needsInit=true isOob=false firmwarePresent=false
```

### After engine fix — needsInit=false on disconnect:
```
[Engine] KeepKey USB detached
[Engine] State → disconnected
[Engine:getDeviceState] bootloaderMode=false initialized=true fwVersion=undefined blVersion=undefined updatePhase=idle state=disconnected hasFeatures=false
[Engine:getDeviceState] → needsBl=false needsFw=false needsInit=false isOob=false firmwarePresent=false
```

### Full device lifecycle (factory-fresh device):
```
# Initial connect — fw 4.0.0 (factory)
[Engine] Features: {"initialized":false,"firmwareVersion":"4.0.0","bootloaderHash":"cb222548..."}
[Engine] State → needs_firmware
[Engine:getDeviceState] → needsBl=true needsFw=true needsInit=true isOob=true

# User unplugs to enter bootloader
[Engine] KeepKey USB detached
[Engine] State → disconnected
[Engine:getDeviceState] → needsBl=false needsFw=false needsInit=false  ← FIXED

# Device reconnects in bootloader mode
[Engine] KeepKey USB attached
[Engine] State → connected_unpaired
[Engine:getDeviceState] → needsBl=false needsFw=false needsInit=false  ← FIXED (was true)

# Device paired in bootloader
[Engine] Features: {"bootloaderMode":true,"firmwareVersion":"1.0.3"}
[Engine] State → bootloader
[Engine:getDeviceState] → needsBl=true needsFw=true needsInit=true isOob=true
```
