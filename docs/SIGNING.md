# macOS Release Signing SOP

This is the production procedure for KeepKey Vault macOS releases. Signing,
notarization, and checksum verification prove artifact identity; they do not
prove that an application can execute. Structural and runtime verification are
separate mandatory gates.

The supported deployment target is macOS 13.0 or later for both Apple Silicon
and Intel. Changing that floor is a product decision and must not be folded into
an emergency packaging repair.

## Stop conditions

Do not sign or publish a macOS artifact when any of these is true:

- the complete application bundle has not passed `audit-macos-bundle.sh`;
- any Mach-O file lacks the advertised architecture;
- any Mach-O file requires a newer macOS than the declared release floor;
- the architecture's `node-hid` native prebuild is absent;
- the Electrobun core provenance, version, or SHA-256 is unknown;
- the packaged backend has not been launched on the target architecture;
- a KeepKey has not connected successfully on the target architecture;
- the source commit, submodule pins, release version, and draft tag disagree;
- notarization, stapling, Gatekeeper assessment, or post-upload hashes fail.
- the configured Developer ID identity is not present in the active keychains.

If an architecture fails, withhold that architecture. Never publish a known-bad
binary merely because the other architecture is ready.

## Architecture contract

| Artifact | Required architecture | Deployment ceiling | Runtime test |
| --- | --- | --- | --- |
| `*-arm64.dmg` | every required Mach-O contains `arm64` | 13.0 | Apple Silicon Mac + device |
| `*-x86_64.dmg` | every required Mach-O contains `x86_64` | 13.0 | Intel Mac + device |

Universal native libraries are acceptable when they contain the required
slice. Thin binaries for the other architecture are not.

The Intel application is currently derived from the ARM-built application.
Consequently, the source application must retain both Darwin `node-hid`
prebuilds until the two architecture-specific artifacts have been assembled.
The conversion must audit the complete result, not only `launcher` and `bun`.

## 1. Prepare the release commit

1. Work from a clean release branch based on the intended `develop` commit.
2. Confirm `projects/keepkey-vault/package.json` contains the intended version.
3. Confirm all submodule gitlinks point to reviewed canonical commits.
4. Run `make preflight`.
5. Record the source commit and submodule SHAs in the release evidence.
6. Do not create a public release or tag yet.

## 2. Prepare and pin the Intel Electrobun core

The Intel core must be immutable and reproducible. Do not overwrite an existing
`electrobun-x64-core-vN` asset. Increment the tag for every rebuild and record:

- Electrobun source commit;
- Bun version and download SHA-256;
- build-host macOS and Xcode versions;
- deployment target;
- SHA-256 of the resulting core archive;
- architecture and minimum-OS report for every included Mach-O file.

Build the candidate with `make build-electrobun-x64-core`.

Before publishing it, verify `launcher`, `bun`, `extractor`,
`libNativeWrapper.dylib`, and `libasar.dylib`. Helper executables used by the
packaged application must either have x86_64 builds or be removed from the
Intel bundle. A vendored `libasar.dylib` is not trusted solely because its file
name contains `x64`; its load commands must pass the macOS 13 ceiling.

Only after review, publish a new, never-before-used core tag and update the
workflow to its exact tag and SHA-256. Asset replacement with `--clobber` is
forbidden for production core inputs.

## 3. Build unsigned candidates

Push the release branch and allow CI to assemble unsigned candidates. CI must
run this gate against each final application before packaging:

```bash
scripts/audit-macos-bundle.sh /path/to/keepkey-vault.app arm64 13.0
scripts/audit-macos-bundle.sh /path/to/keepkey-vault.app x86_64 13.0
```

The audit recursively checks Mach-O architecture and minimum OS versions, plus
the architecture-specific node-hid prebuild. A failed audit is a release
failure, not a warning.

The required `intel-smoke` job runs on GitHub's native `macos-15-intel`
runner. It imports the packaged node-hid module using the packaged Bun runtime
and launches the packaged application. This catches architecture, dyld, native
module, and immediate-startup failures. It does not replace the physical
KeepKey connection test because hosted runners have no device attached.

## 4. Sign locally

Signing credentials live in `.env` and must never be committed:

| Variable | Purpose |
| --- | --- |
| `ELECTROBUN_DEVELOPER_ID` | Developer ID certificate name |
| `ELECTROBUN_TEAMID` | Apple Team ID |
| `ELECTROBUN_APPLEID` | notarization Apple ID |
| `ELECTROBUN_APPLEIDPASS` | app-specific password |

Run `make sign-check`, then use:

- Intel CI artifact: `make sign-release-intel`
- locally built Apple Silicon artifact: `make build-signed`

`_sign-one-dmg` performs the structural audit before signing and again after
signing. `scripts/sign-macos-app.sh` signs native code inside-out and gives the
Bun runtime the JIT entitlements it requires. Never invoke `codesign --deep` as
a substitute for the signing script.

The entitlement set is in `projects/keepkey-vault/entitlements.plist`. Bun must
retain `com.apple.security.cs.allow-jit`. Camera authorization comes from
`NSCameraUsageDescription`; do not add the sandbox camera entitlement.

## 5. Verify the signed artifacts

For each architecture:

1. Mount the final DMG on a matching physical Mac.
2. Copy Vault to `/Applications` and launch that exact copy.
3. Confirm the backend reaches ready state with no native-module error.
4. Connect a real KeepKey and confirm enumeration plus a non-signing public-key
   or address operation.
5. Quit and relaunch once with the device already attached.
6. Verify signatures, notarization, stapling, and Gatekeeper:

   ```bash
   codesign --verify --deep --strict --verbose=2 /Applications/keepkey-vault.app
   spctl --assess --type execute --verbose=4 /Applications/keepkey-vault.app
   codesign --verify --verbose=2 KeepKey-Vault-<version>-<arch>.dmg
   xcrun stapler validate KeepKey-Vault-<version>-<arch>.dmg
   spctl --assess --type open --context context:primary-signature --verbose=4 KeepKey-Vault-<version>-<arch>.dmg
   make verify-entitlements
   ```

For Intel, capture the backend log and confirm there is no
`No native build was found for platform=darwin arch=x64`. Runtime validation on
Apple Silicon under Rosetta is supplementary and does not replace an Intel Mac.

Record the tester, hardware model, macOS version, device firmware, artifact
SHA-256, and result. Signing and testing must refer to the same hash.

## 6. Publish safely

1. Keep the GitHub release as a draft until both desired architectures pass.
   CI must fail rather than upload to an existing public release with the same
   tag; a draft release cannot be used to repair or silently replace public
   assets.
2. Upload signed artifacts without making the release public.
3. Download every uploaded artifact again and compare SHA-256 with the tested
   local files.
4. Confirm filenames and update manifests identify the correct architecture.
   The Windows release artifact must be a directly runnable, Authenticode-signed
   `KeepKey-Vault-<version>-win-x64-setup.exe`; multipart installers and ZIP-only
   install flows fail the one-click release contract.
5. Confirm release notes state the tested OS floor and architectures.
6. Have a second operator review the evidence and approve prerelease publication.
7. Publish as a **prerelease**, never as Latest, for platform smoke testing. Verify
   GitHub's `/releases/latest` endpoint still identifies the prior stable Vault
   release and not this candidate or an auxiliary Electrobun-core release.
8. Test the public prerelease downloads, including a version-pinned website
   download for every platform. Windows must be one click from the downloaded
   EXE; archive extraction is not an acceptable release flow.
9. After the recorded platform gates pass, promote the immutable release with
   `gh release edit v<VERSION> --repo keepkey/keepkey-vault --prerelease=false --latest`.
   Do not rebuild or replace assets during promotion.
10. Verify `/releases/latest` now resolves to the promoted `v<VERSION>`, then
    download and hash-check the public assets once more.

Release notes may claim only checks that were actually performed. Use distinct
language for “signed/notarized,” “structurally audited,” and “runtime tested.”

## 7. Required release evidence

Store or attach:

- release source commit and submodule SHAs;
- CI run URL and conclusion;
- Intel-core provenance and SHA-256;
- recursive bundle-audit output for both architectures;
- codesign, notarization, stapler, and Gatekeeper results;
- physical-machine runtime test records;
- local, uploaded, and re-downloaded SHA-256 values;
- final release approver and publication time.

## Incident rule

If a published architecture is discovered to be non-runnable, immediately mark
or remove that asset, post a user-facing advisory, preserve the failing artifact
for analysis, and require a new versioned artifact. Do not silently replace a
public binary under the same filename or release input tag.
