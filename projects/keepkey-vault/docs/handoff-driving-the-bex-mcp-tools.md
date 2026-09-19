# Handoff — how to actually drive the `bex_*` MCP tools

**Audience:** an agent working in the vault repo that needs to drive a real
browser, or verify wallet behaviour end to end.
**Written:** 2026-09-19, after driving Uniswap and SoltoshiDICE in two Chrome
profiles at once.
**Code:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/mcp.ts`
and `src/bun/bex-bridge.ts` (vault side),
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-client/chrome-extension/src/background/browserTools.ts`
(the tools themselves).

---

## The one-paragraph version

The vault serves MCP at `POST http://localhost:1646/mcp`. Every tool runs
inside the KeepKey browser extension, in the user's REAL Chrome — real tabs,
real logins, real money. You find elements with `bex_snapshot` / `bex_find`,
which hand back opaque refs (`e12`), and you act on the refs with
`bex_click` / `bex_type` / `bex_select`. You never write a CSS selector and
never click a coordinate. Always pass `tabId`, and pass `browser` when more
than one Chrome profile is connected.

---

## Setup: get a token, make one helper

The bearer token is any vault pairing key. Read it from the running vault's DB:

```bash
DB="$HOME/Library/Application Support/com.keepkey.vault/dev/vault.db"
K=$(sqlite3 "file:$DB?immutable=1" \
  "select api_key from paired_apps order by last_used_on desc limit 1;")
```

That DB is the one the dev build uses. The `com.keepkey.vault/vault.db` at the
directory root is a stale 2025 file — do not read that one.

One helper is enough for a whole session. `kk.sh`:

```bash
#!/bin/zsh
tool="$1"; args="${2:-{\}}"
curl -s -m 60 localhost:1646/mcp -H "Authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
r=d.get("result")
if not r: print(d); raise SystemExit
c=r["content"][0]
print(c.get("text","<"+c.get("type","?")+" "+str(len(c.get("data","")))+" bytes>"))'
```

Then `./kk.sh bex_status`, `./kk.sh bex_tabs '{"browser":"b1-3f9a2c"}'`, and so on.
`tools/list` is the source of truth for which tools exist in the build in front
of you — 21 in extension 0.0.38, plus vault-side `bex_browsers`.

Registering the server with an MCP client instead:

```bash
claude mcp add --transport http keepkey http://localhost:1646/mcp \
  --header "Authorization: Bearer $K"
```

## The loop that works

1. **`bex_browsers`** — which Chrome profiles are connected. Ids look like
   `b1-3f9a2c`: a counter plus a per-vault-run suffix.
2. **`bex_tabs`** with that `browser` — find the tab you want, note its `tabId`.
3. **`bex_snapshot`** (or `bex_find` when you know the label) — get refs.
4. **`bex_click` / `bex_type` / `bex_select`** with `ref` + `element` + `tabId`.
5. **Verify** with `bex_find`, `bex_read_page`, or `bex_network`. Never assume a
   click worked.
6. **Re-snapshot** after anything that changes the page. Refs are re-minted each
   snapshot; a stale ref is rejected, not guessed at.

A real exchange from this session, driving two profiles in turn:

```bash
./kk.sh bex_type  '{"browser":"b2-3f9a2c","tabId":356969345,"ref":"e18","element":"Sell amount field","text":"0.01"}'
./kk.sh bex_click '{"browser":"b1-3f9a2c","tabId":356969587,"ref":"e2","element":"Open game metrics button"}'
./kk.sh bex_find  '{"browser":"b2-3f9a2c","tabId":356969345,"text":"usdc|review","regex":true}'
# → button "Buy 26.2816 USDC $26.28" [ref=e27]
```

## The rules that bite

**Always pass `tabId`.** Without it a tool acts on whatever tab is active at
that instant. An earlier session typed into the user's Reddit tab this way. Get
ids from `bex_tabs`, never guess.

**Pass `browser` when more than one is connected.** With several connected and
none named, the call is refused with `browser_ambiguous` rather than routed
somewhere arbitrary — that refusal is deliberate, because the alternative is
silently sending a signing request to the wrong wallet. With exactly one
connected, `browser` is optional.

**Ids are per connection, and per vault run.** An MV3 service-worker restart
gives that profile a new id, and restarting the vault changes the suffix on all
of them. That is deliberate: an id learned before a restart fails with
`unknown_browser` instead of quietly reaching whichever profile reconnected
first. Never cache an id across a gap — call `bex_browsers` again. Compare
`swStartedAt` across calls to spot a service-worker restart.

**Refs die on re-render.** After a click that opens a modal, snapshot again. The
refs inside the modal did not exist before it opened.

**`bex_read_page` with `selector` does not fall back.** The description says it
defaults to `main` then `body`, and that is true only when you pass NO selector.
`{"selector":"main"}` on a page without a `<main>` returns `not_found` — as it
did on Uniswap. Omit the selector, or scope to something you saw in a snapshot.

**Screenshots are for looking, not acting.** There are no refs in a JPEG and no
coordinate clicking. Use `bex_snapshot` to find things.

**A disabled element refuses the click.** That is the tool telling you the dApp
is gating the action ("Swap is disabled until you enter an amount"). Read that
as a finding, not an obstacle to route around.

## Debugging a dApp, once you are driving it

| Question | Tool |
| --- | --- |
| Did the dApp's API call fail? | `bex_network` — `{"status":"error"}` for failures only |
| Is the page throwing? | `bex_console` |
| What did the WALLET see? | `bex_logs` — every provider request/response |
| Is the extension itself broken? | `bex_ext_console` |
| What is waiting for approval? | `bex_pending_requests` |

`bex_logs` is the view a generic browser MCP cannot give you, and it is usually
the one that answers "why did this dApp not connect".

A browser that stops answering is skipped after 3s by `tools/list` and
`bex_browsers`, so one wedged profile cannot stall you for the full 30s call
timeout. A tool call you make yourself still gets the full 30s.

## Signing: where you stop

No tool can press the button on the KeepKey. You can drive a dApp right up to
the signature and no further. Before you trigger one, tell the user in the page
itself:

```bash
./kk.sh bex_panel '{"browser":"b2-3f9a2c","tabId":356969345,"action":"status","level":"action-needed","message":"Confirm the swap on your KeepKey"}'
```

Then `bex_panel` with `level: "done"` once it is handled. Also call
`bex_bring_to_front` when you START a browser task, or your work happens behind
other windows while the user hunts for it.

Do not drive a dApp into a transaction the user did not ask for. This is their
real browser, logged into real accounts, and the device button only gates
KeepKey signing — it gates nothing else Chrome can reach.

## When nothing answers

- `bridge_disconnected` — Agent Mode is off in the extension (side panel →
  Settings → Agent Mode (MCP) → Enable MCP), or Chrome is closed, or the
  extension is not paired. `bex_status` answers truthfully even then, reporting
  `bridge: "down"`.
- 401 — the pairing key is missing or stale. Re-read it from the DB.
- 403 `loopback only` / `not reachable from a browser` — call it from a local
  process, not from a page or a devtools console.
- Connection refused on 1646 — the vault is not running.

## Where the truth lives

- User-facing docs: https://docs.keepkey.com/docs/bex/mcp (and
  `https://docs.keepkey.com/docs/bex/mcp.md` for the raw markdown).
- Tool catalog: `tools/list` against the build in front of you. The extension
  owns the catalog; the vault is a dumb pipe (`src/bun/mcp.ts`).
- Multi-profile routing: `src/bun/bex-bridge.ts` in this repo.
