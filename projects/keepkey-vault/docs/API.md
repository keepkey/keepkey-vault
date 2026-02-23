# keepkey-desktop REST API Reference

Base URL: `http://localhost:1646`

All endpoints except `POST /auth/pair` require `Authorization: Bearer <apiKey>` header.

## Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/pair` | Pair new client, returns `{ apiKey }` |
| GET | `/auth/pair` | Verify existing API key |

### Pairing Request Body
```json
{
  "name": "KeepKey Vault",
  "url": "electrobun://keepkey-vault",
  "imageUrl": "https://keepkey.com/favicon.ico"
}
```

## Address Derivation

All POST, all require API key.

| Endpoint | Chains | Body |
|----------|--------|------|
| `/addresses/eth` | Ethereum | `{ address_n, show_display? }` |
| `/addresses/utxo` | BTC, LTC, DOGE, BCH, DASH | `{ address_n, coin, script_type?, show_display? }` |
| `/addresses/cosmos` | Cosmos | `{ address_n, show_display? }` |
| `/addresses/osmosis` | Osmosis | `{ address_n, show_display? }` |
| `/addresses/thorchain` | THORChain | `{ address_n, show_display? }` |
| `/addresses/mayachain` | Mayachain | `{ address_n, show_display? }` |
| `/addresses/xrp` | Ripple | `{ address_n, show_display? }` |
| `/addresses/bnb` | Binance | `{ address_n, show_display? }` |
| `/addresses/tendermint` | Tendermint | `{ address_n, show_display? }` |

## Signing

### Ethereum
| Method | Path | Description |
|--------|------|-------------|
| POST | `/eth/sign-transaction` | Sign ETH transaction |
| POST | `/eth/sign-typed-data` | Sign EIP-712 typed data |
| POST | `/eth/sign` | Sign message (hex) |
| POST | `/eth/verify` | Verify signature |

### UTXO
| Method | Path | Description |
|--------|------|-------------|
| POST | `/utxo/sign-transaction` | Sign BTC-like transaction |

### Cosmos
| Method | Path | Description |
|--------|------|-------------|
| POST | `/cosmos/sign-amino` | Sign amino message |
| POST | `/cosmos/sign-amino-delegate` | Sign delegation |
| POST | `/cosmos/sign-amino-undelegate` | Sign undelegation |
| POST | `/cosmos/sign-amino-redelegate` | Sign redelegation |
| POST | `/cosmos/sign-amino-withdraw-delegator-rewards-all` | Sign reward withdrawal |
| POST | `/cosmos/sign-amino-ibc-transfer` | Sign IBC transfer |

### Osmosis
Same pattern as Cosmos, plus:
| Method | Path | Description |
|--------|------|-------------|
| POST | `/osmosis/sign-amino-lp-add` | Sign LP addition |
| POST | `/osmosis/sign-amino-lp-remove` | Sign LP removal |
| POST | `/osmosis/sign-amino-swap` | Sign swap |

### THORChain
| Method | Path | Description |
|--------|------|-------------|
| POST | `/thorchain/sign-amino-transfer` | Sign transfer |
| POST | `/thorchain/sign-amino-desposit` | Sign deposit |

### Mayachain
| Method | Path | Description |
|--------|------|-------------|
| POST | `/mayachain/sign-amino-transfer` | Sign transfer |
| POST | `/mayachain/sign-amino-desposit` | Sign deposit |

### Binance
| Method | Path | Description |
|--------|------|-------------|
| POST | `/bnb/sign-transaction` | Sign BNB transaction |

### XRP
| Method | Path | Description |
|--------|------|-------------|
| POST | `/xrp/sign-transaction` | Sign XRP transaction |

## System

### Info
| Method | Path | Description |
|--------|------|-------------|
| POST | `/system/info/get-features` | Get device features/capabilities |
| POST | `/system/info/get-entropy` | Get device entropy |
| POST | `/system/info/get-public-key` | Get public key |
| POST | `/system/info/list-coins` | List supported coins |
| POST | `/system/info/ping` | Ping device |

### Configuration
| Method | Path | Description |
|--------|------|-------------|
| POST | `/system/apply-settings` | Set label, language, auto-lock, passphrase |
| POST | `/system/apply-policies` | Enable/disable policies |
| POST | `/system/change-pin` | Change or remove PIN |
| POST | `/system/clear-session` | Clear device session |
| POST | `/system/wipe-device` | Factory reset |
| POST | `/system/firmware-update` | Update firmware |

### Initialization
| Method | Path | Description |
|--------|------|-------------|
| POST | `/system/initialize/load-device` | Load seed |
| POST | `/system/initialize/recover-device` | Recover from backup |
| POST | `/system/initialize/reset-device` | Reset device |

## BIP44 Paths

Default derivation paths used by KeepKey Vault:

| Chain | Path | Coin Type |
|-------|------|-----------|
| Bitcoin | `m/44'/0'/0'/0/0` | 0 |
| Ethereum | `m/44'/60'/0'/0/0` | 60 |
| Cosmos | `m/44'/118'/0'/0/0` | 118 |
| THORChain | `m/44'/931'/0'/0/0` | 931 |
| Osmosis | `m/44'/118'/0'/0/0` | 118 |
| Litecoin | `m/44'/2'/0'/0/0` | 2 |
| Dogecoin | `m/44'/3'/0'/0/0` | 3 |
| Bitcoin Cash | `m/44'/145'/0'/0/0` | 145 |
| Dash | `m/44'/5'/0'/0/0` | 5 |
| Ripple | `m/44'/144'/0'/0/0` | 144 |
| Mayachain | `m/44'/931'/0'/0/0` | 931 |
| Binance | `m/44'/714'/0'/0/0` | 714 |
