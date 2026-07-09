# Handoff — Bitcoin-only onboarding + separate firmware (SPIKE)

**Branch:** `spike/bitcoin-only-onboarding` (worktree off `origin/develop`)
**Worktree:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-btconly-onboarding`
**Status:** SPIKE — design + de-risk first. These are sensitive, hard-to-reverse flows (firmware variant + seed-lock). Nothing implemented yet.

> Note: there is a stale `keepkey-vault-v11-bitcoin-only` worktree on `feature/bitcoin-only` (behind develop, unrelated dirty submodule) — leave it alone; this spike lives here.

## Goal
During onboarding, offer the user **Bitcoin-only** vs **Multi-coin**. If Bitcoin-only is chosen, install the **bitcoin-only firmware variant** (smaller attack surface, locked-down) instead of the full firmware.

## What already exists (don't rebuild)
- **Bitcoin-only firmware variant** — `BITCOIN_ONLY` build flag (firmware PR #282; CI matrix builds it, #289/#290). Reports `KeepKeyBTC` / `EmulatorBTC` in features (fw `3ac942f5`).
- **Seed-lock** — a bitcoin-only seed is locked to bitcoin-only firmware via storage band `10017` / `STORAGE_VERSION_BTC_ONLY` (fw `d52260c8 feat(storage): lock a bitcoin-only seed to bitcoin-only firmware`). This is the safety rail AND the sharp edge (see risks).

## Blockers (resolve before UI work)
1. **Release pipeline does NOT publish the btc-only binary.** The `v7.14.1` release assets are only `firmware.keepkey.bin` + `HASHES.txt` (checked via `gh release view v7.14.1 --repo keepkey/keepkey-firmware`). The vault installs by fetching `.../releases/download/v${latestFirmware}/firmware.keepkey.bin` (`src/bun/engine-controller.ts:1593`). **The firmware release workflow (`.github/workflows/release.yml` in keepkey-firmware) must publish a second asset** (e.g. `firmware.keepkey-btc.bin`) + its hash, SIGNED like the full one. Without a published, signed btc-only asset there is nothing to install. **Confirm/fix this first.**

## Design (proposed)
Changes span vault + firmware-release:

1. **Onboarding UI** — `projects/keepkey-vault/src/mainview/components/OobSetupWizard.tsx` (2830 lines)
   - Add a `coin-mode` step (new `WizardStep`, ~line 52; `STEP_SEQUENCE` ~line 64) BEFORE `'firmware'`, so the firmware step installs the chosen variant.
   - Copy must state the tradeoff plainly and that it's effectively **one-way** (see seed-lock): Bitcoin-only = BTC + nothing else, cannot later hold ETH/etc. without wiping and reflashing full firmware.
   - Persist the choice into the firmware-install step.

2. **Firmware install** — `projects/keepkey-vault/src/bun/engine-controller.ts:1593` (and the bootloader path ~1539)
   - Parameterize the binary: `firmware.keepkey.bin` vs the btc-only asset name, driven by the onboarding choice. Same signed-install path; only the URL/asset differs.

3. **On-device hash recognition** — `projects/keepkey-vault/src/shared/firmware-versions.ts` (`ONDEVICE_FIRMWARE_HASHES`, ~line 174)
   - Add btc-only full-file SHA-256 entries per version, else btc-only firmware reads as "custom/unsigned". Btc-only has a DIFFERENT full-file hash than the full build.

## Sensitive flows / risks (this is why it's a spike)
- **Variant switch on an initialized device → seed-lock → WIPE/brick risk.** The btc-only seed band (10017) means a btc-only seed won't run full firmware and vice-versa. Reflashing the other variant over an existing wallet can wipe it. Onboarding must only offer the choice on a fresh/uninitialized device; any post-hoc switch needs a loud, explicit wipe-confirm. Reuse the signed→signed storage-retention logic — do NOT let the variant swap silently trip the unsigned-downgrade wipe.
- **Signature verification** — the btc-only `.bin` must be signed and pass `signatures_ok()` exactly like the full build; an unsigned btc-only asset trips the "Unrecognized firmware / take the risk?" bootloader screen.
- **Bootloader/OOB interaction** — installing a variant during OOB onboarding runs through the replug/bootloader cycles. Confirm the variant choice survives the replug sequence.
- **Downgrade/version map** — `firmware-versions.ts` upgrade logic assumes one lineage; btc-only is a parallel lineage with its own hashes.

## Spike deliverables (in order)
1. Confirm/implement the **release pipeline publishes a signed btc-only asset** (firmware repo) — the blocker.
2. Decide the **UX**: where the choice lives, copy, irreversibility warning, fresh-device-only gating.
3. Prototype the **install-variant plumbing** (asset selection in engine-controller + hash map).
4. Device dry-run: fresh device → choose Bitcoin-only → btc-only firmware installs, boots, reports `KeepKeyBTC`, seed-lock holds.

## Key files (full paths, this worktree)
- Onboarding: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-btconly-onboarding/projects/keepkey-vault/src/mainview/components/OobSetupWizard.tsx`
- Firmware install: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-btconly-onboarding/projects/keepkey-vault/src/bun/engine-controller.ts` (~1539 bootloader, ~1593 firmware)
- Hash/version map: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-btconly-onboarding/projects/keepkey-vault/src/shared/firmware-versions.ts`
- Firmware release workflow: `keepkey-firmware/.github/workflows/release.yml` (add btc-only asset)

## Related shipped work (this session, PR #342 → develop)
Clear-sign identity icons (vault/SDK) + Hive account UX (copy + profile links) + swap UX (default output to native gas, EVM summary collapse, search autocorrect off). Firmware 7.15.0-rc7 cut & CI-green on the fork (compass on every clear-sign screen + storage-golden fix).
