# Handoff — keepkey-sdk recovery test + RC state (2026-06-30)

## Where we are

- **Firmware RC flashed on device** = `release/7.15.0-rc1` (`e4208305`), reports **7.15.0**.
  - = develop `fbb20505` (CI-green RC: 12 PRs #262–#273) + a version-bump commit.
  - binary `firmware.keepkey.bin` sha256 `589d4246…dc87` (unsigned dev build → "unofficial firmware" warning).
- **Fork develop CI fully green** (`fbb20505`); release-branch CI is 10/11 green — the 1 red is the version-gated `test_ethereum_blind_sign_blocked` (clear-sign batch #255–261 not staged yet — a real 7.15.0 prerequisite, not a defect).
- **Vault:** PR #305 → develop adds "Hive Support" to the 7.15.0 upgrade-preview (release-notes only).

## New: automated recovery test — `tests/recovery/load-verify.js`

A keepkey-sdk device test that **wipes the device, loads a randomly generated BIP-39
seed, and verifies the device derives the same ETH address an independent library
(ethers v6) does** — across word counts, plus edge cases.

**What it exercises (all on the real flashed RC):**
- `WipeDevice` → `LoadDevice` → `ethGetAddress`.
- `LoadDevice` is production-available — `fsm_msgLoadDevice` is gated only by
  `CHECK_NOT_INITIALIZED` + an on-device confirm, **not** `#if DEBUG_LINK`. So no
  cipher and no debug build needed.
- Cases: 12-word load+verify, 24-word load+verify, cross-seed difference,
  determinism (re-load same seed → same address), invalid-checksum rejection +
  device-left-uninitialized.
- Independent derivation verified against the canonical BIP-39 vector
  (`abandon…about` → `0x9858EfFD…da94`), so device vs ethers agreement is meaningful.

**Run:**
```
cd projects/keepkey-sdk
KEEPKEY_API_KEY=<key> node tests/run-all.js recovery
# or a single file after `npm run build`:  node tests/recovery/load-verify.js
```
(Vault must be serving the REST API on `localhost:1646`.)

### ⚠️ Gates / caveats
- **DESTRUCTIVE — wipes the device.** Run only on a **test device with no real
  funds**. It loops wipe/load ~4× and leaves the device holding the last random seed.
- **Human-in-loop:** each wipe/load blocks until you press **Confirm** on the device
  (~7 presses). Same model as the existing `evm-firmware` signing tests.

### What this does NOT cover — the #272 cipher path
`LoadDevice` bypasses `recovery_cipher.c`. The firmware **#272** fix (per-word
validation during cipher recovery + wipe-on-failure) lives in the **on-device CIPHER
recovery** flow (`recoverDevice`), which:
- shows a scrambled keyboard only on the OLED, and
- has no plaintext-mnemonic API (`recoverDevice` takes only `word_count`/`label`/PIN).

So it **cannot be automated on production firmware** without a human reading the
scramble and entering ciphered words, or a `DEBUG_LINK` build that exposes the cipher.
Two ways to cover it:
1. **On-device manual** — the gating matrix `docs/handoff-firmware-rc-7x-test-matrix.md`
   G1–G12 (dry-run-no-wipe G4 is the critical one).
2. **Emulator + DebugLink** — port the python-keepkey recovery tests (they read the
   cipher via `DebugLinkGetState` and auto-enter). Tests firmware logic, not the
   physical device.

## Next steps
1. Confirm the connected device is a throwaway test device, then run `load-verify.js`.
2. If green, extend edge cases (passphrase on/off → different address; 18-word;
   multi-chain `utxoGetAddress`/`xrpGetAddress` spot-checks — note BTC needs a
   non-ethers derivation for an independent check).
3. Decide how to cover #272's cipher logic (manual G1–G12 now; emulator+DebugLink later).
