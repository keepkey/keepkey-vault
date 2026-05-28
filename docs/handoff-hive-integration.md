# Handoff: Hive Integration

## Status Summary

| Layer | Status | Notes |
|---|---|---|
| Firmware (`alpha`) | ✅ Done | `hive.c`, `fsm_msg_hive.h`, wired into `messagemap.def` + CMakeLists |
| device-protocol | ✅ Done | `messages-hive.proto`, wire IDs 1600–1603 in `alpha` |
| hdwallet | ❌ Not started | No Hive in `modules/hdwallet/` |
| Vault RPC | ❌ Not started | `feature/hive` branch only has submodule bumps, no TS code |
| Pioneer | ❌ Not started | No Hive in pioneer-caip, pioneer-coins, pioneer-balance, or pioneer-network |

---

## Chain Facts

| Field | Value |
|---|---|
| Symbol | `HIVE` |
| SLIP44 | `1275` |
| Curve | `secp256k1` |
| Derivation path | `m/44'/1275'/0'/0/0` |
| Address format | `STM`-prefixed base58 (Graphene/EOS encoding, RIPEMD checksum) |
| Chain ID (mainnet) | `beeab0de00000000000000000000000000000000000000000000000000000000` (32 bytes) |
| CAIP networkId | `hive:beeab0de` (first 8 hex chars of chain_id) |
| CAIP assetId | `hive:beeab0de/slip44:1275` |
| Decimals | `3` (milliHIVE) |
| Also supports | HBD (Hive Backed Dollars), same path/curve |
| Broadcast endpoint | Hive RPC nodes: `https://api.hive.blog`, `https://anyx.io` |

---

## What the Firmware Does

`hive.c` implements:
- `hive_getPublicKey()` — returns `STM`-prefixed base58 public key
- `hive_signTx()` — signs Graphene binary-serialized transfer transactions

`HiveSignTx` proto fields: `chain_id`, `ref_block_num`, `ref_block_prefix`, `expiration`, `from`, `to`, `amount`, `decimals`, `asset_symbol`, `memo`

Response is a 65-byte recoverable secp256k1 signature + full serialized tx bytes.

---

## Work Remaining

### 1. hdwallet — Add Hive wallet adapter
**Repo**: `modules/hdwallet/`
**Reference impl**: look at `packages/hdwallet-keepkey/src/solana.ts` or `tron.ts`

Files to add/edit:
- `packages/hdwallet-core/src/hive.ts` — types: `HiveGetPublicKey`, `HiveSignTx`, `HiveSignedTx`, wallet interface
- `packages/hdwallet-core/src/index.ts` — re-export Hive types
- `packages/hdwallet-keepkey/src/hive.ts` — wire `hiveGetPublicKey()` and `hiveSignTx()` through to firmware via USB transport
- `packages/hdwallet-keepkey/src/keepkey.ts` — add Hive capability flags + register handlers

The firmware proto is already in `deps/device-protocol`. The keepkey transport just needs to call `HiveGetPublicKey` (MessageType 1600) and `HiveSignTx` (MessageType 1602).

### 2. Vault RPC — Wire hdwallet calls into Electrobun RPC
**File**: `projects/keepkey-vault/src/bun/index.ts`
**Branch**: `feat/hive` (current main tree)

Pattern — copy from `tonGetAddress` / `tonSignTx` block (~line 1376):
```typescript
hiveGetPublicKey: async (params) => {
    const addr = await engine.wallet.hiveGetPublicKey(params)
    if (addr) cacheAddress('hive', JSON.stringify(params.addressNList || []), addr)
    return addr
},
hiveSignTx: async (params) => {
    return await engine.wallet.hiveSignTx(params)
},
```

Also add to `src/shared/rpc-schema.ts` (request/response types).

### 3. Pioneer — Add Hive chain support
**Repo**: `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`
**Reference**: `docs/coin-addition/coin-addition-guide.md` (UTXO-style but use Hive-specific values)

Files to edit (in order):

#### pioneer-caip `modules/pioneer/pioneer-caip/src/data.ts`
```typescript
// Chain enum
Hive = 'HIVE',

// BaseDecimal
HIVE: 3,

// ChainToCaip
'HIVE': 'hive:beeab0de/slip44:1275',

// ChainToNetworkId
'HIVE': 'hive:beeab0de',

// shortListSymbolToCaip
HIVE: 'hive:beeab0de/slip44:1275',

// shortListNameToCaip
hive: 'hive:beeab0de/slip44:1275',
```

#### pioneer-coins `modules/pioneer/pioneer-coins/src/paths.ts`
```typescript
// blockchains array
'hive:beeab0de',

// getPaths()
if (blockchains.indexOf('hive:beeab0de') >= 0) {
    output.push({
        note: "Hive Default",
        type: "address",
        networks: ['hive:beeab0de'],
        script_type: "p2pkh",
        available_scripts_types: ['p2pkh'],
        addressNList: [0x80000000 + 44, 0x80000000 + 1275, 0x80000000 + 0],
        addressNListMaster: [0x80000000 + 44, 0x80000000 + 1275, 0x80000000 + 0, 0, 0],
        curve: 'secp256k1',
        showDisplay: false,
    })
}
```

#### pioneer-nodes `modules/pioneer/pioneer-nodes/src/seeds.ts`
Hive uses its own RPC API (not Blockbook). Add a custom node entry pointing to `https://api.hive.blog` for balance/broadcast.

#### pioneer-discovery `modules/pioneer/pioneer-discovery/src/generatedAssetData.json`
```json
"hive:beeab0de/slip44:1275": {
    "symbol": "HIVE",
    "name": "Hive",
    "chainId": "hive:beeab0de",
    "assetId": "hive:beeab0de/slip44:1275",
    "decimals": 3,
    "isNative": true,
    "type": "native"
}
```

#### pioneer-types `modules/pioneer/pioneer-types/src/pioneer.ts`
```typescript
// availableChainsByWallet[WalletOption.KEEPKEY]
Chain.Hive,
```

#### pioneer-network / pioneer-balance / pioneer-signer
Hive has its own JSON-RPC API (`condenser_api.get_accounts` for balance, `condenser_api.broadcast_transaction` for broadcast). There is no existing pioneer-network module for Hive — a new `@pioneer-platform/hive-network` package is needed, OR balance/broadcast can be handled inline in pioneer-balance and broadcast.controller.ts with direct HTTP calls to `https://api.hive.blog`.

**Simplest path**: inline HTTP calls rather than a new package, since Hive's API is simple:
```typescript
// Balance
const res = await fetch('https://api.hive.blog', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc:'2.0', method:'condenser_api.get_accounts', params:[['USERNAME']], id:1 })
})
const [acct] = (await res.json()).result
const balance = parseFloat(acct.balance) // "1.234 HIVE"

// Broadcast
const res = await fetch('https://api.hive.blog', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc:'2.0', method:'condenser_api.broadcast_transaction', params:[signedTx], id:1 })
})
```

#### broadcast.controller.ts `services/pioneer-server/src/controllers/broadcast.controller.ts`
Add a `HIVE_MAP`:
```typescript
const HIVE_MAP: { [key: string]: string } = {
    'hive:beeab0de': 'hive',
}
```

---

## Transaction Construction (Vault → Pioneer → Broadcast)

Hive transactions use Graphene binary serialization. The firmware already handles this — `HiveSignedTx.serialized_tx` is the complete signed transaction bytes ready to broadcast.

To broadcast: POST `serialized_tx` (hex-encoded) to `condenser_api.broadcast_transaction` on a Hive RPC node.

The signed tx format is: `[ref_block_num(2)] [ref_block_prefix(4)] [expiration(4)] [op_count(1)] [op_type(2)] [transfer_body] [extensions(1=0)] [sig_count(1)] [sig(65)]`

---

## Suggested Work Order

1. **hdwallet** — add Hive types + keepkey transport wiring (1–2 hours)
2. **Vault RPC** — add `hiveGetPublicKey` + `hiveSignTx` RPC handlers (30 min)
3. **Pioneer caip/coins/discovery** — CAIP data, paths, asset metadata (1 hour)
4. **Pioneer balance** — inline Hive API call for `get_accounts` (1 hour)
5. **Pioneer broadcast** — inline `broadcast_transaction` call (30 min)
6. **End-to-end test** — get address → sign transfer → broadcast on mainnet

---

## Reference Implementations

| Coin | Pattern to follow | Why |
|---|---|---|
| TON | `hive.ts` in hdwallet-keepkey | Non-EVM, secp256k1, custom serialization |
| Cosmos | address derivation, secp256k1 | Similar BIP44 path structure |
| TRON | broadcast inline in pioneer | Simple HTTP broadcast without dedicated network module |

---

## Worktree Locations

| Repo | Branch | Path |
|---|---|---|
| keepkey-vault-v11 | `feat/hive` | `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11` (main tree) |
| keepkey-vault-v11 | `feature/hive` | `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-hive` |
| keepkey-firmware | `alpha` (Hive included) | `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-firmware` |
| pioneer | `release/v1.3.73` | `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer` |
