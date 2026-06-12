# Handoff — Windows non-AVX launch crash (`0xC000001D`)

**Prepared:** 2026-06-12 · **For:** the Windows agent / build owner with the **Windows build box** (and, ideally, a **no-AVX test machine or VM**)
**Branch / PR:** `fix/windows-non-avx-launcher` → `develop`
**Status of this doc:** root cause confirmed and adversarially verified on macOS; the one-line fix is **staged but NOT built or hardware-tested** — Zig and the Windows pipeline only exist on the build box. This is yours to validate and ship in the next release cycle.

Full technical write-up: [`docs/windows-non-avx-launcher-crash.md`](./windows-non-avx-launcher-crash.md).

---

## TL;DR

A Windows user on an **Intel Pentium Silver N5030** (Gemini Lake — SSE4.2, **no AVX/AVX2**) gets an instant crash on launch: `0xC000001D STATUS_ILLEGAL_INSTRUCTION` at `KeepKeyVault.exe+0x1b96`.

`KeepKeyVault.exe` is **our own** Zig splash wrapper (`scripts/wrapper-launcher.zig`), and `scripts/build-windows-production.ps1` was building it with **no `-mcpu` flag** → Zig targeted the build box's native AVX2 CPU → an AVX `vmovdqa` landed in `main()`'s prologue → illegal opcode on any no-AVX CPU. **It is not an Electrobun or Bun bug** (both are baseline-clean; the wrapper faults before `bun.exe` runs). Bumping Electrobun would **not** have fixed it.

**The fix (already in this PR):** add `-target x86_64-windows -mcpu=baseline` to the `zig build-exe` line.

## The change in this PR

`scripts/build-windows-production.ps1` (the one `zig build-exe`, ~line 694):

```diff
- & $ZigExe build-exe $WrapperSrc -O ReleaseSmall --subsystem windows "-femit-bin=$WrapperExe"
+ & $ZigExe build-exe $WrapperSrc -target x86_64-windows -mcpu=baseline -O ReleaseSmall --subsystem windows "-femit-bin=$WrapperExe"
```

Plus this handoff and the RCA doc. **Surgical — no other files touched.**

## ✅ Your checklist (next release cycle)

1. **Build** a Windows production bundle from this branch on the build box (Zig 0.15.1/0.15.2 as pinned). Confirm the wrapper compiles and the build completes.
2. **Verify the binary is baseline-clean.** Disassemble the produced `KeepKeyVault.exe` and confirm **zero AVX/VEX** instructions. Quick checks:
   - PowerShell sanity on the PE: `.text` VSize should be ~**0x5A46** (baseline), not **0x5CB6** (the AVX build that shipped in 1.4.3).
   - `llvm-objdump -d KeepKeyVault.exe` → grep for VEX-encoded mnemonics (`vmov*`, `vxor*`, `vpxor`, etc.). Expect **none**. The byte sequence `c5 f9 7f` (the old `vmovdqa %xmm6`) must be absent.
3. **Smoke test on real no-AVX hardware** if at all possible — a Gemini Lake N5030/N4020/J-series box, or a VM with AVX masked off (e.g. a QEMU/VirtualBox profile exposing SSE4.2 but not AVX). The app should now reach the WebView2 window instead of dying at launch.
   - If you can't get no-AVX hardware: the static "0 AVX instructions" check in step 2 is the load-bearing proof. The instant-`#UD` failure mode is deterministic — no AVX bytes → can't raise this fault.
4. **Regression-check on a normal (AVX2) machine** that the app still launches and behaves identically. `-mcpu=baseline` only lowers the ISA floor; it must not change behavior.

## 🔜 Secondary task (recommended, same or next cycle)

After the wrapper fix lets the app reach `bun.exe`, our bundled **Bun 1.3.9** is itself inside an upstream non-AVX regression window (fixed in 1.3.7, regressed at 1.3.9, fully settled by **Bun 1.3.14**). The N5030 has SSE4.2 so baseline 1.3.9 *should* run, but to be safe bundle **Bun ≥ 1.3.14**:

- **Cheapest:** set `build.bunVersion` in the Electrobun app config (override added in Electrobun v1.11; works on our current 1.13.1, and Windows always pulls `bun-windows-x64-baseline.zip`).
- **Or:** bump Electrobun to ≥ 1.18 (ships Bun 1.3.13 baseline — closer, still one short of 1.3.14).

Verify the bundled `bun.exe` banner reads `... Windows x64 (baseline)` and the version is ≥ 1.3.14. Detail + version table in §5 of the RCA doc.

> Note: CPUs **below** SSE4.2 (pre-Nehalem, some QEMU vCPUs) are still broken upstream regardless (bun#30613). Not the N5030's case — out of scope here.

## Risk & rollback

- **Risk: low.** Affects only how the Windows wrapper is compiled; no Mac/Linux impact, no runtime/app-code change. `-mcpu=baseline` is the standard portable floor.
- **Caveat: unverified by the author.** Built and reasoned on macOS; the binary-level reproduction was done by cross-compiling the wrapper source, not by running the shipped pipeline. **Do not promote to a release tag until step 2 (and ideally step 3) pass on the build box.**
- **Rollback:** revert the one line. (You'd be back to the crashing build, so only if the baseline build fails to compile for some unforeseen reason — in which case capture the Zig error and ping back.)

## Why we're confident it's this and not Bun/Electrobun

Verified by disassembling the actual shipped artifacts: Electrobun's `launcher.exe` (v1.13.1/1.16.0/1.18.1) and the bundled `bun.exe` are both genuinely baseline (0 AVX / `(baseline)` banner). The crashing binary's `.text` layout matches **our wrapper rebuilt at `-mcpu=haswell`**, byte-for-byte, with the faulting `vmovdqa` at exactly `+0x1b96` — and the layout does **not** match any Electrobun binary. The crash is in our prologue, before `bun.exe` is exec'd.
