# Overnight release prep — 2026-11-14

Both releases are built and waiting on you. Nothing is published, merged to master, or uploaded to a store.

## KeepKey Desktop 1.7.0 (Electrobun 2.x)

**State**
- Branch `release/1.7.0` on keepkey/keepkey-vault, cut from `feat/electrobun-2x`; develop is still 1.x.
- Head `4587cdc7b`: the version bump `df8c0b5c6`, then the Windows core-only devkit build and Electrobun pin `5605f297`.
- CI on the bump commit was all green: three devkits, Linux x64, macOS arm64 and x64, and the Intel smoke test.
- That run created the **draft** release "KeepKey Desktop v1.7.0", with the Linux AppImage, .deb, update archives and CI's unsigned Intel archive.
- CI on `4587cdc7b` (run 43575709482): all green, and the draft release was refreshed.
- **Signed annotated tag `v1.7.0` → `4587cdc7b`** (tag object `98ee74b8`, good signature by highlander@keepkey.com) is pushed. No tag-triggered CI ran.
- The draft release is marked **pre-release** and targets `4587cdc7b`.
- Release notes draft: `/Users/highlander/keepkey-toolchain/release-notes-1.7.0.md`.

**In this release (since 1.6.12)**
- Electrobun 2.0.6 from keepkey/electrobun (Bun 1.4.4 with the emSign/eMudhra revocation fix).
- The audit v4 fixes: #666 and #667, plus Vlad's #652–#663.
- `POST /api/v2/tx/build` (#668), so the extension builds sends in Desktop.

**You need to do**
1. **Signing credentials.** `make sign-check` fails because `ELECTROBUN_DEVELOPER_ID` is not set in the primary `.env`. Add the Apple values, then I can run:
   - `build-signed` (arm64 DMG)
   - `upload-dmg`
   - `sign-release-intel`
   - `release-sums`
2. **Windows build** on the Windows box from the tag:
   - Stage the certified `libkkemu.dll` (sha256 `859b4d64065c0030181c162c7bd06383d37e676816cd192b350d1ae2810fb101`, copy from `~/keepkey-toolchain/vault-release-1611/projects/keepkey-vault/emulator-bundle/`) in `projects\keepkey-vault\emulator-bundle\`.
   - Run `scripts\build-windows-production.ps1`. It now builds the Electrobun devkit `--core-only`.
   - The first run downloads CEF (166 MB) and unpacks it with Git's bzip2, which needs Git for Windows installed. Later builds reuse `vendors\cef`.
   - Fixed overnight:
     - The fork's Zig unzip failed from PowerShell 7.
     - The full devkit build hung on Rust/Go/Odin toolchains that Desktop doesn't use.
3. **QA** on Win10/11, Linux, macOS arm64 and Intel macOS. Include **updating from 1.6.12 to 1.7.0**, which was never tested.
4. **Publish** with `--prerelease`, never Latest. Then open the release→master and master→develop PRs per the SOP.

**Risks / not verified**
- Signed build, Hutch nested signing of the Monero helpers, a macOS 13 launch, the Windows build and install, and the 1.x→2.x auto-update.
- Windows: the unsigned script build is green on CI (PR #669). The signed build and the install are not verified.


## ⚠ Tag move needs your OK (Windows fixes landed after tagging)
- `v1.7.0` (signed) points at `4587cdc7b`. **Do not build Windows from it.** Four Windows bugs were found and fixed after tagging:
  1. The fork's CEF unpack hung for 150 min, because Windows tar's bzip2 pipe never finished. Fixed in fork `251dcc3e`, which runs Git's bzip2 first.
  2. `hutch electrobun` refused the 512 px PNG as `win.icon` (`PngTooLarge`). Fixed in `3ac11e3a9`, which uses the iconset's 256 px PNG.
  3. The Windows Bun gate could never pass, because Hutch embeds the app icon into `bin\bun.exe`. Fixed in `a2c83239a`: the gate now checks that Hutch's Bun 1.4.4 toolchain copy is the pinned baseline `cb1d8e65…`, that the shipped exe reports 1.4.4, and that its size is within 1 MB (it was +265 KB).
  4. Earlier, also after tagging: the core-only devkit change and the Zig unzip fix.
- **`release/1.7.0` is at `a2c83239a`. Release CI is green** (run 43605840101).
- **Proof that Windows builds:** draft PR #669 (do not merge) runs `scripts\build-windows-production.ps1 -SkipSign` on a GitHub Windows runner. Run 43609502884 is **green end to end** and produced the unsigned `KeepKey-Vault-1.7.0-win-x64-setup.exe` (301 MB, sha256 `0a6a2064…`) as artifact `keepkey-vault-windows-unsigned`. The runner needed only box prerequisites: Zig 0.15.1 in `%USERPROFILE%\tools`, Inno Setup, and device-protocol `lib/` copied in.
- Your rule says to tell you before moving a pushed tag, so I have **not** moved it. Say "move the tag", or run:
  ```
  git tag -d v1.7.0 && git push public :refs/tags/v1.7.0
  git tag -s v1.7.0 -m "KeepKey Desktop v1.7.0" a2c83239a && git push public refs/tags/v1.7.0
  ```
  Then PATCH draft release 445122755 with **both** `tag_name=v1.7.0` and `target_commitish=a2c83239a`. Patching only the target resets the tag to `untagged-*`.
- **QA item:** Windows ships the dev-channel build (`_build\dev-win-x64\keepkey-vault-dev`), as in 1.6.12. Check that a 1.6.12 install keeps its data after upgrading to 1.7.0.

## Extension (BEX) 0.0.40

**State**
- Merged into `develop`:
  - #168, the gateway cutover (handoff §3).
  - #167, building sends in Desktop, including the per-row account type and number and the "From: Native SegWit · Account 2" line on the approval.
- `release/0.0.40` holds the bump `25c47e9`. Its release PR **#169 → master** is open and CI is green.
- Chrome zip, built locally on Node 18: `/Users/highlander/keepkey-toolchain/bex-0040-artifacts/chrome-extension-0.0.40.zip`, sha256 `d63c2ab472e5dd1b16bdcb5f6b86ccce9b2ed6b4ee468207cc051e31d4874a6e`.
- Release notes: `/Users/highlander/keepkey-toolchain/bex-0040-artifacts/release-notes-0.0.40.md`.
- Firefox build is disabled in code, as it was for 0.0.39, so there's no Firefox zip.

**Decisions I made for you (change if you disagree)**
- **TRC-20:** Tron balances stay on the old green `/api/v1/portfolio` request, so USDT-Tron doesn't disappear. **DO green must stay up for Tron** until the gateway returns TRC-20.
- Broadcasts send exactly once. A timeout or 5xx is shown as "result unknown, check the explorer before signing again" instead of being re-sent.
- If one balance source fails on a fresh install with no cache, the panel shows "Couldn't load balances" plus Retry, as 0.0.39 did, rather than a wallet that is silently missing a chain.

**You need to do**
1. A small real send per family (UTXO via Desktop 1.7.0, Cosmos family, XRP, Solana), plus the handoff §5 in-extension checks.
2. Merge #169, tag `v0.0.40`, create the GitHub release with the zip, upload to the Chrome Web Store, then open the master→develop sync PR (RELEASE.md steps 4–8).
3. The 10 sends that build in Desktop need Desktop 1.7.0. Older Desktops show "Update KeepKey Desktop to send <chain>". Ship Desktop first, or at the same time.

## Other overnight changes
- **Fork keepkey/electrobun `keepkey/2.x`:**
  - Linux 22.04 build fix.
  - Windows Zig unzip fix.
  - Demo CI fixes: runner images, Windows tar, pwsh, and timeouts.
- **Desktop:** the Linux app failed to pack on 2.x because 581 node_modules paths were longer than Hutch's 256-character tar limit. Fixed by collapsing those nested copies on Linux (`de4ff3b5d`), the same way Windows already does.
- **GitHub API:** the hourly limit was hit once around 06:00 UTC, from `gh run watch` polling. After that, I checked only with single calls after long sleeps.
