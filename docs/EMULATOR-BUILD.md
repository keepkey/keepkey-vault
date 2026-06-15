# Building the KeepKey Emulator

The emulator is the **real KeepKey firmware compiled to run on your computer**
instead of on the device's STM32. It's a developer / power-user tool: it lets
you run whatever firmware is on a branch (e.g. `alpha`, with the latest Zcash /
NEAR work) and exercise new coins in the live Vault UI **before** that firmware
ships to hardware.

> ⚠️ One firmware source, **three build artifacts, two transports.** The single
> most common confusion is treating "the emulator" as one thing. It isn't.
> Read the table before you build.

---

## The three artifacts

| # | Artifact | Transport | Who loads it | Built by |
|---|----------|-----------|--------------|----------|
| 1 | **`libkkemu.dylib`** (macOS) | in-process **ring buffers** via `bun:ffi` | **the Vault** | `make build-emulator` |
| 1′ | **`libkkemu.dll`** (Windows) | same as #1, as a Windows DLL | the Vault (Windows) | `make build-emulator-windows` |
| 2 | **`kkemu`** (standalone binary) | **UDP** on `:11044` / `:11045` | python-keepkey, **firmware CI** | `make build-emulator` (and firmware CI) |

All three come from the *same* C in `modules/keepkey-firmware`. The build flag
`KK_BUILD_DYLIB` is what flips the transport: with it, `lib/emulator/udp.c`
compiles its socket calls out and replaces them with lock-free ring buffers
(`KKEMU_DYLIB=1`); without it you get the UDP binary.

### Why two transports exist

- **Ring-buffer dylib/DLL (#1):** zero sockets, **caller-driven** — the host
  calls `kkemu_poll()` on its own clock (the Vault polls every ~16 ms). This is
  what the Vault uses, and it's where confirm-flow / preview correctness lives,
  because the standalone binary's own poll thread papers over caller-driven
  timing bugs.
- **UDP binary (#2):** has its **own C poll thread**, listens on UDP. Convenient
  for scripted tests (python-keepkey speaks UDP) and for the firmware CI
  screenshot pipeline.

---

## How this is **separate from the emulator in CI**

This is the key distinction to keep straight:

- **Firmware CI (`modules/keepkey-firmware/.github/workflows/ci.yml`)** builds
  the emulator **two** ways, in two separate jobs:
  - `python-integration-tests` → builds the **UDP `kkemu` binary** inside a
    Docker image (`scripts/emulator/Dockerfile`) and runs python-keepkey UDP
    tests + OLED **screenshot** regression. *This is the long-standing "emu in
    CI".*
  - `python-dylib-tests` → builds **`libkkemu.dylib`** (`KK_TRANSPORT=dylib`)
    and runs the dylib-specific tests. *This is the FFI path the Vault uses.*
    It is macOS-only today (see note below).
- **Vault CI (`.github/workflows/build.yml`)** does **not** build or test the
  emulator at all. The emulator is never bundled into the shipped app — since
  commit `bccc9504` it's a user-installed dev tool, not an end-user feature.
- **`make build-emulator` (this repo)** is the **local developer** path. It
  builds *both* artifact #1 and #2 from your current firmware checkout and
  installs them to `~/.keepkey/emulator/`. It is independent of either CI.

So: the **Windows DLL work added here does not touch the CI emulator.** It only
adds artifact #1′ (`libkkemu.dll`) and gates the UDP binary (#2) out on Windows
(it can't build there — sockets/signals). Firmware CI's UDP + screenshot jobs
are unchanged.

---

## Build it — macOS (the Vault emulator)

```bash
make build-emulator
```

What it does:
1. `cmake -DKK_EMULATOR=ON -DKK_DEBUG_LINK=ON -DKK_BUILD_DYLIB=ON …`
2. `make kkemu kkemulator_dylib`
3. installs `libkkemu.dylib` + `kkemu` → `~/.keepkey/emulator/`

**Load-bearing flags** (each one cost a debugging session at some point):

| Flag | Why it's required |
|------|-------------------|
| `KK_DEBUG_LINK=ON` | Without it `DebugLinkDecision` is excluded → every confirm hangs → watchdog SIGKILL. |
| `KK_BUILD_DYLIB=ON` | Produces the shared lib + switches I/O to ring buffers. |
| `PB_NO_PACKED_STRUCTS=1` | nanopb struct alignment across the FFI boundary. |

**Toolchain band (must match):** pyenv **Python 3.10.15**, **protoc 3.21.x**,
pip **protobuf 3.20.3**, **nanopb 0.3.9.4**. Off-band versions fail silently or
produce a runtime-incompatible build.

Then in the Vault: drag the built `libkkemu.dylib` onto the app window (or it's
already installed by `make build-emulator`), and the emulator boots a wallet
through the normal onboarding flow.

---

## Build it — Windows (cross-compiled DLL)

You do **not** need a Windows machine. The DLL is cross-compiled from
macOS/Linux with MinGW-w64.

```bash
brew install mingw-w64          # macOS  (apt-get install mingw-w64 on Linux)
make build-emulator-windows
```

What it does (`scripts/build-emulator-windows.sh`):
1. Uses the same pinned host toolchain as the dylib build (pyenv 3.10.15 +
   nanopb 0.3.9.4 + a cached pinned protoc 3.21.x).
2. Configures cmake with
   `cmake/toolchains/mingw-w64-x86_64.cmake` (`CMAKE_SYSTEM_NAME=Windows`).
3. Builds **only** `kkemulator_dylib` → `build-emu-win/.../libkkemu.dll`.

It does **not** build the UDP `kkemu` binary — that target is gated behind
`if(NOT WIN32)` in `tools/emulator/CMakeLists.txt`.

### What makes the DLL build different from the dylib

The firmware is written in the GCC dialect (`__attribute__`, `__builtin_bswap`,
C11 atomics), so we target **MinGW-w64 / clang, not MSVC** — MSVC would force a
rewrite of all of that. The Windows-specific deltas are small and all behind
`#ifdef _WIN32`:

| Concern | File | macOS/Linux | Windows |
|---------|------|-------------|---------|
| Duplicate `__stack_chk_guard` | `lib/emulator/setup.c` | Apple ld merged it | **removed** the redundant copy — `lib/board/keepkey_board.c` is canonical (also unblocks the Linux `.so` build) |
| RNG | `lib/emulator/setup.c` | `/dev/urandom` | `BCryptGenRandom` |
| Memory lock | `lib/emulator/libkkemu.c` | `mlock`/`munlock` | `VirtualLock`/`VirtualUnlock` |
| 1 ms timer | `lib/board/timer.c` | `SIGALRM`/`ualarm` | poll-driven `timerisr_usr()` from `kkemu_poll()` |
| Flash file (`mmap`) | `lib/emulator/setup.c` | standalone only | dead-code in dylib mode — guarded out |
| DLL symbol export | `tools/emulator/CMakeLists.txt` | implicit | `-Wl,--export-all-symbols` + link `bcrypt` |

> **Status: cross-compile gate PASSED (2026-06-15).** `make build-emulator-windows`
> produces a valid `libkkemu.dll` — `PE32+ x86-64`, ~1.4 MB — with all 8
> `kkemu_*` FFI symbols exported and only standard Windows DLL deps (UCRT,
> `bcrypt.dll`, `KERNEL32.dll`). The full firmware core (`kkfirmware`/`kkboard`/
> `kktransport`/`trezorcrypto`/`SecAESSTM32`), Zcash Orchard crypto included,
> cross-compiles and links clean. Beyond the table above, the link needed two
> more fixes: a strong `random_buffer()` in `lib/rand/rng.c` (trezor-crypto's is
> weak; GNU/MinGW ld won't extract a weak def for a strong ref) and a
> `LINK_GROUP RESCAN` around `FIRMWARE_LIBS` (`kkrand`↔`trezorcrypto` are
> circular and GNU ld is single-pass). Two firmware submodules also had to be
> synced to their pinned SHAs (`trezor-firmware`, `device-protocol`) — the
> `make` target does this automatically.
>
> **Not yet done (next):** loading the DLL at runtime. The Vault-side Windows
> integration (`.dll` path, isMacOS() gates, Credential-Manager flash key,
> drag-drop `.dll`, PE-magic validation) is Phase 2 — tracked in
> `docs/scope-emulator-windows.md`. The DLL has not yet been loaded by the Vault
> on a Windows machine.

---

## Quick reference

```bash
make build-emulator          # macOS: libkkemu.dylib (+ kkemu UDP binary) → ~/.keepkey/emulator/
make build-emulator-windows  # cross-compile libkkemu.dll (MinGW-w64)
make test-emu                # bun tests against the installed dylib (FFI path)
make test-emu-python         # python-keepkey tests against the kkemu UDP binary
make clean-emulator          # remove build dir + installed artifacts
```

Related docs: `docs/scope-emulator-windows.md` (full Windows scope + phasing),
`docs/EMULATOR-NATIVE-MACOS.md` (macOS build deep-dive).
