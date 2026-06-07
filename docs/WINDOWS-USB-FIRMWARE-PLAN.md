# Windows USB — Firmware Fix Plan

**Companion to:** [`WINDOWS-USB-AUDIT.md`](./WINDOWS-USB-AUDIT.md) (findings) and [`WINDOWS-USB-FIX-PLAN.md`](./WINDOWS-USB-FIX-PLAN.md) (app side)
**Repo:** `modules/keepkey-firmware` (separate release + code-signing + on-device testing).
**Reality check:** firmware fixes only help a user **after they flash**, and require hardware-in-the-loop testing. So they are the *durable* fixes; the app/installer registry cleanup ([`WINDOWS-USB-FIX-PLAN.md`](./WINDOWS-USB-FIX-PLAN.md) FIX-7) is the *immediate* remedy for already-deployed devices. Coordinate the two.

All file refs are `modules/keepkey-firmware/lib/board/`.

---

## FW-1 · Derive `bcdDevice` from the firmware version  ⭐ simplest high-value fix
**Cause B.** Effort **S** · Risk **low–med**

**Problem.** `usb.c:122` hard-codes `.bcdDevice = 0x0100` for *every* release. Windows caches the MS OS descriptor query result per **VID+PID+bcdDevice** under `HKLM\…\UsbFlags\2B2400020100`. If that cache is poisoned (`osvc = 00 00`), WinUSB never re-binds — and since the key never changes, a firmware flash doesn't help.

**Solution.** Set `bcdDevice` from the firmware version, e.g. `7.14.0 → 0x07E0` (per the formula below). A new version → a **new `UsbFlags` key with no cached result** → Windows re-queries the MS OS descriptors → WinUSB binds. This means **flashing new firmware self-heals a poisoned machine** — the single biggest leverage point for the smallest change.

```c
// usb.c — replace the constant; 7.14.0 → 0x07E0 (minor & patch each must be < 16)
.bcdDevice = (MAJOR_VERSION << 8) | (MINOR_VERSION << 4) | PATCH_VERSION,
```

> The formula hex-packs the version (minor/patch as nibbles, so each must be < 16 — fine for current versioning). If you prefer a human-readable BCD key like `0x0714` for 7.14.0, use `(MAJOR_VERSION << 8) | ((MINOR_VERSION / 10) << 4) | (MINOR_VERSION % 10)` (drops patch). The only requirement is a unique, monotonically increasing value per release so Windows mints a fresh cache key.

**Coordinate.** The bootloader is a separate binary — bump its `bcdDevice` too (or keep it intentionally distinct, e.g. `0x0Bxx`), so bootloader-mode and firmware-mode each present a clean cache key. Both must still advertise WinUSB.

**Risk.** Confirm no host code filters on `bcdDevice` — the Vault app filters on VID/PID only (`hdwallet-keepkey-nodewebusb/src/adapter.ts:10`; `utils.ts` only defines the VID/PID constants), so this is safe. Device "revision" shown in Device Manager changes per version (expected/harmless).

**Test.** Poison the cache on a Windows box (`osvc=00 00` for `…020100`), confirm dead, flash a build with `bcdDevice=0x07E0`, replug → new `…0207E0` key appears with `osvc=01`, WinUSB binds, app detects.

**Acceptance.** A firmware update restores a previously-poisoned Windows machine with no registry edit.

---

## FW-2 · Lengthen the `usbReconnect()` disconnect pulse
**Completeness lead #11.** Effort **S** · Risk **low**

**Problem.** `usb.c:419-423` re-enumerates with `usbd_disconnect(1)` → `delay_us(1000/20)` (**50 µs**) → `usbd_disconnect(0)`. Windows' hub driver needs ~100 ms+ of D+/D- disconnect to register a removal. Too short → Windows keeps the stale handle, no removal/re-add event fires (this is the real root of the "attach doesn't fire on Win10 after reboot" symptom the app papered over with `startRebootPoll`).

**Solution.** Use a real ≥100 ms pulse (e.g. 150 ms):
```c
void usbReconnect(void) {
  usbd_disconnect(usbd_dev, 1);
  delay_ms(150);            // was delay_us(50) — too short for Windows hub debounce
  usbd_disconnect(usbd_dev, 0);
}
```
(Use the board's millisecond delay helper; confirm it's safe to block here — this runs during the reboot/flash transition, not in the main poll loop.)

**Test.** On Windows, trigger a firmware-update reboot and confirm a USB removal+arrival pair in Event Viewer and that `usb.on('attach')` fires without the reboot-poll fallback.

**Acceptance.** Device re-enumeration after flash is seen by Windows as a real replug; reduces reliance on the app's reboot poll.

---

## FW-3 · Add MS OS 2.0 descriptors (durable first-enumeration fix)
**Cause B (root fix).** Effort **M** · Risk **med**

**Problem.** WinUSB binding relies solely on legacy **MS OS 1.0** (0xEE "MSFT100" string → Compatible-ID → extended-properties GUID, in `winusb.c`). MS OS 1.0 is queried **once** and negatively cached. MS OS 2.0 descriptors live in the **BOS** and are re-read on **every** enumeration → immune to the `osvc` cache. The device already serves a BOS (`usb.c:382-391`) but it carries only the WebUSB platform capability.

**Solution.** Add an MS OS 2.0 platform-capability descriptor to the BOS alongside WebUSB, and implement the `GET_MS_DESCRIPTOR` vendor request (wIndex = 7) returning a descriptor set with:
- a **CompatibleID "WINUSB"** feature for interface 0, and
- a **registry-property** feature setting `DeviceInterfaceGUIDs` = `{0263b512-88cb-4136-9613-5c8e109d8ef5}` (same GUID as today's MS OS 1.0 path, so existing app lookups keep working).

Keep the MS OS 1.0 path for Windows 7. Model the new handler on the existing `winusb_control_vendor_request` in `winusb.c`; add the BOS capability next to `webusb_platform_capability_descriptor` (`webusb.c:25`). the in-repo board file `lib/board/usb21_standard.c` (`usb21_setup`, called from `usb.c:405`) already wires the BOS.

**Risk.** Descriptor byte-layout is fiddly; validate the full set with **MS USB Test Tool / `UsbTreeView`** and Microsoft's MS OS 2.0 validation. Bump `bcdDevice` (FW-1) alongside so machines re-query.

**Test.** Fresh Windows VM (never saw a KeepKey): plug in → WinUSB binds on first try via the MS OS 2.0 path; verify in `UsbTreeView` that the MS OS 2.0 descriptor is read every enumeration.

**Acceptance.** First-ever enumeration reliably binds WinUSB even on slow hubs/docks, and a poisoned MS OS 1.0 cache no longer blocks binding.

---

## FW-4 · Remote-wakeup attribute + suspend/resume handling
**Completeness lead #1 (idle/sleep symptom).** Effort **M** · Risk **med**

**Problem.** `usb.c:295` sets `.bmAttributes = 0x80` (bus-powered, **no** remote-wakeup bit) and there's no suspend/resume handler. Windows enables USB selective suspend by default on laptops; an interrupt-IN endpoint with no host traffic gets its port suspended, and a device that neither advertises nor signals remote wakeup looks wedged until physically replugged. Combined with the app's (current) lack of transfer timeouts, this becomes a permanent hang.

**Solution (simple first).** Two independent, additive steps:
1. **Advertise remote wakeup:** `.bmAttributes = 0x80 | 0x20` (`USB_CONFIG_ATTR_REMOTE_WAKEUP`). Cheap; lets Windows know the device participates.
2. **Handle suspend/resume:** register a suspend callback (libopencm3 `usbd_register_suspend_callback`) so the device resumes cleanly. Full remote-wakeup *signaling* (waking the host) is optional/harder — defer.

This pairs with app FIX-3 (transfer timeouts), which independently prevents a suspended port from becoming an infinite block.

**Test.** Windows laptop on the power-saver profile with "Allow the computer to turn off this device" enabled: leave the app idle past the suspend window, then issue a transfer → device responds (or surfaces a clean reconnect) instead of wedging.

**Acceptance.** Idle-then-resume no longer requires a physical replug.

---

## FW-5 · (Optional) BOS USB 2.0 Extension capability for the 2.1 claim
**Completeness lead #6.** Effort **S** · Risk **low**

**Problem.** `usb.c` declares `bcdUSB = 0x0210` (mandates a BOS) but the BOS lacks a `USB_DC_USB20_EXTENSION` (LPM/BESL) capability — technically malformed for a 2.1 claim; some Windows USB-3 stacks log/retry the BOS read, adding enumeration latency (feeds Cause A).

**Solution.** Either add a USB 2.0 Extension capability to the BOS, or — if no 2.1 feature is actually needed — drop `bcdUSB` back to `0x0200`. Note MS OS 2.0 (FW-3) requires a BOS, so if FW-3 lands, **add** the extension rather than dropping the version.

**Acceptance.** BOS is spec-conformant for the declared `bcdUSB`; no Windows enumeration retries logged in `UsbTreeView`.

---

## Summary & sequencing

| Fix | Cause / lead | Effort | Risk | Self-heals poisoned machines? |
|---|---|---|---|---|
| FW-1 `bcdDevice` from version | B | S | low–med | **Yes** (on flash) |
| FW-2 Reconnect pulse ≥100 ms | #11 | S | low | partial (reboot path) |
| FW-3 MS OS 2.0 descriptors | B (root) | M | med | **Yes** (immune to cache) |
| FW-4 Remote-wakeup + suspend | #1 | M | med | — (fixes idle/sleep) |
| FW-5 BOS 2.0 extension | #6 | S | low | — (reduces enum latency) |

**Recommended firmware release:** **FW-1 + FW-2** first (both **S**, low risk, and FW-1 alone makes a firmware update a recovery path). Add **FW-3** in the same or next release for the durable first-enumeration fix; **FW-4/FW-5** as follow-ups.

**Critical pairing:** ship app FIX-7 (registry cleanup) and FIX-1 (discovery poll) *before/with* the firmware, so users who can't or won't flash still recover, and slow-binding devices are caught regardless.
