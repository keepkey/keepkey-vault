# Bug: Firmware update shows "Please disconnect and reconnect" when it shouldn't

## Summary

After a **firmware** update, the OOB wizard shows the same "Please disconnect and reconnect your KeepKey" prompt that should only appear for **bootloader** updates. Firmware updates auto-reboot the device — no user action is needed. Bootloader updates require manual unplug/replug.

## Observed behavior (2026-03-21)

1. Device connects in bootloader mode (fw=2.1.4, bootloaderMode=true)
2. Firmware binary is flashed, user confirms on device
3. Backend starts reboot poll, device detaches and re-attaches automatically (~7 seconds)
4. **Frontend shows "Please disconnect and reconnect your KeepKey"** with yellow warning box
5. User sees confusing message — device has already auto-rebooted

## Expected behavior

- **Firmware update**: Show a "Device is rebooting..." spinner. Device auto-restarts. No user action needed.
- **Bootloader update**: Show "Please disconnect and reconnect" prompt. Device does NOT auto-restart. User must unplug/replug.

## Root cause

In `OobSetupWizard.tsx`, both the bootloader step (line 345) and firmware step (line 425) set `setRebootPhase('rebooting')` on update completion. The UI at line 1674 renders the same "Please disconnect and reconnect" block for **any** `rebootPhase === 'rebooting'`, regardless of which update type just completed.

### Bootloader reboot (line 340-346):
```tsx
useEffect(() => {
    if (step !== 'bootloader') return
    if (updateState !== 'complete') return
    resetUpdate()
    setRebootPhase('rebooting')  // ← same state for both
}, [updateState, step, resetUpdate])
```

### Firmware reboot (line 420-427):
```tsx
useEffect(() => {
    if (step !== 'firmware') return
    if (updateState !== 'complete') return
    resetUpdate()
    setRebootPhase('rebooting')  // ← same state for both
    setFirmwareJustFlashed(true)
}, [updateState, step, resetUpdate])
```

### UI (line 1673-1713):
```tsx
{rebootPhase === 'rebooting' && (
    // Shows "Please disconnect and reconnect" for BOTH cases
)}
```

## Backend log evidence

```
[07:53:22.246] [Engine] BUTTON_REQUEST — confirm on device
[07:53:47.552] [Engine] Starting reboot poll (5s interval, max 5 min)
[07:53:50.839] [Engine] KeepKey USB detached
[07:53:50.839] [Engine] Detach during reboot phase — ignoring (reboot poll active)
[07:53:57.430] [Engine] KeepKey USB attached           ← auto-reconnect, 7s later
[07:53:59.048] [Engine] Device reconnected after reboot, clearing reboot phase
[07:53:59.048] [Engine] State → needs_init
```

The backend correctly handles the auto-reboot (detach → re-attach → re-pair → state update). The problem is purely in the frontend UI — it shows the wrong message during the ~7 second window.

## Proposed fix

1. **Differentiate reboot phase**: Change `rebootPhase` from `'idle' | 'rebooting'` to `'idle' | 'firmware-rebooting' | 'bootloader-rebooting'`
2. **Firmware reboot UI**: Show "Device is rebooting..." with a spinner (no user action needed)
3. **Bootloader reboot UI**: Keep the existing "Please disconnect and reconnect" prompt
4. The backend reboot poll already handles both cases correctly — no backend changes needed

## Key files

| File | Role |
|------|------|
| `src/mainview/components/OobSetupWizard.tsx` | Wizard UI — rebootPhase state + rendering |
| `src/bun/engine-controller.ts` | Backend — reboot poll, device state machine |
| `docs/logs/2026-03-21-firmware-update-reboot-bug.log` | Full backend log from reproduction |

## Related commits

- `94330f1` — "fix: differentiate bootloader vs firmware reboot messaging" (partial fix, merged to develop)
- `12d36ea` — Merge PR #33 bootloader reboot messaging
