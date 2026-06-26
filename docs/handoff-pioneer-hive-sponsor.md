# Handoff: Pioneer Hive Sponsor Service (Phase 2)

For a Pioneer-side dev/agent. Self-contained. Builds the account-creation backend that
KeepKey Vault's Hive onboarding wizard will call.

- **Pioneer repo:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer`
- **Vault plan + decisions:** `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11-hive/docs/HIVE-ONBOARDING-PLAN.md`
- **Message/serialization spec:** `…/keepkey-vault-v11-hive/docs/HIVE-FIRMWARE-PLAN.md` (Layer 3)
- **Restart Pioneer with `make start`** (never paste manual pnpm/bun recipes).
- **Never read or write `.env`.** Sponsor keys go through the existing secrets mechanism;
  ask for them, fail fast if missing.

---

## 1. Why this exists

Hive has **no free self-service account creation** — it's their spam defense. Creating an
account requires either a ~3 HIVE fee or an **Account Creation Token (ACT)**, paid by an
existing funded account. KeepKey is running a **self-run sponsor**: a funded Hive account
that mints ACTs from Resource Credits (RC) and spends them to create accounts for KeepKey
owners. This service is that sponsor.

The device side is done: firmware 7.15.0 derives SLIP-0048 keys and signs `account_create`
(op 9) with on-device confirmation. The vault collects the user's 4 device-derived public
keys and a device-signed payload, then calls this service to broadcast from the sponsor.

---

## 2. What Pioneer has today (do not rebuild)

`services/pioneer-server/src/controllers/hive.controller.ts` — read-only + relay:

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/hive/account/:pubkey` | Resolve STM pubkey → account name + balances (hive/hbd/hp/rc%) |
| `GET /api/v1/hive/tx-params` | Block reference params for tx construction |
| `GET /api/v1/hive/history/:account` | Recent transfer history |
| `POST /api/v1/hive/broadcast` | Broadcast a signed transfer |

Routes registered in `routes.ts` (~lines 2271, 2300, 2330, 2360). **No rate-limit
middleware exists** in `app.ts` — you must add it. There is **no sponsor account, no ACT
logic, no abuse defense** today.

---

## 3. Locked decisions (do not re-litigate)

1. **Gating = KeepKey owners only.** The create endpoint must verify a device-signed
   attestation, not just rate-limit. (See §6 — confirm the exact mechanism before coding.)
2. **Empty ACT pool = queue + circuit-breaker.** Refuse below a threshold; refill via the
   mint cron. **Never** silently fall back to the 3-HIVE cash fee.
3. **Single account, index 0 only** for v1. Keys arrive at `m/48'/13'/role'/0'/0'`.
4. **Active-key only** is what the vault signs day-to-day; but account creation submits all
   4 public keys (owner/active/posting/memo) — you broadcast all 4 into the new account's
   authorities.

---

## 4. Sponsor mechanics (the core)

```
                 ┌─ claim_account (costs RC, free-ish if HP staked) ──┐
  Sponsor acct ──┤  run on a cron while RC allows                     ├─→ pool of pending ACTs
  (funded, HP)   └────────────────────────────────────────────────────┘
                                                                          │
  Vault request ── create-account ──→ create_claimed_account (spends 1 ACT) ─→ new @username
```

- **`claim_account`** mints one pending ACT. Costs **either** 3 HIVE **or** a large chunk of
  **RC**. With enough staked **Hive Power**, RC regenerates and ACTs are effectively free.
- **`create_claimed_account`** spends one pending ACT to create the user's account with their
  4 device public keys as authorities. This is what the create endpoint broadcasts.
- **HP stake is locked capital, not burned cash** (power-down returns it over 13 weeks). Cash
  only leaves if you ever use the fee path — which decision #2 forbids.

> ⚠️ **Do not hardcode** the RC cost of `claim_account` or the creation fee — both are
> witness-tunable. Read live values:
> - `condenser_api.get_dynamic_global_properties`
> - `rc_api` for current RC cost of `claim_account`
> - witness `account_creation_fee`
> Size the HP stake from the measured claim rate you need to sustain (see §8).

---

## 5. Endpoints to build

### `GET /api/v1/hive/username-available/:name`
- Validate format: 3–16 chars, lowercase `a-z 0-9 -`, Hive naming rules (segments, no
  leading/trailing/double `-`).
- Check on-chain availability via `condenser_api.get_accounts`.
- Response: `{ "available": boolean, "reason"?: string }`

### `POST /api/v1/hive/create-account`
Request:
```jsonc
{
  "username":   "alice",
  "ownerKey":   "STM…",   // m/48'/13'/0'/0'/0'
  "activeKey":  "STM…",   // m/48'/13'/1'/0'/0'
  "postingKey": "STM…",   // m/48'/13'/4'/0'/0'
  "memoKey":    "STM…",   // m/48'/13'/3'/0'/0'
  "attestation": { … }     // device proof — see §6
}
```
Flow:
1. **Verify attestation** (§6). Reject if absent/invalid → `401`.
2. **Rate-limit** (§7). Over limit → `429`.
3. Validate all 4 keys are well-formed STM pubkeys; re-check username availability + format.
4. **Circuit-breaker:** if ACT pool < threshold → `503 { error: "queued", retryAfter }`.
   Do **not** fall back to the cash fee.
5. Build + broadcast `create_claimed_account` from the sponsor (creator = sponsor account),
   spending one ACT, with the 4 keys as authorities (`weight_threshold: 1`, single key auth).
6. Response: `{ "success": true, "txid": "…", "username": "alice" }`.

### `GET /api/v1/hive/sponsor-info`
- Response: `{ "actPool": N, "rcPercent": 0–100, "hivePower": "…", "creatable": N }`.
- Powers UI warnings (vault greys "Create" when `creatable` is 0) **and** monitoring/alerts.

---

## 6. Device attestation (CONFIRM BEFORE CODING — one open item)

Decision is "only a genuine KeepKey." The available signal:

- **Baseline (always available):** the request carries a payload the device signed during the
  on-device `account_create` confirm (firmware `HiveSignAccountCreate` → 65-byte recoverable
  sig). Pioneer verifies the signature recovers to the supplied `ownerKey`. This proves the
  requester controls a full device-derived key set and completed a hardware confirmation.
- **Stronger (only if it exists):** a hardware **device-attestation** key/cert baked into
  KeepKey firmware, verifiable against KeepKey's manufacturing CA. **Unconfirmed that KeepKey
  exposes this** — verify with the firmware team. If it exists, require it; if not, baseline
  signature + rate-limit + `sponsor-info` circuit-breaker is the v1 gate.

**Action:** confirm with firmware whether a verifiable hardware attestation exists. Default to
the baseline mechanism if not. Document whichever you implement in the endpoint.

---

## 7. Abuse defense (none exists today)

- Add rate-limit middleware (`express-rate-limit` or equiv) to `app.ts`, scoped to the create
  route. Baseline: **1 success / IP / 24h** + a short burst limit.
- Username blacklist (reserved/abusive/impersonation names).
- **Circuit-breaker is also a defense:** refusing below the ACT threshold caps the blast
  radius of any drain attempt.
- Log every create attempt (ip, username, attestation result, outcome) for forensics.

---

## 8. Capacity planning (before staking capital)

- Pick a target **accounts/day**. With KeepKey-owners-only gating, this is bounded by device
  sales — size to that, not to an open internet.
- Measure live RC cost of `claim_account`, compute HP needed to sustain the target claim rate
  with RC regen headroom, add buffer. Stake once; monitor.
- Alert thresholds: ACT pool low, RC% low, HP power-down initiated, create error-rate spike.

---

## 9. Definition of done

- [ ] `username-available`, `create-account`, `sponsor-info` live and registered in `routes.ts`
- [ ] Sponsor account funded + HP staked; active key via secrets (not env-in-git)
- [ ] ACT mint cron running; pool maintained
- [ ] Attestation verification implemented (mechanism confirmed with firmware)
- [ ] Rate-limit middleware added; blacklist in place
- [ ] Circuit-breaker returns 503/queued below threshold — never the cash fee
- [ ] End-to-end (mainnet): vault wizard → create-account → `@username` resolves via existing
      `GET /hive/account/:pubkey`
- [ ] Monitoring/alerts wired

---

## 10. Vault-side contract (what calls you)

The vault onboarding wizard (Phase 3, not yet built) will:
1. `hiveGetPublicKeys()` on device → 4 STM keys.
2. `GET /hive/username-available/:name` as the user types.
3. Device signs `account_create` (on-device confirm) → attestation payload.
4. `POST /hive/create-account` with the 4 keys + attestation.
5. Poll `GET /hive/account/:pubkey` until `@username` resolves → Hive card goes ACTIVE.

Keep request/response shapes in §5 stable; the vault codes against them.
