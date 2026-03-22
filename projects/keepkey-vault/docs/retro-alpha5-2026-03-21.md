# ALPHA-5 Test Retrospective — 2026-03-21

Branch: `release-cycle` @ commit `b213f62`
Version: 1.2.6
Machine: Windows 11 Home 10.0.26200

---

## Results

### DEMO APP

1. **Did window appear?** YES
2. **MainWindowHandle:** `789222`
3. **ENTIRE contents of test-app.log:**

```
[2026-03-22T03:58:06.448Z] === TEST APP STARTING ===
[2026-03-22T03:58:06.450Z] platform: win32
[2026-03-22T03:58:06.450Z] pid: 37112
[2026-03-22T03:58:06.450Z] argv: ...\electrobun-test-dev\bin\bun.exe ...\Resources\app\bun\index.js
[2026-03-22T03:58:06.450Z] STAGE 1: importing electrobun/bun...
[2026-03-22T03:58:06.451Z] STAGE 1: OK
[2026-03-22T03:58:06.451Z] STAGE 2: creating BrowserWindow...
[2026-03-22T03:58:06.545Z] STAGE 2: BrowserWindow created
[2026-03-22T03:58:06.545Z] STAGE 3: importing node built-ins...
[2026-03-22T03:58:06.545Z] STAGE 3: OK — os.platform=win32 arch=x64
[2026-03-22T03:58:06.546Z] STAGE 4: trying native addon imports...
[2026-03-22T03:58:06.546Z] STAGE 4a: require('node-hid')...
[2026-03-22T03:58:06.626Z] STAGE 4a: OK — node-hid loaded, devices: 14
[2026-03-22T03:58:06.626Z] STAGE 4b: require('usb')...
[2026-03-22T03:58:06.636Z] STAGE 4b: OK — usb loaded
[2026-03-22T03:58:06.636Z] STAGE 4c: require('ethers')...
[2026-03-22T03:58:06.819Z] STAGE 4c: OK — ethers loaded, version: ethers/5.8.0
[2026-03-22T03:58:06.820Z] STAGE 4d: require('google-protobuf')...
[2026-03-22T03:58:06.823Z] STAGE 4d: OK — google-protobuf loaded
[2026-03-22T03:58:06.823Z] STAGE 4e: require('@keepkey/hdwallet-core')...
[2026-03-22T03:58:06.824Z] STAGE 4e: FAILED — Cannot find module '@keepkey/hdwallet-core'
[2026-03-22T03:58:06.824Z] STAGE 4f: require('@keepkey/device-protocol')...
[2026-03-22T03:58:06.824Z] STAGE 4f: FAILED — Cannot find module '@keepkey/device-protocol'
[2026-03-22T03:58:06.824Z] === IMPORT SUMMARY ===
[2026-03-22T03:58:06.824Z] node-hid: OK
[2026-03-22T03:58:06.825Z] usb: OK
[2026-03-22T03:58:06.825Z] ethers: OK
[2026-03-22T03:58:06.825Z] google-protobuf: OK
[2026-03-22T03:58:06.825Z] hdwallet-core: FAILED
[2026-03-22T03:58:06.825Z] device-protocol: FAILED
[2026-03-22T03:58:06.825Z] Window created: YES
[2026-03-22T03:58:06.825Z] === TEST APP READY ===
```

### VAULT DIRECT RUN

1. **stdout.txt:** empty
2. **stderr.txt:**
   ```
   error: Cannot find module '@keepkey/device-protocol/lib/messages_pb'
   from 'C:\Users\bithi\AppData\Local\Programs\KeepKeyVault\Resources\app\node_modules\@keepkey\hdwallet-keepkey\dist\keepkey.js'

   Bun v1.3.9 (Windows x64 baseline)
   ```
3. **Did a window appear?** NO
4. **MainWindowHandle:** Process crashed immediately (no state captured)
5. **backend.log:** NOT FOUND
6. **app.log:** NOT FOUND

---

## Final Classification

### Matrix Result

**Demo window + all core stages pass / Vault stdout shows exact crash**

### Root Cause: FOUND

```
Cannot find module '@keepkey/device-protocol/lib/messages_pb'
from '@keepkey/hdwallet-keepkey/dist/keepkey.js'
```

**`@keepkey/device-protocol/lib/messages_pb` is missing from the installed
`node_modules`.** The `hdwallet-keepkey` package imports it at load time.
Bun crashes immediately with an unhandled module resolution error. No
Electrobun code ever runs. No window is created. No logs are written.

This has been the root cause for ALL four previous alpha tests.

### Why It's Missing

The `@keepkey/device-protocol` package is a `file:` linked local package
(`modules/device-protocol`). The `collect-externals.ts` script copies it
into the build, but the `lib/` subdirectory containing the compiled
protobuf output (`messages_pb.js`, etc.) may not be present:

1. The `device-protocol` package needs to be built first (`bun run build`
   or similar) to generate `lib/messages_pb.js` from the `.proto` files.
2. If `collect-externals.ts` copies the source package before it's built,
   `lib/` will be missing or incomplete.
3. The `build-windows-production.ps1` script may not build
   `device-protocol` as a prerequisite.

### Why Previous Alphas Misdiagnosed This

- **ALPHA-1**: Blamed WebView2 cache (stale Vite hashes). Wrong —
  WebView2 never initialized because bun crashed on import.
- **ALPHA-2**: Blamed stale WebView2 profile. Wrong — same reason.
- **ALPHA-3**: Blamed native binary. Wrong — demo app proved native
  layer works.
- **ALPHA-4**: Correctly identified Vault-specific failure but didn't
  capture stderr to see the crash message.

The key insight: when Electrobun's bun process crashes during JS import
(before any Electrobun API calls), it produces NO visible output. No
window, no log, no error dialog. The process just exits silently. Only
by running bun directly with stderr capture do you see the error.

---

## Demo App Stage Results

All stages the demo tested passed except the `@keepkey` file-linked
packages (which failed due to `bun install` EPERM, not a packaging issue):

| Stage | Result | Notes |
|-------|--------|-------|
| electrobun/bun import | OK | |
| BrowserWindow creation | OK | MainWindowHandle=789222 |
| Node built-ins (os, path) | OK | |
| node-hid | OK | 14 devices found |
| usb | OK | |
| ethers | OK | v5.8.0 |
| google-protobuf | OK | |
| @keepkey/hdwallet-core | FAILED | Not installed (EPERM) |
| @keepkey/device-protocol | FAILED | Not installed (EPERM) |

---

## Fix

Ensure `@keepkey/device-protocol/lib/messages_pb.js` exists in the
installed `node_modules` at:

```
%LOCALAPPDATA%\Programs\KeepKeyVault\Resources\app\node_modules\
  @keepkey\device-protocol\lib\messages_pb.js
```

Options:

1. **Build device-protocol before collect-externals** — add a build step
   for `modules/device-protocol` in the production build script.

2. **Check collect-externals.ts** — verify it copies the `lib/` directory
   from the built device-protocol, not just the source.

3. **Verify the file exists in the build output** before running the
   installer:
   ```powershell
   Test-Path "projects\keepkey-vault\_build\...\node_modules\@keepkey\device-protocol\lib\messages_pb.js"
   ```
