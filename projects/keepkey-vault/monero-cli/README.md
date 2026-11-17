# Monero CLI sidecar

Vault supports Monero transaction signing on capability-31 firmware. This managed sidecar watches and prepares transactions; the KeepKey signs them. The app requires the complete signing path before onboarding or exposing deposit addresses. The `Monero (XMR)` setting defaults off. Enabling it starts the local worker; disabling it, going offline, changing wallets, or exiting Vault stops monitoring. A connection requires an actual address response and explicit private-view-key approval from the selected KeepKey transport. The worker never receives a seed or private spend key.

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

The asset page shows incoming payments, received/unlocked/locked amounts, confirmations, the receive QR, and address review. A view-only wallet cannot establish which outputs were spent elsewhere, so its received balance is not a verified spendable balance until key images are synced. Fiat portfolio totals do not include this separate Monero wallet balance.

## Hardware signing

Public firmware advertises `Features.capabilities` value **31**. Vault selects messages **1800–1809** for address/view-key/key-image operations and streams transaction signing through **1810–1825**. Firmware version or image hash alone never enables signing. The verified plan adapter and independently loadable Core verifier are required before onboarding, address derivation, or receive QR display. Unsupported builds cannot offer a receive-only deposit flow.

Plans bind the exact recipient, atomic amount, fee, owned inputs and change before Init. Desktop independently verifies the assembled prefix/message hashes, authenticated signature envelopes, output keys/view tags/encrypted amounts/commitments, CLSAGs and Bulletproof+ before a single relay attempt. Standard and subaddress recipients and zero-change Max are covered by public firmware vectors. Payment-proof keys and pending transactions are retained in owner-only backend storage; an unknown relay outcome never triggers a replacement payment.

See [native verifier packaging](../../../docs/monero-release-packaging.md) for the pinned artifact, source build, platform floor, and signature receipt. Actual physical-device and funded-chain acceptance remain separate from public fixture qualification.

## Research emulator fixtures

The development-only research signing path is available when the running emulator is a verified `Monero signing (research)` build and the worker finds the verified host adapter beside wallet RPC. Stage the emulator with `make monero-emulator-signing SOURCE=...` (requires a reviewed `monero-emulator-bundle/signing-manifest.json`, file `libkkemu-monero-signing.dylib`, capabilities `address`, `watch-key`, `key-image`, `sign`). The research emulator remains development-only: `KEEPKEY_INCLUDE_MONERO_EMULATOR=1` copies it, and signed release builds refuse that flag.

### Read-only host adapter

`monero-host-adapter` decodes authenticated Core wallet exports for key-image sync
and unsigned transaction review. It does not contact a node, access a device, sign,
or relay. It is packaged independently of the research emulator flag, so public
firmware key-image monitoring does not depend on selecting an old research build.

`host-adapter-manifest.json` pins the reviewed artifact, repository-local decoder
source and build script, seven dependency archives, and the original upstream base.
The currently qualified artifact is macOS ARM64 with a macOS 13.0 deployment
target; its exact size and SHA-256 are recorded in that manifest.
Supply that artifact explicitly; no developer-machine path or runtime
download is used:

```sh
bun scripts/stage-monero-adapter.ts --source /path/to/monero-host-adapter --require
# Or set KEEPKEY_MONERO_HOST_ADAPTER_SOURCE to the reviewed artifact in a build job.
bun scripts/stage-monero-adapter.ts --if-available
bun test monero-cli/src/host-adapter.test.ts
```

Optional staging tolerates an absent artifact or an unqualified platform; an
explicit source or corrupt staged artifact fails. Use `--require` when qualifying
an app that must provide key-image decoding. Raw staging checks the exact reviewed
size and bytes; runtime additionally checks `hostAdapterSha256` in wallet-tools
metadata. macOS signing preserves the raw pin as `hostAdapterRawSha256` and updates
the runtime hash in disposable copies before the outer app signature seals them.
These metadata fields are not an independent signature; explicit developer tool
overrides remain trusted development inputs.

The decoder source is maintained in
[`native/monero-host-adapter/host-adapter.cpp`](../native/monero-host-adapter/host-adapter.cpp).
It accepts Core's zero-change sweep shape only when exactly two outputs contain
one positive recipient and one standard-address zero-value dummy matching the
authenticated construction's zero change destination. Dummy outputs retain their
position and are never classified as wallet change. Positive change still requires
the recognized wallet subaddress and exact authenticated amount.

From the repository root, rebuild with explicitly supplied pinned archives:

```sh
python3 scripts/build-monero-host-adapter.py \
  --archive-dir /path/to/pinned-archives \
  --work-dir /path/to/new-build-directory \
  --output /path/to/new/monero-host-adapter
```

The build script compiles Core and static Boost, OpenSSL and sodium code for macOS 13.0 and
checks that the final executable links only approved system libraries. It records
source, compiler, SDK, dependency and artifact evidence in the build directory.
The bundled `monero-tools/HOST-ADAPTER-LICENSES.txt` preserves the dependency notices.
A rebuild with another compiler
or dependency set must receive its own artifact review and manifest pin; matching
the version label does not qualify different bytes. Native public-fixture tests
run whenever the reviewed adapter is staged, or via the explicit
`KEEPKEY_TEST_MONERO_HOST_ADAPTER` test input. Unsupported platforms remain gated.

The decoder does not confer firmware signing support. Hardware signing additionally requires capability 31 and the pinned native verifier. The certified bundled 7.17 emulator has no Monero commands; receiving-only research libraries do not qualify the app's Monero onboarding gate.

The public flow is wallet `export_outputs`, adapter `outputs`, device key-image sync (1804–1809) and wallet `import_key_images`; then wallet `transfer` (unsigned set), adapter `plan`, exact plan review, streamed device signing (1810–1825), independent output/proof verification, durable pending storage and `/send_raw_transaction` to the configured daemon over pinned HTTPS or explicit loopback HTTP. Monitoring keys stay in backend memory or the encrypted watch cache and reach the adapter only on stdin. Integrated addresses and explicit payment IDs remain outside the supported transaction shape.

Validation includes identity and consent checks, device/config invalidation, exact uint64 amounts, process shutdown and restart, binary verification, and malformed IPC. `smoke.ts` additionally uses an explicitly supplied verified `monerod` to create a fresh offline mainnet-genesis chain and a documented public upstream Trezor fixture. It checks actual repeated Core Digest authentication, address binding, spend-key refusal, managed configure/refresh, and child cleanup without contacting mainnet or handling funds:

```sh
bun monero-cli/smoke.ts --daemon-bin=/path/to/verified/monerod --daemon-sha256=VERIFIED_SHA256
```

See the [official Wallet RPC documentation](https://docs.getmonero.org/rpc-library/wallet-rpc/) and [official signed downloads](https://www.getmonero.org/downloads/).

## Startup balance and sync progress

The backend saves the last completed Monero balance observation in the encrypted
monitoring store, scoped to the connected standard seed and device. Reopening the
app, reconnecting, changing nodes or scanning again can show that balance with its
original observation time. A fresh spend-verified balance or completed zero
replaces it. A saved display value never authorizes spending, claims current sync, or
unlocks receive controls. Hidden wallets and a different seed/device cannot read
another wallet's snapshot.

Wallet RPC scans in its bounded background auto-refresh loop after identity and
view-only checks complete. Status polling reads the current height and balance
without repeatedly starting an unbounded full-history refresh. Synced requires
catching up to the current responding, synchronized daemon. A temporary wallet
RPC delay does not by itself discard the scan or switch nodes.
