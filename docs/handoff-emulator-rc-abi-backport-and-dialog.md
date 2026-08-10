# Handoff — Emulator RC ABI gap, firmware backport, and Vault version/seed dialog

**Prepared:** 2026-07-08 · **For:** whoever picks up rc7 cut + the firmware PR
**Repos:** `keepkey-vault` (worktree: `keepkey-vault-v11-release-149`, branch `develop`) · `keepkey-firmware` (worktree: `/private/tmp/.../scratchpad/kkfw-emu-backport`, branch `feat/emulator-poll-thread-backport`, fork `BitHighlander/keepkey-firmware`)
**Status:** Vault-side dialog shipped and running locally. Firmware backport built + ABI-verified locally, **committed but not yet pushed / PR'd / merged**. rc7 not yet cut.

---

## TL;DR

1. `release/7.15.0-rc5` and `rc6` emulator dylibs (and `develop` itself) are **missing the poll-thread FFI API** (`kkemu_start/stop/lock/unlock/trylock`) the Vault's `develop` branch requires to load the dylib at all. Symptom: "Start" does nothing — `kkemu_init` throws `Symbol "kkemu_start" not found`.
2. Root cause: `develop`'s `lib/emulator/libkkemu.c` and firmware's `alpha` branch have **two independently-written implementations** sharing the same file paths (322 vs 573 lines — real `add/add` conflicts on cherry-pick, not a clean history).
3. Fix: wholesale-adopted alpha's version of the emulator subsystem onto a new firmware branch off `develop`. Built and verified locally — all 12 Vault-required symbols present. **Not yet pushed or PR'd.**
4. Added a CI step that would have caught this (asserts the full symbol set after the dylib build) — dry-run confirmed it fails against the old rc6 artifact and passes against the new build.
5. Vault side: added a version/seed control dialog to the existing (already `deviceState.isEmulator`-gated) Emulator section in `DeviceSettingsDrawer.tsx`, plus one new hard-gated RPC (`emulatorRevealSeed`) for emulator-only seed backup.

---

## 1. The ABI gap (firmware)

- Confirmed via `nm -gU`: the `release/7.15.0-rc6` CI dylib artifact (`libkkemu-4504c9d...`, run `28956306972`) exports `kkemu_init/shutdown/write/read/poll/is_running/pop_frame/get_display` but **not** `kkemu_start/stop/lock/unlock/trylock`.
- `git log origin/develop..origin/alpha -- lib/emulator include/keepkey/emulator` shows 7 alpha-only commits (`f75dd420` → `f322fc40`) that never landed on `develop`, hence never on any `release/7.15.0-rc*` branch (all cut from `develop`).
- `release/7.15.0-rc6`'s `lib/emulator/libkkemu.c` is **byte-identical** to `develop`'s — confirms this isn't an rc-specific regression, `develop` itself has always lacked the poll-thread API.
- Diffing `develop` vs `alpha`'s current `libkkemu.c` (369 changed lines against a 322-line file) plus `add/add` conflicts on cherry-pick attempt confirmed these are **not the same file lineage** — a genuine independent rewrite, not a simple divergence.

## 2. The backport (firmware, `feat/emulator-poll-thread-backport`, commit `3461c688`)

Wholesale-replaced (byte-identical to `origin/alpha` tip) rather than cherry-picked, since cherry-picking `add/add` conflicts in threading/memory-safety C code is not something to resolve blindly:

- `lib/emulator/{libkkemu.c,setup.c,udp.c,CMakeLists.txt}`
- `include/keepkey/emulator/libkkemu.h`
- `tools/emulator/CMakeLists.txt`
- **New file** `include/keepkey/board/bsd_compat.h` (strlcpy/strlcat prototypes for glibc/MinGW; force-included on non-Apple emulator builds only — hardware build untouched)

Top-level `CMakeLists.txt` was **surgically** patched (NOT wholesale-replaced) — alpha's version predates and is missing `develop`'s `KK_BITCOIN_ONLY` / `KK_ZCASH_PRIVACY` variant-build flags (PR #282). Only added: `NANOPB_PLUGIN` cache var + the non-Apple `bsd_compat.h` force-include.

`ringbuf.c`/`ringbuf.h` were checked and found **byte-identical** between `develop` and `alpha` already — no change needed there.

**CI hardening** (`.github/workflows/ci.yml`, `python-dylib-tests` job): added a "Verify Vault ABI (exported symbols)" step right after the dylib build, asserting all 12 symbols the Vault's `src/bun/emulator.ts` `dlopen()`s. This is why the gap shipped silently — the existing python-keepkey tests only exercise caller-driven `kkemu_poll()`, never `kkemu_start()`, so a dylib missing the whole thread API still passed CI. Dry-ran the check locally against both the broken rc6 dylib (fails, reports the exact 5 missing symbols) and the new build (passes).

**Local verification:** `cmake -DKK_EMULATOR=ON -DKK_DEBUG_LINK=ON -DKK_BUILD_DYLIB=ON ... && make kkemu kkemulator_dylib` — clean build, macOS arm64. `nm -gU` on the output confirms all 12 symbols. Installed at `~/.keepkey/emulator/libkkemu.dylib`, ad-hoc codesigned, and the Vault was rebuilt (`make vault`) and run against it — user confirmed the emulator now starts.

### Not done yet
- [ ] Push `feat/emulator-poll-thread-backport` to `BitHighlander/keepkey-firmware`
- [ ] Open PR → `develop` (**fork only** — never upstream keepkey/keepkey-firmware, per [[feedback-near-firmware-pr-target]])
- [ ] Get CI green (watch the new ABI-check step specifically)
- [ ] Merge
- [ ] Cut next rc branch — **note: `release/7.15.0-rc6` already exists and was cut before this fix**, so the natural next cut is `release/7.15.0-rc7` unless you want to re-cut rc6. Not decided yet — ask before cutting.
- [ ] Re-download the new rc's CI dylib artifact, re-verify against the Vault dialog
- [ ] Later, on explicit request only: upstream this to `keepkey/keepkey-firmware` (this was called out as a deliberate "step 6," after testing — not now)

## 3. Vault-side: emulator version/seed dialog

File: `projects/keepkey-vault/src/mainview/components/DeviceSettingsDrawer.tsx`, inside the existing `deviceState.isEmulator`-gated "Emulator" `Section`. All new controls reuse existing backend RPCs except one:

- **Firmware version display** (`deviceState.firmwareVersion`, already available — no new plumbing)
- **"Change Version…"** — reuses the existing dylib file-picker install path (`emulatorInstallDylib`); the hidden `<input>` was hoisted to the drawer's top-level return so both the Settings-panel install button and this one share it regardless of which section is open
- **Wallet/seed switcher** — `<select>` over `emulatorListWallets()`, calls `emulatorSwitchWallet`
- **New Seed** (12/18/24-word picker) → `emulatorCreateWallet`
- **Import Seed** (mnemonic textarea, client-side word-count validation) → `emulatorImportWallet`
- **Reveal Seed (Backup)** → **new** `emulatorRevealSeed` RPC (`src/bun/index.ts`), hard-gated server-side on `engine.isEmulator` (same pattern as the existing `verifySeedChallenge`), reads the persisted encrypted mnemonic via `loadMnemonic()`/`getActiveFlashName()` rather than a live DebugLink read (avoids the documented DebugLink-hang risk; the saved mnemonic is the actual backup of record)

Also added: `firmwareVersion`/`channel` fields to `EmulatorWalletInfo` (`src/shared/types.ts`) — these were already populated by the `emulatorListWallets` handler but missing from the type; and RPC-schema entries for `emulatorCreateWallet`/`emulatorGetMnemonic`/`emulatorRevealSeed` (previously untyped despite `emulatorGetMnemonic` already being implemented and unused by any frontend caller).

**Deliberately not built:** no artifact-URL/version-registry system, no GitHub Actions downloader baked into the app — per explicit instruction, this rc6 fetch was a one-off and long-term version delivery should go through upstream artifacts, not app-hardcoded URLs.

## 4. Also on this branch (unrelated, pre-existing WIP found and committed)

Two other commits landed on `fix/clearsign-blob-base64-fulltx` (vault) and its `hdwallet` submodule pointer at session start — reviewed, found complete/coherent, and committed rather than stashed:
- vault: bootloader-mode gate before firmware flash + vendored `firmwareClearSigns` allowlist (Pioneer's `/descriptors/*` endpoints are gone) + new `LoadClearsignSigner` REST endpoint
- hdwallet: `ethLoadClearsignSigner` transport call (msg 117), paired with the above

See [[clearsign-identity-icons]] / [[keepkey-sdk-clearsign-coverage]] memory for the wider clearsign context.

## Next: extended mainnet test suite (separate effort, in progress)

User has asked for a design for an automated, locally-driven, AI-agent-operated mainnet test suite: drive the live emulator through real transactions across every supported chain, capture OLED screenshots for human visual review, verify on-chain, and gate firmware releases on a completed checklist. Research on existing wallet-switching/chain-driving/screenshot APIs is in flight as of this handoff; design doc to follow separately.
