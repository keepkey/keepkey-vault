# Handoff — Windows PR Audit (vault #226/#227/#228 + hdwallet #44)

**Prepared:** 2026-06-07 · **For:** a second agent / human auditor with **real Windows 10 + 11 hardware and a KeepKey**
**Status of this doc:** desk review complete (code traced + adversarially verified on macOS). The remaining work is **Windows hardware validation** — none of these fixes have been run on Windows by their author, and the vault PRs get **no CI** (see §5).

All four PRs are authored by BitHighlander, target a coordinated Windows fix train, and each carries a "not built/compiled locally" caveat. The desk review here was done with a 5-reviewer + adversarial-verification workflow; **where the first-pass review was wrong, this doc shows the corrected conclusion** (notably #228 — see §3).

---

## 1. The PRs at a glance

| PR | Repo | Base | Δ | What it does | Desk verdict |
|---|---|---|---|---|---|
| **#226** `fix/windows-build-gnu-tar-and-sh-eol` | keepkey-vault | develop | +25/−0, 2 files | Prepend Git's GNU `tar` to PATH in `build-windows-production.ps1` (so electrobun's `tar --force-local` extract works vs System32 bsdtar); add root `.gitattributes` `*.sh text eol=lf` | **merge-with-nits** |
| **#227** `fix/windows-usb-detection` | keepkey-vault | develop | +518/−0, 4 files | **FIX-1**: bounded post-attach "discovery poll" in `engine-controller.ts` (+55, additive) for slow WinUSB binding; **3 design docs** (audit + app fix plan + firmware fix plan) | **merge-with-nits** |
| **#228** `fix/windows-per-user-install` | keepkey-vault | develop | +55/−2, 1 file | Force per-user install (`installer.iss`: `{autopf}`→`{localappdata}\Programs`, drop `PrivilegesRequiredOverridesAllowed`, `[Code]` guard rejecting Program Files) — fixes splash-hang from Bun needing write-class rights on read-only Program Files | **merge-with-nits** (see §3 — *not* "needs-work"; the two alleged logic bugs were refuted) |
| **#44** `fix/webusb-stall-and-transfer-timeout` | hdwallet | master | +42/−7, 2 files | `clearHalt("out")`→`clearHalt("in")` + throw on stalled read (both node & browser transports); time-bound node `transferIn`/`transferOut` (`LONG_TIMEOUT`=5min / `DEFAULT_TIMEOUT`=5s) | **merge-with-nits** — one misleading claim to fix (see §4) |

**These touch disjoint files → zero merge-conflict risk among them.** The only coupling is semantic (submodule bump, §5).

---

## 2. What this set fixes — and what it does NOT

**Fixed (app-side, Cause A "timing race" + launch/build issues):**
- Slow-WinUSB-binding "beep but not detected" on hubs/docks → FIX-1 discovery poll (#227).
- Stalled-read wrong-endpoint recovery + infinite-transfer hang → #44 (FIX-3/FIX-4).
- Splash-hang on elevated/Program-Files install → per-user install (#228).
- Windows build break (bsdtar rejects `--force-local`) + CRLF `.sh` → #226.

**NOT fixed (still open — tell the release owner):**
- **Cause B** (poisoned `HKLM\…\UsbFlags\2B24*` `osvc=00 00` cache → WinUSB never binds): no host-side remedy here. Needs FIX-7 (installer registry cleanup) + firmware FW-1/FW-3.
- **Cause C** (conflicting/prior driver binding, Zadig/libusb-win32, or a live app holding iface 0): no Windows `win32` branch / actionable UI. Needs FIX-2.
- App FIX-5 (single-instance lock), FIX-6 (HID hardening), FIX-8 (release handle on quit), FIX-9 (crash supervisor): unimplemented.
- **FIX-10 is only half-done**: #226 adds the `.gitattributes` clause but **NOT** the `windows-latest` CI job (the actual point of FIX-10). There is still no Windows CI anywhere (§5).
- All firmware fixes FW-1..FW-5 (`bcdDevice`-from-version, ≥100ms reconnect pulse, MS OS 2.0 descriptors, remote-wakeup, BOS extension): separate `keepkey-firmware` release.

---

## 3. Per-PR findings (corrected after adversarial verification)

### #226 — GNU tar + .sh EOL  ·  *merge-with-nits, low risk*
Functionally correct and confirmed not a no-op: the PATH prepend at `build-windows-production.ps1:35-38` runs **before** the only `electrobun build` (`bun run build` at `:444`), which is what invokes `tar --force-local -xzf` (electrobun.cjs:97). PATH mutations inherit to all child processes.
- **Nit (comment inaccuracy):** the comment says Git `usr\bin` "contains no link.exe/cl.exe." `cl.exe` is absent, but MSYS2 coreutils ships a `link.exe` (hardlink util). The conclusion still holds **only because** `usb`/`node-hid` use prebuilds (no MSVC link from source) — the real linker user is `cargo build --release` for zcash-cli at `:434`. ⚠️ **Validate on Windows that prepending `usr\bin` does not shadow MSVC `link.exe` during the cargo build.** (Low — depends on whether the build runs from a VS Dev Prompt; see §6.)
- **Nit:** `.gitattributes` comment cites `modules/device-protocol`, which is a submodule (rule doesn't reach it) with zero `.sh` files. The real beneficiary is `projects/keepkey-vault/scripts/patch-electrobun.sh`. Cosmetic.
- **Nit:** `.gitattributes` does **not** retroactively renormalize an existing Windows clone's CRLF `.sh`; new clones are fine and `preflight-windows.ps1:250-275` catches a stale CRLF `.sh`. Optionally add a `git add --renormalize` commit.

### #227 — FIX-1 discovery poll + docs  ·  *merge-with-nits*
**FIX-1 typechecks** despite the "not compiled" caveat — the diff was applied to the real tree and `npx tsc --noEmit --skipLibCheck` produced **0 errors (= baseline)**. It is a faithful mirror of the existing `startRebootPoll`/`stopRebootPoll`; the `MAX_DISCOVERY_POLLS=12` cap is airtight (can't poll forever), `syncState` swallows its own errors (un-awaited call can't crash the worker), and the `updatePhase==='rebooting'` guard prevents fighting the reboot poll.
- **Nit (real, low):** `startDiscoveryPoll()` is **not gated to win32**. On macOS/Linux, every device-less startup runs ~12 `syncState()` cycles (~18s of USB enumeration + per-tick log spam) then stops. Bounded and harmless, but the author's own FIX-1 doc scopes the optional poll to "Windows only." Consider `process.platform==='win32'` gate or quieter logging.
- **Nit (real, low):** the **detach handler does not call `stopDiscoveryPoll()`** (`engine-controller.ts:268-285`). A device unplugged mid-grace keeps the poll running uselessly until the ~18s cap. Trivial one-line add; matches intent.
- **Nit:** no re-arm after the 18s cap — a device binding slower than ~18s stays undetected until app restart (author-acknowledged; the optional always-on Windows poll would close it).
- **Docs:** spot-checked load-bearing `engine-controller.ts` file:line claims (`ATTACH_DELAY_MS=1500@:50`, `getDeviceList@:303`, `syncing@:659`, scheduleRetry arming `@:783`, etc.) — **all accurate** (±1 line on a couple of insertion anchors). Firmware-repo claims not verified (separate repo, out of scope).

### #228 — per-user install  ·  *merge-with-nits  (⚠️ first-pass review was WRONG on the two "high" items)*
> **Read this:** the initial reviewer flagged two **high** logic bugs — (a) the `[Code]` guard's `{commonpf}`/`{commonpf32}` "remap to the per-user path under `PrivilegesRequired=lowest`," causing it to block the default path and miss real Program Files; (b) the stale-install warning checks the wrong dir. **Adversarial verification REFUTED both.** Per Inno Setup docs, only the **`auto` family** (`{autopf}`) remaps with elevation; **`{commonpf}` always resolves to `C:\Program Files`** (changes only with 32/64-bit install mode, and `ArchitecturesInstallIn64BitMode=x64compatible` keeps it at the real Program Files). So:
> - The default `%LOCALAPPDATA%\Programs\…` path is **not** a prefix of `C:\Program Files` → `IsUnderProgramFiles` returns False → the wizard advances cleanly. ✅
> - A literal `C:\Program Files\…` target **is** correctly caught and rejected. ✅
> - The `InitializeSetup` warning's `StaleDir := {commonpf}\…` **correctly** points at the old all-users dir and **will** fire. ✅ (The reviewer's "fix the constant" recommendation is itself wrong — `{autopf}` would resolve to LOCALAPPDATA here and *miss* the stale install.)

Remaining **real** items (lower severity):
- **Medium (verify on Windows):** `InitializeSetup`/`NextButtonClick` use `MsgBox`. On `/SILENT` (no `/SUPPRESSMSGBOXES`) these can block an unattended install. **If any channel runs setup.exe silently (MDM/Chocolatey/enterprise), gate the prompts on `not WizardSilent`.** Also a fully silent `/DIR="C:\Program Files\…"` bypasses the interactive `wpSelectDir` guard. (Not verified — decide intended silent behavior.)
- **Low (acknowledged, release-note):** `AppId` unchanged + install dir moved HKLM→HKCU strands the old all-users uninstall entry (two Add/Remove entries; old one points at read-only Program Files; removal needs admin). Author calls this out; the new InitializeSetup warning does fire for it. No migration/`[UninstallDelete]` (intentional — `[InstallDelete]` was removed in `b02a17db` for "nuking files on upgrade").
- **Low:** the Bun-`FILE_WRITE_ATTRIBUTES`-on-read-only-Program-Files root cause is internally consistent but **unverified on hardware** and supersedes earlier packaging-based launch-failure theories. Needs the EPERM-vs-boots A/B confirmation (§6).
- Pascal `[Code]` is syntactically valid (would compile). CI never compiles the `.iss` (§5) — compile with ISCC on the build box before merge.

### #44 — clearHalt + transfer timeouts  ·  *merge-with-nits*
Both mechanical changes are correct: `clearHalt("in", …)` targets the IN pipe a stalled `transferIn` actually halts (old `"out"` was the wrong endpoint), and unconditionally throwing `"bad read"` on stall is strictly safer than the old fall-through. The libusb infinite-timeout (`endpoint.timeout=0`) is real, so bounding transfers is a genuine fix. **Both changed files pass `prettier` + `eslint --max-warnings=0` cleanly** (verified by running them).
- **Medium (the one to decide — verified HOLDS):** the PR comment claims that on read-timeout "the caller's disconnect path closes the device, which … releases the claimed interface." **Traced: that disconnect path does NOT run on the sign/address RPC paths.** `readChunk` throw → `hdwallet-keepkey/src/transport.ts` `read()/readResponse()/call()` (no catch; `call()`'s `finally` only resets a flag) → vault RPC sign handlers (`index.ts:576`, `:1484-1508`) re-throw bare with no `clearWallet()`. The **only** thing that closes the device on a read failure is `clearWallet()→keyring.removeAll()→wallet.disconnect()`, reached only in `syncState`'s already-paired `getFeatures` catch (`engine-controller.ts:677-680`). So on the most likely Windows failure (wedged device mid-sign), the interface is **not** released at timeout — exactly what the companion audit (#227 FIX-3) warned against: *"the release must happen in the transport."* Tempered to medium because (i) the primary win — bounding an infinite transfer — is real, (ii) the next USB event / `syncState` likely reactively heals it, (iii) worst case is a transient false "in use" on reconnect, not data loss. **Action:** either release the interface in the transport on timeout (`clearHalt`+`releaseInterface(0)`+`close()`), or wrap the sign/address RPC calls with a catch that runs `clearWallet()`; **and fix the misleading PR comment.** Must be validated on Windows (mid-sign unplug → next plug pairs without code-19).
- **Low:** the post-stall `clearHalt("in", …)` control transfer is itself **not** time-bounded → can hang on a wedged device (reintroduces an unbounded block right after the bounded read). Wrap it in `withTransferTimeout(…, DEFAULT_TIMEOUT, "clearHalt")` and/or ignore its failure.
- **Nit:** on the **node** transport the old `clearHalt("out")` was effectively dead code (node's transferIn returns `{status:"stall"}` with no `data`), so the real stall-buffer-leak fix lands in the **browser** transport + the direction correction. Don't over-credit the node stall fix in the changelog.
- **CI red is a false signal:** `build (18)` fails on pre-existing `zcash.ts`/`zcash.test.ts` prettier/eslint breakage on master (target of separate **hdwallet PR #41**), **not** #44's files. #41 (or the zcash fix) must merge first for #44's CI to go green.

---

## 4. The single most important code decision for the auditor
**#44's interface-release strategy.** The PR ships a `Promise.race` that throws on timeout and relies on the caller to disconnect — the exact approach #44's own companion audit (#227 `WINDOWS-USB-FIX-PLAN.md` FIX-3) says is insufficient ("must happen in the transport"). Desk-verified that the caller disconnect does **not** run on sign/address paths. **Decide before merge:** (a) accept the deferred/reactive recovery and just fix the PR comment wording, or (b) implement in-transport teardown. Either way, **reproduce on Windows**: start a tx-sign, unplug mid-read, confirm the next `claimInterface(0)` succeeds (no LIBUSB code 19 / false `ConflictingApp`).

---

## 5. Cross-PR coordination (must-do for the release owner)

1. **No CI on the vault PRs (HIGH).** `.github/workflows/build.yml` triggers only on `push`/`pull_request` to `[master, 'release/*']` — **not `develop`**. `gh pr checks` → "no checks reported" for #226/#227/#228; `develop` has **no branch protection**. The matrix is **ubuntu + macOS only — no Windows runner at all**, so `build-windows-production.ps1` (the file #226 edits) is never exercised on any branch. **Gate:** re-target to a `release/*` branch, or require a `release/*` preflight CI pass before any of this reaches `master`/a tag.
2. **Merge order (semantic, files are disjoint so order is otherwise free):**
   1. Merge **hdwallet #44** to hdwallet `master` (after #41/zcash-lint goes green).
   2. Merge vault **#226 / #227 / #228** to `develop` (any order).
   3. **Follow-up vault PR bumps `modules/hdwallet` gitlink** (currently `0ba6f0f5`, **pre-#44** — its transport still has the old `clearHalt("out")`/no-timeout code) to a post-#44 commit **and runs `make modules-build`** so the `file:` deps re-copy. **Until that bump, FIX-3/FIX-4 are merged but NOT live in the vault.** hdwallet is a Tier-1 submodule (must be clean for release).
3. **Doc-vs-code drift to fix in #227 (medium):**
   - FIX-3/FIX-4 text says reads use "~90s matching `core.LONG_TIMEOUT`." `LONG_TIMEOUT` is actually **300000ms = 5 min**, and #44 correctly uses 5 min — so the **doc's "90s" is wrong**. A maintainer trusting it could "fix" the code down to 90s and break long tx-sign confirmations. Change doc to "5 min (`core.LONG_TIMEOUT`)."
   - FIX-3 says interface release "must happen in the transport," but #44 ships the caller-disconnect race. Reconcile the doc with the shipped approach (or change the code — see §4).
4. **#228 is orthogonal** to the USB-detection track (it's a launch-hang/install fix, not in #227's FIX-1..FIX-10 plan). Review on its own merits; don't block it on the others.

---

## 6. Windows hardware test plan (the load-bearing validation)

> KeepKey is connected. Run on **both Win10 and Win11**. Capture logs (`vault-backend.log`) where noted.

**#227 FIX-1 (primary Cause-A repro):**
- [ ] On a USB-3 **hub/dock** that currently shows "chime but not detected," launch Vault, **then** plug in the KeepKey → detected within ~15s, **no app restart**. Logs show `[Engine] Starting discovery poll` and that it stops after pairing (no idle CPU / log churn).
- [ ] Firmware-update interaction: run a fw/bootloader update (enters `updatePhase='rebooting'`, reboot poll active); on re-attach, confirm the discovery poll self-stops on its first tick and reconnection completes once (no duplicate pairing).
- [ ] (If FIX-1 detach-stop is added) unplug within ~5s of attach → poll stops immediately.

**#44 transport (only AFTER the submodule pointer is bumped & bundle rebuilt — see §5):**
- [ ] **Mid-sign wedge:** start `btcSignTx`/`ethSignTx`, physically unplug during the read → clean error eventually surfaces (~5 min `LONG_TIMEOUT`); **immediately re-plug → next pair succeeds with NO LIBUSB code-19 / false `ConflictingApp`.** (This is the unproven assumption behind §4.)
- [ ] **Long-confirmation survival:** PIN, passphrase, and a tx-sign left on the confirm screen >90s (up to ~4 min) — none time out early.
- [ ] Non-sign wedge (idle reconnect/getFeatures fail) → `clearWallet()` runs, next plug recovers (the path the PR's claim *is* true for).

**#228 installer:**
- [ ] Compile `installer.iss` with **ISCC** on the build box (CI never does).
- [ ] Standard (non-admin) interactive install → accept default dir, click Next → **advances cleanly** (no false "must be per-user" error). Lands in `%LOCALAPPDATA%\Programs\KeepKeyVault`; app boots **past the splash**.
- [ ] Type `C:\Program Files\KeepKeyVault` in the dir box → guard **rejects** it.
- [ ] Pre-existing all-users install present → `InitializeSetup` warning fires and shows the **`C:\Program Files`** path; confirm two Add/Remove entries coexist.
- [ ] **If silent installs are used anywhere:** run `/SILENT` with a stale dir present → confirm the `MsgBox` does NOT block (currently it can).
- [ ] **Root-cause A/B:** copy the byte-identical bundle to **both** `C:\Program Files\KeepKeyVault` and `%LOCALAPPDATA%\Programs\KeepKeyVault`; double-click each at medium integrity → Program Files copy fails with `EPERM reading …Resources\main.js`, LOCALAPPDATA copy boots + writes a fresh `vault-backend.log`. Capture both.

**#226 build:**
- [ ] Clean Windows box with electrobun core **not yet cached** (delete `node_modules/electrobun/.cache` + `bin/electrobun.exe`) so the `tar --force-local -xzf` path actually runs → no "`Option --force-local is not supported`" abort.
- [ ] After the PATH prepend, `where.exe tar` → first hit is `…\Git\usr\bin\tar.exe`, `tar --version` → "GNU tar" (not bsdtar).
- [ ] Full `build-windows-production.ps1` **from the release VS Dev Prompt** → `cargo build --release` (zcash-cli, `:434`) succeeds; `usb`/`node-hid` load from prebuilds (no `node-gyp rebuild`); **MSVC `link.exe` not shadowed**.
- [ ] Fresh Windows clone (`core.autocrlf=true`) → `*.sh` check out LF; `preflight-windows.ps1` passes the EOL check.

---

## 7. Open questions for the human
1. Re-target #226/#227/#228 to `release/*` for CI, or rely on a manual `release/*` preflight before `master`? (develop = zero CI.)
2. **#44 interface-release:** accept caller-disconnect + fix the comment, or implement in-transport teardown before merge? (§4)
3. Who owns the post-#44 `modules/hdwallet` pointer-bump PR? Without it FIX-3/FIX-4 aren't live.
4. Make the #227 doc fixes ("90s"→"5 min"; FIX-3 wording) before merge, or as a doc-only follow-up?
5. Is `build-windows-production.ps1` always launched from a VS Dev Prompt (vcvars)? (Bounds the #226 `link.exe`-shadow risk; the script doesn't call vcvarsall itself.)
6. Are any of the produced setup.exe ever run `/SILENT`? (Decides whether #228's MsgBoxes need a `WizardSilent` gate.)

---

## Appendix — provenance of this review
5 deep reviewers (one per PR + a cross-cutting reviewer) over the real code, then every blocker/high finding adversarially re-checked against source. Net corrections from the verification pass: **#228's two "high" guard bugs → refuted** (the `{commonpf}` remap premise was false); **#228 stranded-uninstaller → low** (acknowledged); **#44 interface-leak → medium** (holds but tempered); **"no CI on develop" → high** (holds, if anything understated — no Windows runner exists). Firmware-repo file:line claims in #227's docs were not verified (separate repo). Nothing here was run on Windows — that's §6's job.
