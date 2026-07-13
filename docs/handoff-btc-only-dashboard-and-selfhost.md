# Handoff — Bitcoin-only revisions: dedicated dashboard, header scoping, address book, self-host node

**Branch:** `btc-only` (stay here — do NOT open new branches; this is the single consolidated line, draft PR #353 → develop).
**Worktree:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11`
**Vault code:** `projects/keepkey-vault/`
**Status:** scoping/handoff. Nothing below is built yet. The btc-only *detection* substrate it all builds on is already merged on this branch (see "What already exists").

## What already exists (build on this, don't rebuild)
- `isBitcoinOnlyVariant(firmwareVariant)` in `src/shared/flags.ts` — the single source of truth. Returns true for device Features `firmware_variant` = `KeepKeyBTC`/`EmulatorBTC`. Fully plumbed fw→proto→hdwallet→engine→UI, unit-tested (`src/shared/flags.test.ts`).
- `DeviceStateInfo.firmwareVariant` (`src/shared/types.ts`) is on every `getDeviceState()`; the Dashboard already computes `const btcOnly = isBitcoinOnlyVariant(firmwareVariant)` (`Dashboard.tsx:~1459`) and restricts `visibleChains` to Bitcoin.
- Non-BTC address derivation is already short-circuited for btc-only (`rest-api.ts` `NON_BTC_ADDRESS_PATHS` + batch guard) — no multi-chain log spam.
- Balance cache is purged of non-BTC rows on connect (`clearNonBitcoinBalances`, `engine-controller.ts`).
- Bitcoin-only branded splash (`SplashScreen.tsx` `isBitcoinOnly`, held ~2.2s on startup via `btcSplashHold` in `App.tsx`).
- **`BITCOIN_ONLY_ONBOARDING` flag is OFF** and gates only the OOB firmware picker. Everything below should trigger off the live device variant (`btcOnly`), NOT the flag — so it works the moment a btc-only device connects.

---

## Revision 1 — Dedicated bitcoin-only dashboard

**Why:** the donut + per-chain breakdown are meaningless for a single-asset wallet. Today `Dashboard.tsx` has two views (`type DashboardView = 'orbital' | 'donut'`, `Dashboard.tsx:110`) both built around a multi-chain `allChainsChartData` donut (`Dashboard.tsx:1335`).

**Scope:** when `btcOnly`, render a third view — `'bitcoin'` — instead of orbital/donut. No donut, no chain slices, no allocation. Bitcoin-first layout:
- Big BTC balance (fiat + ₿) and 24h price/line.
- Accounts / xpubs list (the device can hold several BTC accounts — account 0, 1, …) with per-account balance; this is the *real* breakdown for btc-only (by account, not by chain).
- Optional: UTXO count / coin-control entry point, next receive address, send/receive actions.
- Keep swap **only if** THORChain BTC swaps stay in scope (btc-only can swap BTC→native via THORChain memo — no EVM). Decision below.

**Where:**
- `Dashboard.tsx` — add `'bitcoin'` to `DashboardView`; when `btcOnly`, force it and skip the view toggle. Gate the donut/orbital branches behind `!btcOnly`.
- New `src/mainview/components/BitcoinDashboard.tsx` (or a `btcOnly` branch inside Dashboard) — keep it a sibling, don't fork the whole Dashboard. Reuse existing balance/account data already loaded for the `bitcoin` chain.
- The account list data already exists (BTC xpubs/accounts are derived today) — surface it instead of hiding it behind chain drill-down.

**Open decision:** does btc-only keep Swap (THORChain BTC) and the Audit/Reports row, or is it a pure send/receive/hold wallet? Recommend: keep Send/Receive + Swap(THORChain-only) + Audit; drop everything EVM/multi-chain.

---

## Revision 2 — Hide WalletConnect + ShapeShift in the header

**Why:** WalletConnect (dApp sessions) and ShapeShift are multi-chain/EVM surfaces; irrelevant on btc-only.

**Where:** `src/mainview/components/TopNav.tsx`
- ShapeShift is a **tab** in the tabs array (`TopNav.tsx:205`, `id: "shapeshift"`). WalletConnect is a **button** rendered when `onWalletConnectToggle` is set (`TopNav.tsx:393`).
- TopNav does not currently receive the variant. Thread `isBitcoinOnly` down from `App.tsx` (compute once: `isBitcoinOnlyVariant(deviceState.firmwareVariant)` — already done as `splashBitcoinOnly`).
- When `isBitcoinOnly`: filter `"shapeshift"` out of the tabs array, and don't render the WC button (or pass `onWalletConnectToggle={undefined}`).

**Effort:** small (~1 prop + two conditionals). Do this one first — it's the cheapest win and exercises the TopNav plumbing the dashboard toggle also needs.

---

## Revision 3 — Address book, btc-only scoping

**Why:** `AddressBookView.tsx` lists entries across all `CHAINS` (`AddressBookView.tsx:6,14`) with a chain filter defaulting to `"all"` (`:42`). On btc-only, non-BTC entries are dead weight (can't send to them) and the chain filter offers chains the device can't use.

**Scope:** when `btcOnly`:
- Restrict the visible entries + the chain-filter options to the Bitcoin family (bitcoin, and decide on BTC forks — see node section; likely bitcoin only).
- Hide the chain-filter control entirely if only one chain remains.
- Address *capture* paths (swap/WC counterparties) are moot once Rev 2 hides those surfaces.

**Note:** "the address book needs to be addressed" was stated loosely — confirm with product whether btc-only should (a) hide non-BTC entries, or (b) keep them visible but non-actionable. Recommend (a) hide.

---

## Revision 4 — Self-host node ("Self Host" button, btc-only only, configurable)

**Goal:** a btc-only-only header/settings button **"Self Host"** that lets the user point their wallet's Bitcoin data at their **own node** instead of the default (Pioneer) backend — sovereignty for the btc-only crowd.

### Current data path
Vault → **Pioneer** (kkapi/REST, `pioneers.dev`) → **blockbook**. The vault has **no direct node client** today. There is already a configurable *Pioneer-server* list: table `pioneer_servers` + `getPioneerServers`/`addPioneerServerDb`/`removePioneerServerDb` (`db.ts:257,803,816,828`), surfaced in settings. That configures which **Pioneer** instance to hit — a different layer than the node backend.

### The one architecture decision that drives everything
**A) Pioneer-proxied self-host** — user points the vault at a Pioneer instance they run (or that is configured against their node), via the existing `pioneer_servers` mechanism. *Least vault change; user must run Pioneer + a node. Keeps the "all tx build/broadcast through Pioneer" convention.*

**B) Direct-from-vault self-host** — the Bun backend gets its **own** Bitcoin backend client (blockbook / electrum / core) and serves BTC balance/UTXO/fee/broadcast **without Pioneer** for btc-only. *Maximum sovereignty (the actual point of "self host"), but a large new subsystem and it bypasses the Pioneer-always convention for BTC reads/broadcast.*

Recommendation: **B, phased**, because "self host" that still depends on our Pioneer isn't self-host. But (A) is a legitimate MVP if we want it shipping this cycle — reuse `pioneer_servers`, label it clearly, and defer the direct client. **Get product's call here before building.**

### Node/backend types we can support (the candidates you asked about)
A BTC wallet needs, per account xpub: **balance, UTXO set, tx history, fee estimate, broadcast**. Raw Bitcoin Core does *not* index by address, so every option is really "how do we get address/xpub-indexed data."

| Backend | Query model | xpub-native? | Vault integration cost | Who runs it | Notes |
|---|---|---|---|---|---|
| **Blockbook** (Trezor) | REST + WS | **Yes** (query by xpub, handles gap limit) | **Lowest** — Pioneer already speaks blockbook; a direct blockbook client is a thin REST wrapper | Advanced self-hosters | Heavy on disk/RAM (full address index, ~700GB mainnet), slow initial sync. Best *drop-in*. WebSocket gives live balance push. |
| **Electrum server** (Fulcrum / electrs / ElectrumX) | JSON-RPC over TCP/SSL, by **scripthash** | No — vault derives addrs from xpub → scripthash, does gap-limit scan | Medium — need an Electrum client in the **Bun** backend (raw TCP/SSL socket; can't be done from the webview), plus scripthash derivation + fee/broadcast mapping | **Almost everyone** — Umbrel, Start9, RaspiBlitz, myNode, Citadel all ship electrs/Fulcrum | **Highest impact**: it's what self-hosters actually have. Fulcrum = fast; electrs = light. Watch SSL cert trust + connection lifecycle. |
| **Bitcoin Core** (descriptor watch-only) | JSON-RPC over HTTP (cookie/userpass) | Via `importdescriptors` of `wpkh([fp/84h/0h/0h]xpub/<0;1>/*)` | Medium-High — manage a watch-only wallet per account; `importdescriptors` triggers a **rescan** (minutes→hours); poll (no push) | Purists with just `bitcoind` | Most sovereign (no third-party indexer). `listunspent`/`getbalances`/`listtransactions`, `estimatesmartfee`, `sendrawtransaction`. Rescan UX is the sharp edge. |
| **Esplora** (Blockstream, electrs REST) | REST, by address/scripthash | No (gap-limit scan) | Low-Medium — REST, easy from Bun | Umbrel/mempool users | Like blockbook-lite over REST. Good fallback if we already build address-scan logic for Electrum. |

**Recommended phasing:**
1. **Blockbook (direct client)** — lowest lift, xpub-native, reuses everything the blockbook path already assumes. Ship first.
2. **Electrum (Fulcrum/electrs)** — the real self-host win (covers all the node boxes). Biggest new code: Bun-side Electrum TCP/SSL client + xpub→scripthash gap scanning.
3. **Bitcoin Core (descriptor watch-only)** — full sovereignty; gate behind a "this will rescan, may take a while" flow.
4. Esplora optional once (2)'s address-scan logic exists.

### The "Self Host" button + config
- **Button:** header or Settings, **rendered only when `btcOnly`** (same gate as Rev 2). Opens a Self-Host config panel.
- **Config (persist like `pioneer_servers` — new table `btc_nodes` or reuse the pattern):** node **type** (blockbook | electrum | core | esplora), **URL/host:port**, optional **auth** (Core cookie/userpass; Electrum SSL toggle), a **"Test connection"** button (fetch tip height / server banner), enable/disable, and which account(s) it serves.
- **Routing:** when a self-host node is enabled and healthy, btc-only BTC reads/broadcast route to it (arch option B); on failure, surface a loud banner and (config decision) either fall back to Pioneer or hard-fail. Reuse the `meta.degraded` fault-tolerance pattern already in the portfolio path.
- **Never** put node URLs/creds in `.env`; store in the vault DB like `pioneer_servers`. Follow the no-`||`-fallback-on-critical-fields rule for the node URL/scheme.

### Open decisions for product before building Rev 4
1. Architecture **A vs B** (proxied vs direct). Recommend B, phased; A acceptable as MVP.
2. Fallback-to-Pioneer on node failure, or strict self-host (no fallback)?
3. Which node type ships first (recommend Blockbook), and is Electrum a fast-follow (it's the high-value one)?
4. Does self-host also handle **broadcast** (it should, for true sovereignty) or only reads at first?

---

## Suggested build order
1. **Rev 2** (hide WC/ShapeShift) — trivial, establishes the `isBitcoinOnly` → TopNav prop path.
2. **Rev 1** (btc-only dashboard) — the big visible win; reuses the account/balance data already loaded.
3. **Rev 3** (address book scoping) — small, do alongside Rev 1.
4. **Rev 4** (self-host) — largest; needs the product decisions above first. Ship Blockbook (phase 1), then Electrum.

## Guardrails (this repo)
- Stay on **`btc-only`**; all of the above lands here and rides the single draft PR #353 → develop.
- Gate every btc-only behaviour on the live device variant (`isBitcoinOnlyVariant(deviceState.firmwareVariant)`), **not** the `BITCOIN_ONLY_ONBOARDING` flag.
- Multi-chain devices must be byte-identical — every change is behind a `btcOnly` conditional.
- Typecheck baseline is false-green (`tsc` aborts on `@types/minimatch`); judge by differential, not absolute error count.
- No node creds in `.env`; persist in the vault DB.
