# Design — Node-backend isolation, self-host, and offline-first

**Branch context:** `btc-only` (rides draft PR #353 → develop).
**Vault code:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/`
**Status:** research + design. Nothing built. Decide the phase plan at the bottom before writing code.

---

## The one insight everything hangs on

The vault is **already ~90% offline-capable**. Pioneer's entire Bitcoin surface is **three network operations**:

| Op | Where it's called today | Needs network? |
|---|---|---|
| `ListUnspent({ network, xpub })` — UTXOs + balance | `txbuilder/utxo.ts`, `sweep-engine.ts` | yes |
| `GetFeeRateByNetwork` / `GetFeeRate` — sat/vB | `txbuilder/utxo.ts`, `sweep-engine.ts` | yes |
| `Broadcast({ networkId, serialized })` — push signed tx | `txbuilder/index.ts`, `sweep-engine.ts` | yes |
| _(optional)_ `UtxoLookup` — raw prev-tx hex for legacy p2pkh inputs | `sweep-engine.ts` | yes |

Everything else is **local + device**: xpub read (`btcGetPublicKeys`), address derivation (`btcGetAddress`), and **signing (`btcSignTx` over USB)**. There is **no PSBT** in the codebase and **no online/offline detection** — signing today builds KeepKey `btcSignTx` payloads by hand.

**Consequence:** "self-host node" and "offline mode" are the *same refactor*. Both are "replace those 3–4 Pioneer calls with a pluggable backend." Self-host swaps Pioneer for your node; offline mode swaps it for *nothing* (device-only) plus a hand-carried transaction format. Do the seam once; both features fall out.

---

## Part A — Node-backend isolation (no mixing with Pioneer)

### The seam

One interface capturing exactly the four ops above. New dir `src/bun/btc-backend/`, physically separate from `pioneer.ts`.

```ts
// src/bun/btc-backend/types.ts
export interface BtcBackend {
  readonly kind: 'pioneer' | 'core' | 'electrum' | 'blockbook' | 'esplora'
  readonly capabilities: { history: boolean; push: boolean }   // Core-pruned: history=false
  listUnspent(a: { xpub?: string; descriptor?: string; scriptType: string; network: string }): Promise<Utxo[]>
  feeRate(network: string): Promise<{ fast: number; average: number; slow: number }>  // sat/vB
  broadcast(a: { network: string; rawTxHex: string }): Promise<{ txid: string }>
  rawTxHex?(txid: string, network: string): Promise<string | undefined>  // legacy prevtx
  tipHeight(): Promise<number>          // "Test connection" + health probe
  txHistory?(a: { xpub: string; network: string }): Promise<HistoryTx[]>  // optional
}
```

### Implementations (one file each, zero cross-imports)

- `pioneer.ts` — **the only adapter allowed to import `../pioneer`.** Wraps the existing `getPioneer()` calls. Default backend; behaviour byte-identical to today.
- `core.ts` — Bitcoin Core JSON-RPC over HTTP (cookie / userpass). `scantxoutset` for UTXOs (pruned-OK, no history), `estimatesmartfee`, `sendrawtransaction`, `getrawtransaction` (needs `txindex` for legacy prevtx), `getblockchaininfo` for tip. See the Core limits doc — history requires an archival node + descriptor-wallet rescan; MVP is the `scantxoutset` snapshot.
- `electrum.ts` — JSON-RPC over **raw TCP/SSL** (Bun-side only; can't be done from the webview). xpub → per-address scripthash gap scan. This is what Umbrel/Start9/RaspiBlitz actually run.
- `blockbook.ts` / `esplora.ts` — REST, xpub-native (blockbook) or address-scan (esplora). Thinnest to add.

### Isolation rules (enforced, not aspirational)

1. Files under `btc-backend/` **must not import `../pioneer`** except `btc-backend/pioneer.ts`. Add an eslint `no-restricted-imports` rule so a stray import fails CI.
2. Consumers (`txbuilder/utxo.ts`, `sweep-engine.ts`, portfolio) call `getBtcBackend()` — never `getPioneer()` — for the four ops. That's the whole refactor: swap ~4 call-sites.
3. `getBtcBackend()` reads enabled node config from a new `btc_nodes` DB table (mirror `pioneer_servers`: type, url, auth, enabled, healthy). No node config → returns `PioneerBackend`. Offline mode → returns `DeviceOnlyBackend` (Part B). **Never** node creds in `.env` (per repo rule).
4. **On backend failure: NO auto-fallback to Pioneer** (locked). If the user opted into self-host and their node fails, surface a **verbose, actionable error** — which RPC call failed, HTTP status / socket error, auth failure, tip-height/sync state, wrong-network — so they can fix *their* node. Pioneer is used **only** when the user has not opted into self-host, or explicitly switches back to it in settings. This is a deliberate sovereignty stance: a self-host user must never be silently phoned-home to Pioneer. Reuse the `meta.degraded` UI surface for the loud banner, but the backend itself throws — it does not reroute.

**Net:** Pioneer code and node-client code never touch except through `BtcBackend`. "Don't mix with Pioneer" = satisfied by construction.

---

## Part B — Offline-first

### Two independent axes (don't conflate)

- **Sovereignty axis** — where does data come from: Pioneer ↔ your own node. (Part A.)
- **Connectivity axis** — is there a network at all: online ↔ air-gapped. (This part.)

"Offline first" = the connectivity axis pinned to air-gapped. The user runs Vault on a machine with **no network**. Vault + device only.

### Offline detection + the hard switch

- **Detect:** webview `navigator.onLine` + a Bun-side reachability probe (HEAD to Pioneer/base with a short timeout). Either failing → `offline` state, surfaced to the UI.
- **Setting:** `offlineMode: boolean` in `AppSettings` (persisted like the other feature flags in `db`). When **true it's a hard gate — airplane mode: ZERO outbound network, no exceptions** (not even a LAN node — that's the online-self-host axis, a different mode). Regardless of `navigator.onLine`. Per the user's rule: *once "offline first" is chosen, we don't connect unless offline mode is turned off in settings.*
- **Transport is the user's responsibility** (locked). Airplane-mode users move data themselves — thumb drive (PSBT files) and QR codes, exactly as Electrum air-gap users do today. Vault only has to *produce and consume* the standard formats (file + BC-UR QR); it does not manage the transfer.
- **Backend in offline mode:** `getBtcBackend()` returns `DeviceOnlyBackend` — `listUnspent`/`feeRate`/`broadcast` **throw `OFFLINE`**; only local/device ops proceed.

### What works vs. what's disabled offline

| Works offline (device + local) | Disabled offline (needs network) |
|---|---|
| Connect device, PIN/passphrase | Balance / portfolio refresh |
| Read xpubs, derive addresses | Transaction history |
| **Receive** (show/verify address on device) | **Send** (no UTXOs to build with, no broadcast) |
| Sign a **provided** transaction (device) | Swap, WalletConnect, price/market data |
| Firmware file drop (already local) | Firmware *download* |

Header shows an **`OFFLINE`** badge (same plumbing as the btc-only `isBitcoinOnly` prop we just added to `TopNav`); disabled features render greyed with an "offline" tooltip rather than spinning forever.

### The transaction-exchange problem (why offline needs a format)

Offline Vault can't *build* a spend — building needs UTXOs, which need network. So the **unsigned** transaction must come from an online watch-only source, and the **signed** result must go back out. The standard for this is **PSBT (BIP-174)**.

```
[ ONLINE watch-only ]                 [ OFFLINE Vault + KeepKey ]
 has xpubs, hits node                  has device, no network
 builds unsigned PSBT  ──file/QR──►    parse PSBT → btcSignTx → sign on device
                                       ◄──file/QR──  signed PSBT / final rawTx
 broadcast
```

The online side can be **Sparrow / Electrum / Bitcoin Core / Specter** (they already export PSBT) or, phase 3, Vault-in-online-watch-only-mode. KeepKey firmware does **not** speak PSBT natively — we need a **PSBT ↔ `btcSignTx` adapter**: read PSBT inputs (prev txid/vout/value/scriptPubKey + BIP32 derivation matching our xpub fingerprint) → build `btcSignTx` inputs (`addressNList` + `scriptType`) → sign → splice signatures back into a finalized tx / updated PSBT.

**Transfer channels:** (a) file (USB/SD), (b) copy-paste base64, (c) **animated QR** via BC-UR (`ur:crypto-psbt`) — the SeedSigner/Keystone/Foundation/Sparrow interop standard. File+paste first; QR is its own milestone.

### The "dual-laptop" endgame (multichain)

Phase 3: Vault runs in one of two roles (same app):
- **Online watch-only** (no device): holds xpubs, builds unsigned payloads, exports.
- **Offline signer** (device, no network): imports, signs, exports.

PSBT is **BTC-only**. For multichain (ETH/Cosmos/etc.) we serialize the **KeepKey signing request/response** itself — the exact hdwallet `*SignTx` message payloads — into a portable envelope (protobuf or CBOR) that the offline signer deserializes, signs, and returns. That's the "full KeepKey protocol serialize/deserialize, dual-laptop" ask. QR mode carries the same envelope as UR frames.

---

## Phase plan (decide these steps)

**Phase 1 — Work while offline (BTC-only, no tx format yet).**
Detect offline; `offlineMode` setting + the **data-source choice (Pioneer / Self-host / Offline)** in the btc-only `OobSetupWizard` flow; `DeviceOnlyBackend`; header `OFFLINE` badge; disabled-feature states; app never hangs on Pioneer. *You can't spend offline yet — you can read, receive, and stay stable.* Also hardens the app for "Pioneer is down" and gives self-host its verbose-error surface. Small, self-contained, ships on `btc-only`. **Prereq:** the Part-A `BtcBackend` seam (so "offline" is just a backend that throws).

**Phase 2 — Offline BTC signing via PSBT.**
PSBT import (file/paste) → PSBT↔`btcSignTx` adapter → sign on device → export signed PSBT / rawTx. Interops with Sparrow/Electrum/Core. Add `ur:crypto-psbt` animated-QR transport. This is "sign electrum/other online-first payloads, bitcoin only."

**Phase 3 — Full multichain dual-device + QR.**
Vault online-watch-only mode builds serialized KeepKey signing requests for **all** chains; offline Vault signs; file + QR transport both directions; deserialize/serialize the full KeepKey protocol envelope.

**Parallel track — Self-host node (Part A, Rev 4).**
Shares the Phase-1 seam. Recommended order once the seam exists: Blockbook → Electrum → Core. (Prior call: arch B / fallback-to-Pioneer / Blockbook first / reads+broadcast.)

### Dependency graph
```
BtcBackend seam (Part A) ──┬── Self-host: Blockbook → Electrum → Core
                           └── Phase 1 offline ── Phase 2 PSBT ── Phase 3 multichain/QR
```
The seam is the single prerequisite for **both** roadmaps. Build it first.

---

## Locked decisions

1. **Backend failure = no auto-fallback.** Self-host node fails → verbose actionable error, user fixes their node. Pioneer only if the user hasn't opted into self-host (or switches back). Sovereignty stance — never silently phone home.
2. **Offline = airplane mode, zero outbound.** No LAN exception. User owns transport (thumb drive / QR), same as Electrum air-gap users. Vault only produces/consumes the standard formats.
3. **QR = BC-UR** for the bitcoin-only path (`ur:crypto-psbt`). Multichain (P3) uses our own envelope — roll our own.
4. **Bitcoin ecosystem compatibility is the bar.** Canonical formats = **PSBT (BIP-174)** + **BC-UR QR** + **file/base64** — byte-compatible with Coldcard / Sparrow / Electrum / Keystone / SeedSigner. (BC-UR is CBOR under the hood, so BC-UR already covers the "CBOR" question for BTC.)

**Onboarding (locked):** the data-source choice — **Pioneer (default) / Self-host node / Offline (airplane)** — lives in the **bitcoin-only onboarding flow** (`OobSetupWizard`, gated on btc-only), alongside firmware/init steps. Self-host and offline are opt-in there; the choice writes `btc_nodes` + `offlineMode` and is editable later in settings.

## Still to decide (Phase 2, not blocking Phase 1)

- **PSBT signing scope:** on-device output validation depth (flag change vs external outputs), and finalize-to-rawTx vs return-updated-PSBT. (Recommend: both — finalize when we hold every sig, else emit an updated PSBT for the next signer.)
- **Multichain envelope encoding (Phase 3):** protobuf (byte-reuse with device-protocol) vs CBOR (UR-native). Deferred to P3 design.

## Recommended immediate step

Build the **Part-A `BtcBackend` seam + `PioneerBackend`** (pure refactor, behaviour-identical, no user-visible change) and land **Phase-1 offline detection + `OFFLINE` badge + `offlineMode` setting** on top of it. That unblocks self-host *and* offline with one foundation, ships safely behind existing defaults, and is verifiable on the test node next. PSBT (Phase 2) is the first net-new user capability after that.
