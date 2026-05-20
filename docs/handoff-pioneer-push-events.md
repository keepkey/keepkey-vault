# Handoff: Pioneer Push Events + Vault WebSocket Client

## Context

The vault (`projects/keepkey-vault-v11`) needs real-time balance updates when a
BTC (or other UTXO) transaction arrives at a watched address. Without a push
mechanism, balances only update on manual refresh. This became visible with the
zpub `zpub6rXHd37fxCQN5...` failing to show a new incoming balance.

---

## Architecture: How Pushes Are Supposed to Work

```
On-chain tx arrives
  → Blockbook WebSocket (per chain, in pioneer-watchtower)
  → watchtower publishes to Redis: pioneer:tx:bip122:<networkId>
  → pioneer-server subscribes (psubscribe pioneer:tx:*) → handleWatchtowerEvent()
  → emits Socket.IO event: transaction:incoming  →  connected client
  → client triggers forceRefresh → GetPortfolioBalances?forceRefresh=true
```

**Key Redis channels (pioneer-server subscribes to all of these):**

| Channel | Published by | Purpose |
|---------|-------------|---------|
| `pioneer:tx:bip122:<networkId>` | watchtower | New UTXO tx for watched address |
| `pioneer:tx:eip155:<chainId>` | watchtower | New EVM tx |
| `pioneer:balance:update` | cache-worker | Balance cache refreshed |
| `pioneer:tx:confirmations` | watchtower | Confirmation count updated |

**Socket.IO events pioneer-server emits to clients:**

| Event | When |
|-------|------|
| `transaction:incoming` | New unconfirmed or confirmed tx |
| `balance:update` | Balance cache updated by worker |
| `balance:cache:update` | Background stale-while-revalidate fired |
| `transaction:confirmed` | Confirmation count milestone |
| `pioneer:block` | New block (broadcast to all) |

---

## What Was Implemented in the Vault

**The problem:** `socket.io-client` crashes Electrobun's Bun runtime (confirmed
prior incident — never add it back).

**The solution:** `src/bun/pioneer-socket.ts` — a ~140-line minimal Socket.IO v4
client using **Bun's native `WebSocket`** class. It speaks Engine.IO v4 framing
directly over a plain WebSocket connection with no npm packages.

### Engine.IO v4 frame protocol (what the file implements)

```
Server → Client:
  "0{...}"    EIO OPEN handshake  → client responds: "40" (SIO CONNECT)
  "2"         EIO PING            → client responds: "3"  (EIO PONG)
  "4" + body  EIO MESSAGE         → body is Socket.IO payload:
                "0{...}"   SIO CONNECT ack  → client authenticates
                "2[...]"   SIO EVENT        → ["event-name", data]

Client → Server:
  "40"          SIO CONNECT to default namespace /
  "3"           EIO PONG
  "42[...]"     SIO EVENT: 42["authenticate", {"queryKey":"..."}]
```

### Auth flow

```
ws.connect(wss://api.keepkey.info/socket.io/?EIO=4&transport=websocket)
server: 0{"sid":"...","pingInterval":25000,...}
client: 40
server: 40{"sid":"..."}
client: 42["authenticate",{"queryKey":"key:public-1234567890"}]
server: 42["authenticated",{"success":true,"username":"key:public-..."}]
```

### Vault wiring (`src/bun/index.ts`)

- Socket starts when device state transitions to `'ready'`
- Socket stops (and is nulled) when device disconnects
- On `transaction:incoming`, `balance:update`, `balance:cache:update` events:
  → sends `'tx-push-received'` RPC message to frontend
- Frontend (`Dashboard.tsx`) listens for `'tx-push-received'` and calls
  `refreshBalances(true)` (which passes `forceRefresh=true` to Pioneer)

---

## How to Test End-to-End

### Step 1 — verify the socket connects

Start vault (`make dev`), connect device, watch logs for:
```
[PioneerSocket] connecting to wss://api.keepkey.info/socket.io/?EIO=4&transport=websocket
[PioneerSocket] namespace connected — authenticating
[PioneerSocket] authenticated as key:public-...
[PioneerSocket] connected to Pioneer
```

If you see repeated `[PioneerSocket] closed (code=...)` check:
- Is the WebSocket URL correct? (Some Pioneer configs use HTTP only, swap `ws://`)
- Does the server require an existing account for `queryKey`?

### Step 2 — add a test endpoint to pioneer-server (Pioneer team task)

Add `POST /api/test/push-event` to `pioneer-server/src/app.ts` (or a dedicated
test router). It should broadcast a synthetic `transaction:incoming` event to
all connected sockets (or a named user).

**Recommended implementation** (uses existing `wsHandler` which is already exported):

```typescript
// In app.ts, after wsHandler is initialized:

app.post('/api/test/push-event', (req, res) => {
  const { username, chain = 'BTC', address, txid, value } = req.body || {}
  const payload = {
    type: 'incoming',
    chain,
    address: address || 'test-address',
    txid: txid || `test-${Date.now()}`,
    value: value || '0',
    confirmations: 0,
    timestamp: Date.now(),
  }

  if (username) {
    // Targeted — use the already-exported wsHandler.emitTransactionIncoming
    wsHandler.emitTransactionIncoming(username, payload)
    console.log(`[test/push-event] → user ${username}`)
  } else {
    // Broadcast to all sockets — no username required for testing
    io.emit('transaction:incoming', JSON.stringify(payload))
    console.log(`[test/push-event] broadcast → ${io.sockets.sockets.size} socket(s)`)
  }

  res.json({ ok: true, payload })
})
```

Both `wsHandler` and `io` are already in scope in `app.ts`. No new imports needed.

**Test curl:**
```bash
# Broadcast to all (easiest — no username needed)
curl -s -X POST http://localhost:9001/api/test/push-event \
  -H 'Content-Type: application/json' \
  -d '{"chain":"BTC","address":"bc1qtest","txid":"abc123","value":"5000"}' | jq

# Target a specific user (use the queryKey from vault logs as the username)
curl -s -X POST http://localhost:9001/api/test/push-event \
  -H 'Content-Type: application/json' \
  -d '{"username":"key:public-1234567890","chain":"BTC","txid":"abc123"}' | jq
```

**Expected vault logs on receipt:**
```
[PioneerSocket] push event 'transaction:incoming' chain=BTC → triggering forceRefresh
[Dashboard] Pioneer push received — triggering forceRefresh
[getBalances] ... GetPortfolioBalances calls  (forceRefresh=true)
```

### Step 3 — verify watchtower subscription is working

If the socket connects but real transactions don't trigger pushes:

```bash
# Check if the user's BTC addresses are in Redis (replace <username> with
# the key:public-... printed in vault logs)
redis-cli SMEMBERS "user:<username>:addresses:bip122:000000000019d6689c085ae165831e93"

# Should return a list of bc1q... addresses.
# If empty: GetPortfolioBalances ran but extractAddressesFromBalances found no tokens[]
# → the cached balance response may not include the tokens array for this zpub.

# Check the address-registration queue depth (should drain quickly)
redis-cli LLEN "address-registration"

# Check what Pioneer has cached for the zpub
redis-cli GET "balance:bip122:000000000019d6689c085ae165831e93/slip44:0:<zpub>"
```

---

## Known Gaps / Follow-Up Work

### Gap 1: extractAddressesFromBalances only registers receive addresses

`pioneer-server/src/controllers/balance.controller.ts:1595-1613`

When Pioneer returns a zpub balance with a `tokens[]` array (individual addresses),
only addresses on path `/0/N` (receive) are registered with watchtower.
Change addresses (`/1/N`) are skipped. If BTC arrives at a change address (common
after spending), watchtower won't be subscribed to it and no push fires.

**Fix in pioneer-server:** remove the `/0/N` filter so both receive and change
addresses are registered.

### Gap 2: Balance cache may not include tokens[] for zpub entries

`extractAddressesFromBalances` requires `balance.tokens` to exist. If the cached
balance for a zpub is a compact entry (no `tokens` array), zero addresses are
extracted and watchtower is never subscribed.

**Verify:** check the raw cache value for the zpub as shown in Step 3 above.

### Gap 3: No socket.io alternative library evaluated yet

If the raw framing approach causes issues (e.g. Socket.IO server-side protocol
changes, auth handshake timing), the fallback options are:

| Option | Notes |
|--------|-------|
| **SSE** (`/api/events` with `text/event-stream`) | No framing complexity; Bun `fetch()` handles it natively. Requires new Pioneer endpoint. Simpler than WS for one-way push. |
| **`ws` npm package** | Lighter than socket.io-client; speaks plain WebSocket. Would need Pioneer to expose a plain WS endpoint (not Socket.IO). |
| **`socket.io-client` lite build** | May work if the crash was caused by a specific Node.js API — worth checking with a Bun-compat shim. Not recommended until the others are ruled out. |

Vault is the **only** consumer of push events. If Pioneer wanted to simplify the
server side, an SSE endpoint at `GET /api/v1/events?queryKey=...` would be the
cleanest long-term solution (no framing protocol, HTTP-based, trivial to test
with `curl -N`).

---

## Files Changed (Vault)

| File | What |
|------|------|
| `src/bun/pioneer-socket.ts` | New — minimal Socket.IO v4 client, 144 lines |
| `src/bun/pioneer.ts` | `QUERY_KEY` exported |
| `src/bun/index.ts` | Import + `pioneerSocket` var; start on `ready`, stop on `disconnected`; sends `tx-push-received` RPC on relevant events |
| `src/shared/rpc-schema.ts` | `'tx-push-received': { chain?, address?, txid? }` added to messages |
| `src/mainview/components/Dashboard.tsx` | `onRpcMessage("tx-push-received")` → `refreshBalances(true)` |

## Files to Change (Pioneer — handoff to Pioneer team)

| File | What |
|------|------|
| `services/pioneer-server/src/app.ts` | Add `POST /api/test/push-event` (see Step 2 above) |
| `services/pioneer-server/src/controllers/balance.controller.ts:1596-1613` | Remove `/0/N` filter so change addresses are also registered with watchtower |
