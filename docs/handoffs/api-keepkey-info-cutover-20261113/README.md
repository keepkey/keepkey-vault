# api.keepkey.info: DigitalOcean (green) → Cloudflare keepkey-gateway — readiness, 2026-11-13

Read-only review. Nothing was changed: no DNS edits, no Worker routes, no kubectl writes, no deploys.

## Verdict: NO-GO for a full route swap tonight. DO cannot be shut down tonight.

Pointing `api.keepkey.info/*` at the gateway would break, in the field and immediately:
- **Every asset logo** in Desktop (all released versions), the browser extension, the gateway's own asset data and keepkey-store. `/coins/<b64caip>.png` returns 302 to DO Spaces on green and 404 on the gateway.
- **The KeepKey browser extension (keepkey-client 0.0.39, released 2026-11-11).** Per-chain tx building (`/api/v1/buildTx`), `discovery/caip`, `insight`, `nodes`, `tokens/*` and `portfolio` are all green-only. It also calls the extension's paths without a registered query key in some places, while the gateway returns 401 for unregistered keys.
- **Desktop's DeFi/Zapper portfolio** (`/api/v1/zapper/portfolio/{address}`): 404 on the gateway, which has `/zerion/positions` instead. Green currently returns 500 for this, so the feature is already broken today, not newly broken.

Desktop's own Pioneer operations are covered: every op it calls (all versions v1.6.7 → develop) exists on the gateway, and every version registers a query key at startup.

## 1. What api.keepkey.info serves today

| Item | Evidence | Status |
|---|---|---|
| DNS / proxy | `api.keepkey.info`, `api-blue.keepkey.info` both resolve to Cloudflare (172.67.132.200 / 104.21.13.95); `server: cloudflare`, cf-ray present | Cloudflare-proxied |
| Origin | Green Pioneer v3 spec (195,815 B, 156 ops). DO LB `pioneer-server-v3` 143.244.211.85 → deployment `pioneer-server-v3-mjovkeb2` (3/3, Pioneer 1.5.0 digest `06af15ef…`) | DO k8s |
| `/api/v1/health` | 200 | ok |
| `/spec/swagger.json` | 200 | ok |
| `/coins/<b64>.png` | 302 → `https://keepkey.sfo3.cdn.digitaloceanspaces.com/coins/<b64>.png` | **logos live in DO Spaces** |
| SSE `/api/v1/events/subscribe` | 404 on green (no auth) | extension calls it; gateway serves it |

The gateway (`keepkey-gateway`, Worker + Cloudflare Containers) is routed on `oracles.cc/*` and `api-blue.keepkey.info/*` (`wrangler.jsonc` routes). Live revision per the 11-04 handoff: `bff70f2a…`; origin/master is `39b3e27` (2026-11-10).

## 2. Who calls api.keepkey.info

| Client | Default host | Paths used | Updatable? |
|---|---|---|---|
| Desktop develop, v1.6.12, v1.6.7 (latest stable) | `https://api.keepkey.info` (`src/shared/pioneer-server.ts`) | Pioneer ops (all on gateway), `/coins/*.png`, `/api/v1/zapper/portfolio`, `/api/v1/swap/health`, `/api/v1/swappers/supported-chains`, `/api/v1/user/register`, `/api/v1/tron/wallet/*` (404 on both today) | Old installs can't be forced; standard channel stuck on 1.6.7 |
| keepkey-client (browser extension, 0.0.39) | hard-coded `https://api.keepkey.info` | `/api/v1/buildTx` (6 chain handlers), `/api/v1/broadcast`, `/api/v1/insight`, `/api/v1/nodes`, `/api/v1/portfolio`, `/api/v1/tokens/{balances,custom,metadata}`, `/api/v1/events/subscribe`, `/api/v1/user/register`, `/coins/*.png` | Store review delay; installed copies lag |
| keepkey-store | `PIONEER_API` or `https://api.keepkey.info/api/v1` | watch/UTXO | yes |
| keepkey-backend-v3, pioneer repo | references (6 / 50 files) | not reviewed per path | — |
| keepkey-gateway itself | `container/data/assets.json` icon URLs point at `api.keepkey.info/coins/*` | logos | yes |
| keepkey-mobile-expo, keepkey-sdk-v2, keepkey-portfolio, docs-v8 | no references | — | — |

## 3. Gateway parity

Green has 156 ops; the gateway has 49. 117 green ops are absent. Of those, what real clients call:

| Path | Green | Gateway | Caller | Blocker? |
|---|---|---|---|---|
| `/coins/*.png` | 302 | 404 | Desktop (all), extension, gateway data, store | **YES** |
| `/api/v1/buildTx` | serves | absent | extension | **YES** for extension |
| `/api/v1/discovery/caip/{caip}` | 200 | 404 | extension | **YES** for extension |
| `/api/v1/insight`, `/nodes`, `/portfolio`, `/tokens/*` | serve | absent | extension | **YES** for extension |
| `/api/v1/zapper/portfolio/{addr}` | 500 today | 404 | Desktop | no (already broken); Desktop should move to `/zerion/positions` |
| `/api/v1/discovery/search` | 200 unauthenticated | 401 without a registered key | Desktop (registers first) | no for Desktop; check other callers |
| `/api/v1/swaps/pending/{tx}` | 404 for unknown tx | 401 without a registered key | Desktop | no |
| `/api/v1/tron/wallet/*` | 404 | 404 | Desktop txbuilder | pre-existing breakage, not a cutover issue |

The other ~100 green-only ops (admin, cache metrics, Zapper, NowNodes, reports, chat, MCP, dapp atlas) had no caller in Desktop or the extension. Not checked: pioneer-sdk consumers outside this repo set.

## 4. DigitalOcean inventory (context `do-sfo3-do-cluster-2b9226d`)

Cluster: 1 pool `larger-nodes`, 3 × 8 GB droplets.

| Resource | What | Used? | Action |
|---|---|---|---|
| `pioneer-server-v3-mjovkeb2` (3 pods) + LB 143.244.211.85 | green Pioneer = api.keepkey.info | **yes** | keep until parity + client migration |
| `pioneer-cache-worker`, `pioneer-watchtower` | green background jobs (cache warm, swap watching) | yes, by green | retire with green |
| `pioneer-server-blue-v0j1mb7z` (v4 image) + LB 129.212.164.90 | old v4 alpha | blue host is now on the gateway | candidate retire (verify no DNS points at 129.212.164.90) |
| LB `pioneer-server-v3-blue` 146.190.2.118; ingress `pioneer-server-v3-blue-ingress` | old blue path, kept for rollback per 11-04 handoff | rollback only | retire after gateway blue has run clean long enough |
| `do-app-svc-pioneer-9p4q22js` LB 134.199.141.236 | unknown service LB | unknown | trace before removing |
| `pioneer-nexus` | Pioneer nexus | unknown | owner decision |
| `ccbot`, `discord-bridge-shapeshift` | bots | owner | move or retire |
| DegenQuest: `lore-server` (100 Gi PVC), `lore-tunnel` (cloudflared), `zone-gateway`, `dq-npc-intelligence/{npc-intelligence, npc-hindsight, npc-postgres (10 Gi), npc-encrypted-backup cron}`, ingress `dq-npc-origin.rosetta.network` | separate product on the same cluster | yes | **must move before DO shutdown**; not a KeepKey decision |
| ingress-nginx LB 64.225.90.115 | ingress for blue + DQ npc | yes | goes with the cluster |
| Valkey `db-redis-sfo2-62211` (sfo3, 2 vCPU/4 GB) | green's `REDIS_CONNECTION` | yes, cache/queues | retire with green |
| Valkey `db-redis-sfo2-16946` (sfo2, 1 GB) | unknown tenant | unknown | trace |
| Volume `pvc-9c785f69…` 40 GiB, **unattached** | orphan | no | snapshot-then-delete candidate |
| Container registry `pioneer` (degen*, hyperfy*, keepkey-admin, api/auth/game-service 2025-03, …) | images | DQ + Pioneer still pull | retire last |
| DO Spaces `keepkey` (sfo3 CDN) | **all `/coins/*.png` logos** | **yes** | **must move to R2 first** |

## 5. Data

- Green's durable state (users, query keys, pending swaps, admin data) is in **MongoDB Atlas** (`*.w5uxp.mongodb.net`: `DB_URI`, `MONGO_CONNECTION`, `ADMIN_*`), not on DO. Shutting DO doesn't lose it. It won't be visible to the gateway either.
- Green's Valkey on DO is cache/queue state: losing it is safe after green is retired.
- The gateway uses `DATABASE_URL` → **PlanetScale Postgres, AWS us-east, single node, zero replicas** (`docs/PLANETSCALE.md` on origin/master). This still conflicts with the Cloudflare-only / no-AWS rules. Open owner decision; not a blocker for routing, but it is for "Cloudflare only".
- Not migrated: pending swaps and registered query keys from Mongo to the gateway. Users with in-flight swaps tracked by green lose server-side tracking after a swap (Desktop also tracks locally via THORNode/Midgard).

## 6. Rollback pattern for an api.keepkey.info route

Same as the 11-04 blue cutover: a Worker route on a proxied hostname overrides the origin; the DNS record and DO origin stay. **Rollback = remove the Worker route** (`api.keepkey.info/*` from `wrangler.jsonc`, redeploy, or delete the route in the dashboard). Traffic falls back to the proxied record → LB 143.244.211.85 within seconds. Keep green running until the route has held a full release cycle.

## What can be done tonight (safe, reversible)

1. **Logos to R2 (unblocks the biggest item).** Copy the Spaces `coins/` prefix to an R2 bucket; serve `/coins/*` from a Worker/R2 custom route on `api.keepkey.info/coins/*`. Verify a sample of 50 CAIPs byte-for-byte, then switch only that path. Rollback: remove that one route (green's 302 resumes).
2. **Path-scoped gateway routes** for the paths the gateway fully owns and Desktop uses (e.g. `api.keepkey.info/api/v1/swap/health`, `/swappers/supported-chains`) — only if you want live gateway traffic on the main host tonight. Everything else keeps hitting green. Rollback: delete those routes.
3. **Retire clear orphans** after a snapshot: unattached 40 GiB volume. Everything else needs a trace first.

## Runbook for the full route swap (when the blockers are closed)

Pre-checks:
- Gateway serves `/coins/*` (R2) and every extension path in §3, with the same unauthenticated/registered-key behaviour clients expect; or the extension has shipped a version that only uses gateway paths and most installs have updated.
- `make smoke-test api_url=https://oracles.cc` (Pioneer smoke) passes at the green baseline (96/98).
- Desktop develop and v1.6.7 run against `api-blue.keepkey.info` (gateway) in Settings → server: balances, send build (BTC, ETH, ATOM, RUNE), swap quote, swap tracking, logos.

Cutover:
1. Add `{ "pattern": "api.keepkey.info/*", "zone_name": "keepkey.info" }` to `wrangler.jsonc` routes via PR on keepkey-gateway; CI deploys.
2. Verify within 5 minutes: `/api/v1/health` (gateway revision), spec op count = gateway's, 20 logo URLs, Desktop 1.6.7 + develop balances/sends/swap quotes, extension 0.0.39 build-tx for one chain, SSE connect.
3. Watch Worker error rate and 4xx/5xx by path for 1 hour; any 404 spike on a path green served → rollback.

Rollback: remove the route (revert PR, or delete route in dashboard). Green is still behind the proxied record.

## DO decommission checklist (later, ordered by risk — lowest first)

1. Snapshot + delete unattached volume `pvc-9c785f69…` (40 GiB).
2. Trace + retire `do-app-svc-pioneer-9p4q22js` LB and Valkey `db-redis-sfo2-16946` if nothing uses them.
3. Retire old v4 blue (`pioneer-server-blue-v0j1mb7z` + LB 129.212.164.90).
4. After the gateway blue route has run clean for a release: retire the blue rollback set (LB 146.190.2.118, ingress `pioneer-server-v3-blue-ingress`, old blue Service, and the proxied blue DNS A record).
5. Logos fully on R2; DO Spaces `keepkey` bucket retired (keep a copy).
6. After the api.keepkey.info route has held a release cycle: scale green, cache-worker, watchtower to 0; then delete; then retire Valkey `db-redis-sfo2-62211`.
7. Owner: move or retire `pioneer-nexus`, `ccbot`, `discord-bridge-shapeshift`.
8. Owner/DegenQuest: move lore-server (100 Gi data), lore-tunnel, zone-gateway, npc-intelligence + npc-postgres + backup cron, `dq-npc-origin.rosetta.network`.
9. Registry (export images still needed), then cluster, then ingress LB.
10. Separately: gateway DB off PlanetScale/AWS (owner decision), and the ~208 literal secrets in the green Deployment spec should be rotated once green is gone.
