# Handoff: Add LeoDex / LeoKit as a Pioneer Swap Integration

For a Pioneer-side dev/agent. Self-contained. Adds the **only** route that can swap
**native HIVE** cross-chain (and Hive L2 / HBD), via LeoDex's LeoKit aggregator.

- **Pioneer repo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`
- **Swap code:** `services/pioneer-server/src/controllers/{quote,swappers,swap-config}.controller.ts`,
  `services/pioneer-server/src/services/swap-parser.service.ts`, affiliate fields in `routes.ts`.
- **Restart with `make start`.** **Never read/write `.env`** — the LeoKit API key/affiliate id
  goes through the existing secrets mechanism; ask for it, fail fast if missing.
- **Fix in Pioneer** — the vault consumes Pioneer's quotes; don't add a parallel path in the vault.

---

## 1. Why — and the precise scope

Pioneer already integrates **THORChain, Maya, Chainflip, Relay, Near Intents, Rango** directly.
None of them — and none of the vault's EVM aggregators (0x/1inch/CowSwap) — can touch **HIVE**:
it's a standalone Graphene chain (not EVM/Cosmos/UTXO). Maya lists 33 assets; HIVE is not one.

**LeoDex's HAT (Hive Aggregation Technology)** is currently the only thing that swaps **native L1
HIVE** with external assets — it routes HIVE through LEO's Maya liquidity pool. Its developer API
is **LeoKit** (`docs.leokit.dev`): a B2B REST swap API ("for wallets and apps"), aggregating
107+ DEXes across THORChain/Maya/Chainflip/Near Intents/Relay **plus HAT for Hive**, with custom
affiliate fees (0–1000 BPS) and **REST-only, no SDK** (so we construct + sign txs ourselves).

> **SCOPE THIS NARROWLY.** Because Pioneer already has THORChain/Maya/Chainflip/Relay/Near
> directly, LeoKit's value is **HIVE-involving routes and Hive L2 / HBD — not** re-aggregating
> protocols we already quote. Add LeoKit as a swapper that is **only consulted when the route
> touches HIVE / a Hive-Engine asset / HBD**, to avoid duplicate quotes and double-charged
> affiliate fees on routes we already serve. (Optional later: A/B LeoKit vs our direct providers
> on overlapping routes, but that's not this task.)

---

## 2. What exists in Pioneer today (don't duplicate)

`quote.controller.ts::getQuote` (line ~96) fans out to the existing providers and returns
`QuoteResult[]`. Swappers are surfaced in `swappers.controller.ts` (`/swappers`). Parsing lives
in `swap-parser.service.ts`; pending/tracking in `pending-swap.service.ts` + `swap-events.service.ts`;
affiliate fields already exist on the quote request (`routes.ts` ~548: `affiliateAddress`,
`affiliateFee`). The model is: vault asks `/quote`, picks a `QuoteResult`, signs, broadcasts via
the existing per-chain path; Pioneer tracks it.

---

## 3. Integration plan

### 3a. Register the swapper
- Add `leodex` (or `leokit`) to the swapper enum/list used by `swappers.controller.ts` and the
  quote fan-out. Gate it: **only include it in the `getQuote` fan-out when `sellAsset` or `buyAsset`
  is HIVE / HBD / a Hive-Engine token** (CAIP `hive:beeab0de/...`). Skip otherwise.

### 3b. Quote source
- New module `services/pioneer-server/src/services/leokit.service.ts`:
  - `getQuote(sellAsset, buyAsset, amount, affiliate)` → call LeoKit's REST quote endpoint
    (confirm exact path in `docs.leokit.dev` API reference), map its response into Pioneer's
    `QuoteResult` shape (rate, expectedOut, fees, ETA, route legs).
  - For a HIVE **outbound** leg, the result must carry the **deposit Hive account + memo** the
    user sends HIVE to (HAT/Maya memo-swap pattern — see §4).
  - Pass our affiliate id + BPS so fees accrue to us (mirror how the existing providers set
    `affiliateAddress`/`affiliateFee`).
- Wire it into `getQuote`'s aggregation (behind the §3a gate) and into `swap-parser.service.ts`
  so its routes are classified/tracked like the others.

### 3c. Tracking
- LeoKit/HAT swaps settle by outbound deposit + cross-chain fill (like THORChain/Maya). Reuse the
  existing pending-swap tracking; add a status poll against LeoKit's status endpoint if its fill
  isn't observable on the destination chain alone.

---

## 4. The HIVE signing contract (the important part)

HAT/Maya swaps are **memo-based**: deposit the sell asset to a vault account with a swap memo.

- **HIVE outbound (HIVE → X):** the on-chain action is a **HIVE transfer to LeoKit/HAT's Hive
  account with the swap memo** in the transfer's `memo` field.
  **KeepKey can sign this TODAY** — firmware 7.15.0 `HiveSignTx` includes the `memo` field
  (verified; see keepkey-vault `tests` + `HIVE-ATTESTATION-DIGEST-SPEC.md` context). No new
  firmware needed. So the quote must return: `{ depositAccount, memo, amount, asset }` and the
  vault builds a normal Hive transfer to it.
- **HIVE inbound (X → HIVE):** destination is the user's own Hive `@username`; the sell-side is a
  normal deposit on the source chain (BTC/ETH/etc., already signable). LeoKit returns the source
  deposit address + memo.

> Do NOT assume Hive-Keychain. The whole point vs. HiveSwap (Keychain-only) is that LeoKit is
> REST-only, so KeepKey signs the HIVE transfer itself. Keep the contract to
> `{deposit target, memo, amount}` — no Keychain dependency.

**Out of scope (would need new firmware ops, not just HiveSignTx):** Hive-Engine pool swaps and
HIVE↔HBD `convert` are `custom_json`/`convert` operations the firmware does not yet serialize.
If LeoKit routes a swap through those primitives rather than a memo-transfer, flag it — that leg
needs firmware work and should be deferred.

---

## 5. Affiliate / monetization

LeoKit supports 0–1000 BPS affiliate fees. Set our id + BPS the same way the existing swappers do
(`affiliateAddress`/`affiliateFee` on the quote path, `routes.ts` ~548). Store the LeoKit API key
+ affiliate id in secrets (never `.env`-in-git).

---

## 6. Validation gates (before building the quote mapper)

1. **Confirm LeoKit's public API exposes the native-HIVE (HAT) route.** The docs explicitly list
   THORChain/Maya/Chainflip/Relay/Near; HIVE-via-HAT is LeoDex.io's differentiator but its
   exposure over the **public** LeoKit API (vs. only the LeoDex UI) is **unconfirmed**. Verify
   with a live HIVE→BTC quote call before committing. If HAT isn't in the public API yet,
   coordinate with the INLEO/LeoDex team (they've stated they collaborate with Hive projects).
2. **Get the exact HIVE deposit + memo contract** from a real LeoKit quote (deposit account name,
   memo format, expiry) so §4 is implemented to spec, not guessed.
3. **Confirm memo-transfer vs custom_json** for each HIVE route (see §4 out-of-scope note).
4. **Dedupe overlap:** ensure the §3a gate prevents LeoKit from double-quoting routes Pioneer
   already serves via direct THORChain/Maya/etc.

---

## 7. Definition of done

- [ ] `leodex` swapper registered + surfaced in `/swappers`, gated to HIVE/HBD/Hive-Engine routes
- [ ] `leokit.service.ts` maps LeoKit quotes → `QuoteResult`, with affiliate fee applied
- [ ] HIVE-outbound quotes return `{depositAccount, memo, amount, asset}` for a memo-transfer
- [ ] Parsing + pending-swap tracking cover LeoKit fills
- [ ] Live test: HIVE→BTC and BTC→HIVE quote + execute on testnet/mainnet, settlement observed
- [ ] API key / affiliate id via secrets; no `.env` in git

---

## 8. Vault-side contract (what consumes this)

The vault already renders Pioneer `QuoteResult`s in the swap panel. For a HIVE-outbound quote it
needs `{depositAccount, memo, amount, asset}` to build a `HiveSignTx` transfer (KeepKey signs).
Keep the `QuoteResult` shape consistent with existing providers so the vault needs no special-case
code beyond recognizing HIVE as a from/to asset (already supported behind the Hive feature flag).

**Reference:** LeoKit `docs.leokit.dev` · LeoDex `leodex.io` · cross-chain HIVE rationale and the
firmware signing details in keepkey-vault `docs/HIVE-ONBOARDING-PLAN.md` /
`docs/HIVE-ATTESTATION-DIGEST-SPEC.md`.
