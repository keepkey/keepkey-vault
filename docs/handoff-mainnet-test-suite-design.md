# Design — extended mainnet test suite (human/AI hybrid, pre-release gate)

**Prepared:** 2026-07-08, updated same day · **Status:** capture plumbing built and verified; runner script NOT yet written (see "second finding" below — it changes what's safely buildable for v1) · **Depends on:** [[handoff-emulator-rc-abi-backport-and-dialog]] (emulator must actually start — done, pending firmware PR/merge)

## Scope decisions (confirmed)

- **Broad operation coverage** for v1: send + stake/delegate + swap + sign-message per chain where applicable (not just native send).
- **Checklist format**: local markdown under `docs/`, AI-driven (the runner writes results; a human fills in the on-chain/visual validation column).

## Goal

An automated-but-supervised test suite that drives the live emulator through real transactions across every supported chain, with a human validating each step visually (OLED) and on-chain, producing a checklist that must be 100% green before a firmware release ships.

## The key finding that shapes this design

I had two agents inventory the existing wallet-switch/chain-driving/screenshot APIs before designing anything. The load-bearing finding:

**Every REST signing endpoint already requires a real human click to confirm — there is no bypass.** `emuSigningOp()` → `emuInteractiveConfirm()` → `emuGatedConfirm(fn, delegate, {interactive: true})` (`emulator-window.ts:506-563`) blocks on `requestUserConfirm()` in the actual emulator device window. Only setup ops (`loadDevice`, `wipe`, `applySettings`) auto-press. This isn't a gap to close — it's exactly the human-in-the-loop mechanism you described ("humans validate on chain and visually as the agent drives"). The architecture already forces a human to look at the OLED confirm screen before anything signs. Good — nothing to build here, just to drive.

Also confirmed: a separate low-level harness (`tests/emulator/*.test.ts`, `make test-emu`) already proves scripted DebugLink auto-confirm is a known pattern in this codebase — but it bypasses the REST/UI layer entirely (dlopen's the dylib directly). Not reusable for this — we want to exercise the real app path, not go around it.

## Built and verified

- **`captureCurrentFrame()`** (`emulator-window.ts`) — grabs whatever's live on the emulator's OLED canvas as a PNG data URL. Reuses the webview's existing 1bpp-unpack-to-canvas rendering (the same code that already draws the live preview window) instead of reimplementing PNG encoding on the Bun side — the webview does `oledCanvas.toDataURL('image/png')` and posts it back over the existing `/_emu/*` bridge (same pattern as the confirm/seed-ack round trips).
- **`emulatorCaptureFrame` RPC** (`index.ts`) — the in-app-webview-reachable version; writes the PNG to `~/.keepkey/emulator/screenshots/` (or a caller-supplied `dir`), hard-gated on `engine.isEmulator`.
- **`POST /emulator/capture` REST endpoint** (`rest-api.ts`) — see the finding below for why this exists as REST, not just RPC. Returns the raw PNG data URL; the caller decides where to save it. Same `engine.isEmulator` gate, plus the normal REST pairing/auth.
- All three rebuilt and compiled clean in the running dev app.

## Second finding: RPC vs REST reachability sets the real v1 boundary

While building the runner, I hit a harder architectural fact than the confirm-gating one: **`buildTx`, `emulatorSwitchWallet`, `emulatorCreateWallet`, etc. are Electrobun webview↔bun RPC methods — reachable only from inside the app's own frontend JS context.** An external script (a standalone `bun run tests/mainnet-suite/...`) has no network path to them; the RPC bridge isn't HTTP. The only externally-reachable surface is the REST API on port 1646 (confirmed zero `/emulator/*` routes existed before this session — I added exactly one, the capture endpoint above).

This matters because `buildTx` is what makes the real in-app Send flow chain-agnostic from the caller's side (`{chainId, to, amount}` in, fully-formed unsigned tx out — it does UTXO selection, EVM gas estimation, Cosmos sequence lookup, etc.). The REST sign-transaction endpoints it feeds into do **not** do that work themselves — I checked the actual Zod schemas:

- **Safe to drive externally, right now, no new code**: `/eth/sign-transaction` (nonce/gas all optional — backend fills sane defaults, so `{to, value, from}` is genuinely sufficient) and every sign-message endpoint (`/eth/sign`, `/tron/sign-message`, `/ton/sign-message`, `/solana/sign-offchain-message`) — none of these move funds, and their schemas only need a message + address.
- **Not safely automatable yet**: `/utxo/sign-transaction` requires the caller to supply already-selected `inputs`/`outputs`. `/xrp/sign-transaction` requires `sequence`/`lastLedgerSequence`/the full `tx` wrapper. `/solana/sign-transaction`, `/tron/sign-transaction`, `/ton/sign-transaction` all require an already-built `raw_tx`. Cosmos-family (`/cosmos/sign-amino-*` etc.) requires a full `signDoc` with `account_number`/`sequence`. None of this is exposed as "just give me to/amount" over REST — that convenience only exists inside `buildTx`, which an external driver can't reach.

I'm not going to fabricate UTXO input selection or Cosmos sequence numbers for real-money operations without a verified builder behind them — that's exactly the kind of guess that looks plausible and is wrong in a way that either fails loudly (safe) or, worse, succeeds against the wrong inputs (not safe). Same logic for stake/delegate/swap, which are fund-moving to third-party addresses (validators, DEX routers) with no safe default destination at all.

## Recommendation for closing this gap (your call)

Two honest paths to actually reach "broad" scope safely:

1. **Add REST equivalents of `buildTx`** (or a subset scoped to test-suite needs) — expose the same chain-agnostic `{chainId, to, amount}` → unsigned-tx builder over `/tx/build`, reusing the exact backend logic `buildTx` already calls. This is real, scoped work (not fabrication) and would make every chain's native send safely automatable the same way EVM already is. Stake/swap still need real destination addresses decided by a human first (matrix would carry those as required, human-supplied fields, not guessed).
2. **Narrow v1 to what's REST-reachable today**: EVM native send + all sign-message ops, fully automated now; every other chain's send and all stake/swap ops ship as `needs-tx-builder` placeholder rows in the checklist (visible, not silently skipped) until (1) happens.

I'd default to (2) now — ship the real, verified subset today, and (1) as an explicit next step — rather than block everything on building the REST tx-builder first. Say the word and I'll write the runner + matrix + checklist against that scope, or push forward on (1) if you'd rather close the gap first.
