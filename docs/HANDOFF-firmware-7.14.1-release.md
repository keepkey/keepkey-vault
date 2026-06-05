# Firmware 7.14.1 Release Handoff

## Status
- [x] Code merged to upstream develop (PR #425)
- [x] `release/7.14.1` branch pushed to `keepkey/keepkey-firmware`
- [x] Tag `v7.14.1` pushed to `keepkey/keepkey-firmware` (annotated → commit `5482e736`)
- [x] Firmware binary built (CI, asset attached 2026-05-30)
- [x] Firmware binary signed (3/5 — slots 1/2/3, all verified against `pubkeys.h`)
- [x] GitHub release published 2026-06-05 (un-drafted; marked Latest)

## Verified hashes (device-verifiable build hash = payload, `tail -c +257`)
Canonical = the **tag-reproducible** build (commit `5482e736`, embeds that hash):
- full signed file : `f40fe1b74949a9e091269536b27cd53bbb8a5c1c428a6c36ff7d5c6bf6845f46`
- payload          : `73a880682d00c725cf9b38347ed0f08f4c2214c2c0f54559739f9d939f6275ae`
- reproducible via `git checkout v7.14.1 && scripts/build/docker/device/release.sh` → `tail -c +257 | sha256`.
- matches `firmware/releases.json` + `manifest.json` (v7.14.1) and release `HASHES.txt`.

### Provenance note
The CI draft originally attached a binary built from branch commit `9e057c2` (2026-05-23),
mislabeled under the `-5482e73-` filename, with payload `e0c05185…`. That binary is
**code-identical** to the tag build — the only difference is the embedded 40-char commit
stamp at code offset 313718 (net source delta between the two commits is CI/emulator/test-client
files only; all device sources identical). It was replaced with the tag-reproducible build so the
documented verify-by-rebuild flow passes.

## Repo
`https://github.com/keepkey/keepkey-firmware`
Tag: `v7.14.1` → commit `5482e736`

## Step 1 — Build the firmware binary

```bash
cd /path/to/keepkey-firmware
git checkout v7.14.1
git submodule update --init --recursive
./scripts/build/docker/device/release.sh
```

Output: `bin/firmware.keepkey.bin` and `bin/firmware.keepkey.elf`

Compute hashes:
```bash
sha256sum bin/firmware.keepkey.bin
tail -c +257 bin/firmware.keepkey.bin | sha256sum  # payload hash (skip 256-byte header)
```

Build on multiple machines and confirm hashes match before signing.

## Step 2 — Sign the binary (3/5 key holders)

Sign `firmware.keepkey.bin` on air-gapped machine with the firmware signing keys.
Replace the unsigned binary with the signed one.

Reference: see how `v7.14.0` was signed at `https://github.com/keepkey/keepkey-firmware/releases/tag/v7.14.0`

## Step 3 — Publish the GitHub release

A draft release may already exist at `https://github.com/keepkey/keepkey-firmware/releases` (created by the Release CI workflow if it passed).

If no draft exists, create the release manually:
- Tag: `v7.14.1`
- Title: `Firmware v7.14.1`
- Attach: signed `firmware.keepkey.bin`, `firmware.keepkey.elf`, `HASHES.txt`
- Publish (un-draft)

## What changed in 7.14.1

- feat(solana): SignOffchainMessage with domain-separated envelope
- feat(ton): Ed25519 SignMessage (AdvancedMode-gated)
- feat(tron): TIP-712 SignTypedHash
- feat(tron): TIP-191 SignMessage + VerifyMessage
- feat(emulator): libkkemu shared library + native macOS build
- fix(tron): drop bogus has_signature/has_address on TronTypedDataSignature
- fix: replace volatile+__sync_synchronize with C11 atomics in ringbuf
- Various "potential fix for pull request finding" security hardening commits
