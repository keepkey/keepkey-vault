# QA Report Findings — v1.2.0 (Windows 10, 2026-03-20)

Tester: illithics | Device: factory-fresh KeepKey | Build: 1.2.0

---

## OOB Issues

### 1. Reboot messaging mismatch (Figure 3) — MUST FIX

**What happens**: After firmware flash, the device screen shows:
> FIRMWARE UPDATE COMPLETE. Please disconnect and reconnect.

But the app shows "Device is rebooting..." with a spinner, implying the
user should wait. The user doesn't know they need to manually unplug.

**Root cause**: The reboot-phase UI in OobSetupWizard uses the same
"rebooting" message for both bootloader flash (auto-reboot, no user action)
and firmware flash (manual disconnect/reconnect required). The device sends
a different message for each, but the app doesn't distinguish them.

**Fix**: During firmware reboot phase, show:
- "Unplug your KeepKey and plug it back in"
- Match the device screen text: "Please disconnect and reconnect"
- Only show "rebooting" spinner for bootloader flash (which auto-reboots)

**Files**: `OobSetupWizard.tsx` (reboot-phase rendering)

---

### 2. Seed phrase warning not prominent enough (Figure 4) — SHOULD FIX

**What happens**: During "Creating Wallet...", the user is told to follow
prompts on the device. The seed words appear on the KeepKey OLED screen.
The app's prompt is too subtle — easy to miss the critical "write these down"
instruction.

**Tester note**: "This needs big bold emphasis! Unmissable. Trezor makes you
prove you wrote it down. We should either do that, or make this a neon sign."

**Fix options**:
1. Add a large, prominent warning banner with red/yellow styling:
   "WRITE DOWN EVERY WORD. This is your only backup. You will NOT see them again."
2. Add a confirmation checkbox: "I have written down my recovery phrase"
   that gates the "Continue" button.
3. Both.

**Files**: `OobSetupWizard.tsx` (init-progress step rendering)

---

### 3. Splash screen resolution (Figure 1) — LOW PRIORITY

**What happens**: The KeepKey logo on the splash screen looks pixelated /
low-resolution on Windows.

**Likely cause**: SVG rendering at 1x on a high-DPI display, or the logo
PNG asset is low-resolution. Windows WebView2 may not apply DPI scaling
to background images the same way macOS WKWebView does.

**Files**: Splash screen component, logo assets

---

### 4. Menu not populated (Figure 2) — LOW PRIORITY

**What happens**: Application menu (File, Edit, Window) shows only default
Electrobun entries. No KeepKey-specific menu items.

**Documented as**: WINDOWS-QUIRKS.md #33

---

## In-Wallet Issues

### 5. No Solana or Zcash on dashboard (Figure 5) — OUT OF SCOPE

These chains require firmware >= 7.11.0. The test device has firmware 7.10.0.
After firmware update, these chains will appear. The `minFirmware` gate in
`chains.ts` is working correctly.

### 6. No swaps visible (Figure 6) — BY DESIGN

Swaps are behind a feature flag (`swaps_enabled`), default OFF. Enable in
Settings. This is intentional for the pre-release phase.

### 7. "View in Explorer" button inactive (Figure 7) — WINDOWS QUIRK

`window.open()` is blocked by WebView2 security policy on Windows.
Works on macOS. Documented as WINDOWS-QUIRKS.md #32.

---

## Action Items

| # | Issue | Priority | Status |
|---|-------|----------|--------|
| 1 | Reboot messaging mismatch | MUST FIX | Open |
| 2 | Seed phrase warning | SHOULD FIX | Open |
| 3 | Splash resolution | LOW | Open |
| 4 | Menu not populated | LOW | Documented |
| 5 | No Solana/Zcash | N/A | Firmware gate, correct |
| 6 | No swaps | N/A | Feature flag, by design |
| 7 | View in Explorer | MEDIUM | Documented as Windows quirk |
