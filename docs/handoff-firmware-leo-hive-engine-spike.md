# Spike Handoff: KeepKey firmware support for LEO / Hive-Engine (`custom_json`) actions

**Audience:** the vault/firmware agent. **Type:** time-boxed spike (de-risk, don't ship).
**Outcome wanted:** a go/no-go + a concrete proto + signing design for letting KeepKey sign
Hive-Engine token actions (starting with **LEO**), which is the single blocker for native-HIVE
cross-chain swaps in Pioneer.

---

## 1. Why this exists (the blocker, established by research)

Pioneer wants to offer native-HIVE swaps. We traced the only live route end-to-end:

- Native HIVE swaps (LeoDex **HAT**) route **HIVE → LEO/CACAO pool on Maya → external L1**.
  Per the INLEO AMA: *"all swaps from Hive Assets to other L1 tokens must flow…into the
  LEO/CACAO pool."*
- **Maya has no native HIVE pool** — it has a **LEO–CACAO** pool. So the path goes through **LEO**.
- **LEO and SWAP.HIVE are Hive-Engine (L2) tokens.** Moving HIVE into that lane = **`custom_json`**
  operations (Hive-Engine deposits + market/pool orders). LeoDex signs these today with **Hive
  Keychain / XDeFi** — multiple operations, not one transfer.

**KeepKey firmware today signs only a Hive `transfer` op (+ memo) via `HiveSignTx`.** It does **not**
serialize `custom_json`. So every real native-HIVE route is unsignable on KeepKey right now. This
spike decides what it takes to change that.

> The complementary Pioneer-side handoff (`handoff-pioneer-leodex-swapper.md`) is **gated on this
> work**: Pioneer can map LeoKit quotes, but the vault can only execute a HIVE-outbound leg once
> the firmware can sign whatever ops the route needs. If the route reduces to a pure
> `transfer`+memo deposit (LeoKit's unconfirmed §1 gate), this spike is unnecessary — but the
> evidence says it does **not**; it needs Hive-Engine ops.

---

## 2. Goal of the spike (what to produce)

Time-box ~2–3 days. Deliverables, not a finished feature:

1. **Map** the current Hive signing path in firmware (proto message, handler, serializer, on-device
   display, key/authority derivation). Write down file paths + the exact current op coverage.
2. **Confirm** the Hive `custom_json` binary serialization + signing digest (see §4) and that the
   **active authority** key path is reachable from the current Hive derivation.
3. **Prototype** signing exactly one Hive-Engine **LEO** action (a `market` sell or a `marketpools`
   swap) and broadcast it to confirm the produced signature is valid on-chain.
4. **Recommend** the on-device display strategy (clear-sign structured Hive-Engine actions vs.
   generic blind-sign) — this is the real design decision, see §5.
5. **Output**: proposed proto changes + the vault↔firmware contract + risk list + go/no-go.

Non-goals: full UI, every Hive-Engine contract, production hardening. Just enough to commit to a design.

---

## 3. Current state to verify (don't trust, confirm)

- `HiveSignTx` (per onboarding notes, firmware ~7.15.0) covers the **`transfer`** op including the
  `memo` field. Confirm the message shape and that it's transfer-only.
- The Hive signing digest/attestation is documented in
  `docs/HIVE-ATTESTATION-DIGEST-SPEC.md` and `docs/HIVE-ONBOARDING-PLAN.md` (in the hive vault repo).
  Read these first — they define how the tx digest is built and likely already encode the chain id.
- Hive chain id = `beeab0de…` (matches CAIP `hive:beeab0de`). Native HIVE asset = `slip44:1275`.

---

## 4. What a LEO / Hive-Engine action actually is (the spec to sign)

Hive-Engine has **no separate chain**. Every Hive-Engine action is a **Hive L1 `custom_json`
operation** that the sidechain nodes read. So the firmware doesn't need a new chain — it needs the
**`custom_json` operation** (Hive op id **18**).

**`custom_json` operation fields (in serialization order):**

| field | value for Hive-Engine |
|---|---|
| `required_auths` | `[senderAccount]` — **active** authority (token transfers, market, pools) |
| `required_posting_auths` | `[]` (empty for token/market/pool actions) |
| `id` | `"ssc-mainnet-hive"` (the Hive-Engine sidechain id string) |
| `json` | a JSON **string**: `{"contractName":..,"contractAction":..,"contractPayload":{..}}` |

**Serialization** (Hive/Graphene): `op_id` (varint=18) → `required_auths` (varint count + each
account as length-prefixed string) → `required_posting_auths` → `id` (length-prefixed string) →
`json` (length-prefixed string). Whole tx is signed as `sha256(chain_id ++ serialized_tx)`, same
digest scheme the existing `transfer` path already uses — so most of the pipeline is reuse; the new
work is **serializing one more op type** + displaying it.

**The specific actions the HAT/LEO route needs (confirm exact payloads against Hive-Engine docs):**

- **Hive-Engine token transfer** (move LEO / SWAP.HIVE):
  `{"contractName":"tokens","contractAction":"transfer","contractPayload":{"symbol":"LEO","to":"..","quantity":"..","memo":".."}}`
- **Hive-Engine market order** (LEO ↔ SWAP.HIVE on the internal order book):
  `{"contractName":"market","contractAction":"sell"|"buy"|"cancel","contractPayload":{"symbol":"LEO","quantity":"..","price":".."}}`
- **Diesel-pool swap** (AMM) — ⭐ **CONFIRMED the HAT hop (see §7 q3): prototype THIS**:
  `{"contractName":"marketpools","contractAction":"swapTokens","contractPayload":{"tokenSymbol":"SWAP.HIVE","tokenAmount":"..","tradeType":"exactInput","minAmountOut":"..","tokenPair":"SWAP.HIVE:LEO"}}`
  (canonical pair ordering is `SWAP.HIVE:LEO` — the reverse does not exist on-chain).

**Already signable today (verify, may need nothing):** the **peg-in** native HIVE → SWAP.HIVE is a
plain Hive `transfer` to the Hive-Engine gateway account with a memo — that's the existing
`HiveSignTx` transfer path. If true, only the **L2 hop(s)** need new firmware.

---

## 5. The real design decision: clear-sign vs. blind-sign

`custom_json.json` is arbitrary text. Two options — call this in the spike:

- **A. Generic `custom_json` signing** — firmware accepts any `{required_auths, id, json}`, displays
  a hash/preview, user confirms. *Least code, but blind-signing*: the user can't verify on-device
  what LEO action they're authorizing. Security smell; opens KeepKey to "sign this opaque json" abuse.
- **B. Structured Hive-Engine actions** — firmware parses the known `contractName/contractAction`
  set above and renders human screens ("Sell 100 LEO @ 0.0042 SWAP.HIVE"). Safer, matches KeepKey's
  clear-signing posture, more firmware code + a parser.

**Recommendation to evaluate:** B for the handful of actions the route needs, with A explicitly
**rejected or feature-flagged off** so we don't ship blind-signing. The spike should confirm the
parser cost is acceptable on the device (memory/screen). `// ponytail:` if A is taken as a stopgap,
name the ceiling — blind-sign is a known security gap, upgrade to B before GA.

**B's load-bearing rule (do NOT skip):** the firmware must **sign the exact `json` string it
receives and parse THAT SAME string for the display** — never reconstruct the json from parsed
fields. If firmware re-encodes json from structured inputs, `display ≠ signed` (key-order /
whitespace drift) and the clear-signing guarantee is fake. So: the **vault sends the verbatim
`json` string**; firmware signs it byte-for-byte and renders the human screen from it. Additionally
the parser must: pin `id == "ssc-mainnet-hive"`, whitelist the `contractName`/`contractAction` set,
and bound the json length to a safe on-device buffer. Anything failing these → reject, don't
fall back to blind-sign.

---

## 6. Out of scope for *this* spike (flag, track separately)

These are also `custom_json`/native ops the firmware can't sign, but they aren't on the LEO path:

- **HIVE ↔ HBD `convert`** (native op, separate op id) — needed for HBD routes, not LEO.
- **Native internal-market `limit_order_create`/`_cancel`** — the on-chain HIVE/HBD DEX.

If the design in §5 generalizes the op pipeline, note how cheaply these fold in later — don't build them.

---

## 7. Open questions the spike must answer

1. Does the existing Hive digest/derivation already expose the **active** key, or only posting? (Token
   ops need active.)
2. Exact `contractPayload` shapes HAT actually broadcasts — get a real LeoDex/Keychain-signed LEO
   swap tx from a block explorer (hiveblocks.com) and **copy its `custom_json`** as the prototype target.
3. ✅ **RESOLVED — it's the diesel pool, not the order book.** Live Hive-Engine data: the
   `marketpools` pool `SWAP.HIVE:LEO` holds **~121,702 SWAP.HIVE + ~764,376 LEO**; the order-book
   `market` for LEO has **~26 HIVE/24h volume** (effectively dead). So the HAT hop is
   `marketpools.swapTokens` on pair `SWAP.HIVE:LEO`. Prototype that payload (§4 bullet 3).
4. On-device parser feasibility for structured display (§5 option B).
5. Does peg-in (HIVE→SWAP.HIVE) truly reduce to the existing `transfer` path? (Confirm gateway account + memo format.)

---

## 8. Definition of done (spike)

- [ ] Current Hive signing path mapped (files, op coverage, digest, key path) — written down.
- [ ] `custom_json` serialization + digest confirmed against a real on-chain Hive-Engine tx.
- [ ] One LEO `custom_json` action signed by firmware (prototype) and **broadcast successfully**.
- [ ] Display strategy decided (§5) with a security rationale.
- [ ] Proposed proto change + vault↔firmware contract documented.
- [ ] Scope confirmed for `convert` / `limit_order` as follow-on (§6).
- [ ] Clear **go/no-go** + effort estimate for the production implementation.

---

## 9. The vault↔Pioneer contract this unblocks

Once firmware can sign the needed Hive-Engine op(s), the vault builds them from a Pioneer
`QuoteResult`. For a HIVE-outbound HAT leg Pioneer must return enough to construct the op(s) —
deposit/target account, memo or `custom_json` payload, amount, asset. Keep the `QuoteResult` shape
consistent with existing providers (see `handoff-pioneer-leodex-swapper.md` §8). If the route is
multi-op (peg-in transfer **then** an L2 pool swap), the contract must express an **ordered list of
ops to sign**, not a single tx.

**Sequencing nuance:** these are **separate, sequentially-broadcast transactions**, not one
multi-op tx — the peg-in (HIVE→SWAP.HIVE) must *confirm* before the L2 `swapTokens` can spend the
SWAP.HIVE. So the contract is an ordered list where each step is its own signature + broadcast,
**gated on the prior step confirming**. Build that gating into the vault flow.

**Trust-model caveat (state plainly, don't oversell):** this work makes the route **signable on
KeepKey** — it does **not** make it trustless. The final **SWAP.HIVE → native HIVE** hop is an
INLEO/Hive-Engine **gateway withdrawal (custodial peg)**, per the deep-research. And liquidity is
thin: the `SWAP.HIVE:LEO` diesel pool is ~121k HIVE / ~764k LEO, further bounded by the LEO/CACAO
Maya pool — a few-thousand-dollar swap moves price materially. "Signable" ≠ "trustless" ≠ "deep."

---

## 10. References

- Pioneer-side handoff (gated on this): `handoff-pioneer-leodex-swapper.md`
- Hive signing internals: `docs/HIVE-ATTESTATION-DIGEST-SPEC.md`, `docs/HIVE-ONBOARDING-PLAN.md`
- Hive-Engine contracts (token/market/marketpools): hive-engine.com docs, developers.hive.io/layer2
- Hive op serialization / `custom_json`: developers.hive.io
- Route confirmation: INLEO AMA "L1 Native HIVE & LEO Swaps Powered by Maya"
  (hive.blog/@khaleelkazi); LeoDex intro (hive.blog/@leofinance)
- Inspect a real LEO swap tx: hiveblocks.com (find a LeoDex/Keychain custom_json to copy as the prototype target)
