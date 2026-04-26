# Handoff — finishing the 7.15 emulator work

**Branch:** `feat/emu-wallet-metadata` (pushed to `origin`, 12 commits on top of `develop`)
**Status:** boots, loads, dashboard renders. **Send is still broken. OLED preview shows no real data.** Two specific things below are the hard blockers; the rest is polish.

---

## Where we are

**Working end-to-end:**
- Add a new emulator from the bottom-right pill → spawns fresh emu on alpha channel → engine connects → state=`needs_init` → `OobSetupWizard` mounts → user picks Create/Recover → seed loads → state=`ready` → Dashboard renders.
- App restart with a saved emu wallet: stale-storage detection → wipe + auto-reload mnemonic from Keychain → state=`ready` → Dashboard.
- Per-wallet metadata persists: label, firmware version, channel, USD total all surface on the splash device cards alongside real KeepKeys.

**The 12 commits on this branch** got us from "won't even start the emu" through SIGTRAP/SIGBUS/SIGKILL crashes to "boots and looks right." Memory file `~/.claude/projects/-Users-highlander-…/memory/emu-7.15-debugging.md` has the full bug-by-bug story; read that first before debugging anything emu-related.

---

## What still doesn't work

### 🔴 BLOCKER 1 — Sending crashes the app

User reproduction:
1. Boot vault, load a seeded emu wallet, dashboard shows balances
2. Try to send a transaction (Solana SOL native transfer in the user's case)
3. Backend log:
   ```
   [solanaSignTx] RPC call received
   [solanaSignTx] legacy — fullTx=215B sigCount=1 messageStart=65
   [emu-window] 3 chunks written, polling 2 pre-polls
   [emu-window] Waiting for user confirmation (id=69c2a819...)
   [emu-window] No emulator window — rejecting (fail closed)
   [emu-window] User responded: approved=false
   Child process terminated by signal: 9
   ```

**Two distinct bugs in this trace:**

**1a. Emulator window goes missing between dashboard mount and sign click.**
Commit `ddd0a03` partially addressed this — `requestUserConfirm` now auto-reopens the window if `emuWindow` is null. **Not yet retested by the user**; the first thing to do is verify the auto-reopen path actually works. If it does, sign should at least show the confirm dialog.

If auto-reopen doesn't work, the deeper question is: **why is `emuWindow` null after the dashboard loads?** The window is opened by `emulatorInit` / `emulatorSwitchWallet` and only torn down by explicit close handlers. Something is clearing the `emuWindow` reference. Suspects:
- Wizard transitions calling `closeEmulatorWindow` somewhere (grep `closeEmulatorWindow` callers in `src/bun/index.ts` — there are several in setup paths)
- The `BrowserWindow.on('close')` handler firing because the user closed the window manually after onboarding
- `emulatorImportWallet` (RPC handler at `index.ts:3560-3680`) closes + reopens — race possible

**1b. SIGKILL after the signing op resolves to `approved=false`.**
This is the watchdog firing again, but the timing is suspicious — `User responded: approved=false` should have triggered an immediate Cancel send to the firmware, then the sign op rejects on the JS side, transport returns an error, RPC returns. No reason for `kkemu_poll` to busy-loop here.

Hypothesis: when the vault rejects (sends `Cancel` over iface 0), the firmware's `confirm_helper` exits with `ret_stat=false` → `fsm_msgSolanaSignTx` returns `Failure` → vault's hdwallet transport reads it → done. But maybe the vault doesn't actually send `Cancel` — it just resolves the JS promise locally with false. The firmware then sits in confirm_helper waiting for BA/DLD that never come, kkemu_poll busy-loops, watchdog fires. Look at `src/bun/emulator-window.ts:requestUserConfirm` rejection path and check whether it actually writes a Cancel frame to iface 0.

**Quickest path to confirming this:** run the user's flow with the just-bundled `ddd0a03` and capture the new log. If "No emulator window" is gone but the sign still hangs, it's bug 1b. If it shows the confirm dialog and the user clicks Reject, then it's clearly 1b.

### 🔴 BLOCKER 2 — OLED preview never shows real device output

User reports: "I still have yet to see any real data in the emulator preview." Throughout the entire flow — boot, wipe, load, post-load — the emu window only ever shows static placeholder UI (the lock/unlock icon was the only thing visible). The actual firmware-rendered OLED framebuffer is supposed to be drawn into the canvas via the `display-update` packets.

**Plumbing summary:**
- `src/bun/emulator.ts:emuGetDisplay()` calls `kkemu_get_display` and copies the framebuffer into a Uint8Array.
- `src/bun/emulator-window.ts:startDisplayPoll()` runs every 66ms (`~15 fps`), fetches the framebuffer, base64-encodes it, sends to the webview via `sendToWindow('display-update', { fb, w, h })`.
- The webview's `onDisplayUpdate(data)` decodes base64 and renders into a 256×64 canvas using SSD1306 page format (8 pages × 256 cols, each byte = 8 vertical pixels).

**What to check first:**
1. Is `kkemu_get_display` actually returning a non-null pointer with `w=256, h=64`? My isolated dylib test did show `fbPtr=4394017601 w=256 h=64` and the first 8 bytes were `00 00 00 00 00 00 00 00` — meaning the framebuffer existed but was all-zeros at that moment. **The firmware may simply not be drawing anything to the OLED in the dylib build.**
2. Is the `display-update` packet actually reaching the webview? Add a `console.log('[emu-ui] onDisplayUpdate w=' + data.w + ' h=' + data.h)` in `emulator-window.ts:onDisplayUpdate` (the inline webview HTML, line ~615) and watch the webview devtools. If you see them, the issue is on the canvas-render side; if not, it's on the bun-send side (`viewReady` race? `sendToWindow` dropping them?).
3. Even if the framebuffer is being delivered, the SSD1306 page-format decoder might be wrong for the 7.15 dylib's framebuffer layout. The 7.10 dylib returned `NULL` early so this code path was never exercised; nobody's verified it actually draws correctly.

**The lock/unlock icon the user sees is purely the placeholder UI** in the webview HTML (`oled.innerHTML = '<div class="idle-text">KeepKey Emulator Ready</div>'` and similar). Real frames would replace it via the `hasRealDisplay = true` branch.

---

## What's solid (don't waste time re-debugging)

These were all chased down already and have memory + commit messages:

- **Webview ready handshake** (`9ce826d`): `executeJavascript` no longer races the WKWebView's first paint.
- **Bun `toBuffer` GC bug** (`268f0cb`): `toArrayBuffer().slice()` everywhere.
- **`KK_DEBUG_LINK=ON` cmake flag** (`19d4011`): the actual fix for the confirm-flow hang. Without this, `msg_read_tiny` doesn't recognize `DebugLinkDecision`, confirm_helper busy-loops, watchdog SIGKILLs.
- **Watchdog 60s** (`9b7126a`): old 15s default was too tight for 7.15's slower derivation paths. Don't lower it back.
- **3s deadlines on DebugLink seed verifies** (`da814f2`, `8ce8962`): cosmetic; they hang on the dylib path. Removing them re-introduces the wizard/dashboard hangs.

---

## Out-of-scope but worth flagging

- **Zcash Orchard on emu** — user said explicitly out of scope. Separate branch.
- **DebugLink reads hang on dylib** — root cause of the timeouts above. If fixed, the workarounds can come out. Likely a poll-thread / interleaving issue in the dylib (`libkkemu.c` ringbuffer logic).
- **python-keepkey reactive flow deadlocks the dylib** — `BitHighlander/python-keepkey @ feat/dylib-transport` has scaffolding (`DylibTransport`, `tests/test_dylib_confirm_flow.py`) that reproduces it deterministically in <30s. Real fix is the same poll-thread in the dylib.
- **`getBalances` per-chain timing instrumented** (`9b7126a`) but not yet diagnosed. Watch for `[getBalances] <chain>.<method> took XXXms` lines >2s.
- **Bundled-vs-user-installed emu drag-and-drop UX** — sketched in an earlier conversation. Out of scope for this branch.

---

## Repro environment

```bash
# From repo root:
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11

# Make sure submodule is on the right firmware
git -C modules/keepkey-firmware log --oneline -1     # should be f8fee570 on alpha

# Build/start dev
make dev    # = bun run dev — re-bundles backend + frontend, launches Electrobun

# Re-build the emulator dylib if you change firmware:
make build-emulator-alpha    # honors the new -DKK_DEBUG_LINK=ON via the patched _build-emu rule
```

The emulator binary + dylib live at `firmware/emulators/7.15.0-alpha/`. They're committed. Don't delete and re-build unless you've changed firmware code.

For diagnosing firmware-contract issues *without* electrobun in the loop:

```bash
cd modules/keepkey-firmware/deps/python-keepkey/tests
PYTHONPATH=..:../keepkeylib \
  KK_TRANSPORT=dylib \
  KK_DYLIB=$PWD/../../../../../../firmware/emulators/7.15.0-alpha/libkkemu.dylib \
  PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python \
  python3 -m pytest test_dylib_confirm_flow.py -v
```

`Initialize` → `Features` round-trips. Anything that needs reactive ButtonAck currently hangs (out-of-scope dylib bug, not new).

---

## Recommended sequence for the next session

1. **Verify `ddd0a03` actually fixed the missing-window** — pull, restart, try a send. If the confirm dialog appears, decline it and watch what happens.
2. **If decline → SIGKILL: fix the Cancel-not-sent path in `requestUserConfirm`.** The vault should write a `Cancel` (msg type 20) frame to iface 0 when the user rejects, so the firmware's `confirm_helper` can exit cleanly.
3. **If decline → clean failure but still no OLED preview: instrument `onDisplayUpdate` in the webview HTML.** First confirm packets arrive at all. Then verify the framebuffer bytes look like a real OLED frame (mostly non-zero in the bottom rows where text usually lives).
4. **If display packets aren't arriving: check the firmware actually drives the OLED in the dylib build.** Memory note from earlier sessions said `force_animation_start()` and `animate()` overwrites get involved, and that the 7.10 dylib returned NULL for `kkemu_get_display`. The 7.15 dylib returns a buffer but it may be all-zeros if `display_refresh()` isn't being called from `kkemu_poll`.
5. **Once send + display work, the branch is reviewable.** Open the PR.

Treat the existing 12 commits as foundation. The two remaining bugs are stop-the-show; the rest is post-merge polish.
