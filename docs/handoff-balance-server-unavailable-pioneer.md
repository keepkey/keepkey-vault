# Handoff → pioneer-server agent: investigate "Balance server unavailable" ticket

**Date raised:** 2026-06-09
**Ticket symptom window:** ~11:24 AM (user-reported local time — **confirm timezone**, then widen the search to roughly 10:00 AM–12:30 PM around it).
**Server:** `api.keepkey.info` (Cloudflare-fronted: 104.21.13.95 / 172.67.132.200).
**Pioneer monorepo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`

## What you're investigating

A Vault user (firmware 7.14.1, default-label device) plugs in, enters PIN, and gets a
**"Balance server unavailable"** banner *instead of* the portfolio. We could not reproduce on a dev
machine. The server is globally healthy right now (swagger `200`), so this is either
network/Cloudflare-specific to that user, a slow/failing upstream for their specific payload, or a
specific pubkey the API rejects. **Server-side logs from the ticket window are the decisive evidence.**

Important framing: the dev can't reproduce because the dev already has **cached balances**. Vault only
shows the *bare error screen* (suppressing the portfolio) when there is **no cached snapshot** —
i.e. the user's **very first** `GetPortfolioBalances` of the session failed. So you are looking for a
**first-fetch failure**, not a flaky retry.

## Exactly what the Vault client sends (so you know what to grep)

All from `projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/`:

1. **Client init** — `GET /spec/swagger.json` (`pioneer.ts:63-81`), client timeout 60s.
2. **SSE auth registration** — `POST /api/v1/user/register` with
   `{ username, queryKey }` (`pioneer.ts:90-97`). Best-effort, non-fatal.
3. **The portfolio call** — `POST GetPortfolioBalances` (`index.ts:1944-1975`):
   - Body: `{ pubkeys: [{ caip, pubkey }, ...], extraContracts?: [{...custom tokens}] }`
   - **Chunked**: 8 pubkeys per request, up to **4 concurrent** chunks, per-chunk timeout **45s**,
     total budget **120s** (single-chain variant uses **60s**).
   - On an `extraContracts` schema error the client **retries the same chunk without
     `extraContracts`** — so you may see paired requests (with then without custom tokens).

### Correlation keys — how to isolate THIS user

Every Vault generates a stable `queryKey` of the form **`vault:<uuid>`** and registers a
`username` = the first 32 chars of that key (`pioneer.ts:12-24, 87-89`). Both are sent on
`GetPortfolioBalances` (via the client's queryKey auth) and on `/api/v1/user/register`.

- Grep `user/register` POSTs in the window for `username` starting `vault:` → gives you the
  exact `queryKey` for sessions active then.
- Pivot from that `queryKey` to all `GetPortfolioBalances` requests in the window.
- (If you have the user's email/device from the ticket, map it to their queryKey first.)

## Hypotheses to confirm or refute (in priority order)

1. **Cloudflare blocked them at the edge** (never reached app). Check Cloudflare/WAF logs for
   `403`/`503`/managed-challenge/JS-challenge on `POST GetPortfolioBalances` or `GET /spec/swagger.json`
   in the window. Note their country/ASN — region or bot rules can block one user while the service is
   globally fine. **If it's Cloudflare, there may be NO app-server log line at all** — absence in app
   logs + presence in CF logs is itself the answer.
2. **Timeout under their payload.** Did `GetPortfolioBalances` run long (>45s/chunk, >120s total)?
   Look for slow upstream balance providers (which chain/provider was slow?), large pubkey sets, or a
   single chunk hanging. A wallet that derives many accounts × EVM chains produces many pubkeys.
3. **A specific pubkey/chain 400s.** Any `400`/validation error tied to a particular `caip` or
   malformed `pubkey`? Capture the offending `caip` and pubkey prefix.
4. **`extraContracts` schema rejection loop.** Did the with-custom-tokens call 400 and the retry also
   fail? Capture the `body.extraContracts` validation message the server returned.

## What to report back (so we can close the loop in Vault)

- The user's `queryKey` and the count/outcome of their `GetPortfolioBalances` calls in the window.
- For each failure: HTTP status, which layer (Cloudflare vs app), latency, the `caip`(s) in the chunk,
  and the **exact error body** the server returned (Vault surfaces this verbatim to the user via
  `getPioneerPortfolioErrorMessage`, `index.ts:147-157`).
- Whether the failure was edge (CF) or origin (app), and whether it was transient or persistent for
  that user.
- Any rate-limit / per-queryKey throttle that could have tripped on the 4 concurrent chunks.

## Why this matters for the Vault-side fix

We're about to add a **"copy support handoff" dialog** to Vault that bundles the error + logs so future
occurrences are self-reporting. Knowing the *server-side* failure class (edge block vs timeout vs bad
pubkey vs schema) tells us **which fields to capture in that handoff** and whether Vault should
auto-retry, fall back to the default host, or surface a network-troubleshooting hint.

## Open question to resolve first

Confirm the **timezone** of the 11:24 AM ticket timestamp before searching — an offset will put you in
the wrong log window.
