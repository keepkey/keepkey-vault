# Handoff — Finish the btc-only self-host epic (zero Pioneer calls)

**Branch:** `btc-only` (draft PR #353 → develop). Stay on it.
**Vault code:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/`
**Goal (definition of done):** when a self-host node is enabled on a bitcoin-only device, Vault makes **ZERO Pioneer calls** for that wallet. Balance ✅ done; **send + price + history still hit Pioneer** — that's the "cheating" the user called out. Finish those.

## Test node (on the tailnet, "beast" = 100.117.181.111)
- **Blockbook** `http://100.117.181.111:9130` — no auth, xpub-native, archival. Returns per-UTXO `path` (verified in the user's send log: `path:"m/84'/0'/0'/0/18"`).
- **Bitcoin Core 28** `http://100.117.181.111:8332` — needs `rpcuser:rpcpassword` (in the node's `bitcoin.conf`).

## What's already done (commit map on `btc-only`)
- Seam + PioneerBackend (`d5e2a0cd`), offline/DeviceOnly (`da195484`), CoreBackend (`daa5a63a`), BlockbookBackend (`cfbc0ce4`), auto-detect type (`741711f8`), split user/pass + save-while-enabled + status bar + connect walkthrough (`fix`/`feat` commits), **balance-read migration** (`b0b8a7f3` — `getBalances` routes BTC through `getBtcBackend().listUnspent(xpub)` when `kind !== 'pioneer'`).
- Design: `docs/design-offline-first-and-node-isolation.md`. Memory: `btconly-node-isolation-offline.md`.
- **Verified live**: Blockbook test/tip/fees/xpub-listUnspent; on-device send SUCCEEDED (but via Pioneer for UTXO+broadcast — that's what this handoff fixes).

## The remaining Pioneer surface (grep of `src/bun`, btc-only+node wallet)
| Pioneer call | Where | Fixed by |
|---|---|---|
| `ListUnspent` (send UTXO fetch) | `txbuilder/utxo.ts:191` | **Task 1** |
| `GetFeeRateByNetwork` / `GetFeeRate` | `txbuilder/utxo.ts:235,341` | **Task 1** |
| `Broadcast` (send) | `txbuilder/index.ts` | **Task 1** |
| `GetPortfolioBalances` (balance) | `index.ts` | ✅ done (`b0b8a7f3`) |
| `GetMarketInfo` (price/USD) | `index.ts`, balance injection | **Task 2** (decision) |
| `GetTransactionHistory` | activity path | **Task 3** |
(Solana/staking/name/gas calls don't fire on btc-only — ignore.)

---

## Task 1 — Send path onto the seam (THE main one)

`txbuilder/utxo.ts` is a **shared multi-UTXO-chain builder** (BTC/LTC/DOGE/BCH/Dash/Zcash). Only **BTC** (`network === 'bip122:000000000019d6689c085ae165831e93'`) routes to the node when `getBtcBackend().kind !== 'pioneer'`; every other coin stays on Pioneer.

**The signing gotcha:** the builder needs each UTXO's **derivation `path`** (e.g. `m/84'/0'/0'/0/18`) to know the `addressNList` to sign with, plus `scriptType` and (for legacy p2pkh) the prev-tx `hex`. Pioneer's `ListUnspent` returns `path` + `tx.hex`. The seam must preserve these.

**Steps:**
1. **Extend `BtcUtxo`** (`btc-backend/types.ts`) — add `address?: string` (already has `path?`, `scriptType?`, `hex?`).
2. **`blockbook.ts` `listUnspent`** — preserve `path` + `address` from the response (`/api/v2/utxo/{xpub}` returns both). Map `{ txid, vout, value: parseInt(u.value), path: u.path, address: u.address, scriptType }`. **Blockbook does NOT return `tx.hex`** → for legacy p2pkh inputs, fetch it via `rawTxHex(txid)` (already implemented, `/api/v2/tx-specific`). Segwit (p2wpkh) needs only value — no hex.
3. **`core.ts` `listUnspent`** — the hard one. `scantxoutset` returns `desc` per unspent (e.g. `wpkh([fp/84h/0h/0h/0/18]xpub…)#cs`) but **no clean `m/…` path**. Parse the origin path out of the descriptor (`[fp/PATH]`) → `m/PATH`. Provide `hex` via `getrawtransaction` (needs `txindex`; Test Connection warns if off). Verify against a Core node with funds.
4. **`txbuilder/utxo.ts`** — in `fetchUtxosForXpub` (and `estimateUtxoFee`/`buildUtxoTx` fee blocks): if `network === BTC_NETWORK_ID && getBtcBackend().kind !== 'pioneer'`, use `getBtcBackend().listUnspent({network, xpub})` + `.feeRate(network)` and MAP the `BtcUtxo[]` into the shape the builder expects (it tags `_sourceAccountPath`, `scriptType`, `value` as Number, `tx.hex`/`hex`, `path`). Keep the Pioneer branch for all other coins + the default. **Preserve the existing address→path / scriptPubKey→path lookup construction** — it keys off `path`.
5. **`txbuilder/index.ts` broadcast** — for BTC, `getBtcBackend().broadcast({ network, rawTxHex: serialized })`; keep Pioneer for other chains.
6. **On-device test**: send a small amount, both a **p2wpkh** (bc1q) and a **legacy p2pkh** (1…) input if available (the latter exercises the `hex` fetch). Confirm the log no longer shows `pioneer.ListUnspent`/`pioneer.Broadcast` for BTC.

**Risk:** this is the live money path. Behaviour must stay byte-identical for non-BTC and for `kind === 'pioneer'`. Test a real send before committing.

---

## Task 2 — Price independence (product decision)

`GetMarketInfo` (USD price) is a Pioneer call. The node doesn't serve price, so "zero Pioneer" forces a choice:
- **(A)** Keep price on Pioneer — pragmatic; price isn't blockchain data. But it's *a Pioneer call*, so not literally zero.
- **(B)** Sats-only / BTC-denominated mode when self-host — no USD, fully sovereign. Cleanest for purists.
- **(C)** Alternate price source (mempool.space, CoinGecko, user-configurable) — another external dep, not the node.

**Recommend:** (B) as the default for self-host ("your node, your unit of account — sats"), with (C) as an opt-in. Confirm with product. Until decided, price stays on Pioneer (documented as the one exception).

---

## Task 3 — Kill the remaining Pioneer calls + noise
- **Activity/history** (`GetTransactionHistory`): route BTC history through the node (Blockbook `/api/v2/address|xpub/{key}` has `transactions`; Core needs archival+rescan → history unavailable, show "history needs Blockbook or an archival node").
- **btc-only log noise**: `[REST] Invalid coin name` for LTC/DOGE/BCH/Dash and `EVM addresses init failed` — the device correctly refusing non-BTC. Extend the existing btc-only short-circuit (`NON_BTC_ADDRESS_PATHS` / `deviceIsBitcoinOnly()`) to cover the batch-pubkey path so these don't spam. Cosmetic but user-facing in logs.
- **Full audit**: with a node enabled, run the app and grep the Bun logs for `pioneer.` / `Pioneer:` / `GetPortfolio` / `Broadcast` — the only acceptable remaining hit is the Task-2 price call (until B/C lands).

---

## Verification (definition-of-done checklist)
Run on the btc-only device with the node enabled:
1. **Balance**: dashboard shows correct BTC; log has `[getBalances] BTC via self-host node (blockbook|core)`, NOT `BTC entries from Pioneer`.
2. **Send (p2wpkh)**: build+sign+broadcast; log shows the node's listUnspent/broadcast, no `pioneer.ListUnspent`/`pioneer.Broadcast` for BTC.
3. **Send (legacy p2pkh)** if fundable: exercises `rawTxHex` prev-tx fetch.
4. **Zero-Pioneer proof**: watch the Bun log (or a network monitor) across a full balance+send cycle — no `pioneer.*` for BTC except the price call (Task 2).
5. **Both backends**: repeat 1–3 against Blockbook `:9130` AND Core `:8332`.
6. **Offline**: airplane mode → OFFLINE strip, balances cached/0, no network.
7. **Multi-chain regression** (non-btc-only device, no node): dashboard balances + a send on ETH and a UTXO alt (LTC) — byte-identical to `develop`. This is the merge gate.

## Guardrails
- Stay on **`btc-only`**; everything rides PR #353.
- Gate on `getBtcBackend().kind !== 'pioneer'` and/or the device btc-only variant — `kind === 'pioneer'` (default) and multi-chain devices MUST be byte-identical.
- No node creds in `.env` (they live in the DB: `btc_node_rpc_user`/`_pass`).
- Typecheck baseline is false-green (`fiatCurrency`/`TFunction`/`never` noise) — judge by differential.
- Every backend has a pure-normalizer unit test (`bun src/bun/btc-backend/*.test.ts`) — add one for the descriptor-path parse (Task 1.3) and the listUnspent path preservation.

## Merge
Only after the Task-1 send migration + the multi-chain regression pass. Balance-from-node + send-from-Pioneer is the half-state the user rejected — don't merge it. Once send is on the node and regression is clean, merge PR #353; price (Task 2) and history (Task 3) can be fast-follows if scoped as known gaps.
