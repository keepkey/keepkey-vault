# Handoff: Vault — Pioneer SSE Event Streaming

**Branch:** `feature-streams`  
**Status:** Vault implementation complete. Requires Pioneer server on `feat/pubkey-streaming`.

---

## What was built

Three files changed to give the vault real-time transaction notifications via Server-Sent Events:

| File | Change |
|---|---|
| `src/bun/pioneer.ts` | Persistent `queryKey` (DB-backed) + registers key with Pioneer after init |
| `src/bun/event-stream.ts` | **New** — SSE client with auto-reconnect |
| `src/bun/index.ts` | Starts stream after `getBalances` derives addresses; stops on disconnect |

Frontend already handles `tx-push-received` RPC event → `forceRefresh` in `Dashboard.tsx`.

---

## How it works

1. `getBalances` derives all addresses (EVM multi-index, Cosmos, XRP, Solana, etc.)
2. At the end of `getBalances`, `startEventStream(addresses, handler)` opens a POST SSE connection to `POST /api/v1/events/subscribe` with all individual addresses (no xpubs)
3. Pioneer watchtower monitors those addresses on-chain
4. When a tx arrives, Pioneer pushes `tx:incoming` → vault fires `rpc.send['tx-push-received']` → Dashboard calls `forceRefresh`
5. On device disconnect, `stopEventStream()` tears down the connection immediately

### Address filtering (what gets subscribed)

```
EVM:     evmAddresses.toAddressSet().addresses  (individual accounts, not xpubs)
Others:  pubkeys where caip does NOT start with 'bip122:' and pubkey is not an xpub/ypub/zpub/dgub/Ltub/Mtub
UTXO:    EXCLUDED — watchtower derives addresses from xpubs server-side via the sync worker
```

---

## Persistent queryKey

`pioneer.ts` now generates a stable UUID on first run and saves it to the DB as `pioneer_query_key`. This is required for SSE auth — the old `key:public-${Date.now()}` key was ephemeral and not registered in Pioneer's Redis.

Override with env: `PIONEER_API_KEY=your-key`

---

## Pioneer server requirement

The SSE endpoint lives on branch `feat/pubkey-streaming` of the pioneer repo. It is **not on master** yet.

```bash
# Check if the endpoint is live
curl -s http://localhost:9001/api/v1/events/stats
# → {"sessions":0,"connections":0}   ← server supports SSE
# → 404                               ← still on older pioneer build
```

The vault degrades gracefully if the endpoint returns 404 — `startEventStream` logs a warning and schedules a reconnect every 10s, while existing `GetPortfolioBalances` polling continues unchanged.

---

## Testing

```bash
# 1. Start pioneer on feat/pubkey-streaming branch
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer
git checkout feat/pubkey-streaming
make start

# 2. Start vault
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11
make vault

# 3. Trigger getBalances (click refresh or wait for auto-load)
# Watch vault bun process logs for:
#   [event-stream] Connected — watching N addresses

# 4. Send a small amount of ETH/USDC to a watched EVM address from another wallet
# Watch for:
#   [event-stream] Incoming tx 0xabc... → 0x141D...
#   [Dashboard] Pioneer push received — triggering forceRefresh

# 5. Check event-stream stats
curl http://localhost:9001/api/v1/events/stats
# → {"sessions":1,"connections":1}
```

---

## What's NOT done

- **Frontend toast for incoming tx** — Dashboard triggers `forceRefresh` on `tx-push-received` but shows no notification toast. A future pass could add a Chakra `toastService` call in the `tx-push-received` handler.
- **PioneerSocket overlap** — `pioneer-socket.ts` (WebSocket-based generic push events) and `event-stream.ts` (SSE, address-specific) both call `rpc.send['tx-push-received']`. This is additive, not harmful — two notifications produce two refreshes, which is idempotent. Can consolidate later once SSE is proven stable.
- **Address re-subscription** — if the user adds a new EVM address index, `startEventStream` is not called again. It re-subscribes on the next full `getBalances`. Acceptable for now.

---

## Related handoffs

- Pioneer server side: `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer/HANDOFF-VAULT-EVENT-STREAMING.md`
- Pioneer WebSocket push (earlier approach): `docs/handoff-pioneer-push-events.md`
