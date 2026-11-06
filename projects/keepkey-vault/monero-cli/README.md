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

Preparation authenticates the pinned Monero 0.18.5.4 release manifest with the pinned binaryFate key, verifies the selected official archive, and extracts only wallet RPC and its license. The output directory must be empty for a fresh preparation. Generated vendor binaries and compiled workers are ignored by Git. `prepare.py --platform` and `build.ts --platform=...` support macOS arm64/x64, Linux arm64/x64, and Windows x64. Native macOS arm64 is validated in this PR; other targets need their own runtime validation.

Release CI prepares and builds the sidecar before packaging. CI sets `KEEPKEY_REQUIRE_MONERO_SIDECAR=1` to refuse missing sidecar inputs. Existing builds that omit this optional feature keep Monero unavailable; partially staged inputs are always rejected. Runtime metadata belongs to the trusted app bundle; `MONERO_TOOLS_DIR` and `MONERO_CLI_BIN` are explicit developer overrides, not independent proof of an official release.

## Vault and the emulator

Enable Monero in Settings, then open the Monero tab or the XMR entry in the wallet chain list. Choose the daemon and earliest restore height in Settings before connecting. Zero scans the entire chain; choosing a height after an older payment can omit it.

The current firmware counterpart is [keepkey-firmware PR 1036](https://github.com/BitHighlander/keepkey-firmware/pull/1036). Its receive-only native emulator build implements address, private-view-key consent, and experimental key-image commands without the native Core signing dependency. The ordinary emulator and production device builds do not gain these commands.

To stage the currently reviewed macOS arm64 receive library:

```sh
bun scripts/stage-monero-emulator.ts --source /path/to/tested/libkkemu.dylib
```

The script requires the checked-in `monero-emulator-bundle/manifest.json` byte hash and architecture. Stage a new tested binary only after reviewing and updating its manifest pin. Include this unsigned research artifact in a development app with `KEEPKEY_INCLUDE_MONERO_EMULATOR=1 bun run build`. Signed releases exclude it pending separate deployment-target and signing certification. With the feature enabled, select `Monero receive-only (research)` in the emulator build selector. It gets a distinct build-scoped flash profile; enabling the feature alone does not select a library or replace a wallet.

## Scope and validation

The panel shows incoming payments, received/unlocked/locked amounts, confirmations, the receive QR, and address review. This implementation has no sending or key-image import into the host wallet. A view-only wallet cannot establish which outputs were spent elsewhere, so its received balance is not a verified spendable balance. Fiat portfolio totals do not include this separate receive preview.

The full bounded CLSAG/Bulletproof+ signing experiment remains separately opt-in in the firmware research tree and is not a hardware signing implementation. Physical-device support requires the audit gates recorded there.

Validation includes identity and consent checks, device/config invalidation, exact uint64 amounts, process shutdown and restart, binary verification, and malformed IPC. `smoke.ts` additionally uses an explicitly supplied verified `monerod` to create a fresh offline mainnet-genesis chain and a documented public upstream Trezor fixture. It checks actual repeated Core Digest authentication, address binding, spend-key refusal, managed configure/refresh, and child cleanup without contacting mainnet or handling funds:

```sh
bun monero-cli/smoke.ts --daemon-bin=/path/to/verified/monerod --daemon-sha256=VERIFIED_SHA256
```

See the [official Wallet RPC documentation](https://docs.getmonero.org/rpc-library/wallet-rpc/) and [official signed downloads](https://www.getmonero.org/downloads/).
