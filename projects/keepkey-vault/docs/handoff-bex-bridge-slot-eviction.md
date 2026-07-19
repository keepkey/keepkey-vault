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

## Task 0 — the transparency contract: if MCP touches a page, the page says so

**Priority: highest. This is a product invariant, not a feature.**

### The rule

> Any MCP operation that touches a web page must be visible in that page, every
> time, without the agent having to remember to announce it.

### Why it is currently only half-true

The overlay (`pages/content/src/agentOverlay.ts`) is intact and needs **no**
extra permissions — plain DOM in the isolated world of a content script that is
already declaratively injected on `<all_urls>` at `document_start`. Confirmed:
the `scripting` permission dropped in `b3e3126` was only ever for
`chrome.scripting.executeScript` into tabs predating extension load. It has
nothing to do with the overlay. **Do not re-add `scripting` for UI reasons.**

The gap is *coverage*. The overlay fires from `showThen()`, which has exactly
three callers (`pages/content/src/agentDom.ts:399,406,425`): `clicking`,
`typing`, `selecting`. Every other page-touching tool draws nothing:

- `bex_navigate` — moves the user's tab, silently
- `bex_read_page`, `bex_snapshot`, `bex_find` — read page content, silently
- `bex_screenshot` — captures the tab, silently
- `bex_console`, `bex_network`, `bex_perf`, `bex_storage` — read page state
  (`bex_storage` reads localStorage), silently
- `bex_bring_to_front` — moves the user's window, silently

Reading a user's page and screenshotting it are exactly the operations that most
need to be visible. A live session showed the user watching a tab, expecting the
driving UI, and correctly seeing nothing — because that session only ever
navigated, snapshotted and read.

### Where to enforce it

There is one choke point already: `executeBrowserTool(tool, args)`
(`chrome-extension/src/background/browserTools.ts:400`), a single switch over
every `bex_*` tool. Announce there, once, rather than at each call site:

```ts
// The UI itself, and browser-level calls that touch no page.
const NO_ANNOUNCE = new Set(['bex_panel', 'bex_tabs'])

export async function executeBrowserTool(tool: string, args: any): Promise<any> {
  if (!NO_ANNOUNCE.has(tool)) await announce(tool, args) // must never throw
  switch (tool) { /* unchanged */ }
}
```

`announce()` resolves the target tab the same way the tool will
(`resolveTab(args?.tabId)`), then posts one message to that tab's content script
so the overlay raises the banner and logs a caption — `reading page`,
`navigating`, `capturing screenshot`. No pointer, since these have no target
element; the existing `showThen()` pointer stays as the richer treatment for
click/type/select. Announce is the floor, not a replacement.

Enforcing at the dispatcher rather than per-tool is the whole point: a tool
added later is covered by construction, and the only way to bypass it is to
handle a tool outside `executeBrowserTool` — which the test below catches.

### Keep the banner up for the whole session

`BANNER_IDLE_MS = 8000` (`agentOverlay.ts:18`) hides the banner after 8s of
quiet. A hardware-wallet confirmation routinely exceeds that, so today the "MCP
is driving" banner disappears at precisely the moment the agent is waiting on a
signature — the highest-stakes, longest-silence part of the flow. Keep it up
while any MCP call is in flight and until an explicit end-of-session
(`bex_panel` with `level: 'done'`), rather than on an activity timer.

### The test that keeps it from rotting

Structural enforcement is what makes this durable, so pair the wrapper with a
registry test:

- Enumerate every tool the extension advertises via `bex_list_tools`.
- Assert each is either handled inside `executeBrowserTool` **and** not in
  `NO_ANNOUNCE`, or is in `NO_ANNOUNCE` with a comment saying why.
- A new tool then fails the test until its author makes an explicit, reviewed
  choice about visibility.

Without this, the contract degrades to "remember to call the overlay", which is
exactly the state that produced the current gap.

### One decision needed (not mine to make)

Some tools work on a tab with **no content script** — the pre-existing-tab case
created by dropping `scripting`. `bex_screenshot`, `bex_navigate` and
`bex_bring_to_front` would still function there, but with **no way to show the
indicator**. Two options:

1. **Strict** — refuse, with `reload the page so the driving indicator can be
   shown`. The contract genuinely holds: no invisible driving, ever. Cost:
   screenshotting a pre-existing tab starts failing.
2. **Lenient** — allow, and report the invisibility in the tool result so the
   agent must tell the user.

Strict is the honest reading of "users need transparency". Confirm before
building, since option 1 is a behaviour break.

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
