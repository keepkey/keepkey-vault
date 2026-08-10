# Handoff — Audit every REST sign endpoint for UI gating

**Captured:** 2026-06-19
**Baseline:** `develop` @ `0fbd2062` (PR #264 merged). NOTE: PR #266
(`fix/swap-execute-requires-review`) is in flight and already addresses the
two swap-path items called out below — audit against develop, but check whether
#266 has merged before re-deriving the swap findings.
**Repo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault`

---

## Goal / the invariant being audited

**No REST caller may cause the device to sign anything without the user being
able to see what they're signing and physically approve it.** "See" means one
of two real review surfaces:

- **Vault overlay** — vault renders the decoded request (amounts, to-address,
  typed data, message text) in its own window and the user approves there
  *before* the device is touched.
- **Device screen** — the firmware renders the actual content on the KeepKey
  OLED (`showDisplay`/policy) and the user approves with the physical button.

A signing endpoint that, under **default or adversarial inputs**, reaches the
device with neither surface showing the real content is a **blind-sign hole**.
The job is to classify every sign endpoint and prove each one always hits at
least one surface — or fix the ones that don't.

This was prompted by the swap epic: `/api/v2/swap/execute` was added as a
headless (no-vault-GUI) device sign, which is uniquely bad for swaps because the
device can only render "send X to `<addr>`" — it cannot convey that `<addr>` is
a router/inbound vault and the intent is in an opaque memo. The same lens now
needs to sweep **all** sign endpoints.

---

## The three gating mechanisms in the codebase (know these before auditing)

1. **Central `SIGNING_ROUTES` gate** — `src/bun/rest-api.ts:1038` (the set) +
   `:1481` (the gate). Any POST whose path is in `SIGNING_ROUTES` is intercepted
   *before* its handler: empty-body probe rejection
   (`requiredSigningFields`, `:1072`), then `callbacks.onSigningRequest(info)`
   (`index.ts:1074` → `rpc.send['signing-request']` → vault overlay →
   `auth.requestSigningApproval(id)` blocks for the user's decision). Preview
   decoders that populate the overlay live at `:1530-1640` (EIP-712, personal_sign,
   TON/TRON tx, Solana message/tx). **This is the vault-overlay surface.**

2. **Inline per-handler approval** — a handler calls `onSigningRequest` itself
   instead of relying on the set. Example: `/api/v2/sweep/execute`
   (`src/bun/rest-sweep.ts:~129`, the "Signing approval gate" block) builds a
   `SigningRequestInfo` and awaits approval before `btcSignTx`. Also the swap
   dialog path. **Same vault-overlay surface, reached a different way** — so
   "not in `SIGNING_ROUTES`" does NOT by itself mean "ungated"; grep the handler.

3. **Device `showDisplay` / firmware policy** — message-signing handlers pass
   `showDisplay: body.show_display` to `wallet.*SignMessage(...)`. When true (or
   when firmware policy forces it), the KeepKey renders the message on its OLED.
   **This is the device-screen surface.** Its sufficiency hinges on the
   `show_display` default and the firmware's behavior when it's omitted — see
   the open questions.

A given endpoint may rely on (1), (2), (3), or a combination. The audit must
record which, and prove it can't be bypassed.

---

## Full sign-endpoint inventory (classify + verify each)

All routes require `auth.requireAuth` (bearer). Handlers in `rest-api.ts`
unless noted. "In set" = present in `SIGNING_ROUTES`.

### A. Transaction signing — covered by the central set (mechanism 1)
Verify: each is in `SIGNING_ROUTES`, has a `requiredSigningFields` entry, and
the overlay preview decoder renders meaningful detail (not just raw JSON).

| Route | Handler | In set | Preview decoder |
|---|---|---|---|
| `/eth/sign-transaction` | `:1953` | ✅ | generic body + to/value |
| `/eth/sign-typed-data` | `:2040` | ✅ | `decodeEIP712` `:1537` |
| `/eth/sign` (personal_sign) | `:2066` | ✅ | hex→text `:1539-1571` |
| `/utxo/sign-transaction` | `:2090` | ✅ | inputs/outputs |
| `/xrp/sign-transaction` | `:2244` | ✅ | — (verify) |
| `/solana/sign-transaction` | `:2253` | ✅ | `:1611` |
| `/solana/sign-message` | `:2320` | ✅ | `:1578` signer-derive check |
| `/tron/sign-transaction` | `:2342` | ✅ | to/value `:1576` |
| `/ton/sign-transaction` | `:2361` | ✅ | to/value `:1572` |
| `/cosmos/sign-amino*` (6) | `:2122-2158` | ✅ | shared amino preview |
| `/osmosis/sign-amino*` (9) | `:2160-2214` | ✅ | shared amino preview |
| `/thorchain/sign-amino-{transfer,deposit}` | `:2216-2228` | ✅ | shared |
| `/mayachain/sign-amino-{transfer,deposit}` | `:2230-2242` | ✅ | shared |

### B. Message / off-chain signing — NOT in the central set; rely on device screen (mechanism 3)
These were a false-positive in an earlier review ("they bypass the gate") — they
*do* surface review **via the device screen** (`showDisplay`), which is adequate
for message signing IF the device actually renders. **Confirm that assumption.**

| Route | Handler | In set | Surface | Must verify |
|---|---|---|---|---|
| `/tron/sign-message` (TIP-191) | `:2379` | ❌ | device `show_display` | default when omitted |
| `/tron/sign-typed-hash` (TIP-712) | `:2413` | ❌ | device (hash mode) | device shows what for a bare hash? |
| `/ton/sign-message` | `:2435` | ❌ | device `show_display` + AdvancedMode policy | default when omitted |
| `/solana/sign-offchain-message` | `:2453` | ❌ | device `show_display` | default when omitted |

`show_display` is `z.boolean().optional()` (`schemas.ts:33,175,209,228`) — i.e.
it can be **omitted**, and the handler forwards `undefined`. **Open question
O1** below.

### C. Sweep — inline approval (mechanism 2)
| Route | Handler | Gate |
|---|---|---|
| `/api/v2/sweep/execute` | `rest-sweep.ts:88` | inline `onSigningRequest` before `btcSignTx` — verify the `SigningRequestInfo` carries real outputs (to-address + amount), not an empty stub |

### D. Swap — remote-control + headless (mechanisms 2/none)
On **develop** these are the two known gaps; PR #266 fixes them — confirm state:
| Route | Handler | Develop behavior | PR #266 |
|---|---|---|---|
| `/api/v2/swap/execute` | `rest-swap.ts:73` → `headlessExecuteSwap` (`index.ts`) | **headless device sign, no vault review** | drives SwapDialog review, blocks on on-screen approval |
| `/api/v2/swap/confirm` | `rest-swap.ts:118` → `swap-cmd:'confirm'` → `SwapDialog` `handleExecuteSwap()` | **programmatic "click Approve"** — signs with no human gesture | route 403'd + dialog ignores programmatic confirm |
| `/api/v2/swap/{open,set,advance,requote,close}` | `rest-swap.ts` | navigation only — **verify none can trigger a sign** | unchanged |

### E. Broadcast-only (no signing — confirm they never sign)
| Route | Handler | Note |
|---|---|---|
| `/api/v2/tx/broadcast` | `rest-pioneer.ts:91` | broadcasts a caller-supplied pre-signed `serialized` tx — no device sign. Confirm it cannot be coerced into signing. |
| `/api/zcash/shielded/broadcast` | `rest-api.ts:3640` | broadcast of pre-built tx — confirm the **build/sign** half (`buildShieldedTx`/`finalizeShieldedTx`, wherever it signs) is itself gated. |

---

## Open questions to resolve (the crux of the audit)

- **O1 — `show_display` default + firmware semantics.** For B's four routes:
  when `show_display` is omitted/`false`, does the firmware still render the
  message and require a button press, or does it sign silently? If silent, these
  are blind-sign holes and need either (a) force `showDisplay: true` server-side,
  or (b) addition to `SIGNING_ROUTES` + `requiredSigningFields` + a preview
  decoder (message text / typed-hash). Test on a real device both ways.
- **O2 — typed-hash on device (`/tron/sign-typed-hash`).** Hash mode sends only
  `domain_separator_hash` + `message_hash`. Even if the device displays, a raw
  32-byte hash is not human-meaningful. Decide whether vault must decode/echo the
  structured data (like `/eth/sign-typed-data`) for real consent.
- **O3 — preview completeness for set-gated routes (A).** For each, confirm the
  overlay shows decoded detail, not `rawRequestBody` JSON only. XRP and the
  amino family are the ones to eyeball.
- **O4 — empty-probe parity.** Every route in `SIGNING_ROUTES` must have a
  `requiredSigningFields` entry (`:1072`) or empty probes fall through to the
  handler's schema (one layer deeper, still rejected, but no early gate). Diff
  the set against the function and list any missing.
- **O5 — sweep `SigningRequestInfo` fidelity (C).** Confirm the inline gate
  passes the real destination + amount so the user approves a meaningful request.

---

## Method (how to audit each endpoint)

For every row above, with a KeepKey connected and `KEEPKEY_REST_API=true`:
1. **Happy path:** POST a minimal real body with a bearer token. Observe whether
   (a) a vault overlay appears AND/OR (b) the device screen shows the content.
   Record which surface(s) fired.
2. **Adversarial — omit display:** for B, omit `show_display` (and try `false`).
   Confirm a review surface still fires. If none → **blind-sign hole**.
3. **Adversarial — empty/probe body (`{}`):** confirm 400 before any device
   interaction (probe gating).
4. **Adversarial — swap bypass:** drive `/open`+`/advance` then `/confirm` (and
   `/execute`) and confirm no sign happens without an on-screen human click
   (post-#266).
5. Record auth: every route 401s without a bearer.

Produce a table: route → surface(s) that fire on happy path → behavior under
each adversarial case → verdict (gated / **hole**) → fix.

---

## Definition of done

- A filled-in verdict table for **every** route in the inventory.
- Every endpoint proven to hit a review surface under default AND adversarial
  inputs, OR a filed fix (force `showDisplay`, add to `SIGNING_ROUTES` +
  `requiredSigningFields` + preview decoder, or remove the route).
- O1–O5 answered with on-device evidence (not assumed from code).
- A short note on whether the device-screen surface is considered sufficient
  *policy* for message signing, or whether vault should mirror it in the overlay
  for consistency.

---

## File index (absolute)

- `…/src/bun/rest-api.ts` — `SIGNING_ROUTES:1038`, `requiredSigningFields:1072`,
  central gate `:1481`, overlay preview decoders `:1530-1640`, tx-sign handlers
  `:1953-2370`, message-sign handlers `:2379-2475`, zcash broadcast `:3640`
- `…/src/bun/rest-swap.ts` — swap routes incl. `/execute:73`, `/confirm:118`
- `…/src/bun/rest-sweep.ts` — `/sweep/execute:88` + inline approval gate
- `…/src/bun/rest-pioneer.ts` — `/tx/broadcast:91`
- `…/src/bun/index.ts` — `onSigningRequest:1074` (overlay bridge), swap dialog
  drive/await (`headlessExecuteSwap`, `awaitSwapUiState`)
- `…/src/bun/auth.ts` — `requestSigningApproval` (the blocking approval promise)
- `…/src/bun/schemas.ts` — `show_display` defs (`:33,175,209,228`)
- `…/src/shared/types.ts` — `SigningRequestInfo:506`
- `…/src/mainview/components/SwapDialog.tsx` — `swap-cmd` handler (`confirm`/`advance`)
- Signing-approval overlay component (frontend) — listens for `signing-request`;
  locate via `grep -rn "signing-request" src/mainview`
