# Monero release packaging gaps

Packaging is unchanged by this work. Capability-31 signing still needs these two release fixes. Paths below are relative to the repository root.

## Plan adapter is omitted

Evidence: `projects/keepkey-vault/electrobun.config.ts:46` gates research artifacts on `KEEPKEY_INCLUDE_MONERO_EMULATOR`; `:57` gates `monero-host-adapter` on that same flag. `projects/keepkey-vault/scripts/build-signed.ts:91` rejects the flag. The adapter is required for output export (`projects/keepkey-vault/monero-cli/src/wallet.ts:272`) and transfer-plan decoding (`:331`); without it, `sendReady` is false (`:128`) and Desktop blocks sending (`projects/keepkey-vault/src/bun/monero-vault.ts:377`). The Core verifier alone cannot build a plan.

Proposal: independently bundle a reviewed adapter for each supported platform, with its license and `monero-tools.json` receipt. Pin the approved artifact by SHA-256; preserve the runtime `hostAdapterSha256` check (`projects/keepkey-vault/monero-cli/src/tools.ts:56`). The staging script already verifies a supplied reviewed hash (`projects/keepkey-vault/scripts/stage-monero-adapter.ts:16`).

Change `build-signed.ts:53` to require the adapter with the other Monero inputs. Extend its signing/staging call at `:76` and source overrides at `:83` to include the adapter. Extend `scripts/monero-signing-metadata.py:103` to verify its approved raw hash, sign a disposable copy, and record the signed copy's hash in the copied receipt. Keep research emulators excluded. Move the adapter copy out of the research gate in `electrobun.config.ts:57` and consume the staged source override.

## Core verifier is not self-contained

Evidence: `projects/keepkey-vault/electrobun.config.ts:48` copies only `libmonero_core_verify.dylib`. Its approved hash is `6f3aac3710a698fdb515860156302592cb0f6fe0c79df3fe69b86d7a97e2484c` (`projects/keepkey-vault/src/bun/monero-device-signing.ts:16`). `available()` checks the file/hash (`:133`, `:136`), while loading happens later (`:144`).

Read-only `shasum` and `otool -L` inspection of that exact artifact at `/Users/highlander/keepkey-toolchain/vault-xmr/projects/keepkey-vault/monero-device-bundle/libmonero_core_verify.dylib` confirmed absolute `/opt/homebrew/opt/` dependencies: hidapi, unbound, libsodium, OpenSSL (ssl/crypto), and Boost (chrono, date_time, program_options, serialization, filesystem, thread). A clean Mac lacks them, so a valid file/hash can still fail at `dlopen`. This matches the supplied review, finding 3.

Proposal: rebuild a self-contained verifier with static third-party dependencies, or bundle the entire transitive dylib closure and relink every non-system load command/install name to bundle-local `@loader_path`/`@rpath` locations. Include dependency licenses. Pin the completed, relinked artifacts by hash, rather than pinning the current developer build.

Add verifier/dependency inputs to `build-signed.ts:53`; stage and sign their disposable copies before `buildElectrobun` at `:96`, dependencies first. Add source overrides alongside `:83`, and copy the complete closure in `electrobun.config.ts:48`. Verify approved pre-sign hashes and record final signed hashes in an app-sealed receipt; update the runtime verifier pin/receipt check to authenticate the distributed bytes, since relinking and signing change the current hash. Reject unresolved non-system absolute paths recursively. Qualify the installed, signed bundle on a clean Mac without Homebrew: load the verifier, accept the standard/subaddress/sweep vectors, and reject corrupted signatures. Repeat for every supported architecture; the current loader supports only macOS arm64 (`monero-device-signing.ts:131`).
