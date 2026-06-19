# Handoff — Headless swap REST endpoints for the BEX (browser extension)

> **UPDATE 2026-06-19 — `/execute` is no longer headless signing.** The
> "device is the only trust gate" stance below was reversed: a swap must never
> reach the device without vault showing the user exactly what they're signing
> (the firmware can only render "send X to `<addr>`", which hides the swap
> intent — router/inbound address + opaque memo). `POST /api/v2/swap/execute`
> now **drives vault's real SwapDialog to its review screen**, seeded with the
> swap, and blocks until the user approves on-screen (vault re-quotes; the
> dialog signs + tracks) or cancels (→ HTTP 409). `/quote` is unchanged.
> BEX-side impact: the signed quote is vault's authoritative re-quote (the BEX
> quote is a pre-estimate); a user rejecting in vault returns 409, not a txid.
> See `headlessExecuteSwap` in `src/bun/index.ts`.

**Captured:** 2026-06-19
**Requested by:** keepkey-client (BEX) swaps epic — a native swap UI composed *entirely inside the extension side panel* (faithful port of the `KeepKey BEX` design). The BEX renders the whole from→to→quote→review→submitted flow itself and signs on the device; it does **not** drive vault's own SwapDialog window.
**For:** whoever implements the vault REST changes.
**Repo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault`

---

## Why this exists / the decision

Today `/api/v2/swap/*` (`src/bun/rest-swap.ts`) is a **UI remote control** for vault's in-app `SwapDialog` — its header comment is explicit: *"No headless quoting, no asset list … quoting + signing + broadcast all flow through the dialog and the device."* `open/set/requote/advance/confirm` pop and drive vault's own window; callers only read mirrored state via `GET /state`.

The BEX swap epic needs the opposite: **headless quote + execute**, so the extension composes its own swap UI and only relies on vault for the engine + the device signature. The user has explicitly sanctioned reversing the "no headless" stance for this.

**This is a deliberate architecture reversal — flag it for the vault owner's sign-off.** Mitigation: the **device remains the trust gate** — `executeSwap` still signs on the physical KeepKey (the firmware shows tx details; the user presses the button). Headless here means "no vault *GUI* in the loop," not "no device confirmation."

The good news: **vault already has the entire engine and even anticipated headless callers.** `swap.ts:501` ships `NOOP_PUSH_SUBSTAGE` *"for REST/headless paths."* The work is wiring REST → functions that already exist.

---

## What to expose

Auth: every route is `auth.requireAuth(req)` (Bearer), identical to the existing `/api/v2/swap/*` routes. The BEX already holds a paired bearer token (`KeepKeySdk` pairing in `chrome-extension/src/background/wallet.ts`).

### 1. `GET /api/v2/swap/assets` — **already exists, reuse as-is**
Firmware-filtered `SwapAsset[]` (`src/shared/types.ts:933`). Handler: `rest-swap.ts` → `callbacks.getDeviceSwapAssets()`. BEX uses this for the from/to picker. No change needed.

### 2. `POST /api/v2/swap/quote` — **NEW (headless)**
- **Body** = `SwapQuoteParams` (`types.ts:1007`):
  `{ fromCaip, toCaip, amount, fromAddress, toAddress, slippageBps?, isMax?, feeLevel? }`
  (BEX supplies `fromAddress`/`toAddress` — it derives them from the device via the SDK; `slippageBps` default 300, `feeLevel` 1/3/5.)
  Reuse the dead `SwapQuoteRequest` zod schema at `src/bun/schemas.ts:474` (currently wired to no route).
- **Returns** `{ data: SwapQuote }` (`types.ts:964`): `expectedOutput, minimumOutput, inboundAddress, router?, memo, expiry?, fees{affiliate,outbound,totalBps}, estimatedTime, slippageBps, integration?, swapper?, relayTx?, warning?, minAmountIn?, netFromAmount?, nearIntents*`.
- **Wraps:** `getSwapQuote()` (`swap.ts:254`) **plus the reserve-clamp / net-amount logic already in the in-app handler at `index.ts:5026-5135`** (isMax → re-quote with the reserve-deducted amount; the `netFromAmount` re-quote for NEAR-Intents UTXO sendMax). Do not reimplement quoting — lift that handler.

### 3. `POST /api/v2/swap/execute` — **NEW (headless, device-signed)**
- **Body** = `ExecuteSwapParams` (`types.ts:1021`), which the BEX builds from the `/quote` response + chain ids:
  `{ fromChainId, toChainId, fromCaip, toCaip, amount, memo, inboundAddress, router?, expiry?, expectedOutput, isMax?, feeLevel?, fromAddressOverride?, toAddressOverride?, fromEvmAddressIndex?, integration?, relayTx?, tokenDecimals? }`
  **plus** the tracker fields the in-app path reads from its in-memory quote cache (`integration, swapper, slippageBps, fees, minimumOutput, estimatedTime, nearIntentsDepositAddress`). **Make `/execute` stateless** — pass these in the body rather than depending on `swapQuoteCache` (the cache works for the same-process dialog; two separate HTTP calls should not rely on it).
- **Behavior:** build a `SwapContext` (`swap.ts:483`) exactly like the in-app handler at **`index.ts:5189-5211`** (`wallet`, `getAllChains`, `getRpcUrl`, `getBtcXpub`, `getAllBtcXpubs`, `wrapSign`, `isAdvancedModeEnabled`), but set **`pushSubStage: NOOP_PUSH_SUBSTAGE`** (`swap.ts:501` — no WebView to update). Call `executeSwap(params, ctx)` → signs on device (blocks on the button press) → broadcasts. Then `trackSwap(result, trackParams, …)` exactly as `index.ts:5214-5234` so `/api/v1/swaps*` and tracking work. Respect the passphrase-privacy `skipPersist` path (`index.ts:5231`).
- **Returns** `{ data: SwapResult }` (`types.ts:1060`): `{ txid, fromCaip, toCaip, fromAmount, expectedOutput, approvalTxid?, fromAmountBaseUnits? }`. For ERC-20 sources `approvalTxid` is a *separate* approval tx the user also signs first — surface it so the BEX can show "approval → swap".
- **Timeout:** device-interactive — the BEX calls with a 5-minute (`AbortSignal.timeout(300000)`) timeout; don't impose a shorter server cap.

### 4. Tracking for the "Swap Submitted" screen — **reuse existing**
`GET /api/v1/swaps/:txid` already returns a `SwapHistoryRecord` (`types.ts:1186`: `status, outboundTxid, receivedOutput, confirmations-ish, completedAt, refundReason, …`). The BEX polls it (no SSE in vault — interval poll ~1–2s). **Gotcha:** it returns empty/404 during a passphrase session by design (`rest-api.ts:3305-3356`) — the BEX must show honest copy for hidden wallets, not "0 swaps."
- *Optional:* if live confirmation counts beyond the persisted record are needed, expose `getPendingSwaps()` (`swap-tracker.ts`) per-txid as `GET /api/v2/swap/track/:txid`. Start without it; add only if `/api/v1/swaps/:txid` proves insufficient.

---

## Implementation shape (suggested, minimal)

The cleanest path mirrors how the dialog is already wired:
1. Add `getSwapQuoteHeadless` + `executeSwapHeadless` to the `RestApiCallbacks` interface (`rest-api.ts`), implemented in `index.ts` by **lifting the existing RPC handlers** (`index.ts:5026` quote, `5145` execute) — same engine calls, same ctx, `NOOP_PUSH_SUBSTAGE`, same `trackSwap`.
2. Add the `quote`/`execute` route cases in `rest-swap.ts` (`handleSwapRoute`, mounted at `rest-api.ts:3651`), `auth.requireAuth` gated, `parseRequest` against the schemas, dispatching to those callbacks. Keep them clearly separated from the remote-control `open/set/...` routes (different mental model).
3. `validateSeedAssets` (`rest-swap.ts:138`) already rejects unknown asset keys at the boundary — reuse for `quote`.

Net new code is small; it's wiring, not engine work.

---

## Definition of done (test plan)

1. `POST /api/v2/swap/quote` with a real CAIP pair + amount returns a `SwapQuote` matching what the dialog shows for the same inputs (incl. reserve clamp on `isMax`).
2. `POST /api/v2/swap/execute` with that quote's fields signs on the device and returns a `txid`; the tx lands; `GET /api/v1/swaps/:txid` shows it progressing to `completed`.
3. ERC-20 source returns `approvalTxid` and both txs land.
4. All four routes 401 without a bearer; the BEX's re-pair-on-401 path (`wallet.ts:239-247`) recovers.
5. Passphrase session: execute still works on-device; history endpoints honestly return empty (BEX shows hidden-wallet copy).
6. No regression to the existing `/api/v2/swap/*` remote-control routes (the dialog still works).

---

## The BEX-side contract (what the extension will do)

For reference — so vault's shapes match the consumer:
- Auth: `wallet.getSdk().getClient().getApiKey()` → `Authorization: Bearer` (pattern copied from `keepkey-client/chrome-extension/src/background/chains/solanaHandler.ts:374-411`).
- Flow: `GET /assets` (picker) → `POST /quote` on input change → render quote read-only → `POST /execute` on "Confirm" (5-min timeout; device button) → poll `GET /api/v1/swaps/:txid` for the progress screen.

---

## File index (absolute)

**vault (this repo):**
- `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/swap.ts` — engine: `getSwapAssets:183`, `getSwapQuote:254`, `SwapContext:483`, `NOOP_PUSH_SUBSTAGE:501`, `executeSwap:505`
- `…/src/bun/index.ts` — in-app RPC handlers to lift: `getSwapAssets:4906`, `getSwapQuote:5026`, `executeSwap:5145`, `getPendingSwaps:5242`
- `…/src/bun/rest-swap.ts` — existing remote-control routes + `handleSwapRoute`; add the headless routes here
- `…/src/bun/rest-api.ts` — `handleSwapRoute` mount `:3651`; `RestApiCallbacks`; `/api/v1/swaps*` history `:3305-3356`
- `…/src/bun/schemas.ts` — `SwapQuoteRequest:474` (reuse), `SwapSeedFields:486`
- `…/src/bun/swap-tracker.ts` — `trackSwap`, `getPendingSwaps`
- `…/src/bun/auth.ts` — `requireAuth:210`
- `…/src/shared/types.ts` — `SwapAsset:933`, `SwapQuote:964`, `SwapQuoteParams:1007`, `ExecuteSwapParams:1021`, `SwapResult:1060`, `SwapHistoryRecord:1186`

**BEX (consumer):**
- `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-client/chrome-extension/src/background/wallet.ts` — vault SDK + bearer token
- `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-client/chrome-extension/src/background/chains/solanaHandler.ts:374-411` — canonical authenticated-fetch-to-vault pattern
- `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-client/_design-bex/KeepKey Extension.html` — the design being ported (untracked)
