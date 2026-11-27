# Monero signing on Linux x64 (and Intel Mac via CI): handoff

Repo: https://github.com/keepkey/keepkey-vault. Base is `develop` at `3a110b094`. All file:line references are to that commit. App code is under `projects/keepkey-vault/`.

## 1. Where things stand

- **darwin-arm64: shipped.** The helpers come from the non-app release tag `monero-native-20261117` (`.github/workflows/build.yml:33`, downloaded at `:317-336`). Do not add more assets to that release, or create a release like it, without the owner.
- **win32-x64: merged in #758** at develop `3a110b094`. It is an MSYS2 UCRT64 static build with a PE import allow-list. The CI job `monero-native-win32-x64` is at `build.yml:901-1044`. `windows-unsigned` stages the helpers with `--require` when they are pinned (`:1131-1143`). The pins (full sha256):
  - `monero-host-adapter.exe`: `2f1aaa0eec66bbc341b769885fe3e87da4affdde09ba4c0986b522ac9262a78c` (36456371 bytes)
  - `monero_core_verify.dll`: `a31aad03f8a7dc10cf5ac812ec1928dda6ce858e51e9df09c0c3357cb6f24fee` (16988588 bytes)
- **The product rule:** Monero is gated only by the feature flag plus firmware, never by platform. Linux and Intel Mac are missing only because the helpers are not built and pinned yet.
- **Runtime and packaging are already generic.** Once a platform key exists in both manifests, these pick it up with no code change:
  - `src/bun/monero-core-verifier-artifact.ts:13-22,66-83`: lookup by manifest key. Linux uses the raw reviewed bytes; the signed fallback is darwin-only (around `:72`).
  - `monero-cli/src/host-adapter.ts:10-46`
  - `electrobun.config.ts:35-60`
  - `scripts/build-signed.ts:100-131`
  - `scripts/monero-release-assets.ts:17-26,51-55`: the Linux layout expects bun at `<root>/bin/bun`. UNCONFIRMED that the real tar matches.
  - `scripts/verify-release-bundle.ts:24-25,82-87,104-105`
  - `scripts/check-monero-bundle.ts:13-24`
  - `monero-cli/src/tools.ts:15-17`: the `monero-wallet-rpc` archive pins for linux-x64 and darwin-x64 already exist.
- **What blocks Linux and Intel Mac:**
  - **Manifests:** neither has `linux-x64` or `darwin-x64` entries. Today they have `darwin-arm64` (`host-adapter-manifest.json:43`, `core-verifier-manifest.json:33`) and `win32-x64` (`:55`, `:48`).
  - **Build scripts:** both accept only `TARGETS = {"darwin-arm64": "darwin", "win32-x64": "win32"}`. That is `scripts/build-monero-host-adapter.py:32` and `scripts/build-monero-core-verifier.py:31`; `--target` takes its choices from that dict (`:370` / `:343`).
  - **CI:** no job builds or stages helpers for these platforms. The Linux and macOS x64 legs run only `stage-monero-adapter.ts --if-available` (`build.yml:338-340`).
- `src/bun/monero-device-signing.ts:162` (`createMoneroDeviceSigner`) hard-gates darwin-arm64. I found callers only in tests, so it looks like the research prover. UNCONFIRMED that the product path never uses it. The product path appears to use `createMoneroCoreVerifier` (`:129-131`), which is manifest-driven.

## 2. Machine setup on Linux

```bash
git clone https://github.com/keepkey/keepkey-vault.git ~/work/keepkey-vault
cd ~/work/keepkey-vault
git checkout develop && git pull --ff-only
git rev-parse HEAD           # expect 3a110b094... or newer
git checkout -b feat/monero-linux

git config user.name "highlander"
git config user.email "highlander@keepkey.com"
git config commit.gpgsign true
git config user.signingkey <owner key id>   # owner supplies or imports the key; UNCONFIRMED (GPG or SSH signing)
```

Keep the repo out of `/tmp`.

**Toolchain.** Build the helpers inside a container with glibc 2.35 or older, matching CI. `ubuntu:22.04` (glibc 2.35) is the safe choice. Do not use `debian:bookworm`: its glibc 2.36 is above the floor that the Linux glibc audit enforces.

```bash
sudo apt-get install -y docker.io git python3 perl make cmake gcc g++ pkg-config xz-utils curl
docker pull ubuntu:22.04
docker inspect --format '{{index .RepoDigests 0}}' ubuntu:22.04   # record the FULL digest for CI
```

Inside the container, install `build-essential cmake perl pkg-config python3 xz-utils ca-certificates binutils`.

**Bun and JS.** Use the repo's `make` targets (`make help` at the repo root). Never run npm, pnpm, yarn or `bun run` directly. If a needed target is missing, stop and ask; do not invent one. `monero-cli/prepare.py` maps linux-x64 to `bun-linux-x64-baseline` (`monero-cli/prepare.py:21-22`, `monero-cli/build.ts:6-7`).

**Never read or edit `.env` files.**

## 3. Work items for linux-x64 (in order)

1. **Add the target names.** In `scripts/build-monero-host-adapter.py:32` and `scripts/build-monero-core-verifier.py:31`, add `"linux-x64": "linux"`. Stop treating every target that is not win32 as darwin:
   - Add an explicit `build_linux` branch next to `build_windows`. The dispatch is at adapter `:290` (function at `:174`) and verifier `:280` (function at `:146`).
   - `build()` already checks `sys.platform` and jobs 1..16 (adapter `:250`, verifier `:228`).
2. **Write `build_linux` in each script.** Model it on `build_windows`, and keep all the code inside the script so `buildScriptSha256` covers it (adapter `:64-65`).
   - **OpenSSL:** `perl Configure linux-x86_64 no-shared no-tests no-module no-engine no-legacy no-dso`.
   - **Boost:** `bootstrap --with-toolset=gcc`, then `b2 toolset=gcc link=static runtime-link=shared target-os=linux address-model=64`.
   - **Compile flags:** `-ffunction-sections -fdata-sections -ffile-prefix-map=<work>=. -ffile-prefix-map=<src>=.`. Keep `SOURCE_DATE_EPOCH` and `ZERO_AR_DATE=1` (adapter `:285`). The verifier already applies that environment and its OpenSSL pins for targets other than darwin-arm64 (`:234`, `:253`, `:268-271`), so linux-x64 inherits them.
   - **Link flags:** `-static-libstdc++ -static-libgcc -Wl,--gc-sections`. For the verifier `.so`, add a version script that exports only `monero_core_verify` and `monero_core_plan_size`. This is the ELF counterpart of the `.def` written at verifier `:168-170`.
   - **Link inputs:** drop unpinned system archives from the link, as `windows_link_command` does (`:114`, `:146`). Reuse the aborting unbound stubs (`UNBOUND_UNREACHABLE` `:82`, `windows_unreachable_archive` `:87`) only if GNU ld still needs those references. UNCONFIRMED on ELF.
   - **ELF check (replaces the PE check):**
     - `readelf -d`: NEEDED may contain only `libc.so.6`, `libm.so.6`, `libpthread.so.0`, `libdl.so.2` and `ld-linux-x86-64.so.2`.
     - No `GLIBC_` symbol version above 2.35.
     - The dynamic exports equal `EXPORTS`. This mirrors verifier `:211`.
   - **result.json:** the same fields as win32 (adapter `:234-240`), plus the gcc version, glibc version and container image digest.
3. **Leave the darwin path alone for now.** The darwin-x64 changes are in §6.
4. **First local build.** Run in the container from the repo checkout:
   ```bash
   python3 projects/keepkey-vault/scripts/build-monero-host-adapter.py --target linux-x64 --jobs 4
   python3 projects/keepkey-vault/scripts/build-monero-core-verifier.py --target linux-x64 --jobs 4
   ```
   Do not commit the hash from this run. It only shows the build works; pins come from CI (§5).
5. **Manifest entries (do this last, in a separate pin commit).** Add `files["linux-x64"]` to both manifests with filename, full sha256, size and dependencies. The verifier filename is whatever the pin commit chooses (for example `libmonero_core_verify.so`); no code hardcodes it. Linux entries carry no kernel floor.
6. **Out of scope:** linux-arm64. It is defined in `prepare.py:21-22` but no helper work is planned for it. List it as a future target, not as a platform gate.

## 4. CI jobs to add (`.github/workflows/build.yml`)

1. **New job `monero-native-linux-x64`**, next to `:901`:
   - `runs-on: ubuntu-24.04` with `container: ubuntu:22.04@sha256:<full digest>`. Use apt `=version` pins where practical.
   - `timeout-minutes: 180` and `permissions: contents: read`.
   - Copy the win32 steps:
     - output cache key `monero-native-linux-x64-${{ hashFiles(<the same 6 inputs as :927>) }}` with the image digest string appended
     - the shared archive cache `monero-archives-…` (`:953`)
     - the Python fetch that checks `archivesSha256` (`:956-976`)
     - both scripts run with `--target linux-x64 --jobs 4`
     - log upload on failure (`:989-1006`)
   - **Gate step.** Print `readelf -d` NEEDED, the exports, the full sha256 and the size. If the manifest has no `files['linux-x64']` yet, emit `::warning::` and exit 0. If the pin does not match, emit `::error::` and exit 1. This mirrors `:1008-1032`.
   - Upload the artifact as `monero-native-linux-x64` with 14-day retention. The name must never match `keepkey-vault-*`.
2. **Build matrix.** At `:162-169`, change `needs` to `[devkit, monero-native-linux-x64, monero-native-darwin-x64]` and keep `if: ${{ !cancelled() }}`. This makes the arm64 leg wait as well; accept that or split the job. Add a matrix key `monero-native: linux-x64` on the Linux leg (`:181-185`) and `darwin-x64` on the macOS x64 leg.
3. **Replace `:338-340` for non-arm64 legs.** Mirror `windows-unsigned:1131-1143`:
   - Download the `monero-native-${{ matrix.monero-native }}` artifact only when `needs.monero-native-<p>.result == 'success'`.
   - Run a bun one-liner: exit 0 if both manifests have `files[P]`.
   - If both are pinned: run `stage-monero-adapter.ts --require --source .reviewed-monero/monero-host-adapter` and `stage-monero-core-verifier.ts --source .reviewed-monero/<verifier file>`, and export `MONERO_CORE_VERIFY_DIR` and `KEEPKEY_REQUIRE_MONERO_SIDECAR=1`.
   - If not pinned: emit `::warning::` and keep `--if-available`.
   - With pins present, a missing artifact must fail the leg.
4. **Add `check-monero-bundle.ts --require` to the Linux package step.** It is not in `build.yml` for any leg today.
5. **The Linux glibc audit** ("Audit Linux glibc footprint", around `:520-575`, `LINUX_GLIBC_FLOOR '2.35'`) scans every ELF in `stable-linux-x64-keepkey-vault.tar.zst`. Once the helpers are bundled it gates them automatically. That is why the container must have glibc 2.35 or older.
6. **Release job (`:1264-1272`).** Keep the explicit `needs.X.result == 'success'` checks. Do not add the native jobs to `needs`. Update the comment at `:1270-1271` to name the new jobs. The release must never upload native-helper artifacts.

## 5. Pinning

- Take pins only from a green CI run of the native job on the PR branch, never from a local build.
- Copy the full sha256, size, NEEDED list and exports from the gate step in the CI log. Record them in full and never shorten them.
- Cross-check: download the CI artifact, run `sha256sum` and `stat -c %s`, and compare with the log. Optionally reproduce the same hash in the same container on the Linux box.
- The pin commit changes only the two manifests. Its message must cite the run URL (`https://github.com/keepkey/keepkey-vault/actions/runs/<id>`) and the full hashes.
- After the pin, the next CI run must show the gate passing with no warning, and the Linux leg must stage with `--require`.

## 6. Intel Mac (darwin-x64): CI only

Do not install macOS on the Linux box. The `macos-15-intel` runner covers this. Work items:

1. **Build scripts:** add `"darwin-x64": "darwin"` and pass the target into the darwin path instead of using arm64 literals:
   - `-arch arm64` becomes `-arch x86_64` (adapter `:295`, verifier `:285`)
   - `darwin64-arm64-cc` becomes `darwin64-x86_64-cc` (adapter `:296`)
   - `architecture=arm` becomes `architecture=x86` (verifier `:288`)
   - the lipo check expects `x86_64` (adapter around `:350`)
   - keep minos 13.0 and the LC_UUID checks
2. **Homebrew filter** (adapter `:340`, verifier `:316`): it matches only `/opt/homebrew/`. Add `/usr/local/`, or use `brew --prefix`.
3. **Verifier darwin check (`:325`):** it reads `artifact["dependencies"]` and `artifact["exports"]`, which crashes when no pin exists. Compare against the expected lists directly, as win32 does. The adapter already tolerates a missing pin (`:247`).
4. **Decide deliberately** whether darwin-x64 gets the determinism environment and the OpenSSL pins. They are keyed on target != darwin-arm64 (`:234`, `:253`, `:270`).
5. **New job `monero-native-darwin-x64`** on `macos-15-intel`:
   - Pin Xcode with `xcode-select` (version UNCONFIRMED) and record `xcodebuild -version` and `clang --version`.
   - Gate with `otool -L`, `lipo -archs == x86_64`, and the full sha256 and size against `files['darwin-x64']`.
   - Upload the `monero-native-darwin-x64` artifact.
6. **Manifest entry:** `files["darwin-x64"]` needs `minimumMacosVersion` and `minimumDarwinMajor`, or the host check fails.
7. **Intel packaging conflict.** `collect-externals.ts:413-416` says x64 is derived from the arm64 build. `Makefile:198` and `build.yml:510-512` say a native `macos-15-intel` leg builds it and `make sign-release-intel` then re-signs and re-packs. Treat the comment as stale. The open question is whether `sign-release-intel` writes or preserves `core-verifier-receipt.json` for x64, and whether `scripts/sign-macos-app.sh` re-signs the helpers. Both are UNCONFIRMED. The pin must be on the pre-sign bytes, as for arm64; how the arm64 pins relate to signing is also UNCONFIRMED.
8. **`intel-smoke` (`:1178-1262`):** once the pin exists, add a check that both helpers are `lipo -archs` x86_64. Optionally run `monero-cli/package-smoke.ts`. Gate it on the manifest so it is a no-op before the pin.

## 7. Testing on the Linux machine (real KeepKey, firmware 7.17)

1. **udev rules.** Create `/etc/udev/rules.d/51-usb-keepkey.rules` with the KeepKey vendor `2b24`:
   ```
   SUBSYSTEM=="usb", ATTR{idVendor}=="2b24", MODE="0666", TAG+="uaccess"
   KERNEL=="hidraw*", ATTRS{idVendor}=="2b24", MODE="0666", TAG+="uaccess"
   ```
   Then run `sudo udevadm control --reload-rules && sudo udevadm trigger` and replug. Check that the repo does not already ship this file (UNCONFIRMED). A device missing from rusb enumeration is not proof it is disconnected; the HID fallback may still reach it.
2. **Install the build.** Download `stable-linux-x64-keepkey-vault.tar.zst` from the green CI run that includes the pins, unpack it outside `/tmp`, and run it. Check that `monero-device/` contains both helpers and that their sha256 equals the manifest values in full.
3. Confirm the firmware is 7.17 in the app, then turn on the Monero feature flag in Settings. The exact flag name is UNCONFIRMED.
4. Let the wallet sync. Record the sync height and the time it took.
5. **Receive check.** Show the receive address on the device and page through every page. The full address must appear on the device and match the app character for character. Any ellipsis is a bug.
6. **Send.** Do a small send only after the owner explicitly approves real-money testing. Confirm the full destination and amount on the device, then record the txid and confirmations.
7. **Capture:** app logs, the helper hashes, `ldd` output for both helpers, screenshots or photos of the device pages, sync timing, and the txid.
8. **Pass** means:
   - Monero is available with no platform message.
   - The helpers load with the `--require` build.
   - The receive address matches on every page.
   - The send (if approved) broadcasts and confirms.

   **Fail** means a helper problem or receipt error, a hash mismatch, a glibc error, an address mismatch, or a truncated display.

## 8. Rules for the session

- Commits must be signed as `highlander@keepkey.com`. Add no Co-Authored-By line and no AI attribution in commits, PRs or comments.
- Open the PR with `gh pr create --repo keepkey/keepkey-vault --base develop --head feat/monero-linux`. Keep the PR text short and human.
- No force-pushes to shared branches. Do not delete branches after merge.
- No releases and no tags. In particular, do not add assets to `monero-native-*` releases.
- Never ellipsize hashes or addresses, in docs, logs or on the device.
- Never read or edit `.env`. Ask the owner for credentials.
- No mocks. Unpinned means Monero is unavailable with a warning, never a fake helper.
- Use `make` targets only.
- Copilot reviews only with the owner's OK.
