# ALPHA-4 Test Retrospective — 2026-03-21

Branch: `release-cycle` @ commit `2339b32`
Version: 1.2.6 (Vault), 0.0.1 (Demo)
Machine: Windows 11 Home 10.0.26200

---

## PART 5: Report

### Vault

1. **Did the Vault installer finish?** YES
2. **Did the Vault splash screen appear?** NO
3. **Did the Vault main window appear?** NO
4. **Vault MainWindowHandle:** `0` (bun PID=14640), `0` (launcher PID=17544)
5. **Vault app.log has NEW entries?** NO — app.log DOES NOT EXIST
6. **Vault backend.log has content?** NO — backend.log DOES NOT EXIST
7. **JS filenames on disk:** `index.js`, `asset-data.js`, `index.css`, locale files, images (all unhashed, correct)
8. **index.html references:** `<script type="module" crossorigin src="./assets/index.js"></script>`

### Demo App

9. **Did the demo app window appear?** YES
10. **Demo MainWindowHandle:** `7670112` (bun PID=43096)
11. **Log files created?** YES — `app.log` (614 bytes, created 22:43:52)
12. **Does the demo app prove Electrobun can open a window on this machine?** YES

### Final Classification

13. **Matrix result: Vault FAIL / Demo PASS**

14. **Narrowest correct conclusion:**
    KeepKey-specific packaging, cache, or runtime path is broken.
    The machine and Electrobun native layer are fine — proven by the demo app
    creating a WebView2 window (MainWindowHandle=7670112) and generating
    app.log. The problem is specific to the KeepKey Vault app configuration,
    build output, or bun/index.js runtime initialization path.

---

## Evidence Comparison

| Evidence | Vault | Demo App |
|----------|-------|----------|
| MainWindowHandle | 0 | 7670112 |
| app.log | NOT FOUND | 614 bytes |
| backend.log | NOT FOUND | N/A |
| WebView2 profile created | NO (`com.keepkey.vault` absent) | YES (`com.keepkey.electrobun-test\dev\WebView2`) |
| Processes running | YES (bun + launcher) | YES (bun + launcher) |
| Window visible | NO | YES |

---

## What This Rules Out

- **Machine is fine.** Windows 11 build 10.0.26200 can run Electrobun + WebView2.
- **Electrobun native layer is fine.** `libNativeWrapper.dll` and `WebView2Loader.dll` work.
- **WebView2 Runtime is fine.** The runtime initializes and creates windows.
- **ALPHA-3's conclusion was wrong.** "Native binary broken" was incorrect.

## What This Points To

The failure is in the KeepKey Vault-specific path between:
- `launcher.exe` starting `bun.exe`
- `bun.exe` executing `Resources/app/bun/index.js`
- `index.js` calling Electrobun APIs to create the webview window

Something in this chain hangs or fails silently BEFORE WebView2
initialization. The demo app skips most of this complexity — it has
a minimal `index.js` and no external dependencies.

### Likely suspects (narrowed)

1. **`Resources/app/bun/index.js` crashes or hangs on import.**
   The Vault's bun entry point imports 286 external packages including
   native addons (`node-hid`, `usb`, `secp256k1`, `keccak`, etc.).
   Any of these could hang on import, crash silently, or block the
   event loop before Electrobun gets to create the WebView2 window.

2. **Electrobun config differences.** The Vault's `electrobun.config.ts`
   has significantly more configuration than the demo's minimal config.
   A misconfiguration could cause silent failure.

3. **The `main.js` / `Resources/main.js` entrypoint.** Electrobun reads
   `Resources/main.js` as the native-side entry point. If this file has
   issues specific to the Vault build, it would fail before `bun/index.js`.

4. **Bun network access warning.** User noted a "bun warning for network
   access" when launching the demo. If the Vault's bun process triggers
   a similar firewall/network prompt and the user doesn't see it (because
   no window is visible), bun might be blocked waiting for network
   permission, which could hang Electrobun initialization.

### Recommended next steps

1. **Run Vault's bun/index.js directly** to see stdout/stderr:
   ```powershell
   & "$env:LOCALAPPDATA\Programs\KeepKeyVault\bin\bun.exe" run "$env:LOCALAPPDATA\Programs\KeepKeyVault\Resources\app\bun\index.js" 2>&1 | Tee-Object -FilePath "$env:USERPROFILE\Desktop\vault-stdout.txt"
   ```

2. **Compare electrobun.config.ts** between Vault and demo app for
   any setting that could cause silent failure.

3. **Check Windows Firewall** for bun.exe rules — the demo may have
   been allowed while the installed Vault's bun.exe hasn't been prompted.

4. **Try launching Vault from the demo app's directory structure** —
   copy Vault's views and bun entry into the demo app's build output
   to isolate whether it's the code or the packaging.

---

## Build Notes

- Vault: Built, EV-signed, 50.8 MB installer. Clean asset filenames confirmed.
- Demo: Built with workaround (copied electrobun.exe from main project cache
  due to tar extraction failure on Windows). `launcher.exe` produced
  successfully despite `failed to copy \0` warning.
- Demo app used electrobun v1.13.1 (same as main project).

---

## Decision Matrix Result

```
Vault FAIL / Demo PASS
→ KeepKey-specific packaging, cache, or runtime path is broken.
→ Machine and native layer proven working.
→ Investigation should focus on Vault's bun/index.js, electrobun config,
  and the 286-package dependency tree.
```
