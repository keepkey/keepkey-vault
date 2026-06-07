# Windows USB Connection Audit

**Date:** 2026-06-07
**Method:** Multi-agent code audit (6 dimensions, adversarial verification) + maintainer symptom report
**Scope:** Full USB stack — app transports (`usb`/`node-hid`), engine lifecycle, firmware descriptors, Windows packaging

---

## The actual symptom (anchor for prioritization)

> Windows 10 **and** 11 users **hear the system USB connection chime, but KeepKey Vault never detects the device.** Clusters on **fresh installs / new users** and **USB hubs / docks / laptops**; otherwise **seems random.** Hotplug (attach/detach) works fine for the maintainer and most users.

This single fact reframes the whole audit. The chime means **Windows successfully enumerated the device** (power, data lines, descriptors, device node, cable all fine). The failure is *above* enumeration: **the app's USB library cannot see a device Windows already enumerated.**

Load-bearing Windows fact: on Windows, libusb — and therefore the `usb` npm package, `usb.getDeviceList()`, and `webusb.getDevices()` — can **only access devices bound to WinUSB** (or libusbK/libusb-win32). A device bound to the *wrong* driver, to *no* driver, or whose WinUSB binding hasn't finished yet is **completely invisible** to the app. It won't appear in the device list at all.

So "beep but not detected" ≡ **Windows enumerated the KeepKey but WinUSB is not (yet/ever) bound to its vendor interface.** Everything below is ranked by how well it explains *that*.

> ⚠️ Note: the original audit's executive summary led with a different symptom class ("wallet froze / had to restart" — caused by blocking I/O). Those findings are real and included in §4, but they are **not** the reported symptom. Do not let them distract from §1–§3.

---

## §1. Causes that produce "beep but not detected" (ranked by fit)

### A. Enumeration/binding **timing race** — app probes before WinUSB finishes binding  ⭐ best fit for hubs/docks/random/fresh
**Files:** `engine-controller.ts:50` (`ATTACH_DELAY_MS = 1500`), `:265` (attach → `setTimeout(syncState, 1500)`), `:303` (one-shot `getDeviceList()`), `:895` (`keepKeyOnBus = getDeviceList().some(idVendor===0x2B24)`), `:782-803` (retry **only** when `connected_unpaired && lastError`). Firmware even warns: *"Windows are strict about interfaces appearing in correct order"* (`keepkey-firmware/lib/board/usb.c:270`).

**Mechanism.** The KeepKey is a **composite device** (vendor interface #0 + U2F-HID interface). On attach, Windows must spin up `usbccgp.sys`, create a function PDO per interface, then bind WinUSB to interface #0 via the MS OS descriptor handshake. Behind a USB-3/xHCI root hub, a dock, a deep hub chain, or on a busy laptop, that can take **longer than the app's single fixed 1500 ms delay.** When `initializeWallet()` then runs:
- `webUsbAdapter.getDevice()` sees nothing (WinUSB not bound yet) → logs *"WebUSB getDevice() returned nothing"* → falls through to HID.
- `usb.getDeviceList()` also returns nothing → `keepKeyOnBus = false`.
- HID finds nothing (modern firmware has no HID wallet interface — see §3/C).
- With `keepKeyOnBus=false` and no `lastError`, **`scheduleRetry()` is never armed** → state sits at `disconnected` → nothing ever re-probes. `usb.on('attach')` already fired and won't fire again.

Result: "beep, then nothing, until I restart the app." Most users win the race on a direct port → it works for them. The losers are exactly: slow binding (hubs/docks/laptops) and first-plug (fresh installs). This is **app-side fixable** and is the single highest-ROI fix for the reported symptom.

**Fix.** Replace the single fixed `ATTACH_DELAY_MS` probe with a **retry/backoff loop**: after attach (and on an always-on disconnected-state poll), re-run `getDeviceList()` + `getDevice()` every ~750 ms for ~10–15 s before giving up; arm the retry even when `keepKeyOnBus=false` (the device may just not be visible *yet*). Pair this with an always-on disconnected-state poll as a backstop (see [`WINDOWS-USB-FIX-PLAN.md`](./WINDOWS-USB-FIX-PLAN.md) FIX-1). Stop on pair success.

### B. Poisoned `osvc` / `UsbFlags` cache — WinUSB never binds, **permanently** (confirmed finding F1)
**Files:** `keepkey-firmware/lib/board/usb.c:122` (`bcdDevice=0x0100`, frozen for every release), `:382-391` (BOS carries WebUSB platform cap only — **no MS OS 2.0**), `winusb.c:29-131` (MS OS 1.0 WCID is the *only* binding path).

**Mechanism.** WinUSB auto-binding for the vendor interface relies solely on legacy **MS OS 1.0** descriptors (0xEE "MSFT100" string → Compatible-ID "WINUSB" → extended-properties GUID). Windows queries this **once per VID+PID+bcdDevice** and caches the result under `HKLM\SYSTEM\CurrentControlSet\Control\UsbFlags\2B2400020100` as `osvc`. If that first probe ever fails or is garbled (hub timing — see A; a racing co-installer; the firmware's own 50 µs `usbReconnect` re-enumeration at `usb.c:419-423`, see §5/#11), Windows records `osvc = 00 00` ("no MS OS descriptors") and **never re-queries.** WinUSB never binds; the interface sits as an un-driver'd yellow-bang device; the app is blind. Because `bcdDevice` is hard-coded `0x0100` for **every** firmware version, the normal remedy (bump REV → new cache key → fresh query) is unavailable — **a poisoned machine stays poisoned across every firmware flash.** MS OS 2.0 descriptors (in the BOS) are re-read every enumeration and are immune to this negative cache; that's why Microsoft recommends them for USB 2.1+.

**Fix.** (1) Add an MS OS 2.0 platform-capability descriptor to the BOS + `GET_MS_DESCRIPTOR` (wIndex=7) returning CompatibleID "WINUSB" for iface 0 + `DeviceInterfaceGUIDs`; keep MS OS 1.0 for Win7. (2) Derive `bcdDevice` from firmware version. (3) **Immediate host-side remedy** (firmware fixes only help post-flash): installer/app deletes `HKLM\…\UsbFlags\2B24*` on install/repair, and/or bundle a signed WinUSB INF/CAT to repair already-deployed devices.

### C. Conflicting / prior driver binding (confirmed finding P1; completeness lead #5)
**Files:** `engine-controller.ts:905-983` (WebUSB→HID fallback), `:887-888,698-702` (permission branch is **Linux-only**; `process.platform === 'linux'` at `:700`), `nodewebusb/src/transport.ts:44-46` (code 19 → `ConflictingApp`), `index.ts:6263` (cross-app protocol-handler override is **macOS-only**), `App.tsx:837-844` + `DeviceClaimedDialog.tsx` (misleading generic dialog).

**Mechanism.** A user migrating from the legacy KeepKey Desktop/Chrome app (bound via libusb-win32, or a Zadig WinUSB instance with a *different* GUID) has a sticky non-WinUSB binding under PID 0x0002 → `claimInterface(0)` throws code 19 / open error, *or* the device is invisible to libusb entirely. Or a **live** old KeepKey Desktop / Trezor Bridge / browser WebUSB tab holds interface #0. Windows has **no** driver-conflict branch (the tailored remediation exists only for Linux udev and macOS protocol-handlers), so the app shows a generic "close other apps / replug" dialog that can't fix a stale *binding*, and blindly falls to the dead HID path.

**Fix.** Add a `win32` branch: on code 19/16/access (or "2B24 present in Windows but invisible to libusb"), set a `windowsDriverConflict`/`deviceBusy` flag and show actionable guidance (close other KeepKey apps / WebUSB tabs; Device-Manager uninstall-and-replug; bundled libwdi/pnputil rebind to GUID `{0263b512-88cb-4136-9613-5c8e109d8ef5}`). Mirror the Linux udev "Fix it for me" pathway. Skip the futile HID fallback for modern firmware.

---

## §2. Diagnostic — confirm which cause, on an affected machine (read-only)

```powershell
# 1) Is the KeepKey present, and what driver/class did Windows give it?
Get-PnpDevice -PresentOnly | Where-Object InstanceId -match 'VID_2B24' |
  Select-Object Status, Class, FriendlyName, InstanceId | Format-List

# 2) What service is bound?  (healthy = "WinUSB")
Get-PnpDevice -PresentOnly | Where-Object InstanceId -match 'VID_2B24' | ForEach-Object {
  $svc = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_Service).Data
  "{0}  ->  service={1}" -f $_.InstanceId, $svc }

# 3) MS OS descriptor cache for VID/PID/bcdDevice 2B24/0002/0100:
#    osvc = 01 xx -> descriptors detected (good);  00 00 -> cached as "none" (POISONED)
$k = 'HKLM:\SYSTEM\CurrentControlSet\Control\usbflags\2B2400020100'
if (Test-Path $k) { ($k|Get-Item).GetValue('osvc') | % { $_.ToString('X2') } } else { 'no usbflags entry yet' }
```

Interpretation:
| #2 service | #3 osvc | Most likely cause |
|---|---|---|
| `WinUSB`, Status OK | `01 ..` | **A** (timing race) or a *live* app holding it → app-side backoff + conflict UI |
| not `WinUSB` / yellow-bang | `00 00` | **B** (poisoned cache) → delete the `usbflags` key, replug; if it works, confirmed |
| `libusb0` / `libusbK` / other | any | **C** (conflicting prior driver) → rebind to WinUSB |

Fastest single confirmation: run **Zadig**, install **WinUSB** on the KeepKey (interface 0), replug. If the app instantly detects it → root cause is WinUSB-not-bound (A/B/C), not app logic.

---

## §3. Why the "dual-transport fallback" doesn't save these users

Modern firmware (`usb.c:121`) enumerates **only** as PID `0x0002`, vendor-class WinUSB (plus a U2F-HID interface, which is FIDO, not the wallet protocol). The HID transport (`nodehid/utils.ts:2`) looks for PID `0x0001`, which only exists on **legacy firmware / old bootloaders.** So when WebUSB/WinUSB fails on a modern device, the HID fallback finds nothing — the resilience the architecture doc advertises does not apply to current devices on Windows.

---

## §4. Other confirmed findings (real, but NOT the reported symptom)

These cause the *"froze / won't reconnect until restart"* class. Worth fixing; separate track.

| # | Severity | Finding | File:line |
|---|---|---|---|
| H1 | high | `node-hid` `readSync()` blocks the single Bun worker thread, no timeout/async; `withTimeout()` can't fire while blocked (team-acknowledged `engine-controller.ts:1424-1430`) | `nodehid/transport.ts:41,10-13` |
| W2 | high | WebUSB `transferIn/Out` on interrupt EPs have **no timeout** → wedged device blocks forever; orphaned transfer keeps interface #0 claimed → false `ConflictingApp` on reconnect; `msgTimeout` at `hdwallet-keepkey/src/transport.ts:288` is dead code | `nodewebusb/transport.ts:71-91` |
| E2 | high | Native USB I/O in the main backend process, no isolation/supervisor; a libusb fault is fatal (documented unplug crash); team's own relauncher mitigation unimplemented | `engine-controller.ts:247-252,919-941` |
| P2 | high | No OS-level single-instance lock before USB init; only guard is gated behind the **off-by-default** REST API and is racy | `index.ts:903-934` (`:915`) |
| W1 | med | WebUSB stall recovery does `clearHalt("out")` while reading IN (wrong EP+direction) and returns the stalled empty buffer → "message not valid" | `nodewebusb/transport.ts:79-91` |
| H2 | med | HID `writeChunk` doesn't prepend the `0x00` report-ID byte HIDAPI/Windows require (legacy HID path) | `nodehid/transport.ts:45-50` |
| P3 | med | No Windows CI job → native-prebuild staging never exercised; `require('usb')` regressions ship undetected | `.github/workflows/build.yml` |
| E3/H3 | low | `stop()` never releases the device handle; HID transport has no detach detection | `engine-controller.ts:319-324` |

(25 further candidate findings were **refuted** by adversarial verification — e.g. "releaseInterface leak" and "reset on code 19": on Windows a dead process's WinUSB handle is auto-reclaimed by the OS, and `libusb_reset_device` is a no-op on the WinUSB backend, so those were not real Windows mechanisms.)

---

## §5. Follow-up leads worth checking (firmware-side, also fit the symptom)

- **#11 `usbReconnect()` uses a 50 µs disconnect pulse** (`usb.c:419-423`) — far below Windows' ~100 ms hub debounce; can leave Windows holding a stale handle after firmware re-enumeration (a firmware-side root cause for the "attach didn't fire on Win10" workaround). **Lengthen to >100 ms.**
- **#1 No selective-suspend / remote-wakeup** (`usb.c:295` `bmAttributes=0x80`, no resume handler) — explains "stops responding after idle/sleep." Set the remote-wakeup bit + handle suspend/resume, or disable selective suspend for this VID/PID host-side.
- **#6 `bcdUSB=0x0210` mandates a BOS read** but the BOS lacks a USB 2.0 Extension/LPM cap (technically malformed for a 2.1 claim) — adds enumeration latency on some Win USB-3 stacks; ties to cause A.
- **#2/#9 The always-on U2F-HID interface** can be grabbed by the Windows FIDO/WebAuthn stack and is what `node-hid` actually enumerates on modern firmware — wasting the HID fallback and risking contention.
- Ruled out by the symptom: **charge-only cable / dead port** (the chime proves enumeration succeeded).

---

## Prioritized roadmap (re-ordered for "beep but not detected")

**Now (app-side, days, fixes the reported symptom for most affected users):**
1. **Retry/backoff probe after attach + always-on disconnected-state poll** (cause A). Re-probe `getDeviceList()`+`getDevice()` for ~10–15 s; arm retry even when not yet visible.
2. **Windows "present-but-invisible" detection + actionable dialog** (cause C): query SetupAPI/`Get-PnpDevice` for a 2B24 device libusb can't open; tell the user the real fix; offer driver rebind. Skip the dead HID fallback for modern firmware.
3. **Host-side `UsbFlags\2B24*` cleanup** on install/repair (cause B, immediate remedy for poisoned machines).

**Next (1–2 wks):** unconditional single-instance lock (P2); bound all WebUSB transfers + real RPC timeouts (W2); `readTimeout()` for HID (H1); `clearHalt` direction fix (W1); Windows CI (P3).

**Deeper (firmware / architecture, wks):** MS OS 2.0 descriptors + version-derived `bcdDevice` (cause B durable fix); lengthen `usbReconnect` pulse (#11); selective-suspend/remote-wakeup (#1); out-of-process USB isolation + supervisor (E2).
