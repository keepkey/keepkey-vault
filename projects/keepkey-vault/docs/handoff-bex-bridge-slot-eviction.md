# Handoff — BEX side of the bridge slot-eviction fix

**Owner repo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-client`
**Paired vault PR:** https://github.com/keepkey/keepkey-vault/pull/372 (merged into `develop` → `bex-bridge.ts`)
**Date:** 2026-07-19

---

## What happened

The KeepKey extension is installed in two Chrome profiles on this machine
(`Default` and `Profile 1`, both KeepKey Client 0.0.37, one Chrome process).
Both service workers open a socket to `ws://localhost:1646/bex-bridge`.

The vault kept exactly one socket and every new connection replaced it:

```ts
// bex-bridge.ts, before the fix
if (sock && sock !== ws) { sock.close(); failAllPending(...) }
sock = ws
```

So the two instances evicted each other. The evicted one reconnects — and
because `reconnectDelay` resets to 5s on every successful open
(`chrome-extension/src/background/mcpBridge.ts:199`), it never backs off out
of the fight. The slot flapped indefinitely; the extension console logged
`bridge connected` every ~10s forever.

**Consequence:** each MCP tool call was served by whichever profile held the
slot at that instant. Silently. Observed as `bex_tabs` and `bex_snapshot`
answering from different profiles, and two different `SW_STARTED_AT` values
coming back from `bex_status` vs `bex_ext_console` (both read the same module
constant, `providerLog.ts:48`, so two values means two service workers).

The visible symptom was broken browser automation. The actual hazard is that a
signing request could be routed to a nondeterministically chosen wallet.

## What the vault now does (already landed, no BEX action required for it)

A newcomer only takes the slot if the incumbent has been silent for
`STALE_MS = 45_000`. Any inbound frame stamps liveness, including the BEX's
20s `HEARTBEAT_MS` pings — so a live extension is never judged stale, and the
SW-restart-with-lost-close-frame case still recovers.

A refused instance is closed with **code 4409**, reason
`"bridge slot held by another KeepKey instance"`.

This alone stops the flapping and the nondeterministic routing. The BEX work
below is about not wasting reconnects and telling the user what is going on.

---

## Task 1 — treat close code 4409 as terminal (small, do this first)

**File:** `chrome-extension/src/background/mcpBridge.ts`, the `socket.onclose`
handler (~line 232) and `scheduleReconnect` (~lines 245-252).

Today `onclose` unconditionally calls `scheduleReconnect()`. A refused
instance therefore retries forever against a slot it can never win, and each
retry is a connect + 401-or-close round trip against the vault.

Wanted:

- `socket.onclose = (ev) => { ... }` — inspect `ev.code`.
- On `4409`: do **not** reconnect. Record the state (something like
  `bridgeBlockedBy = 'other-instance'`) and stop.
- On anything else: current behaviour, unchanged.
- Offer a way back: retry once on an explicit user action (toggling Agent mode
  off/on, or the side-panel reconnect control) so a user who closes the other
  profile is not stuck until they restart Chrome. A long idle re-probe — one
  attempt every few minutes — is acceptable if you prefer it to a manual
  control, but plain `scheduleReconnect()` backoff is not: it is what produced
  the flap.

**Do not** simply lengthen the backoff. Two instances backing off in lockstep
still trade the slot, just more slowly and less predictably.

## Task 2 — surface it

The user currently has no way to know their agent traffic is going to the
wrong profile.

- `bex_status` should report the refusal, e.g. `bridge: "blocked"` with a
  reason, instead of the current `"down"`/`"up"` binary. An agent that sees
  `blocked` can tell the user which profile to close rather than blaming the
  dApp. Note the vault's `mcp.ts` `FALLBACK_TOOLS` path is what answers when
  the bridge is down — check that a blocked-but-not-down state reads sensibly
  through it.
- Extension badge / side panel: a visible "another KeepKey instance is driving
  the agent bridge" state. This is the only surface the user actually looks at.

## Task 3 — stable instance id (closes the remaining hole)

**This is the one that lets the vault stop guessing.**

Known ceiling of the vault fix: a genuinely dead incumbent — SW killed without
a close frame — wedges the bridge for up to 45s, because staleness is the only
signal the vault has.

Fix: give the vault identity instead of a timer.

- Generate a per-profile uuid once, persist in `chrome.storage.local`
  (**not** `SW_STARTED_AT` — that changes on every service worker restart,
  which is exactly the case we need to recognise as *the same* instance).
- Send it on connect. Cheapest wiring is a query param alongside the existing
  token, `BRIDGE_URL` at `mcpBridge.ts:23`:
  `ws://localhost:1646/bex-bridge?token=<pairing key>&instance=<uuid>`
  The vault already parses `?token=` in `rest-api.ts:1293-1300`, so this costs
  one more `url.searchParams.get`.
- Vault rule once the id is available: same id → replace immediately (a
  reconnect of the same instance, no 45s wait); different id and incumbent live
  → refuse with 4409. Fall back to the current staleness rule when no
  `instance` param is present, so an older BEX keeps working.

Note `server.upgrade(req)` in `rest-api.ts` currently passes no per-connection
data, so the vault side of this needs the id threaded through to `onBexOpen`.
That vault change was deliberately **not** built ahead of the BEX sending the
id — do them together.

---

## How to reproduce / verify

1. Install the extension in two Chrome profiles, both paired to the same vault.
2. Watch `bex_ext_console` — pre-fix you see `bridge connected` every ~10s
   forever. Post-fix the loser goes quiet.
3. Call `bex_tabs` then `bex_snapshot` repeatedly. Pre-fix they disagree about
   which tabs exist and explicit tab ids raise `tab_not_found`. Post-fix they
   agree, every time.
4. Cross-check `swStartedAt` from `bex_status` and `bex_ext_console` — it must
   be the same value on every call. Two values means two instances are still
   being served.

Vault-side regression tests for the slot rule live in
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/mcp.test.ts`
under `describe('BEX bridge call lifecycle')`.
