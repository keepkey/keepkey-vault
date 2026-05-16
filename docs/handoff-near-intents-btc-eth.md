# Handoff: BTC→ETH via ShapeShift NEAR Intents

**Status**: Pioneer (blue) deployed ✅ — Vault changes committed locally, needs PR  
**Branch**: `portfolio-debug` in keepkey-vault-v11  
**Pioneer branch**: `release/dedup-scam-filter` → api-blue.keepkey.info  

---

## What was fixed

THORChain is globally halted (all 43 pools, `trading_halted: true`). MayaChain is down (502).
ShapeShift routes BTC→ETH via **NEAR Intents** — a memo-less deposit: just send BTC to a
deposit address, no OP_RETURN memo required. Three layers needed fixing:

### 1. Pioneer: `shapeshift-swap` client (`modules/intergrations/shapeshift-swap/src/index.ts`)

ShapeShift's NEAR Intents response puts the BTC deposit address in `step.allowanceContract`,
not `step.transactionData.to` (which is `{}`). The transfer branch now reads:

```
depositAddress = txData.to || step.allowanceContract || originalQuote.recipientAddress
txParams.to = depositAddress
txParams.recipientAddress = depositAddress
txParams.swapper = step.source   // 'NEAR Intents'
```

### 2. Pioneer: router (`modules/pioneer/pioneer-router/src/index.ts`)

- `hasInstructions` now accepts `transfer`-type txs that have a destination address (no memo required).
- `MEMOLESS_SUPPORT` now includes `shapeshiftSwap: true` so `memoless: true` requests route via NEAR Intents instead of returning "No quotes available".

### 3. Vault: `swap-parsing.ts` + `swap.ts`

Two memo-required guards each needed a NEAR Intents exemption:

```ts
const isMemolessTransfer = !!inboundAddress && swapper === 'NEAR Intents'
```

Files changed:
- `projects/keepkey-vault/src/bun/swap-parsing.ts` — line ~185
- `projects/keepkey-vault/src/bun/swap.ts` — lines ~401 and ~683

---

## How to test locally

### Prerequisites

- Pioneer running locally (`make start` in pioneer monorepo, port 9001)
- Vault running against local Pioneer (or use `--blue` flag in the e2e test to hit blue)
- BTC in the wallet (need ~0.001+ BTC + fees)
- KeepKey connected

### 1. Verify Pioneer returns a NEAR Intents quote

```bash
curl -s -X POST http://localhost:9001/api/v1/quote \
  -H "Content-Type: application/json" \
  -d '{
    "sellAsset": "bip122:000000000019d6689c085ae165831e93/slip44:0",
    "sellAmount": "0.001",
    "buyAsset": "eip155:1/slip44:60",
    "recipientAddress": "0xYOUR_ETH_ADDRESS",
    "senderAddress": "YOUR_BTC_ADDRESS"
  }' | python3 -m json.tool
```

**Expected response shape**:
```json
[{
  "integration": "shapeshiftSwap",
  "quote": {
    "swapper": "NEAR Intents",
    "txs": [{
      "type": "transfer",
      "txParams": {
        "to": "bc1q...",           ← BTC deposit address (from allowanceContract)
        "recipientAddress": "bc1q...",
        "memo": "",                ← intentionally empty
        "swapper": "NEAR Intents"
      }
    }]
  }
}]
```

Key things to confirm:
- `txs[0].type` is `"transfer"` (not `"EVM"`)
- `txParams.to` is a valid `bc1q...` bech32 address
- `txParams.memo` is empty/absent
- `quote.swapper` is `"NEAR Intents"`

### 2. Check swap health (verify THORChain is still halted)

```bash
curl -s http://localhost:9001/api/v1/swap/health | python3 -m json.tool
# or against blue:
curl -s https://api-blue.keepkey.info/api/v1/swap/health | python3 -m json.tool
```

THORChain should show `"status": "degraded"` with BTC in `haltedPools`.
ShapeShift and Relay should show `"status": "ok"`.

### 3. Apply vault changes

The vault changes are on `portfolio-debug` in keepkey-vault-v11. Cherry-pick or apply manually:

**`src/bun/swap-parsing.ts`** — around the `!memo && !hasPrebuiltTx` check (~line 185):

```diff
+ // For memo-less UTXO swaps (e.g. NEAR Intents via ShapeShift), the deposit
+ // address IS the only instruction — no memo or calldata needed.
+ const isMemolessTransfer = !!inboundAddress && swapper === 'NEAR Intents'
  if (!memo && !hasPrebuiltTx && !isNativeDeposit) {
+ if (!memo && !hasPrebuiltTx && !isNativeDeposit && !isMemolessTransfer) {
    throw new Error('Quote returned no swap instructions ...')
  }
```

**`src/bun/swap.ts`** — two places, same pattern:

```diff
  const hasPrebuiltTx = !!params.relayTx
  const isNativeDeposit = isNativeDepositCaip(params.fromCaip)
+ const isMemolessTransfer = !!params.inboundAddress && params.swapper === 'NEAR Intents'
  if (!params.inboundAddress && !isNativeDeposit && !hasPrebuiltTx) throw new Error(...)
- if (!params.memo && !hasPrebuiltTx) throw new Error('Missing swap memo from quote')
+ if (!params.memo && !hasPrebuiltTx && !isMemolessTransfer) throw new Error('Missing swap memo from quote')
```

(Occurs at ~line 400 in `executeSwap` and ~line 683 in `previewSwap`.)

### 4. Run the e2e swap test

```bash
cd e2e/swaps/e2e-swap-suite

# Against blue Pioneer + local vault (typical local dev setup):
bun run simple-swap \
  "bip122:000000000019d6689c085ae165831e93/slip44:0" \
  "eip155:1/slip44:60" \
  "0.001" \
  --blue

# Against local Pioneer:
bun run simple-swap \
  "bip122:000000000019d6689c085ae165831e93/slip44:0" \
  "eip155:1/slip44:60" \
  "0.001" \
  --local
```

**Expected flow**:
1. Quote fetched — `shapeshiftSwap / NEAR Intents` selected
2. Preview builds — plain BTC send to `bc1q...` deposit address, no memo
3. KeepKey shows "Send 0.001 BTC to bc1q..." (no OP_RETURN output)
4. User confirms on device
5. BTC tx broadcasts
6. ~13 minutes later ETH arrives at recipient address

### 5. What "success" looks like in the UI

When THORChain is halted, the swap dialog should:
- Show amber/red dot on THORChain in the provider health bar (if implemented)
- Fall through to ShapeShift NEAR Intents automatically
- Show no memo field in the preview (NEAR Intents is memo-less)
- Show estimated time ~13 minutes (812s from ShapeShift API)

---

## Why the UTXO tx builder works without changes

`createUnsignedUtxoTx` already handles empty memo correctly:

```ts
const memoRaw = memo && memo.trim() ? memo.trim() : undefined
// ...
...(memoRaw ? { opReturnData: memoRaw } : {}),  // skipped when empty
```

An empty memo produces a plain BTC send to `params.inboundAddress` (the deposit address)
with no OP_RETURN output — exactly what NEAR Intents requires.

---

## Pairs that work via NEAR Intents

NEAR Intents routes any UTXO→EVM pair ShapeShift supports. Confirmed working:
- BTC → ETH
- BTC → USDC (eip155:1)
- BTC → any EVM token ShapeShift lists

UTXO→UTXO (BTC→LTC) and EVM→UTXO are not supported by NEAR Intents.

---

## Current network status (as of 2026-05-15)

| Integration | Status | Notes |
|---|---|---|
| THORChain | ❌ All pools halted | `trading_halted: true` on all 43 pools |
| MayaChain | ❌ Down | 502 from midgard |
| ShapeShift NEAR Intents | ✅ Working | BTC→ETH confirmed |
| Relay | ✅ Working | EVM↔EVM only |
