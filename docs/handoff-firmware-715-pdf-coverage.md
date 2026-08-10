# Firmware 7.15-rc2 — PDF Test-Report Coverage Audit (Handoff, 2026-07-02)

**Mission:** the CI-generated PDF test report is the release gate artifact. Before 7.15
ships, the PDF must show **in-report, real-OLED-screenshot proof** that the three new
headline features — **Hive, Zcash Orchard, EVM Clear-Signing (Insight)** — work.
Today it shows none of that. This doc is the audit of why, the exact iteration
workflow to fix it, and the per-feature acceptance criteria.

---

## Where we are (audited 2026-07-02, develop tip after Hive merge)

Source run: `BitHighlander/keepkey-firmware` CI run **28551715652** (develop push
"fix(build): split hive nanopb generation", green). Artifacts reviewed: `test-report`
(PDF), `oled-screenshots`, `python-test-results` (junit.xml 459 tests / junit-screenshots.xml 83).

PDF header: **"Firmware 7.14.1 | 135 tests: 125 passed, 10 pending"**.

### Root cause #1 — version still 7.14.1
`CMakeLists.txt` on develop: `VERSION 7.14.1`. Cascades everywhere:
- Every test with `requires_firmware("7.15.0")` **skips**: all 5 Hive tests, all 16
  clear-sign device tests, 9 zcash display-address/seed-fingerprint tests.
- The report generator drops whole sections below min-fw: `render()` does
  `active = [s for s in SECTIONS if ver_ge(fw_version, min_fw)]` — the **V section
  (EVM Clear-Signing, min 7.15.0) is silently excluded from the PDF**.

### Root cause #2 — stale python-keepkey pin
Firmware develop pins `deps/python-keepkey` = `452ca986` (branch
`reconcile/upstream-sync` on BitHighlander/python-keepkey). That pin:
- Has **no Hive section** in `scripts/generate-test-report.py` SECTIONS (grep "hive" = 0
  hits). Even after a version bump, Hive stays invisible in the PDF.
- Its compiled protos **lack `GetBip85Mnemonic`** → all 6 BIP-85 tests skip via
  `requires_message()` ("not supported by this firmware build") even though bip85 IS
  in develop's `messagemap.def`. Suspect Hive protos may be similarly missing/stale —
  verify against the device-protocol release branch (`up/release-protocol`, PR #111).
- Zcash catalog only lists 9 tests (4 FVK + 5 PCZT); the 9 display-address +
  seed-fingerprint tests exist in the suite but are **not in SECTIONS** → never shown.

### Root cause #3 — screenshot frame picker leaks setup frames
`_pick_best_frame`/`_is_setup_frame` in the generator let the **"IMPORT RECOVERY
SENTENCE"** load-device frame and near-blank PIN/lock frames through as the
"representative" screenshot for many tests (all of Z section, most of TON/TRON,
several Solana). The Zcash section's only two images are a setup frame and a blank
unlock frame. There is **no shielded-confirm OLED screen anywhere in the PDF**.

### Feature-specific capability gaps (a version bump alone won't fix)
- **Zcash Z5–Z7** (single/multi Orchard action signing + 64-byte sig check) skip with
  *"Legacy sighash-only mode requires header/orchard digests in current firmware"* —
  a firmware capability gap. Decide: implement header/orchard digests for the PCZT
  legacy-sighash path, or explicitly document these as post-7.15 in the PDF.
- **C31** (bip39 invalid-word rejection, the high-risk #272 feature) also pending.

### What's already good
Mature chains are solid and well-screenshotted: BTC 28/28, ETH 16/16 (incl. E5b
chunked-EIP-1559 regression), XRP/ATOM/RUNE/MAYA/EOS, Solana 13/13, TRON 6/6, TON 8/8.
The 13 offline clear-sign serializer unit tests (V1–V8 class) pass. The report
infrastructure works — the rc2 content is just gated off.

---

## The iteration workflow (agreed with user)

We **continually update our python-keepkey branch and re-pin it into firmware develop
PRs to drive the test flow**. CI builds the kkemu emulator from firmware source and
runs the pinned python-keepkey tests against it, then generates the PDF — so the pin
is the only coupling.

Loop (repeat until acceptance criteria below are met):

1. **Edit tests + report generator** on `BitHighlander/python-keepkey` branch
   `reconcile/upstream-sync` (the branch develop pins). Changes land in:
   - `tests/test_msg_*.py` (new/fixed tests)
   - `scripts/generate-test-report.py` (SECTIONS catalog, screenshot specs, frame picker)
   - `deps/device-protocol` pin inside python-keepkey if protos are missing
     (Hive msgs 1600–1609, GetBip85Mnemonic) — use the release-protocol branch
     (`BitHighlander/device-protocol:up/release-protocol`, upstream PR #111).
   Keep upstream **python-keepkey PR #196** (the release-tests PR) pointed at this
   same branch so it stays in sync automatically.
2. **Re-pin in firmware**: branch off `origin/develop`, bump `deps/python-keepkey`
   to the new SHA (plus `CMakeLists.txt`/other firmware fixes as needed). Push as a
   `fix/**` branch — **CI runs on push to fix/** (alpha/stage PRs get no CI; this
   is the known trick, see memory `fw-715-staging-stack`).
3. **Pull artifacts + review**:
   ```bash
   gh run list --repo BitHighlander/keepkey-firmware --branch <branch> --limit 3
   gh run download <run-id> --repo BitHighlander/keepkey-firmware \
     -n test-report -n oled-screenshots -n python-test-results -D out/
   ```
   Read the PDF (it's the deliverable — judge it, not just the junit). Check:
   junit skips (grep `skipped` messages), section presence, screenshot frames.
4. **Merge**: when green AND the PDF shows the feature properly, PR the pin-bump
   into develop (one green PR at a time, per the release SOP).

Local fast loop (no CI wait): `scripts/emulator/` docker compose —
`DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose up --build python-keepkey`
(arm64 Mac gotchas in memory `insight-clearsign`: drop kkemu `ports:` from the base
compose if a native kkemu holds UDP 11044/11045).

### Immediate work queue (ordered)
1. **Bump firmware version → 7.15.0** in `CMakeLists.txt` on develop (own PR, trivial,
   unblocks everything gated).
2. **python-keepkey pin refresh**: rebuild protos against release device-protocol so
   `GetBip85Mnemonic` + Hive messages exist → BIP-85 (6) and Hive (5) tests actually run.
3. **Add Hive SECTION** to generate-test-report.py (letter must be unused — H is
   THORChain; use e.g. `G`): catalog the 5 existing tests + screenshot specs, and
   EXPAND coverage (see criteria below).
4. **Fix the frame picker**: setup frames ("IMPORT RECOVERY SENTENCE", blank/lock
   frames) must never be selected as a test's representative frame; prefer frames
   containing feature keywords (SEND/CONFIRM/APPROVE/SIGN/VERIFIED/SHIELDED…).
5. **Add the missing zcash tests to SECTIONS** (display-address ×2, seed-fingerprint ×7)
   and add screenshot capture for the shielded-confirm screen.
6. **Z5–Z7 decision**: implement header/orchard digests in firmware, or mark as
   documented post-7.15 gaps in the PDF description text (no silent pendings).
7. Re-run full loop; verify V section (clear-sign) now renders with device tests
   passing + screenshots.

---

## Acceptance criteria — "PDF proof" per feature

A feature is release-ready only when the **PDF itself** shows all of the below
(green checkmarks + real OLED frames, not setup screens, in the feature's section):

### Hive (new section, e.g. G) — currently 0% visible
- [ ] Section exists in SECTIONS catalog with user-flow description.
- [ ] `test_hive_get_public_key_active` + `all_roles` PASS (owner/active/posting/memo).
- [ ] `test_hive_sign_transfer` PASS **with OLED screenshot** of the transfer confirm
      (amount + recipient account visible).
- [ ] `test_hive_sign_account_create` PASS **with OLED screenshot** of the
      account-create confirm (attestation flow — the thing vault actually uses).
- [ ] `test_hive_sign_account_update` PASS.
- [ ] Coverage additions: reject-path test (user cancels), wrong-role key test.

### EVM Clear-Signing / Insight (section V) — exists but hidden
- [ ] V section renders in the PDF (needs version ≥ 7.15.0).
- [ ] V1–V8 (serializer/verify unit) PASS.
- [ ] V9 binding happy path PASS **with screenshot of the VERIFIED-icon screen**
      showing decoded method + args.
- [ ] V10 replay-reject (metadata bound to tx A, sign tx B refused) PASS.
- [ ] V11 AdvancedMode gate (blind data hard-rejected when OFF) PASS **with the
      rejection screen captured**.
- [ ] V12 cancel-clears-metadata PASS.

### Zcash Orchard (section Z) — 6/9, wrong screenshots
- [ ] Z1–Z4 FVK tests PASS (already do).
- [ ] Z8/Z9 transparent-shielding PASS **with a real confirm screenshot** (currently
      shows setup/blank frames).
- [ ] Z5–Z7 either PASS with **shielded-action confirm screenshot** (amount + fee on
      OLED) or the section text explicitly states the legacy-sighash limitation and
      why it doesn't block release.
- [ ] Display-address + seed-fingerprint tests (9) added to catalog and PASS, with
      the z-address display screenshot.

### BIP-85 (section D) — 0/6 running
- [ ] All 6 tests PASS (needs proto in the pin; feature is already in firmware).
- [ ] Screenshot of the derivation-params confirm screen (word display itself is
      fine to capture — CI uses the public all-all-all test seed).

### Report hygiene (cross-cutting)
- [ ] Header reads Firmware 7.15.0.
- [ ] Zero setup-frame ("IMPORT RECOVERY SENTENCE") or blank images anywhere.
- [ ] Every `[NEW]` section has ≥1 meaningful feature screenshot.
- [ ] Pending count only contains items with an explicit written justification in
      the section text. No silent skips: any junit skip whose test is in SECTIONS
      must surface as a visible pending with reason.

---

## Key references
- Report generator (real one): `deps/python-keepkey/scripts/generate-test-report.py`
  (firmware `scripts/generate-test-report.py` is just a merge-junits shim).
- Section gating: `render()` → `ver_ge(fw_version, min_fw)`; screenshot phase driven
  by `screenshot_filter(fw_version)` — adding screenshots to a SECTIONS entry
  auto-includes the test in CI Phase 1.
- Skip machinery: `tests/common.py` → `requires_firmware()` (Features version) and
  `requires_message()` (message class present in compiled keepkeylib pb2 modules).
- Pins at audit time: firmware develop `deps/python-keepkey=452ca986`
  (reconcile/upstream-sync); upstream PRs: device-protocol **#111**, python-keepkey
  **#196** (keep branches synced — firmware pins the branches).
- Prior art for the V-section flow incl. 356-screenshot run on alpha: memory
  `insight-clearsign` + `scripts/emulator/` compose setup.
- Release SOP: `docs/firmware-release-sop.md` (upstream-first, in-order merges).
