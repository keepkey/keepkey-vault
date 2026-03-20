# Windows Quirks — KeepKey Vault

Known Windows-specific issues, workarounds, and platform-gating patterns.
This document serves as a reference for anyone working on the Windows build.

---

## 1. Window Drag is Broken (Electrobun + WS_POPUP)

Electrobun's native `startWindowMove` doesn't work on Windows `WS_POPUP` frameless windows.
`setWindowPosition` FFI is also broken on WS_POPUP — only `setWindowFrame` works.

**Workaround**: Custom JS-driven drag via `useWindowDrag` hook — mousedown captures frame,
mousemove fires `windowSetFrame` RPC (fire-and-forget for smooth tracking).
macOS continues to use Electrobun's `-webkit-app-region: drag` CSS class.

**Files**: `src/mainview/hooks/useWindowDrag.ts`, `src/mainview/components/TopNav.tsx`

---

## 2. Window Resize is Broken

No native resize handles on frameless `WS_POPUP` windows.

**Workaround**: `WindowResizeHandles.tsx` — 8 invisible edge/corner hit-targets with
min size 600×400. Same `windowSetFrame` RPC approach as drag.

**Files**: `src/mainview/components/WindowResizeHandles.tsx`

---

## 3. Click Passthrough — Drag Swallows Clicks

Electrobun's drag detection uses aggressive raw-input tracking on Windows that swallows
all click events. A full-width `electrobun-webkit-app-region-drag` overlay on the nav
was blocking all tab/settings/button clicks.

**Fix**: Removed full-width drag overlay from windowControls. TopNav interactive elements
get `stopPropagation` on mousedown. Platform-gated: macOS keeps the CSS drag class,
Windows uses the JS `useWindowDrag` hook on the nav bar only.

**Files**: `src/mainview/components/TopNav.tsx`, `src/mainview/App.tsx`

---

## 4. Window Icon Shows Bun Logo

`setWindowIcon` FFI is a no-op on Windows — Electrobun never implemented it.
The taskbar and title bar show the Bun runtime icon instead of KeepKey's.

**Workaround**: Direct Win32 API calls via `bun:ffi` — `LoadImageW` + `SendMessageW`
with `WM_SETICON` on the HWND from `mainWindow.ptr`.

**Important**: The build script must copy a real `.ico` file (not a renamed PNG) so
`LoadImageW` can load it. `build-windows-production.ps1` handles this.

**Files**: `src/bun/index.ts`, `scripts/build-windows-production.ps1`

---

## 5. `file:` Linked Packages Break Dependency Collection

Bun leaves empty stubs in `node_modules/` for `file:` workspace deps (directory
containing only a nested `node_modules/` subfolder). The transitive dependency walker
in `collect-externals.ts` finds 0 deps for these packages.

**Fix**: `FILE_LINKED_PACKAGES` map resolves `file:` links to their actual source
directories before walking. This brought collected packages from 79 → 238.

**Files**: `scripts/collect-externals.ts`

---

## 6. Relocatability — Works in Dev, Hangs When Installed

Bun resolves `require()` by walking up the directory tree. The dev build tree always
has a parent `node_modules/` (the project's dev install). The installed location
(`AppData\Local\Programs\KeepKeyVault\`) has NO parent `node_modules/`.

**Packages wrongly stripped**: `rxjs`, `lodash`
**Packages never collected**: `protobufjs`, `libsodium-wrappers`, `@cosmjs/*`, etc.

**Fix**: Always test from the installed path. Keep `STRIP_DIRS` conservative. List all
`file:` deps in the EXTERNALS array.

```powershell
# Diagnose from installed location:
Set-Location 'C:\Users\bithi\AppData\Local\Programs\KeepKeyVault'
& '.\bin\bun.exe' run './Resources/app/bun/index.js'
# Error: Cannot find package 'rxjs' from '...'
```

---

## 7. PATH Separator

Windows uses `;` as PATH separator vs `:` on Unix. Any code that manipulates PATH
must use `path.delimiter` or platform-check.

---

## 8. `du -sk` Doesn't Exist on Windows

The `du` command is not available on Windows. Replaced with pure Node.js
`getDirSize()` using recursive `readdirSync` + `statSync`.

**Files**: `scripts/collect-externals.ts`

---

## 9. Prebuild Pruning Must Be Platform-Aware

Native addon prebuilds (e.g., `node-hid`, `usb`) ship binaries for all platforms.
The prune step must keep only `win32-x64` prebuilds on Windows and remove the rest
(darwin, linux). Incorrect pruning causes runtime crashes or silent failures.

**Files**: `scripts/collect-externals.ts`, `scripts/prune-app-bundle.ts`

---

## 10. Path Separators — No Hardcoded `/`

Use `path.sep` or `path.join()` everywhere. Hardcoded `/` in file paths breaks
on Windows. Also applies to glob patterns passed to Node.js APIs.

---

## 11. Opening URLs — `start` is a Shell Built-in

macOS: `open <url>`. Linux: `xdg-open <url>`.
Windows: `start` is a `cmd.exe` built-in, NOT an executable.
Must invoke as `cmd /c start "" <url>` (empty title required for URLs with `&`).

---

## 12. `__dirname` Not Available in ESM / Bun

ESM modules don't have `__dirname`. Use `import.meta.dir` (Bun-specific) or
the standard ESM polyfill:

```ts
import { fileURLToPath } from 'url'
import { dirname } from 'path'
const __dirname = dirname(fileURLToPath(import.meta.url))
```

**Files**: `vite.config.ts`, `src/bun/index.ts`

---

## 13. WebView2 Must Be Pre-installed

The app renders its UI via Microsoft WebView2. If WebView2 is not installed,
the app launches silently — no error, no window, no crash. Just nothing.

**Fix**: `installer.iss` always runs the WebView2 bootstrapper during installation.
The Inno Setup `[Run]` section downloads and installs it if missing.

**Files**: `scripts/installer.iss`

---

## 14. Build Folder: `build/` → `_build/`

Electrobun's default `build/` output folder caused conflicts (possibly with git
or other tooling). Changed to `_build/` across the entire build pipeline.

**Files**: `electrobun.config.ts`, `scripts/collect-externals.ts`,
`scripts/build-windows-production.ps1`, `Makefile`

---

## 15. `titleBarStyle: hidden` Breaks Keyboard on macOS

Setting `titleBarStyle: hidden` in Electrobun config broke keyboard input in
WKWebView on macOS. Had to revert and use a different approach for the frameless
window (traffic-light overlay + custom drag).

This is a macOS bug discovered during Windows work — noted here because the
frameless window approach affects both platforms.

---

## 16. USB Attach Event May Not Fire After Device Reboot (Windows 10)

On Windows 10, `usb.on('attach')` may not fire after the KeepKey device reboots
(e.g., after a firmware flash). The app would hang waiting for reconnection.

**Workaround**: Fallback polling — `syncState()` every 5 seconds while
`updatePhase === 'rebooting'` to detect the device via periodic scanning.

**Files**: `src/bun/engine-controller.ts` (line ~448)

---

## 17. Camera Capture is macOS Only

Camera/QR scanning spawns `ffmpeg -f avfoundation` which only works on macOS.
Windows and Linux get a graceful error: "Camera capture is currently only
supported on macOS."

**Files**: `src/bun/camera.ts`

---

## 18. Home Directory: `HOME` vs `USERPROFILE`

Unix uses `$HOME`, Windows uses `%USERPROFILE%`. Code that resolves `~` paths
(e.g., `~/.keepkey/`) must check both:

```ts
const home = process.env.HOME || process.env.USERPROFILE || ''
```

**Files**: `src/bun/db.ts`

---

## 19. File Manager Reveal is Platform-Specific

Opening the file manager to reveal an exported file requires different commands:

| Platform | Command |
|----------|---------|
| Windows  | `explorer <path>` |
| macOS    | `open -R <path>` |
| Linux    | `xdg-open <path>` |

**Files**: `src/bun/index.ts`

---

## 20. WebView2 Profile Locking in Dev Mode

WebView2 locks its user-data folder. Running multiple dev instances or
restarting quickly causes profile lock errors and silent failures.

**Workaround**: Dev script generates a unique WebView2 user-data folder per run
using a timestamp:

```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = "$LOCALAPPDATA\com.keepkey.vault\dev\webview2-$timestamp"
```

Also enables remote debugging on port 9222.

**Files**: `scripts/dev-hmr-windows.ps1`

---

## 21. HMR Port Cleanup on Windows

Vite HMR server on port 5173 can get orphaned on Windows (no automatic cleanup
on process exit). The dev script must find and kill stale processes:

```powershell
Get-NetTCPConnection -LocalPort 5173 | ... | Stop-Process -Force
```

Also kills any `*electrobun*` processes from prior runs.

**Files**: `scripts/dev-hmr-windows.ps1`

---

## 22. MAX_PATH (260 Chars) Breaks Recursive Submodule Init

Fully recursive `git submodule update --init --recursive` pulls firmware deps
with paths exceeding Windows' 260-character MAX_PATH limit.

**Workaround**: Selective submodule init — only pull the modules actually needed:

```powershell
git submodule update --init modules/hdwallet
git submodule update --init modules/proto-tx-builder
git submodule update --init modules/keepkey-firmware
```

**Files**: `scripts/build-windows-production.ps1`

---

## 23. `bun install` ENOENT Errors on Deeply Nested `file:` Deps

`bun install` exits non-zero due to ENOENT errors on deeply nested transitive
deps inside file-linked workspace packages. These deps aren't needed at build
time (`collect-externals` resolves them later).

**Workaround**: Temporarily relax PowerShell error handling:

```powershell
$ErrorActionPreference = 'Continue'
bun install
$ErrorActionPreference = 'Stop'
```

**Files**: `scripts/build-windows-production.ps1`

---

## 24. Zip Buffer Overflow (ENOBUFS) During Electrobun Bundle

Electrobun's Zig CLI uses Bun's `execSync` with a 1 MB `maxBuffer` to run
`zip -y -r -9 ...`. With 13K+ files in the bundle, stdout overflows.

**Workaround**: Two-pronged fix:
1. PATH shim script (`scripts/zip`) intercepts zip calls and adds `-q` (quiet)
2. `patch-electrobun.sh` patches Electrobun's CLI to add `-q` and increase
   `maxBuffer` to 50 MB

**Note**: The zip shim is a bash script — only works on Unix. Windows builds
use the patched Electrobun CLI directly.

**Files**: `scripts/zip`, `scripts/patch-electrobun.sh`, `scripts/build-signed.ts`

---

## 25. EV Code Signing Quirks

Windows EV code signing has several sharp edges:

- **Certificate discovery**: Must check both `Cert:\CurrentUser\My` and
  `Cert:\LocalMachine\My` — location depends on how the USB token driver installs it
- **`.node` files can't be signed**: `signtool` doesn't recognize native addon
  binaries (`.node`); they're skipped. May trigger SmartScreen warnings.
- **rcedit on `bun.exe`**: Skipped intentionally — running rcedit on the 113 MB
  Bun binary can corrupt it, and Bun runs headless anyway
- **Electrobun's rcedit call fails**: It hardcodes a CI path that doesn't exist
  locally; the build script runs rcedit manually on `launcher.exe` and the
  wrapper EXE only

**Files**: `scripts/build-windows-production.ps1`

---

## 26. Zig Wrapper Launcher — `CREATE_NO_WINDOW`

The KeepKey Vault EXE is a thin Zig wrapper (`wrapper-launcher.zig`) that
launches `bin/launcher.exe` via `CreateProcessW`. Key details:

- Uses `CREATE_NO_WINDOW` (0x08000000) flag to prevent a console flash
- Converts all paths to UTF-16LE for Win32 wide-char APIs
- Sets the working directory to the EXE's own directory
- Closes process/thread handles after spawn (fire-and-forget)

**Files**: `scripts/wrapper-launcher.zig`

---

## 27. No Spaces in Install Path

The install directory is `KeepKeyVault` (no spaces). Bun Workers silently fail
when the executable path contains spaces. Inno Setup uses `{autopf}\KeepKeyVault`.

**Files**: `scripts/installer.iss`, `package.json`

---

## 28. Installer Runs Without UAC Elevation

`PrivilegesRequired=lowest` — no admin rights needed. The app installs to the
user's local `Program Files` directory. Users can optionally choose to elevate
via `PrivilegesRequiredOverridesAllowed=dialog`.

Minimum Windows version: 10.0.17763 (Windows 10 1809, October 2018).

**Files**: `scripts/installer.iss`

---

## 29. `navigator.platform` is Deprecated

Frontend platform detection uses `navigator.platform?.startsWith('Win')` which
is deprecated. Currently works in all WebView2 versions but should be migrated
to `navigator.userAgentData.platform` with a fallback in the future.

**Files**: `src/mainview/lib/platform.ts`

---

## 30. Symlinks Must Be Dereferenced During Bundle Copy

`collect-externals.ts` uses `cpSync(src, dst, { dereference: true })` when
copying node_modules into the bundle. Without this, symlinks would point to
the dev tree (which won't exist on the user's machine). After pruning, a
second pass removes any dangling symlinks that survived.

**Files**: `scripts/collect-externals.ts`

---

## 31. PNG-to-ICO Conversion in Build Script

`app.ico` in the Electrobun build output is actually a renamed PNG (Electrobun
doesn't convert it). Win32's `LoadImageW` can't load PNGs as icons.

**Fix**: The build script uses `System.Drawing` to convert the PNG into a proper
multi-size ICO (16, 32, 48, 256px) with bicubic interpolation. Output is saved
as `app-real.ico` and then copied over `app.ico`.

**Files**: `scripts/build-windows-production.ps1`

---

## 32. "View in Explorer" Button Does Nothing

`window.open(url)` does not work in Electrobun's WebView2 on Windows — the
WebView2 security policy blocks navigation to external URLs. On macOS,
Electrobun's WKWebView handles `window.open` correctly.

**Workaround**: Use an RPC call to the Bun backend which calls
`Bun.spawn(['cmd', '/c', 'start', '', url])` to open the URL in the
system browser. The frontend should detect Windows and use RPC instead of
`window.open`.

**Status**: Known issue, not yet fixed. macOS works correctly.

**Files**: `src/mainview/components/AssetPage.tsx`, `src/mainview/components/ActivityPanel.tsx`

---

## 33. Application Menu Not Populated

On Windows, the Electrobun `ApplicationMenu` shows only the default entries
(Hide, Quit, Window minimize/close). No custom menu items are registered.
On macOS, the native menu bar is populated by Electrobun automatically.

**Status**: Cosmetic, low priority. The app is fully functional without menus.

**Files**: `src/bun/index.ts`
