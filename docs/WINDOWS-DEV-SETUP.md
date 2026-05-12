# Windows Dev Setup — From Zero

First-time setup of a Windows machine to build and run KeepKey Vault locally. This is the "I just got a Windows box" doc — every package and registry change is listed explicitly. Read top to bottom.

For day-to-day dev workflow once setup is done, see [`WINDOWS-DEV-MODE.md`](./WINDOWS-DEV-MODE.md). To cut a signed release, see [`WINDOWS-BUILD-AND-SIGN.md`](./WINDOWS-BUILD-AND-SIGN.md). For platform gotchas reference, see [`WINDOWS-QUIRKS.md`](./WINDOWS-QUIRKS.md).

---

## What you'll have at the end

A Windows machine that can:
- Clone `keepkey-vault` and all submodules
- Run `bun run dev:hmr:win` to launch a dev build with HMR
- Run `.\scripts\build-windows-production.ps1 -SkipSign` to produce an unsigned installer
- (Optionally) sign + ship a real release if you have access to the EV cert and token

Estimated time: **60–90 minutes** on a fresh Windows 11 box with good internet. Most of that is downloads.

---

## 0. Baseline requirements

- **Windows 10 build 17763+ or Windows 11 x64**. Windows 10 needs WebView2 Runtime; Windows 11 has it pre-installed.
- **Administrator access** on the machine. Several installs and a registry tweak require it.
- **At least 30 GB free disk space**. The repo + submodules + `node_modules` + Rust target dirs add up.
- **A working `winget`**. Pre-installed on Win11 and modern Win10. If `winget --version` errors, install "App Installer" from the Microsoft Store first.

> Open an **Administrator PowerShell** for the install steps. Right-click the PowerShell icon → "Run as administrator". You'll know it worked when the title bar says "Administrator: Windows PowerShell".

---

## 1. Enable long paths

Windows defaults to a 260-character path limit (MAX_PATH). The keepkey-vault repo has nested `node_modules` paths that blow past this. Submodule cloning will fail or silently truncate without long-path support.

```powershell
# 1a. NTFS long paths (registry — system-wide, requires admin)
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force | Out-Null

# 1b. Git long paths
git config --system core.longpaths true
```

A reboot is recommended after step 1a — some processes cache the old policy.

---

## 2. PowerShell execution policy

The build/dev scripts are unsigned `.ps1` files. The default `Restricted` policy refuses to run them.

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Verify with `Get-ExecutionPolicy -Scope CurrentUser` — should print `RemoteSigned`.

---

## 3. Core tools (via winget)

Run each in order. Each command is independent — if one fails, fix it before moving on rather than chaining.

```powershell
# Git for Windows — includes Git Bash, which we use later for the device-protocol build
winget install --id Git.Git -e

# Node.js LTS — needed by some submodule build scripts (yarn / npm)
winget install --id OpenJS.NodeJS.LTS -e

# Yarn classic — required by modules/hdwallet
winget install --id Yarn.Yarn -e

# Bun runtime — the project's primary JS runtime
winget install --id Oven-sh.Bun -e

# Rust + cargo — for zcash-cli sidecar
winget install --id Rustlang.Rustup -e
# After install, set the default toolchain:
rustup default stable

# Zig compiler — builds the wrapper EXE (KeepKeyVault.exe)
winget install --id zig.zig -e

# Visual Studio Build Tools — provides MSVC + Windows SDK, required by native node addons
# (usb, node-hid) and by the cargo build of zcash-cli's transitive C dependencies.
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
    "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# Inno Setup 6 — produces the installer EXE (only needed for release builds)
winget install --id JRSoftware.InnoSetup -e
```

**Close and reopen your PowerShell session after this block** so `PATH` updates pick up.

Verify everything is reachable:

```powershell
git --version
node --version
yarn --version
bun --version
cargo --version
zig version
where.exe signtool.exe   # should print a path under "Windows Kits\10\bin\..."
where.exe iscc           # should print Inno Setup path
```

> If `signtool.exe` is not found, the VS Build Tools install did not include the Windows 10 SDK. Open the Visual Studio Installer GUI, modify the Build Tools install, and tick "Windows 10 SDK" or "Windows 11 SDK".

---

## 4. WebView2 Runtime

Windows 11 has this pre-installed. On Windows 10, verify:

```powershell
Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*" `
    -ErrorAction SilentlyContinue | Where-Object { $_.name -match "WebView2" }
```

If nothing prints, install it:

```powershell
$url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
$out = "$env:TEMP\MicrosoftEdgeWebview2Setup.exe"
Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
& $out /silent /install
```

Without WebView2, KeepKey Vault launches but produces no window — see [`WINDOWS-QUIRKS.md`](./WINDOWS-QUIRKS.md) §13.

---

## 5. Clone the repo

```powershell
# Pick a short path — the deeper the checkout, the more MAX_PATH headroom you burn.
# C:\kk works; C:\Users\YourName\Documents\Projects\... probably won't.
mkdir C:\kk
cd C:\kk
git clone https://github.com/keepkey/keepkey-vault.git
cd keepkey-vault
```

Submodules are initialized selectively by the build script — **do not** run `git submodule update --init --recursive` (firmware submodules have paths exceeding MAX_PATH even with long paths enabled in some setups). Let the build script handle it.

---

## 6. Build the `device-protocol` library (one-time, the tricky bit)

`modules/device-protocol/lib/` is gitignored. The compiled protobuf files (`messages_pb.js`) need to exist before anything else in the build can work. The `device-protocol` build uses BSD `sed` in its postprocess step which is not native to Windows.

**Easiest path: use Git Bash**, which ships with GNU `sed`:

```bash
# Open Git Bash (Start Menu → "Git Bash")
cd /c/kk/keepkey-vault
git submodule update --init modules/device-protocol
cd modules/device-protocol
npm install
npm run build

# Verify
ls lib/messages_pb.js
# Should print: lib/messages_pb.js
```

Alternatives if Git Bash isn't available:
- **WSL**: `wsl` → `cd /mnt/c/kk/keepkey-vault/modules/device-protocol && npm install && npm run build`
- **Copy from another machine**: if a teammate has a built copy, copy the entire `modules/device-protocol/lib/` directory over.

After this step, you can go back to PowerShell for the rest.

---

## 7. First build — verify the toolchain works

A signed release build needs the EV token, which most contributors won't have. Do an **unsigned test build** to confirm everything compiles:

```powershell
.\scripts\build-windows-production.ps1 -SkipSign
```

What this should produce:
- ~15-20 minutes of output (submodule init, `bun install`, `yarn build`, `cargo build`, electrobun bundle, Inno Setup compile)
- `release-windows\KeepKey-Vault-<version>-win-x64-setup.exe` (unsigned)
- `release-windows\SHA256SUMS.txt`

If the script aborts, read the error message carefully — every failure mode has a specific message and most are listed in [`WINDOWS-BUILD-AND-SIGN.md`](./WINDOWS-BUILD-AND-SIGN.md#common-failures). The most common first-time issues:

- **`FATAL: modules/device-protocol/lib/messages_pb.js is MISSING`** — you skipped step 6. Go back.
- **`Zig compiler not found`** — `winget install zig.zig` then reopen PowerShell.
- **`Inno Setup compilation failed`** — MAX_PATH issue. Re-run after confirming long paths are enabled (step 1).
- **`cargo build --release failed for zcash-cli`** — usually missing VS Build Tools C++ workload. Open Visual Studio Installer, modify the Build Tools install, and ensure "Desktop development with C++" is ticked.

---

## 8. Run the dev mode

Production builds are slow (~15 min). For day-to-day dev, use the HMR script:

```powershell
cd C:\kk\keepkey-vault
bun run dev:hmr:win
```

This is documented in detail in [`WINDOWS-DEV-MODE.md`](./WINDOWS-DEV-MODE.md). Briefly:
- Kills stale Bun / launcher / electrobun processes
- Frees ports 5177 (Vite HMR) and 50000 (app REST)
- Builds, then launches `launcher.exe` directly from the dev build tree

If the app starts but no window appears, see [`WINDOWS-DEV-MODE.md`](./WINDOWS-DEV-MODE.md) §2 — this is a known WebView2 non-determinism issue on Windows.

---

## 9. Optional — set up code signing

Only relevant if you'll be cutting releases. Most contributors skip this section.

1. Plug in the USB EV signing token (e.g., SafeNet eToken, Sectigo USB token)
2. Install the vendor's certificate management software (typically bundled on the token's drive or downloadable from the vendor)
3. Unlock the token and import the certificate into the Windows cert store (the vendor tool walks you through this — the cert ends up in `Cert:\CurrentUser\My`)
4. Capture the thumbprint:
   ```powershell
   Get-ChildItem Cert:\CurrentUser\My | Format-Table Subject, Thumbprint, NotAfter
   ```
5. Set the thumbprint as an env var so you don't have to pass it every time:
   ```powershell
   [Environment]::SetEnvironmentVariable("KK_SIGN_THUMBPRINT", "<your-thumbprint>", "User")
   ```
   Reopen PowerShell. Verify with `$env:KK_SIGN_THUMBPRINT`.
6. Run a signed build:
   ```powershell
   .\scripts\build-windows-production.ps1
   ```

Full release workflow lives in [`WINDOWS-BUILD-AND-SIGN.md`](./WINDOWS-BUILD-AND-SIGN.md).

---

## Common setup gotchas

### `bun install` fails with ENOENT on deeply nested deps
Expected — Bun has issues with deeply nested `file:` workspace deps. The production build script tolerates this. If you're running `bun install` manually outside the script and want to verify success, check that `node_modules/electrobun/` and `node_modules/@keepkey/` exist; the ENOENT errors are on transitive deps that `collect-externals` handles later.

### `yarn build` in `modules/hdwallet` fails with TypeScript errors
The hdwallet submodule pins specific TypeScript versions. If you have a globally-installed TypeScript that's incompatible, remove it: `npm uninstall -g typescript`. Yarn will use the workspace-local version.

### `cargo build --release` is very slow on first run
~5-10 minutes is normal — Rust compiles a lot of crypto crates from scratch. Subsequent builds are fast (incremental). The target directory ends up around 3-4 GB.

### `signtool` says "no certificates were found that met all the given criteria"
The token is plugged in but not unlocked, or the cert isn't visible in `Cert:\CurrentUser\My`. Re-run the vendor's cert management tool and ensure the cert is "installed for the current user."

### Antivirus deletes `bun.exe` or `launcher.exe`
Bun's JIT triggers some heuristic AV scanners. Add an exclusion for `C:\kk\keepkey-vault\` and `%LOCALAPPDATA%\Programs\KeepKeyVault\` in your AV's settings.

### `pnpm` vs `bun` vs `npm`
This project uses **Bun** as the primary runtime and package manager. `npm` and `yarn` are only used inside specific submodules. Do not switch the top-level project to npm/yarn — it will break the workspace resolution.

---

## Quick reference: what each tool is for

| Tool | Used by | What breaks without it |
|---|---|---|
| Bun | All of `projects/keepkey-vault` | Nothing builds |
| Yarn classic | `modules/hdwallet` | hdwallet build fails |
| Node + npm | `modules/device-protocol` | Can't build `lib/messages_pb.js` |
| Rust + cargo | `projects/keepkey-vault/zcash-cli` | Zcash shielded features missing |
| Zig | Wrapper EXE compile | `KeepKeyVault.exe` missing |
| VS Build Tools | `usb`, `node-hid`, cargo C deps | Native modules don't compile |
| Windows SDK | `signtool.exe` | Can't sign releases |
| Inno Setup 6 | `ISCC.exe` | Can't build installer |
| WebView2 Runtime | Runtime UI rendering | App has no window |
| Git Bash | `device-protocol` postprocess | `lib/` never builds |

---

## Where things live on disk

| Path | What |
|---|---|
| `C:\kk\keepkey-vault\` | Repo |
| `C:\kk\keepkey-vault\projects\keepkey-vault\_build\` | Dev build output |
| `C:\kk\keepkey-vault\release-windows\` | Signed installer output |
| `C:\tmp\kk\` | MAX_PATH staging area (auto-created during release build) |
| `%LOCALAPPDATA%\Programs\KeepKeyVault\` | Production install location |
| `%LOCALAPPDATA%\com.keepkey.vault\` | Runtime data: `vault-backend.log`, SQLite DB, WebView2 profiles |

When troubleshooting an installed build, **`vault-backend.log` is the single source of truth** — see [`HANDOFF-1.2.14-WIN10-WATCHDOG-CRASH.md`](./HANDOFF-1.2.14-WIN10-WATCHDOG-CRASH.md) for the diagnostic story behind the synchronous logger.
