# Windows Build Pipeline

## Overview

The Windows build for KeepKey Vault has **two paths**:

1. **Dev build**: `bun run build` — builds the app for local testing
2. **Production build**: `scripts/build-windows-production.ps1` — builds, signs, and creates an installer

Both produce the same directory structure, but production adds code signing and Inno Setup packaging.

---

## Dev Build (`bun run build`)

### What Runs

```bash
# From package.json "build" script:
vite build && bun scripts/collect-externals.ts && electrobun build
```

Three sequential steps:

```
Step 1: vite build
  └── Compiles React UI → dist/index.html + dist/assets/

Step 2: bun scripts/collect-externals.ts
  └── Collects ~180 npm packages → build/_ext_modules/

Step 3: electrobun build
  ├── Compiles src/bun/index.ts → Resources/app/bun/index.js (target: "bun")
  ├── Copies dist/* → Resources/app/views/mainview/
  ├── Copies build/_ext_modules → Resources/app/node_modules/
  ├── Copies bin/launcher.exe, bun.exe, libNativeWrapper.dll
  └── Generates version.json, build.json
```

### Output Location

```
projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev/
```

### Expected Behavior

```bash
# Run from the build directory:
cd projects/keepkey-vault/build/dev-win-x64/keepkey-vault-dev/
./bin/launcher.exe

# Expected: Window opens with KeepKey Vault UI
# The launcher sets CWD to its own directory, finds Resources/ relative to itself
```

---

## Production Build (`build-windows-production.ps1`)

### Prerequisites

| Tool | Purpose | Install |
|------|---------|---------|
| SignTool | Code signing (Authenticode) | Windows SDK 10.0.26100.0 |
| Inno Setup 6 | Installer creation | `winget install JRSoftware.InnoSetup` |
| Zig | Compile wrapper-launcher.zig | `winget install zig.zig` |
| Bun | Build toolchain | Already installed |
| Yarn | Build hdwallet monorepo | Already installed |
| Sectigo EV cert | Code signing certificate | USB token required |

### Certificate Setup

The script expects a Sectigo EV code signing certificate with thumbprint:
```
986AEBA61CF6616393E74D8CBD3A09E836213BAA
```

The certificate must be in the Windows certificate store (CurrentUser\My or LocalMachine\My). For EV certificates, the USB hardware token must be connected.

### Full Pipeline

```powershell
# Run from repo root:
.\scripts\build-windows-production.ps1

# Optional flags:
.\scripts\build-windows-production.ps1 -SkipBuild    # Reuse existing build
.\scripts\build-windows-production.ps1 -SkipSign     # Skip code signing (testing)
.\scripts\build-windows-production.ps1 -Thumbprint "YOUR_CERT_THUMBPRINT"
```

### Step-by-Step Breakdown

#### 1. Pre-flight Checks
```powershell
# Verifies:
# - SignTool exists at: C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe
# - Inno Setup ISCC.exe found
# - git, bun, yarn in PATH
# - Certificate found and not expiring within 30 days
```

#### 2. Build Submodules & Dependencies
```powershell
git submodule update --init --recursive

# Build proto-tx-builder (Cosmos transaction builder)
cd modules/proto-tx-builder && bun install

# Build hdwallet (hardware wallet SDK)
cd modules/hdwallet && yarn install && yarn build

# Install keepkey-vault dependencies
cd projects/keepkey-vault && bun install
```

#### 3. Build the App
```powershell
cd projects/keepkey-vault
bun run build
# This runs: vite build && bun scripts/collect-externals.ts && electrobun build
```

#### 4. Code Sign All Binaries
```powershell
# Signs every .exe and .dll in bin/ and Resources/
# Skips .node files (native modules — not signable via Authenticode)

signtool sign /sha1 986AEBA61CF6616393E74D8CBD3A09E836213BAA /fd sha256 /tr http://timestamp.digicert.com /td sha256 <file>
```

**Files signed:**
- `bin/launcher.exe`
- `bin/bun.exe`
- `bin/libNativeWrapper.dll`
- `bin/WebView2Loader.dll`
- All `.dll` files in `Resources/` (native modules)
- `KeepKey Vault.exe` (wrapper)

**Files NOT signed:**
- `.node` files — native Node.js addon format, not recognized by SignTool
- `.js` files — not binary executables

#### 5. Convert Icon (PNG → ICO)
```powershell
# Electrobun outputs app.ico which is actually a PNG (wrong format)
# Script converts to proper multi-resolution ICO: 16x16, 32x32, 48x48, 256x256
# Output: Resources/app-real.ico
```

This is a known quirk — Electrobun's icon handling on Windows outputs a PNG with `.ico` extension. The production script fixes this using System.Drawing.

#### 6. Build Wrapper EXE
```powershell
# Compiles scripts/wrapper-launcher.zig → "KeepKey Vault.exe"
zig build-exe wrapper-launcher.zig -O ReleaseSmall --subsystem windows -femit-bin="KeepKey Vault.exe"
```

**Why the wrapper exists**: Electrobun's `launcher.exe` is a generic name. The wrapper:
- Has a branded name ("KeepKey Vault.exe")
- Uses Windows subsystem (no console window)
- Sets CWD to its own directory before calling `bin/launcher.exe`

```zig
// scripts/wrapper-launcher.zig — simplified logic:
pub fn main() !void {
    const exe_dir = std.fs.selfExeDirPath(&buf);
    const launcher_path = join(exe_dir, "bin", "launcher.exe");

    CreateProcessW(
        null,           // use command line
        launcher_path,  // "C:\...\bin\launcher.exe"
        null, null,
        0, 0, null,
        exe_dir,        // ← CWD set to app root (CRITICAL for DLL loading)
        &si, &pi,
    );
}
```

#### 7. Create Installer (Inno Setup)
```powershell
ISCC /DMyAppVersion=1.0.0 /DMySourceDir=<build_dir> /DMyOutputDir=release-windows installer.iss
```

**Installer configuration** (`scripts/installer.iss`):
```ini
[Setup]
AppId={{B8E3F2A1-5C7D-4E9F-A1B2-3C4D5E6F7A8B}
AppName=KeepKey Vault
DefaultDirName={autopf}\KeepKey Vault    ; → C:\Program Files\KeepKey Vault
Compression=lzma2
MinVersion=10.0.17763                     ; Windows 10 1809+
ArchitecturesAllowed=x64compatible
PrivilegesRequired=lowest                 ; No admin required (with override option)

[Files]
; Copies entire app structure preserving directory layout:
Source: "KeepKey Vault.exe";  DestDir: "{app}"
Source: "bin\*";              DestDir: "{app}\bin"          ; recursive
Source: "Resources\*";        DestDir: "{app}\Resources"    ; recursive

[Icons]
; Start menu + optional desktop shortcut

[Run]
; Auto-launch after install
```

**Installed directory structure:**
```
C:\Program Files\KeepKey Vault\
├── KeepKey Vault.exe          ← Entry point
├── bin\
│   ├── launcher.exe
│   ├── bun.exe
│   ├── libNativeWrapper.dll
│   └── WebView2Loader.dll
├── Resources\
│   ├── app\
│   │   ├── bun\index.js
│   │   ├── views\mainview\
│   │   └── node_modules\
│   ├── app-real.ico
│   └── version.json
└── unins000.exe               ← Inno Setup uninstaller
```

#### 8. Sign the Installer
```powershell
signtool sign /sha1 <thumbprint> /fd sha256 /tr http://timestamp.digicert.com /td sha256 /d "KeepKey Vault Installer" KeepKey-Vault-1.0.0-win-x64-setup.exe
```

#### 9. Generate Checksums
```
release-windows/
├── KeepKey-Vault-1.0.0-win-x64-setup.exe  (~38 MB)
└── SHA256SUMS.txt
```

---

## The `build-signed.ts` Wrapper

Electrobun's CLI uses `Bun.spawnSync()` with a 1MB `maxBuffer` to run `zip` commands. When the app bundle has 13K+ files (all those node_modules), the zip output overflows the buffer and crashes.

```typescript
// scripts/build-signed.ts
// Puts a quiet-zip shim on PATH before invoking electrobun build

const scriptsDir = join(import.meta.dir)
const currentPath = process.env.PATH || ''

Bun.spawnSync(
    ['electrobun', 'build', `--env=${env}`],
    {
        env: {
            ...process.env,
            // Prepend scripts/ to PATH so our `zip` shim is found first
            PATH: `${scriptsDir}${process.platform === 'win32' ? ';' : ':'}${currentPath}`,
        },
    }
)
```

The `scripts/zip` shim adds `-q` (quiet) flag to suppress per-file output, keeping stdout under the 1MB limit.

---

## Windows-Specific Code Fixes in KeepKey Vault

### 1. PATH Separator (`build-signed.ts`)
```typescript
// Windows uses ; to separate PATH entries, Unix uses :
PATH: `${scriptsDir}${process.platform === 'win32' ? ';' : ':'}${currentPath}`
```

### 2. URL Opening (`src/bun/index.ts:838-844`)
```typescript
if (process.platform === 'win32') {
    // 'start' is a shell built-in on Windows, must use cmd.exe
    Bun.spawn(['cmd', '/c', 'start', '', parsed.href])
} else {
    const cmd = process.platform === 'linux' ? 'xdg-open' : 'open'
    Bun.spawn([cmd, parsed.href])
}
```

### 3. `import.meta.dir` Instead of `__dirname` (`src/bun/rest-api.ts`)
```typescript
// __dirname doesn't exist in ESM. import.meta.dir is the Bun equivalent.
const swaggerPath = join(import.meta.dir, 'swagger.json')
```

### 4. Cross-Platform `du` (`scripts/collect-externals.ts`)
```typescript
// du command doesn't exist on Windows. Use recursive statSync instead.
function getDirSize(dirPath: string): number {
    let size = 0
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.isDirectory()) size += getDirSize(join(dirPath, entry.name))
        else size += statSync(join(dirPath, entry.name)).size
    }
    return size
}
```

### 5. Platform Prebuild Pruning (`scripts/collect-externals.ts:230-234`)
```typescript
// Remove native prebuilds for other platforms to reduce bundle size
const REMOVE_PREBUILD_PREFIXES = isWindows
    ? ['linux', 'darwin', 'android']  // On Windows, remove Linux/Mac/Android
    : isMac
        ? ['linux', 'win32', 'android']
        : ['darwin', 'win32', 'android']
```

---

## Dev Mode with HMR (`dev-hmr-windows.ps1`)

For development with hot module replacement:

```powershell
.\scripts\dev-hmr-windows.ps1
```

This script:
1. Kills any existing processes on port 5173 and any electrobun processes
2. Creates a unique WebView2 user data folder (avoids locked profile bugs):
   ```
   %LOCALAPPDATA%\com.keepkey.vault\dev\webview2-{timestamp}
   ```
3. Starts Vite HMR server on port 5173
4. Waits up to 20 seconds for the port to bind
5. Builds the app (`bun run build`)
6. Launches `electrobun dev`
7. Cleans up on exit

**Expected behavior**: Changes to React components in `src/mainview/` hot-reload in the webview. Changes to `src/bun/` require a full rebuild.

---

## Why NOT MSIX

Electrobun does **not** use MSIX packaging. On Windows it uses either:
- **Self-extracting EXE** (Electrobun's built-in): Setup.exe + tar.zst archive
- **Inno Setup** (KeepKey's choice): Traditional installer EXE with proper Add/Remove Programs integration

MSIX was attempted but has problems:
- Requires Microsoft Store certification or sideloading configuration
- Sandboxing can interfere with USB device access (node-hid, usb)
- More complex signing requirements (separate from Authenticode)
- The Inno Setup approach is simpler and provides the same UX

---

## Signing Summary

| What | How | When |
|------|-----|------|
| macOS app bundle | `codesign` + Apple notarization | `build:stable` / `build:canary` |
| macOS native modules | `codesign` via collect-externals.ts | During dependency collection |
| Windows EXE/DLL | SignTool + Sectigo EV certificate | `build-windows-production.ps1` |
| Windows installer | SignTool + Sectigo EV certificate | After Inno Setup compilation |
| Windows .node files | NOT signed (SignTool doesn't support) | Skipped |
| Linux | NOT signed | N/A |

### SmartScreen Note

Windows SmartScreen reputation builds over time with EV certificates. The first few downloads may show a "Windows protected your PC" warning. After enough successful downloads, SmartScreen will recognize the publisher and stop showing warnings.
