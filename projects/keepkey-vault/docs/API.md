# KeepKey Vault v11 API Reference

KeepKey Vault v11 exposes two API layers for communicating with the KeepKey hardware wallet.

## API Layers

### Electrobun RPC (primary)

The built-in frontend communicates with the Bun main process over Electrobun's WebSocket-based RPC. This is the primary interface and is always active. The schema is defined in `src/shared/rpc-schema.ts`.

RPC calls use request/response semantics (`rpcRequest('method', params)`) and one-way push messages (`rpc.send['message-name'](payload)`).

### REST API (opt-in, port 1646)

An HTTP API for external applications (dApps, SDKs, CLI tools). Disabled by default. Enable it by setting `KEEPKEY_REST_API=true` in app settings or via the Settings UI.

- Base URL: `http://localhost:1646`
- Compatible with the `kkapi://` protocol (maps to `localhost:1646`)
- All endpoints except health, ping, and pairing require `Authorization: Bearer <apiKey>` header
- Signing endpoints require explicit user approval via the Electrobun UI before execution
- CORS is enabled for all origins (bearer-token auth model, not cookie-based)
- Swagger UI available at `http://localhost:1646/docs`
- OpenAPI spec at `http://localhost:1646/spec/swagger.json`

---

## RPC Methods

### Requests (WebView calls Bun)

#### Device Lifecycle

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getDeviceState` | void | `DeviceStateInfo` | Current device connection state |
| `startBootloaderUpdate` | void | void | Enter bootloader and flash update |
| `startFirmwareUpdate` | void | void | Flash latest firmware |
| `flashFirmware` | void | void | Flash firmware (when in bootloader) |
| `analyzeFirmware` | `{ data: string }` | `FirmwareAnalysis` | Analyze a custom firmware binary |
| `flashCustomFirmware` | `{ data: string }` | void | Flash user-supplied firmware |
| `resetDevice` | `{ wordCount, pin, passphrase }` | void | Generate new seed on device |
| `recoverDevice` | `{ wordCount, pin, passphrase }` | void | Recover device via cipher recovery |
| `loadDevice` | `{ mnemonic, pin?, passphrase?, label? }` | void | Load a known mnemonic |
| `verifySeed` | `{ wordCount }` | `{ success, message }` | Verify seed backup |
| `applySettings` | `{ label?, usePassphrase?, autoLockDelayMs? }` | void | Change device settings |
| `changePin` | void | void | Start PIN change flow |
| `removePin` | void | void | Remove PIN protection |
| `sendPin` | `{ pin: string }` | void | Respond to PIN prompt |
| `sendPassphrase` | `{ passphrase: string }` | void | Respond to passphrase prompt |
| `sendCharacter` | `{ character: string }` | void | Send character during cipher recovery |
| `sendCharacterDelete` | void | void | Delete last character during recovery |
| `sendCharacterDone` | void | void | Confirm final word during recovery |

#### Wallet Operations

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getFeatures` | void | any | Get device features (model, firmware, policies) |
| `ping` | `{ msg?: string }` | any | Ping the device |
| `wipeDevice` | void | any | Factory reset |
| `getPublicKeys` | paths array | any | Derive public keys / xpubs |

#### Address Derivation

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `btcGetAddress` | `{ addressNList, coin?, scriptType?, showDisplay? }` | any | Bitcoin / UTXO address |
| `ethGetAddress` | `{ addressNList, showDisplay? }` | any | Ethereum / EVM address |
| `cosmosGetAddress` | `{ addressNList, showDisplay? }` | any | Cosmos address |
| `thorchainGetAddress` | `{ addressNList, showDisplay? }` | any | THORChain address |
| `mayachainGetAddress` | `{ addressNList, showDisplay? }` | any | Mayachain address |
| `osmosisGetAddress` | `{ addressNList, showDisplay? }` | any | Osmosis address |
| `xrpGetAddress` | `{ addressNList, showDisplay? }` | any | XRP address |
| `solanaGetAddress` | `{ addressNList, showDisplay? }` | any | Solana address |

#### Transaction Signing

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `btcSignTx` | `{ coin, inputs, outputs, version?, locktime? }` | any | Sign UTXO transaction |
| `ethSignTx` | `{ addressNList, to, value, nonce, gasLimit, chainId, ... }` | any | Sign EVM transaction (EIP-155 / EIP-1559) |
| `ethSignMessage` | `{ addressNList, message }` | any | Sign ETH message |
| `ethSignTypedData` | `{ addressNList, typedData }` | any | Sign EIP-712 typed data |
| `ethVerifyMessage` | `{ address, message, signature }` | any | Verify ETH signature |
| `cosmosSignTx` | amino tx object | any | Sign Cosmos transaction |
| `thorchainSignTx` | amino tx object | any | Sign THORChain transaction |
| `mayachainSignTx` | amino tx object | any | Sign Mayachain transaction |
| `osmosisSignTx` | amino tx object | any | Sign Osmosis transaction |
| `xrpSignTx` | XRP tx object | any | Sign XRP transaction |
| `solanaSignTx` | `{ addressNList, rawTx }` | any | Sign Solana transaction |

#### Pioneer Integration

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getBalances` | void | `ChainBalance[]` | Fetch all chain balances via Pioneer |
| `getBalance` | `{ chainId }` | `ChainBalance` | Fetch single chain balance |
| `buildTx` | `BuildTxParams` | `BuildTxResult` | Build unsigned transaction |
| `broadcastTx` | `{ chainId, signedTx }` | `BroadcastResult` | Broadcast signed transaction |
| `getMarketData` | `{ caips: string[] }` | any | Get market prices for assets |
| `getFees` | `{ chainId }` | any | Get fee estimates for a chain |

#### Bitcoin Multi-Account

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getBtcAccounts` | void | `BtcAccountSet` | List BTC accounts (all script types) |
| `addBtcAccount` | void | `BtcAccountSet` | Add next account index |
| `setBtcSelectedXpub` | `{ accountIndex, scriptType }` | void | Set active BTC account |
| `getBtcAddressIndices` | `{ xpub }` | `{ receiveIndex, changeIndex }` | Get current address indices |

#### EVM Multi-Address

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getEvmAddresses` | void | `EvmAddressSet` | List tracked EVM address indices |
| `addEvmAddressIndex` | `{ index? }` | `EvmAddressSet` | Add an EVM address index |
| `removeEvmAddressIndex` | `{ index }` | `EvmAddressSet` | Remove an EVM address index |
| `setEvmSelectedIndex` | `{ index }` | void | Set active EVM address index |

#### Chain Discovery

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `browseChains` | `{ query?, page?, pageSize? }` | `{ chains, total, page, pageSize }` | Search Pioneer chain catalog |

#### Custom Tokens and Chains

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `addCustomToken` | `{ chainId, contractAddress }` | `CustomToken` | Add custom ERC-20 token |
| `removeCustomToken` | `{ chainId, contractAddress }` | void | Remove custom token |
| `getCustomTokens` | void | `CustomToken[]` | List custom tokens |
| `addCustomChain` | `CustomChain` | void | Add custom EVM chain |
| `removeCustomChain` | `{ chainId }` | void | Remove custom chain |
| `getCustomChains` | void | `CustomChain[]` | List custom chains |

#### Token Visibility (Spam Filter)

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `setTokenVisibility` | `{ caip, status }` | void | Mark token visible or hidden |
| `removeTokenVisibility` | `{ caip }` | void | Remove visibility override |
| `getTokenVisibilityMap` | void | `Record<string, TokenVisibilityStatus>` | Get all visibility overrides |

#### Camera / QR Scanning

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `startQrScan` | void | void | Start camera for QR scanning |
| `stopQrScan` | void | void | Stop camera |

#### Pairing and Signing Approval

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `approvePairing` | void | `{ apiKey }` | Approve pending REST API pairing request |
| `rejectPairing` | void | void | Reject pending pairing request |
| `approveSigningRequest` | `{ id }` | void | Approve a signing request |
| `rejectSigningRequest` | `{ id }` | void | Reject a signing request |
| `listPairedApps` | void | `PairedAppInfo[]` | List all paired applications |
| `revokePairing` | `{ apiKey }` | void | Revoke an app's API key |

#### API Audit Log

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getApiLogs` | `{ limit?, offset? }` | `ApiLogEntry[]` | Get REST API audit log entries |
| `clearApiLogs` | void | void | Clear the audit log |

#### App Settings

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getAppSettings` | void | `AppSettings` | Get current settings |
| `setRestApiEnabled` | `{ enabled }` | `AppSettings` | Enable or disable REST API |
| `setPioneerApiBase` | `{ url }` | `AppSettings` | Set Pioneer API base URL |

#### Balance Cache / Watch-Only

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `getCachedBalances` | void | `ChainBalance[] | null` | Get locally cached balances |
| `checkWatchOnlyCache` | void | `{ available, deviceLabel?, lastSynced? }` | Check if watch-only data exists |
| `getWatchOnlyBalances` | void | `ChainBalance[] | null` | Get balances without device connected |
| `getWatchOnlyPubkeys` | void | pubkey array | Get cached public keys |

#### App Updates

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `checkForUpdate` | void | `UpdateInfo` | Check for new app version |
| `downloadUpdate` | void | void | Download available update |
| `applyUpdate` | void | void | Apply downloaded update |
| `getUpdateInfo` | void | `UpdateInfo | null` | Get current update state |
| `getAppVersion` | void | `{ version, channel }` | Get running app version |

#### Utility

| Method | Params | Response | Description |
|--------|--------|----------|-------------|
| `openUrl` | `{ url }` | void | Open URL in system browser |

### Messages (Bun pushes to WebView)

| Message | Payload | Description |
|---------|---------|-------------|
| `device-state` | `DeviceStateInfo` | Device state changed |
| `firmware-progress` | `FirmwareProgress` | Firmware flash progress |
| `pin-request` | `PinRequest` | Device is requesting PIN entry |
| `character-request` | `CharacterRequest` | Device is requesting character (cipher recovery) |
| `passphrase-request` | `{}` | Device is requesting passphrase |
| `recovery-error` | `{ message, errorType }` | Recovery or PIN change failed |
| `btc-accounts-update` | `BtcAccountSet` | BTC accounts changed |
| `evm-addresses-update` | `EvmAddressSet` | EVM tracked addresses changed |
| `camera-frame` | string (base64) | Camera frame for QR scanning |
| `camera-error` | string | Camera error message |
| `update-status` | `UpdateStatus` | App update download/install progress |
| `pair-request` | `PairingRequestInfo` | External app requesting to pair |
| `signing-request` | `SigningRequestInfo` | External app requesting to sign |
| `signing-dismissed` | `{ id }` | Signing request was dismissed |
| `api-log` | `ApiLogEntry` | New REST API log entry |
| `walletconnect-uri` | string | WalletConnect URI received |

---

## REST API Endpoints

Base URL: `http://localhost:1646`

### Public (no auth required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check with device status, supported chains, uptime |
| GET | `/api/v1/health` | Alias for `/api/health` |
| GET | `/api/v1/health/fast` | Minimal health check (status + uptime only) |
| GET | `/info/ping` | Returns `{ message: "pong" }` -- SDK detection |
| POST | `/system/info/ping` | Returns `{ message: "pong" }` -- SDK detection |
| GET | `/admin/info` | Version, connection status, uptime |
| GET | `/spec/swagger.json` | OpenAPI specification |
| GET | `/docs` | Swagger UI (interactive API docs) |
| GET | `/api/cache/status` | Cache status (pubkey + address cache counts) |
| GET | `/api/portfolio` | Portfolio stub (returns device state, no balance aggregation) |
| GET | `/auth/paired-apps` | List paired apps (keys stripped) |

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/pair` | Pair a new app. Body: `{ name, url?, imageUrl? }`. Returns `{ apiKey }`. Requires user approval via UI. |
| GET | `/auth/pair` | Verify existing API key. Returns `{ paired: true/false }`. |

### Address Derivation (auth required)

All POST. Body: `{ address_n: number[], coin?: string, script_type?: string, show_display?: boolean }`.

| Path | Chain(s) |
|------|----------|
| `/addresses/utxo` | Bitcoin, Litecoin, Dogecoin, Bitcoin Cash, Dash, DigiByte |
| `/addresses/eth` | Ethereum and all EVM L2s |
| `/addresses/cosmos` | Cosmos |
| `/addresses/osmosis` | Osmosis |
| `/addresses/thorchain` | THORChain |
| `/addresses/mayachain` | Mayachain |
| `/addresses/tendermint` | Tendermint (generic cosmos) |
| `/addresses/xrp` | XRP |
| `/addresses/solana` | Solana |

### Signing (auth required, user approval required)

#### Ethereum / EVM

| Method | Path | Description |
|--------|------|-------------|
| POST | `/eth/sign-transaction` | Sign EVM transaction (EIP-155 and EIP-1559). Supports `from` address auto-lookup across first 5 account indices. |
| POST | `/eth/sign-typed-data` | Sign EIP-712 typed data. Body: `{ address, typedData }` |
| POST | `/eth/sign` | Sign hex message. Body: `{ address, message }` |
| POST | `/eth/verify` | Verify signature. Body: `{ address, message, signature }` |

#### UTXO

| Method | Path | Description |
|--------|------|-------------|
| POST | `/utxo/sign-transaction` | Sign UTXO transaction. Body: `{ coin?, inputs, outputs, version?, locktime? }`. Auto-prefixes BCH addresses. |

#### Cosmos

| Method | Path | Description |
|--------|------|-------------|
| POST | `/cosmos/sign-amino` | Sign generic amino message |
| POST | `/cosmos/sign-amino-delegate` | Sign delegation |
| POST | `/cosmos/sign-amino-undelegate` | Sign undelegation |
| POST | `/cosmos/sign-amino-redelegate` | Sign redelegation |
| POST | `/cosmos/sign-amino-withdraw-delegator-rewards-all` | Claim all staking rewards |
| POST | `/cosmos/sign-amino-ibc-transfer` | Sign IBC transfer |

#### Osmosis

All Cosmos amino endpoints plus:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/osmosis/sign-amino` | Sign generic amino message |
| POST | `/osmosis/sign-amino-delegate` | Sign delegation |
| POST | `/osmosis/sign-amino-undelegate` | Sign undelegation |
| POST | `/osmosis/sign-amino-redelegate` | Sign redelegation |
| POST | `/osmosis/sign-amino-withdraw-delegator-rewards-all` | Claim all staking rewards |
| POST | `/osmosis/sign-amino-ibc-transfer` | Sign IBC transfer |
| POST | `/osmosis/sign-amino-lp-add` | Add liquidity |
| POST | `/osmosis/sign-amino-lp-remove` | Remove liquidity |
| POST | `/osmosis/sign-amino-swap` | Swap |

#### THORChain

| Method | Path | Description |
|--------|------|-------------|
| POST | `/thorchain/sign-amino-transfer` | Sign transfer |
| POST | `/thorchain/sign-amino-deposit` | Sign deposit (e.g. LP add, swap) |

#### Mayachain

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mayachain/sign-amino-transfer` | Sign transfer |
| POST | `/mayachain/sign-amino-deposit` | Sign deposit |

#### XRP

| Method | Path | Description |
|--------|------|-------------|
| POST | `/xrp/sign-transaction` | Sign XRP transaction |

#### Solana

| Method | Path | Description |
|--------|------|-------------|
| POST | `/solana/sign-transaction` | Sign Solana transaction. Body: `{ raw_tx, addressNList? }` |

### Device Info (auth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/system/info/get-features` | Device features (snake_case format, 10s cache) |
| POST | `/system/info/get-public-key` | Get xpub. Body: `{ address_n, ecdsa_curve_name?, show_display?, coin_name?, script_type? }` |
| POST | `/system/info/list-coins` | List supported coins (from built-in chain config) |

### Device Management (auth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/system/apply-settings` | Set label, passphrase, auto-lock delay |
| POST | `/system/apply-policies` | Enable/disable device policies |
| POST | `/system/change-pin` | Change or remove PIN. Body: `{ remove?: boolean }` |
| POST | `/system/clear-session` | Clear device session |
| POST | `/system/wipe-device` | Factory reset the device |
| POST | `/system/initialize/reset-device` | Generate new seed. Body: `{ word_count?, label?, pin_protection?, passphrase_protection? }` |
| POST | `/system/initialize/recover-device` | Recover from seed. Body: `{ word_count?, label?, pin_protection?, passphrase_protection? }` |
| POST | `/system/initialize/load-device` | Load seed directly |
| POST | `/system/recovery/pin` | Send PIN during recovery. Body: `{ pin }` |

### SDK / Multi-Device (auth required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v2/devices` | List connected devices (single-device mode) |
| GET | `/api/v2/devices/active` | Get active device |
| GET | `/api/v2/devices/paired` | Get paired device info |
| POST | `/api/v2/devices/select` | Select device (no-op in single-device mode) |
| GET | `/api/v2/devices/:id` | Get device by ID |
| GET | `/api/portfolio/:device_id` | Device portfolio stub |
| POST | `/api/pubkeys/batch` | Batch derive public keys and addresses. Supports `type: 'address'` for non-UTXO chains and `type: 'xpub'` for UTXO chains. |

### WalletConnect Reverse Proxy

Requests to `/wc/*` are reverse-proxied to the WalletConnect dApp origin. This allows the WC panel to load as same-origin content, avoiding mixed-content blocks in WKWebView. GET only, no auth required.

---

## BIP44 Derivation Paths

Default paths used by KeepKey Vault:

### UTXO Chains

| Chain | Path | Coin Type | Script Type |
|-------|------|-----------|-------------|
| Bitcoin | `m/44'/0'/0'/0/0` | 0 | p2pkh (legacy) |
| Bitcoin (SegWit) | `m/49'/0'/0'/0/0` | 0 | p2sh-p2wpkh |
| Bitcoin (Native SegWit) | `m/84'/0'/0'/0/0` | 0 | p2wpkh |
| Litecoin | `m/44'/2'/0'/0/0` | 2 | p2wpkh |
| Dogecoin | `m/44'/3'/0'/0/0` | 3 | p2pkh |
| Dash | `m/44'/5'/0'/0/0` | 5 | p2pkh |
| DigiByte | `m/44'/20'/0'/0/0` | 20 | p2pkh |
| Bitcoin Cash | `m/44'/145'/0'/0/0` | 145 | p2pkh |

### EVM Chains (all share coin type 60)

| Chain | Path | Chain ID |
|-------|------|----------|
| Ethereum | `m/44'/60'/0'/0/0` | 1 |
| Polygon | `m/44'/60'/0'/0/0` | 137 |
| Arbitrum | `m/44'/60'/0'/0/0` | 42161 |
| Optimism | `m/44'/60'/0'/0/0` | 10 |
| Avalanche C-Chain | `m/44'/60'/0'/0/0` | 43114 |
| BNB Smart Chain | `m/44'/60'/0'/0/0` | 56 |
| Base | `m/44'/60'/0'/0/0` | 8453 |
| Monad | `m/44'/60'/0'/0/0` | 143 |
| Hyperliquid | `m/44'/60'/0'/0/0` | 2868 |
| Custom EVM chains | `m/44'/60'/0'/0/0` | user-defined |

All EVM chains derive the same address at a given account index. The firmware receives `coin: 'Ethereum'` for all EVM chains.

### Cosmos-Family Chains

| Chain | Path | Coin Type |
|-------|------|-----------|
| Cosmos (ATOM) | `m/44'/118'/0'/0/0` | 118 |
| Osmosis (OSMO) | `m/44'/118'/0'/0/0` | 118 |
| THORChain (RUNE) | `m/44'/931'/0'/0/0` | 931 |
| Mayachain (CACAO) | `m/44'/931'/0'/0/0` | 931 |

### Other Chains

| Chain | Path | Coin Type |
|-------|------|-----------|
| Ripple (XRP) | `m/44'/144'/0'/0/0` | 144 |
| Solana (SOL) | `m/44'/501'/0'/0'` | 501 |
