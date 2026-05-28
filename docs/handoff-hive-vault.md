# Handoff: Hive Vault Integration

> Updated 2026-05-22. Pioneer `feat/hive-support` branch running on localhost:9001.

---

## Status Matrix

| Layer | Status | Notes |
|---|---|---|
| Firmware (`alpha`) | ✅ Done | `hive.c`, wire IDs 1600–1603 |
| device-protocol | ✅ Done | `messages-hive.proto` |
| `hdwallet-core` types | ✅ Done | `packages/hdwallet-core/src/hive.ts` |
| `hdwallet-keepkey` adapter | ✅ Done | `packages/hdwallet-keepkey/src/hive.ts` |
| `keepkey.ts` wiring | ✅ Done | lines 1573-1578 |
| Vault RPC handlers | ✅ Done | `src/bun/index.ts` lines 1629-1647 |
| Pioneer CAIP/balance | ✅ Live | `feat/hive-support` → PR #66 |
| Pioneer `/hive/*` endpoints | ✅ Live | `hive.controller.ts` — all 4 endpoints |
| Pioneer broadcast fix | ✅ Live | Now requires `body.signedTx` JSON, not raw bytes |
| **`chains.ts`** | ❌ Missing | No Hive entry → nothing derives or displays |
| **`txbuilder/hive.ts`** | ❌ Missing | No buildTx / signTx / broadcastTx for Hive |
| **Address extraction fix** | ❌ Bug | `result?.address` must also check `result?.publicKey` |
| **HBD token** | ❌ Not started | Same account/key as HIVE, separate CAIP |

**Vault work = 3 files: `chains.ts`, `txbuilder/hive.ts`, one-line fix in `index.ts`.**

---

## Pioneer API Surface (localhost:9001)

All endpoints live on the `feat/hive-support` branch.

### `GET /hive/account/{pubkey}`

Resolve an STM public key to its on-chain account and return the full account state.

**`pubkey`** = STM-prefixed base58 key from the device (e.g. `STM6n9vMPPjW...`)

```bash
curl http://localhost:9001/hive/account/STM6n9vMPPjWGHZBUfckpH3dKYHjTqwLkQMFXqNm4JZGC...
```

**Response (account exists):**
```json
{
  "success": true,
  "account": {
    "name": "alice",
    "hive": "1281.778",
    "hbd": "521.275",
    "hp": "553.421",
    "hiveSavings": "0.000",
    "hbdSavings": "11261.982",
    "pendingHive": "0.000",
    "pendingHbd": "0.000",
    "pendingHp": "0.000",
    "hpDelegatedOut": "0.000",
    "hpDelegatedIn": "0.341",
    "rcPercent": 82,
    "rcCurrent": "12345678900",
    "rcMax": "15000000000",
    "poweringDown": false,
    "powerDownWeeklyHp": "0.000"
  }
}
```

**Response (key not yet registered to any account):**
```json
{ "success": true, "noAccount": true }
```

The vault should show `noAccount: true` as an informational state ("No Hive account for this key yet — create one at ecency.com/signup"), not as an error.

---

### `GET /hive/tx-params`

Get current block reference parameters before calling `hiveSignTx` on the device.

```bash
curl http://localhost:9001/hive/tx-params
```

**Response:**
```json
{
  "success": true,
  "refBlockNum": 37727,
  "refBlockPrefix": 2927886070,
  "expirationUnix": 1748030520,
  "expirationIso": "2026-05-22T18:02:00",
  "chainId": "beeab0de00000000000000000000000000000000000000000000000000000000"
}
```

These map directly to the `HiveSignTx` proto fields the firmware expects.

---

### `GET /hive/history/{account}`

Recent transfers for a Hive account name (NOT the STM key — use the `name` from `/hive/account/{pubkey}` first).

```bash
curl http://localhost:9001/hive/history/alice
```

**Response:**
```json
{
  "success": true,
  "account": "alice",
  "transfers": [
    {
      "txid": "432d26148e41ec2bd5f0c05cc8c05bfb845467b3",
      "blockNum": 93210456,
      "timestamp": "2026-05-21T14:23:00",
      "type": "transfer",
      "from": "bob",
      "to": "alice",
      "amount": "1.000 HIVE",
      "memo": "payment"
    }
  ]
}
```

---

### `POST /hive/broadcast`

Broadcast a fully signed transaction. The vault calls this after `hiveSignTx` returns from the device. Accepts the original tx params + the hex signature, assembles the JSON tx internally, and calls `condenser_api.broadcast_transaction_synchronous`.

```bash
curl -X POST http://localhost:9001/hive/broadcast \
  -H 'Content-Type: application/json' \
  -d '{
    "ref_block_num": 37727,
    "ref_block_prefix": 2927886070,
    "expiration": "2026-05-22T18:02:00",
    "from": "alice",
    "to": "bob",
    "amount": "1.000 HIVE",
    "memo": "test",
    "signature": "205a951eff2cebf71d81838e231..."
  }'
```

**Response:**
```json
{
  "success": true,
  "txid": "432d26148e41ec2bd5f0c05cc8c05bfb845467b3",
  "blockNum": 93210457,
  "trxNum": 2
}
```

`signature` is the 65-byte recoverable secp256k1 signature from `HiveSignedTx.signature` converted to hex (`Buffer.from(signedTx.signature).toString('hex')`).

---

### `POST /api/v1/balance` (existing, enhanced)

```json
{
  "caip": "hive:beeab0de/slip44:1275",
  "pubkey": "STM6n9vMPPjW..."
}
```

Returns `asset.balance` (HIVE amount as string) and `asset.address` (resolved account name). If no account exists, returns `balance: "0"`.

---

## Vault Implementation Guide

### Step 1 — `src/shared/chains.ts`

**Extend `chainFamily` union (line 13):**
```typescript
chainFamily: 'utxo' | 'evm' | 'cosmos' | 'xrp' | 'solana' | 'zcash-shielded' | 'tron' | 'ton' | 'hive'
```

**Add to `CONFIGS` array (after the `ton` entry):**
```typescript
{
  id: 'hive', chain: 'HIVE', coin: 'Hive', symbol: 'HIVE',
  chainFamily: 'hive', color: '#E31337',
  rpcMethod: 'hiveGetPublicKey',
  signMethod: 'hiveSignTx',
  defaultPath: [0x80000000 + 44, 0x80000000 + 1275, 0x80000000 + 0, 0, 0],
  explorerAddressUrl: 'https://hiveblocks.com/@{{address}}',
  explorerTxUrl:      'https://hiveblocks.com/tx/{{txid}}',
  minFirmware: '7.14.0',
},
```

`Chain.Hive = 'HIVE'`, `BaseDecimal.HIVE = 3`, and `ChainToNetworkId['HIVE'] = 'hive:beeab0de'` are all live in `@pioneer-platform/pioneer-caip` (PR #66). No `CAIP_FALLBACKS` or `NETWORKID_FALLBACKS` needed once the package is bumped.

---

### Step 2 — Address extraction fix in `src/bun/index.ts`

The `hiveGetPublicKey` RPC returns `{ publicKey: 'STM6...', rawPublicKey: Uint8Array }` — there is no `address` field. The generic non-EVM derivation loop uses `result?.address || ''`, so the Hive address will always be empty.

Find the line (appears in multiple getBalances/getAddress paths):
```typescript
const address = typeof result === 'string' ? result : result?.address || ''
```

Change to:
```typescript
const address = typeof result === 'string' ? result : result?.address || result?.publicKey || ''
```

Apply this in **every** call site that calls `wallet[method](addrParams)` for non-EVM chains (grep for `result?.address`).

---

### Step 3 — `src/bun/txbuilder/hive.ts` (new file)

Create this file then wire it into `index.ts`.

```typescript
// src/bun/txbuilder/hive.ts

const HIVE_CHAIN_ID = 'beeab0de00000000000000000000000000000000000000000000000000000000'
const PIONEER_BASE = 'http://localhost:9001'  // or use the pioneer client

export interface HiveBuildParams {
  fromAccount: string
  to: string
  amount: string    // "1.234 HIVE" or "1.234 HBD"
  memo?: string
  addressNList: number[]
}

export interface HiveUnsignedTx {
  addressNList: number[]
  chainId: Buffer
  refBlockNum: number
  refBlockPrefix: number
  expiration: number        // Unix timestamp
  expirationIso: string     // ISO string for broadcast
  from: string
  to: string
  amount: number            // in milliHIVE (3 decimals), e.g. 1234 for "1.234 HIVE"
  decimals: number          // always 3
  assetSymbol: string       // "HIVE" or "HBD"
  memo: string
  // Kept for broadcast reconstruction — not sent to device
  _broadcastParams: {
    from: string; to: string; amount: string; memo: string
    ref_block_num: number; ref_block_prefix: number; expiration: string
  }
}

export async function buildHiveTransfer(
  pioneer: any,
  params: HiveBuildParams,
): Promise<HiveUnsignedTx> {
  // Get block reference from Pioneer
  const txParamsResp = await pioneer.GetHiveTxParams()   // or direct fetch
  const txParams = txParamsResp?.data || txParamsResp
  if (!txParams?.success) throw new Error(`GetHiveTxParams failed: ${txParams?.error}`)

  const amountFloat = parseFloat(params.amount)
  const amountMilli = Math.round(amountFloat * 1000)
  const assetSymbol = params.amount.toUpperCase().includes('HBD') ? 'HBD' : 'HIVE'

  return {
    addressNList:   params.addressNList,
    chainId:        Buffer.from(HIVE_CHAIN_ID, 'hex'),
    refBlockNum:    txParams.refBlockNum,
    refBlockPrefix: txParams.refBlockPrefix,
    expiration:     txParams.expirationUnix,
    expirationIso:  txParams.expirationIso,
    from:           params.fromAccount,
    to:             params.to,
    amount:         amountMilli,
    decimals:       3,
    assetSymbol,
    memo:           params.memo || '',
    _broadcastParams: {
      from:             params.fromAccount,
      to:               params.to,
      amount:           params.amount,
      memo:             params.memo || '',
      ref_block_num:    txParams.refBlockNum,
      ref_block_prefix: txParams.refBlockPrefix,
      expiration:       txParams.expirationIso,
    },
  }
}

export async function broadcastHiveTx(
  pioneer: any,
  signedTx: any,
): Promise<{ txid: string }> {
  const bp = signedTx._broadcastParams
  if (!bp) throw new Error('Hive signed tx missing _broadcastParams')

  const sig: string = signedTx.signature instanceof Uint8Array
    ? Buffer.from(signedTx.signature).toString('hex')
    : signedTx.signature

  const resp = await pioneer.BroadcastHiveTx({
    ...bp,
    signature: sig,
  })
  const data = resp?.data || resp
  if (!data?.success) throw new Error(`Hive broadcast failed: ${data?.error}`)
  return { txid: data.txid }
}
```

---

### Step 4 — Wire into `src/bun/txbuilder/index.ts`

**Import:**
```typescript
import { buildHiveTransfer, broadcastHiveTx, type HiveUnsignedTx } from './hive'
```

**In `buildTx()`:**
```typescript
case 'hive': {
  const unsignedTx = await buildHiveTransfer(pioneer, {
    fromAccount: params.fromAddress,
    to:          params.to,
    amount:      `${params.amount} ${params.asset || 'HIVE'}`,
    memo:        params.memo,
    addressNList: chain.defaultPath,
  })
  const fee = '0'  // Hive uses RC, no HIVE fee
  return { unsignedTx, fee }
}
```

**In `signTx()`:**
```typescript
case 'hive': {
  const hiveResult = await wallet.hiveSignTx(unsignedTx)
  // Preserve _broadcastParams through signing for broadcast reconstruction
  return { ...hiveResult, _broadcastParams: unsignedTx._broadcastParams }
}
```

**In `broadcastTx()`:**
```typescript
if (chain.chainFamily === 'hive') {
  return await broadcastHiveTx(pioneer, signedTx)
}
```

---

### Step 5 — Account name display

After `getBalances()` derives the Hive STM key, call `GET /hive/account/{pubkey}` to get the resolved account name. Store it so the UI can show `@alice` instead of `STM6n9vMPPjW...`.

The `POST /api/v1/balance` call already sets `asset.address = hiveAcct.name` — so if the vault feeds the balance response back into the account display, it gets the name for free.

---

## Key Numbers

| Field | Value |
|---|---|
| SLIP-44 | `1275` (KeepKey-specific) |
| Chain ID | `beeab0de000...` (64 hex chars, 32 bytes) |
| CAIP networkId | `hive:beeab0de` |
| CAIP assetId | `hive:beeab0de/slip44:1275` |
| Decimals | `3` (milliHIVE) |
| Derivation path | `m/44'/1275'/0'/0/0` → active key |
| Wire ID: HiveGetPublicKey | `1600` |
| Wire ID: HivePublicKey | `1601` |
| Wire ID: HiveSignTx | `1602` |
| Wire ID: HiveSignedTx | `1603` |
| Pioneer endpoints | `localhost:9001/hive/*` |
| Hive RPC nodes | `api.hive.blog`, `anyx.io` |
| No-account state | `noAccount: true` — not an error, needs faucet |
| RC warning threshold | < 20% — show UI warning |
| Min firmware | `7.14.0` |

---

## Hive Quirks Reference

| Quirk | Impact |
|---|---|
| Identity = username, not address | `result?.publicKey` stored as pubkey; `account.name` shown in UI |
| `hiveGetPublicKey` returns `{ publicKey }` not `{ address }` | Fix `result?.address \|\| result?.publicKey` in index.ts |
| No fees — Resource Credits | Show `rcPercent` in wallet; warn below 20% |
| `noAccount: true` is normal for fresh keys | Guide user to faucet, not error state |
| Broadcast = JSON tx object | **Not** raw bytes. Use `POST /hive/broadcast` |
| `broadcast_transaction_synchronous` | Returns txid + block_num — use this not the async variant |
| HBD is second asset, same key | Add `hive:beeab0de/token:HBD` in a follow-up PR |
| SLIP-44 = 1275 | Do NOT use 135 (that's Steem) |

---

## Pioneer Files Changed (PR #66 + this session)

| File | Change |
|---|---|
| `pioneer-caip/src/data.ts` | `Chain.Hive`, all CAIP maps |
| `pioneer-caip/src/supported-caips.ts` | `hive:` prefix → `'HIVE'` |
| `pioneer-coins/src/paths.ts` | BIP44 path entry |
| `pioneer-coins/src/types.ts` | `ScriptType` union extended |
| `pioneer-discovery/src/generatedAssetData.json` | HIVE asset metadata |
| `pioneer-types/src/pioneer.ts` | `Chain.Hive` in KEEPKEY chains |
| `pioneer-balance/src/index.ts` | `case 'HIVE'` with key resolution |
| `broadcast.controller.ts` | Hive now requires `body.signedTx` JSON |
| **`hive.controller.ts`** (new) | `/hive/account`, `/hive/tx-params`, `/hive/history`, `/hive/broadcast` |

PR: https://github.com/coinmastersguild/pioneer/pull/66
