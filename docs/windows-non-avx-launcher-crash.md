# Windows non-AVX launch crash — root cause analysis

**Date:** 2026-06-12 · **Component:** Windows production build (`scripts/build-windows-production.ps1` + `scripts/wrapper-launcher.zig`)
**Status:** root cause confirmed, one-line fix staged on `fix/windows-non-avx-launcher`. **Not yet built or hardware-verified** (investigated on macOS; Zig is a Windows-build-box tool).

---

## 1. Symptom

KeepKey Vault for Windows (1.4.3) crashes **instantly on launch** — no window, no splash — with Windows Error Reporting showing:

```
Exception code: 0xC000001D   (STATUS_ILLEGAL_INSTRUCTION)
Faulting module: KeepKeyVault.exe
Fault offset:    0x0000000000001b96
```

Reported on an **Intel Pentium Silver N5030** ("Gemini Lake" / Goldmont Plus). That microarchitecture has **SSE4.2 but no AVX and no AVX2**. The binaries are all correctly x64 — this is an *instruction-set* mismatch, not an architecture mismatch.

This affects the whole no-AVX Windows-x64 class: Gemini Lake / Apollo Lake Pentium Silver & Celeron N/J chips, older pre-Sandy-Bridge cores, and VMs whose hypervisor does not pass AVX through to the guest.

## 2. Root cause

`KeepKeyVault.exe` is **not** Electrobun's launcher and **not** `bun.exe`. It is **KeepKey's own splash wrapper**, `scripts/wrapper-launcher.zig`, compiled on the Windows build box by `scripts/build-windows-production.ps1`. The build invocation was:

```powershell
& $ZigExe build-exe $WrapperSrc -O ReleaseSmall --subsystem windows "-femit-bin=$WrapperExe"
```

There is **no `-target` and no `-mcpu`**, so Zig defaults to **`-mcpu=native`** — the *build machine's* CPU, which is AVX2-capable. Zig/LLVM therefore emits AVX codegen, including a VEX-encoded callee-saved-XMM spill in `main()`'s prologue.

The faulting byte at `+0x1b96` is exactly that instruction:

```
c5 f9 7f b5 c0 06 04 00   vmovdqa %xmm6, 0x406c0(%rbp)
```

`vmovdqa` (VEX prefix `c5`) is an AVX instruction. On the N5030 the CPU has no AVX decode path → `#UD` invalid-opcode → `0xC000001D`. This happens in the wrapper's own prologue, **before `bun.exe` is ever exec'd**, which is why the crash is attributed to `KeepKeyVault.exe` and not to Bun.

## 3. Evidence

- **PE layout match.** The crashing `KeepKeyVault.exe` has `.text` VA=0x1000, VSize=**0x5CB6**, RawPtr=0x400. Cross-building `wrapper-launcher.zig` with Zig 0.15.1 at `-mcpu=haswell`/`-mcpu=skylake` reproduces that PE layout **exactly**, and places the `vmovdqa` at **exactly RVA 0x1b96**. The whole binary then contains 632 VEX/EVEX instructions.
- **Baseline build is clean.** Re-building the same source with `-mcpu=baseline` emits SSE2 `movdqa` at that site instead, contains **0 VEX instructions**, and `.text` shrinks to VSize=0x5A46.
- **Not Electrobun's launcher.** Electrobun's prebuilt `launcher.exe` has a different `.text` size (VSize=0x111C6) and disassembles to **0 AVX instructions** in v1.13.1, v1.16.0 and v1.18.1 — it is genuinely baseline-clean (built with `-Dcpu=baseline`). The layout mismatch is conclusive: the crasher is our wrapper, not theirs.
- **Not the bundled Bun.** `bun.exe` in our Electrobun 1.13.1 bundle is the genuine baseline build (version banner: `Bun v1.3.9 (cf6cdbbb) Windows x64 (baseline)`). It never runs, because the wrapper faults first.

## 4. The fix

Pin the wrapper's target ISA. One line in `scripts/build-windows-production.ps1`:

```powershell
& $ZigExe build-exe $WrapperSrc -target x86_64-windows -mcpu=baseline -O ReleaseSmall --subsystem windows "-femit-bin=$WrapperExe"
```

`-mcpu=baseline` is Zig's x86-64-v1 (SSE2-era) floor — runs on every x64 CPU. Verified that this cross-build compiles cleanly on Zig 0.15.1/0.15.2 and produces zero AVX instructions. There is only **one** `zig build-exe` in the Windows build (the wrapper), so no other native-CPU binary carries the same bug.

## 5. Secondary: the bundled Bun version (separate, lower priority)

Independent of the wrapper bug, our bundled `bun.exe` (Bun **1.3.9**, via Electrobun 1.13.1) sits inside an upstream non-AVX regression window:

| Bun version | Non-AVX baseline status |
|---|---|
| ≤ 1.3.6 | Crashes — baseline Bun linked an AVX2 (`-march=haswell`) WebKit prebuilt |
| 1.3.7 | Fixed (WebKit#57026) |
| **1.3.9** (we bundle this) | **Regressed** — `-march` change; no dedicated baseline WebKit yet |
| 1.3.11 | Dedicated baseline WebKit artifacts added; upstream still reports VM crashes |
| **1.3.14** | First version that combines baseline WebKit + the JSC JIT CPU-detection fix (WebKit#198, OSXSAVE/XCR0 AVX gating). Earliest considered safe. |

The N5030 has SSE4.2, so baseline Bun ≥ 1.3.9 *should* run — but after the wrapper fix lets the app reach `bun.exe`, the safe move is to bundle Bun **≥ 1.3.14**, via either:

- Electrobun's per-app config override `build.bunVersion` (added in Electrobun v1.11; usable while staying on 1.13.1 — Windows always fetches `bun-windows-x64-baseline.zip`), or
- bumping Electrobun to ≥ 1.18 (ships Bun 1.3.13 baseline; still short of 1.3.14).

Note: CPUs **below** SSE4.2 (pre-Nehalem, some QEMU vCPUs) remain unfixable upstream today (bun#30613, fix PR #30642 open). Out of scope for the N5030.

## 6. What this was NOT (ruled out)

- Not an Electrobun bug — their launcher and bundled Bun are baseline-clean. Bumping Electrobun does **not** fix this crash.
- Not a Bun bug at the crash site — Bun never executes before the fault.
- Not a Zig panic/`@trap()` (which also surfaces as `0xC000001D`) — the faulting bytes decode to a real `vmovdqa`, not `ud2`, and the reproduction confirms it.

Precedent for "looks like missing-baseline but is the app's own packaging": Electrobun issue #415 (macOS, retracted once the launcher was verified baseline) and KeepKey's own `v1.16.1-keepkey` fork fixing Apple codesign corrupting Zig `__TEXT`. This one is the genuine article — our wrapper really was built non-baseline.
