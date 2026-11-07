# Monero CLI sidecar

This is Vault's managed, view-only Monero sidecar. The `Monero (XMR)` setting defaults off. Enabling it starts the local worker; disabling it, going offline, changing wallets, or exiting Vault stops monitoring. A connection requires an actual address response and explicit private-view-key approval from the selected KeepKey transport. The worker never receives a seed or private spend key.

The worker communicates over bounded NDJSON stdin/stdout, starts a pinned official `monero-wallet-rpc` on authenticated loopback, and keeps RPC credentials outside process arguments and logs. Remote daemon connections require verified HTTPS; plain HTTP is allowed only for an explicit loopback daemon. Wallets and random passwords are session-only, with private encrypted cache files removed on shutdown. Reconnecting after a process restart requires consent again.

## Build

Use Bun 1.3.14 or later, Python 3, `curl`, `gpg`, and `gpgv`:

```sh
bun run monero:prepare
bun run monero:build
bun run monero:test
bun run build
```

Preparation authenticates the pinned Monero 0.18.5.4 release manifest with the pinned binaryFate key, verifies the selected official archive, and extracts wallet RPC, `monerod`, and their license. The output directory must be empty for a fresh preparation. Generated vendor binaries and compiled workers are ignored by Git. `prepare.py --platform` and `build.ts --platform=...` support macOS arm64/x64, Linux arm64/x64, and Windows x64. Native macOS arm64 is validated; other targets need their own runtime validation.

Release CI prepares and builds the sidecar before packaging. CI sets `KEEPKEY_REQUIRE_MONERO_SIDECAR=1` to refuse missing sidecar inputs. Existing builds that omit this optional feature keep Monero unavailable; partially staged inputs are always rejected. Runtime metadata belongs to the trusted app bundle; `MONERO_TOOLS_DIR` and `MONERO_CLI_BIN` are explicit developer overrides, not independent proof of an official release.

## Vault and the emulator

Enable Monero in Settings, then open Monero (XMR) in the wallet chain list. Connection and balance verification run automatically, with explicit device consent and signing. Wallet scanning starts at zero unless a later start was deliberately saved; older payments before that start are omitted.

## Run your own node

Settings → Monero prefers a local pruned mainnet node. Existing remote URLs survive upgrades; switching to a remote node is explicit and there is no automatic public-node fallback. The node panel shows block height, approximate progress, allocated storage, free space, and the blockchain folder. Wallet scanning is separate from node sync; automatic wallet connection waits for the local node to be fully synced.

Start verifies the bundled daemon, checks capacity for an estimated 105 GiB chain plus a 25 GiB reserve, and starts restricted loopback RPC at `127.0.0.1:18081`. It limits concurrency to two and disables incoming peers. While Vault runs, storage monitoring stops the owned daemon gracefully if the drive disappears or space falls below the reserve. Closing Vault requests a graceful stop; after an explicit Start, reopening Vault resumes the node when Monero is enabled and local mode is selected. Offline mode stops it as well. A unique config path, executable and data directory identify the owned process across app restarts; another process on the RPC port is never stopped or replaced.

The storage folder can change only while stopped. Selecting another folder does not move or delete a blockchain. Estimates grow with the chain, and block percentages are not time estimates. The initial sync can take days. The local node contains public chain data, not wallet spending keys. macOS signing updates the daemon receipt before sealing the outer app signature, preserving the authenticated release hash separately.

The current firmware counterpart is [keepkey-firmware PR 1036](https://github.com/BitHighlander/keepkey-firmware/pull/1036). Its receive-only native emulator build implements address, private-view-key consent, and experimental key-image commands without the native Core signing dependency. The ordinary emulator and production device builds do not gain these commands.

To stage the currently reviewed macOS arm64 receive library:

```sh
bun scripts/stage-monero-emulator.ts --source /path/to/tested/libkkemu.dylib
```

The script requires the checked-in `monero-emulator-bundle/manifest.json` byte hash and architecture. Stage a new tested binary only after reviewing and updating its manifest pin. Include this unsigned research artifact in a development app with `KEEPKEY_INCLUDE_MONERO_EMULATOR=1 bun run build`. Signed releases exclude it pending separate deployment-target and signing certification. With the feature enabled, select `Monero receive-only (research)` in the emulator build selector. It gets a distinct build-scoped flash profile; enabling the feature alone does not select a library or replace a wallet.

## Scope and validation

The asset page shows incoming payments, received/unlocked/locked amounts, confirmations, the receive QR, and address review. A view-only wallet cannot establish which outputs were spent elsewhere, so its received balance is not a verified spendable balance until key images are synced. Fiat portfolio totals do not include this separate receive preview.

## Research send (signing emulator only)

Sending is offered only when the running emulator is a verified `Monero signing (research)` build and the worker finds `monero-host-adapter` beside the wallet RPC, pinned by `hostAdapterSha256` in `monero-tools.json`. Stage them with `make monero-emulator-signing SOURCE=...` (requires a reviewed `monero-emulator-bundle/signing-manifest.json`, file `libkkemu-monero-signing.dylib`, capabilities `address`, `watch-key`, `key-image`, `sign`) and `make monero-adapter SOURCE=... SHA256=...`. Both are development artifacts: only `KEEPKEY_INCLUDE_MONERO_EMULATOR=1` copies them and signed release builds refuse that flag.

The flow follows the firmware research host runner: wallet `export_outputs`, adapter `outputs`, device key-image sync (530..535) and wallet `import_key_images`; then wallet `transfer` (unsigned set), adapter `plan`, a plan-versus-request check (one recipient, exact amount, wallet fee, change only to this wallet, inputs only from synced outputs), research signing (65000/65001) on the emulator, a check of the signed bytes (hash, fee, rings, key images), and `/send_raw_transaction` to the configured daemon over the same pinned HTTPS or loopback HTTP. The view key reaches the adapter only on stdin. Integrated addresses and payment IDs are refused.

The full bounded CLSAG/Bulletproof+ signing experiment remains separately opt-in in the firmware research tree and is not a hardware signing implementation. Physical-device support requires the audit gates recorded there.

Validation includes identity and consent checks, device/config invalidation, exact uint64 amounts, process shutdown and restart, binary verification, and malformed IPC. `smoke.ts` additionally uses an explicitly supplied verified `monerod` to create a fresh offline mainnet-genesis chain and a documented public upstream Trezor fixture. It checks actual repeated Core Digest authentication, address binding, spend-key refusal, managed configure/refresh, and child cleanup without contacting mainnet or handling funds:

```sh
bun monero-cli/smoke.ts --daemon-bin=/path/to/verified/monerod --daemon-sha256=VERIFIED_SHA256
```

See the [official Wallet RPC documentation](https://docs.getmonero.org/rpc-library/wallet-rpc/) and [official signed downloads](https://www.getmonero.org/downloads/).
