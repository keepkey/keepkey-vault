# Scope: Emulator → Vault Flow + Windows Emulator Port

**Date:** 2026-06-15
**Branch:** `feature-emulator`
**Goal:** A working emulator→vault flow for developers / power users who want **early access to new coins** (run the same `alpha` firmware that has Zcash/NEAR/etc. *before* it ships to hardware), and scope what a **Windows** emulator would take.

> Method note: this scope was produced by a multi-agent map + adversarial verification pass over the vault (`projects/keepkey-vault/src/bun/emulator*.ts`) and firmware (`modules/keepkey-firmware/lib/emulator`, `tools/emulator`). The headline correction below (the preview was *not* yanked for bugs) was confirmed against commit history, not memory.

---

## 1. What the emulator actually is

`libkkemu.dylib` **is the real KeepKey firmware compiled as a host shared library.** Not a re-implementation — the same C that runs on the device, with the STM32 peripheral layer swapped for host equivalents. That's the whole value prop: whatever coin support lands on `alpha` (today: full Zcash Orchard, NEAR, etc.) runs in the emulator immediately, so a power user gets it in the real Vault UI before a hardware firmware release.

**Runtime architecture (current, macOS):**
- Vault loads the dylib via `bun:ffi` `dlopen` and drives it with a **16 ms poll loop** (`setInterval(kkemu_poll, 16)`). `emulator.ts:56-67, 154-157`
- **8-function FFI contract:** `kkemu_init / shutdown / write / read / poll / is_running / get_display / pop_frame`. `include/keepkey/emulator/libkkemu.h`
- **HID I/O is ring buffers, not UDP** — `KKEMU_DYLIB=1` compiles the socket layer out and replaces it with lock-free SPSC rings (`rb_main_in/out`, `rb_debug_in/out`). `lib/emulator/udp.c:99-117`, `libkkemu.c:74-97`
- **OLED preview** is a 64-frame capture ring: firmware's `display_refresh()` snapshots the 256×64 canvas into 1-bit SSD1306 frames; `kkemu_pop_frame` drains them; vault replays into a `<canvas>` at ~15 fps. This captures transient screens (confirm/cipher/recovery) that live and die *inside* a single synchronous `kkemu_poll()`. `libkkemu.c:107-132, 313-320`
- **Flash** is host-owned (1 MB buffer passed to `kkemu_init`), `mlock`'d, encrypted at rest with an AES-256-GCM key stored in **macOS Keychain**. A separate `{name}.mnemonic.enc` works around the firmware's per-boot non-deterministic storage-wrapping key. `emulator-keychain.ts`
- **Confirm flow** is the subtle part: `confirm_helper()` is a blocking C busy-loop inside `kkemu_poll()`. Vault pauses the poll, pre-writes `ButtonAck`+`DebugLinkDecision` pairs to **iface 1** (alternating, to avoid the iface-0-priority starvation bug), then does one final poll. `emulator-transport.ts`, `emulator-window.ts:516-595`
- **Watchdog:** a bash subprocess SIGKILLs the host if a heartbeat file goes stale >60 s (JS timers can't fire during an FFI block). `emulator-watchdog.ts`

---

## 2. macOS build process review

**One target does it all:** `make build-emulator` (`Makefile:362-385`)
1. `cd modules/keepkey-firmware`, init named submodules
2. `rm -rf build-emu && mkdir build-emu`
3. `cmake .. -DKK_EMULATOR=ON -DKK_DEBUG_LINK=ON -DKK_BUILD_DYLIB=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_C_FLAGS="-DPB_NO_PACKED_STRUCTS=1" -DCMAKE_CXX_FLAGS=...`
4. `make -j$(sysctl -n hw.ncpu) kkemu kkemulator_dylib`
5. install `build-emu/lib/libkkemu.dylib` → `~/.keepkey/emulator/libkkemu.dylib`, `build-emu/bin/kkemu` → `~/.keepkey/emulator/kkemu`

**Load-bearing flags (each cost a debugging session historically):**
- `KK_DEBUG_LINK=ON` — without it `DebugLinkDecision` matches no case → every confirm hangs → watchdog SIGKILL.
- `KK_BUILD_DYLIB=ON` — produces the shared lib + switches I/O to ring buffers.
- `PB_NO_PACKED_STRUCTS=1` — nanopb alignment on ARM64; required.

**Toolchain band (must match):** pyenv Python 3.10.15, protoc 3.21.12, pip protobuf 3.20.x, nanopb 0.3.9.4.

**Install / runtime:** single user slot `~/.keepkey/emulator/libkkemu.dylib` (no bundled channels since `bccc9504`). Vault validates a dropped dylib by Mach-O magic before `dlopen`. `index.ts:5759-5807`

**Health assessment:**
- ✅ Solid: the build is reproducible and self-contained in one Make target; the FFI contract is clean; ring-buffer I/O removed the UDP flakiness.
- ⚠️ Fragile: hard pin to the exact toolchain band (silent breakage off-band); `-j$(sysctl …)` and codesign/Keychain are macOS-only; no version/compat check between an installed dylib and the firmware it was built from (only Mach-O magic).

---

## 3. The "screen preview got yanked" question — corrected

**It was not yanked because of bugs. The preview works.** What was removed was the *end-user entry point*, deliberately.

- **`bccc9504` (Apr 30 2026) "feat(emulator): hide from end users + smart drag-and-drop dispatcher"** stripped the invitation surfaces — `EmulatorButton.tsx` (−240 lines), the bottom-right pill, "Pair Emulator", "+ Add" — and unbundled the shipped dylib (−~2 MB). Stated rationale: *"The emulator is a developer tool, not an end-user feature."* It **did not touch `emulator-window.ts`**; the preview/`emuPopFrames` path was left fully intact. Net −1,241 lines.
- The two crashes that *did* affect the preview were fixed with clean root-cause fixes, both **ancestors of HEAD**:
  - `268f0cbc` — Bun `toBuffer(ptr)` GC-freed the dylib's static `.bss` framebuffer → SIGBUS on the 2nd poll tick. Fix: `new Uint8Array(toArrayBuffer(...)).slice()` (JS-owned copy).
  - `9ce826d8` — `executeJavascript` before page load crashed WKWebView (`EXC_BREAKPOINT`, host exit 133). Fix: `/_emu/ready` handshake + `viewReady` gate.
  - `820dfaa6` — architecture upgrade: replaced before/after `emuGetDisplay` polling with the capture-ring playback queue (so intermediate confirm screens actually render).

**So the user's recollection is half-right:** there *were* a lot of bugs around the preview, and "should be a lot mostly there" is correct — but it was hidden as a product decision, and the preview bugs were already fixed. **Re-exposing it for power users is mostly restoring a gated entry point + polish, not a bug hunt.**

**The genuinely-still-open emulator issues** (none block the preview, but they shape the "working flow"):
- `confirm_helper` blocks the JS event loop during a poll tick (mitigated by pre-write + watchdog; the clean fix is a poll thread in the dylib or non-blocking confirm).
- `DebugLinkGetState` reads hang on the dylib path → wrapped in 3 s `Promise.race` workarounds.
- python-keepkey reactive confirm flow deadlocks the dylib (test-only; `DylibTransport` reproduces it).
- The **firmware CI screenshot pipeline** is a *different* subsystem (DebugLink `force_animation_start()` overwrites static canvases) and is still broken for non-confirm screens — do not conflate it with the vault preview.

---

## 4. Windows emulator scope

The map agents (assuming **MSVC**) sized this as a large POSIX port. Verification + direct inspection show the right target is **MinGW-w64 / clang cross-compile**, which collapses most of it. Two independent halves:

### 4A. Firmware → `libkkemu.dll` (the load-bearing unknown)

**Why MinGW-w64, not MSVC:** the firmware is written in the GCC dialect — `__attribute__`, `__builtin_bswap*`, C11 `_Atomic`. MinGW/clang accept all of these natively; MSVC would require rewriting them. The CMake already names the shared-lib target *"libkkemu.dylib / libkkemu.so"* — **a Linux `.so` build is an intended target**, so glibc already satisfies the POSIX surface. **Windows-via-MinGW is a small delta from the Linux build, not a from-scratch port.**

**Recommended approach: cross-compile the DLL on the existing macOS/Linux build host** via a CMake toolchain file (`x86_64-w64-mingw32-gcc`). This sidesteps the "no Windows CI runner" problem entirely (the *app* installer is already built/signed on a separate Windows box; the DLL can be cross-built upstream and shipped into it).

**Concrete deltas (all `#ifdef _WIN32`, ~4 files):**
| Spot | File | Today | Windows |
|---|---|---|---|
| RNG | `lib/emulator/setup.c` (`setup_urandom_only`) | `/dev/urandom` open/read | `BCryptGenRandom` |
| Mem-lock | `lib/emulator/libkkemu.c:154,234` | `mlock`/`munlock` | `VirtualLock`/`VirtualUnlock`, or no-op (already non-fatal) |
| Timer | `lib/board/timer.c:233-235` | `signal(SIGALRM)`+`ualarm()` at init | stub — `kkemu_poll()→animate()` already drives timing in dylib mode; the signal timer is redundant here |
| Flash file | `lib/emulator/setup.c` (`setup_flash`) | `mmap`/`ftruncate`/`lseek` | **dead code in dylib mode** (host provides buffer via `kkemu_init`) — guard so it compiles |
| Symbol export | `lib/emulator/CMakeLists.txt` | implicit (Mach-O) | `__declspec(dllexport)` on the 8 `kkemu_*`, or `-Wl,--export-all-symbols` |

**Non-blockers (verified):** BSD sockets (already `#ifdef KKEMU_DYLIB`-excluded — `nm` on the built dylib shows **zero** socket symbols); `-Wl,-no_fixup_chains` (Apple+arm64-guarded, no-op elsewhere); `__attribute__`/`__builtin_*`/C11 atomics (MinGW-native). Linked libs (`trezorcrypto`, `SecAESSTM32`, `qrcodegenerator`, `kkrand`, board/transport) are portable C — but **must be verified to cross-compile**; this is the real risk (see §5).

### 4B. Vault integration on Windows

| Concern | File | Change |
|---|---|---|
| Lib path/ext | `emulator.ts:42-43` | `.dll` + `%LOCALAPPDATA%\KeepKey\emulator\libkkemu.dll` on win32 |
| Platform gate | `emulator.ts:114-118`, `pairEmulator:97` | branch `isMacOS()` to allow win32 |
| Flash keystore | `emulator-keychain.ts` | macOS Keychain (`security` CLI) → **Windows Credential Manager** (portable) or DPAPI (simpler, per-machine) |
| Watchdog | `emulator-watchdog.ts` | bash/`kill -9` already no-ops on win32; either a native watcher or rely on existing `Promise.race` timeouts (acceptable for a dev tool) |
| Binary validation | `index.ts:5770-5772` | Mach-O magic → **PE magic** (`MZ` / `0x4D5A`) for `.dll` |
| Install RPC gate | `index.ts:5763`, `rpc-schema.ts:338` | `process.platform === 'darwin'` → allow win32 |
| Drag-and-drop | dispatcher from `bccc9504` | extend the `.dylib` branch to `.dll` |

### 4C. Build / distribution

- **DLL:** cross-compile on macOS/Linux (MinGW toolchain file); ship into the Windows bundle.
- **App:** `scripts/build-windows-production.ps1` already produces a signed `win-x64` installer (Inno Setup, EV signing, WebView2). Add: sign the `.dll` and place it on the FFI search path (next to `KeepKeyVault.exe` or the `%LOCALAPPDATA%` slot).
- **Native USB precedent exists:** `node-hid`/`usb` already ship win32 prebuilds and `collect-externals.ts` already keeps them on Windows — so native-lib bundling on Windows is a solved, exercised path.
- **CI gap (known):** `build.yml` runs only ubuntu + macos-14 and not on `develop`. Windows is validated manually per release today (per `handoff-windows-prs-audit.md`). A cross-compile step for the DLL can run on the existing Linux runner.

---

## 5. Risks & unknowns (ranked)

1. ~~**Does `libkkemu` cross-compile to a working `.dll` under MinGW-w64 at all?**~~
   **✅ RESOLVED (2026-06-15) — gate passed.** `make build-emulator-windows`
   produces a valid `libkkemu.dll` (`PE32+ x86-64`, ~1.4 MB, all 8 `kkemu_*`
   exports, deps only UCRT + `bcrypt.dll` + `KERNEL32.dll`). The full firmware
   core — Zcash Orchard crypto included — compiles and links. See
   `docs/EMULATOR-BUILD.md` for the exact fixes (strong `random_buffer`,
   `LINK_GROUP RESCAN`, the `#ifdef _WIN32` shims, submodule-SHA syncs).
2. **`bun:ffi` `dlopen` of a `.dll` under the Electrobun-bundled Bun runtime on Windows** — documented to work, but never exercised in this repo. **Now the #1 unknown** — the DLL exists but has not yet been loaded by the Vault on Windows.
3. **`confirm_helper` blocking model on the Windows event loop without the POSIX watchdog** — needs the `Promise.race` timeouts to be sufficient, or a native watcher.
4. **Per-boot storage-key non-determinism** — the mnemonic-persistence workaround must port to the Windows keystore.
5. **libgcc/libwinpthread runtime DLLs** — none appeared in the DLL's import table, so likely not needed; if a target Windows box complains, add `-static-libgcc`/`-static` to the link.

---

## 6. Recommended path

**Phase 0 — macOS "working flow" for power users (small, ships value now).**
The macOS pieces are all present; the flow just isn't reachable. Re-expose behind a power-user gate (settings toggle or documented drag-drop), then verify the end-to-end *early-access* path with a real coin (Zcash Orchard from `alpha`): drop dylib → boot emu wallet → onboarding → use the coin in the live UI. Close residual confirm/preview rough edges as found.

**Phase 1 — prove the Windows DLL (de-risk #1).**
MinGW-w64 CMake toolchain file; cross-compile `libkkemu.dll`; load it in a standalone Bun FFI harness on Windows and confirm `kkemu_init` + an xpub derivation. *Go/no-go gate for the whole Windows effort.*

**Phase 2 — Windows vault integration.** §4B changes behind `process.platform` branches.

**Phase 3 — Windows build/dist.** Bundle+sign the DLL in the existing Windows installer; add the cross-compile CI step.

**Rough sizing:** Phase 0 small (days). Phase 1 small-to-medium *if* the core cross-compiles, open-ended if it doesn't. Phase 2 medium (keystore + gates). Phase 3 small (infra already exists).
