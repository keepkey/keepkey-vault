# Handoff from support triage — 2026-11-11

Source: support DB (tickets + chats, last ~3 weeks), plus a diagnostic report the owner pasted. Customer identities left out on purpose.

## 1. macOS: app won't quit (ticket 6af1ff4e…, 2026-11-09)
- "latest version of KeepKey Vault on MacOS 15.8 will not quit. Requires force quit."
- App version not stated; "latest" = 1.6.4 at the time (confirm).
- Where to look: `projects/keepkey-vault/src/bun/index.ts` cleanup/quit helper (~line 11824, "Cleanup and quit helper"). Likely suspects: a cleanup step that never resolves (USB release, zcash sidecar shutdown, open server on 1646, pending device call), so the process never exits. Cmd+Q and menu Quit should go through the same path as window close.
- Repro: macOS 15.x, launch, (connect device, maybe leave a wallet sync running), Cmd+Q. Check whether it hangs with and without a device connected.
- Suggested fix shape: a hard timeout on cleanup that ends in `process.exit` no matter what.

## 2. Windows: device "not-present" (diagnostic report, 2026-11-09)
```
App: 1.6.1  OS: win32 10.0.26200 (x64, Windows 11 24H2/25H2 build)
Visible to app (libusb): no   Windows PnP present: no   Bound driver: none
MS OS cache (osvc): 00 00     Likely cause: not-present
```
- PnP doesn't see the device at all, so it's below the app: the cable, port, or device. It could also be a device stuck in a state that doesn't enumerate.
- They're on 1.6.1, not the current release. Ask them to update, but that won't fix a device that PnP can't see.
- Gap to look at: the report can't tell "nothing plugged in" apart from "plugged in but enumeration failed" (Device Manager "Unknown USB Device (Device Descriptor Request Failed)" / code 43). If `windows-usb-probe.ts` can detect failed-enumeration nodes (VID 0000/PID 0002 problem devices), that changes the advice from "swap the cable" to "the device or bootloader needs attention". See existing docs: `docs/WINDOWS-USB-AUDIT.md`, `docs/WINDOWS-USB-FIX-PLAN.md`.

## 3. Related device issues (not confirmed as app bugs)
- **macOS, 1.6.4, fw 7.14.2, bl 2.1.4** (ticket 6ada38f1…, 2026-10-22): after the wrong-PIN wait ends, "Forgot your PIN? Wipe device" shows no wipe confirmation on the device. The wait timer also survives reconnecting. Worth reproducing. It could be the app sending WipeDevice while the device is still in the PIN-delay state.
- **Windows 11** (chats 2026-10-26, several in a row, same user): restore says "invalid" after all 12 words get check marks, across 2 PCs, after 6 wipes. Most likely a wrong word (BIP39 checksum failure), but check that the restore flow's error makes that clear.
- A chat on 2026-11-01 says a secondhand device isn't detected while old KeepKey software is still installed. That's a known cause; see WINDOWS-QUIRKS.

## 4. Not for the vault agent
- Tickets saying "BTC shows in history but balance is 0" (×3, 10-31 → 11-06) are the Pioneer UTXO history-value bug, which has its own ticket and isn't a vault bug.
- Litecoin funds on custom paths (ticket 6ae812b9…): the Audit view's "Send to support →" link doesn't go anywhere. **That one IS a vault UI bug**, a small fix.
