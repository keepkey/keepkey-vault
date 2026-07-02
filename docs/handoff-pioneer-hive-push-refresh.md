# Handoff: Pioneer-side gaps found by the asset-page refresh audit (2026-07-01)

Context: a user sent HIVE to their vault, got no push, and the asset-page
refresh appeared to do nothing. The vault-side root cause (single-chain
`getBalance` missing the `publicKey` derive fallback) is fixed in the vault
repo. A six-agent audit of the full refresh path (vault UI → bun →
pioneer-client → pioneer server → push pipeline) also verified, empirically,
that `?forceRefresh=true` reaches `POST /api/v1/portfolio` and genuinely
bypasses the balance cache — including for hive. The items below are the
**pioneer-side** findings that remain open. Repo: `projects/pioneer`,
branch `develop` (audited @ `00507f37f`).

## 1. HIVE has zero push coverage (HIGH)

An incoming HIVE transfer can never produce a `transaction:incoming` /
`tx:incoming` event:

- `services/pioneer-server/src/websocket/WebSocketHandler.ts:150-163` —
  `setupRedisSubscriptions` subscribes a **hardcoded 12-network list**
  (BTC/LTC/DOGE/BCH/DASH/QTUM + 6 EVM). No `hive:beeab0de` (also no
  cosmos/thorchain/xrp/solana).
- `services/pioneer-watchtower` has **zero hive references** — its chain
  universe is `chainConfig.blockbooks` from pioneer-nodes
  (`modules/pioneer/pioneer-nodes/src/seeds.ts:121-315`); hive has no
  blockbook. The SSE path (`events-stream.controller.ts:73` →
  `pioneer:watcher:add`) terminates in the same blockbook-only watchtower,
  so subscribing hive addresses is a no-op.

Fix: a dedicated hive watcher in watchtower (poll `account_history` for the
resolved account name, publish `pioneer:tx:hive:beeab0de`), and derive
`WATCHED_NETWORK_IDS` from watchtower-supported chains instead of the
hardcoded list.

## 2. Hive address registration uses the STM pubkey, not the account name (MEDIUM, blocks #1)

`modules/pioneer/pioneer-balance/src/index.ts:460` resolves the account name
(`asset.address = hiveAcct.name`) but `BalanceCache.fetchFromSource`
(`modules/pioneer/pioneer-cache/src/stores/balance-cache.ts:237-252`) drops it
— `BalanceData` has no address field — so the address-registration pipeline
registers the **STM public key** as the watchable address
(`balance.controller.ts:1951-1952`). Incoming hive transfers reference the
account name, so push matching could never hit even with a watcher. Pass
`asset.address` through into `BalanceData` and register that for
account-model chains.

## 3. Failed forced refresh rewrites `fetchedAt` → stale data stamped fresh (MEDIUM)

`modules/pioneer/pioneer-cache/src/core/base-cache.ts:521-525` — when a
forced refresh's upstream fetch fails, the stale cached value is served with
`fetchedAt = now` (+`_degraded`). The controller computes `isStale`
(`balance.controller.ts:966-968`) and `staleChains` (`:1598-1612`) from
`fetchedAt`, so both lie for degraded entries; only `meta.failures` tells the
truth. Keep the original fetch timestamp (add `lastAttemptAt` if needed).

## 4. Hive balance adapter is fragile under the 5s per-chain budget (MEDIUM)

`modules/pioneer/pioneer-balance/src/index.ts:438-456` — single hardcoded
node (`https://api.hive.blog`), two **sequential** JSON-RPC POSTs, no
per-request timeout, no failover. The force-refresh path races it against
`CHAIN_FETCH_TIMEOUT_MS = 5000` (`balance-cache.ts:375-404`); on timeout the
user silently gets last-known cache tagged `_degraded` (and per #3, stamped
fresh). Add an AbortController timeout + a fallback node (api.deathwing.me /
anyx.io), and cache the immutable pubkey→account-name resolution.

## 5. Socket events the vault can't decode (LOW)

`WebSocketHandler.ts:1874,1927` emit `balance:update` /
`balance:cache:update` as `JSON.stringify(payload)` **strings** while
`transaction:incoming` (`:410-424`) is an object. Emit objects consistently
(or document the string envelope). NOTE: the vault deliberately does NOT
consume these two events even after its socket-leg repair — see #7.

## 7. `balance:update` / `balance:cache:update` are self-echoes, not worker pushes (HIGH — blocks any client using them)

The **GetPortfolioBalances controller itself** emits these events, per
requested pubkey, to the *requesting user's own sockets*:
`balance.controller.ts:776/788/798` (`emitBalanceCacheUpdate`, subtypes
`updated`/`same`/`skipped` — `skipped` fires whenever `fetchedAt < 5 min`,
i.e. the steady state) and `:974` (`emitBalanceUpdate`, once per pubkey of
the response). These three call sites are the only emitters in the tree —
the background cache worker (`RefreshWorker` / `StaleBalanceScanner`) never
publishes balance updates. So today the events are 100% echoes of the
client's own REST queries: any client that refreshes balances on them
enters a self-sustaining request loop (we confirmed this in review and
reverted the vault's consumption of them — the vault now listens only to
`transaction:incoming`).

For a usable "soft update" signal: emit balance events from the WORKER
refresh path (or add a `source: 'worker' | 'request'` field), gate on
`type === 'updated'` with `balance !== previousBalance`, and don't echo to
the requester's own socket for request-triggered fetches.

## 6. Hive is in the slow soft-update lane (LOW / FYI)

Background refresh for hive falls under the global stale scanner: 1-hour
threshold, 100 keys per 10-min tick (`cache-manager.ts:285-291`,
`stale-balance-scanner.ts`). UTXO gets a 15-min loop; EVM/hive/etc. wait up
to 1h+. With no push (#1), hive freshness is effectively poll-driven from
the vault. Consider a faster class for account-model chains once #1 lands.
