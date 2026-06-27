# Hive Onboarding — Next Steps (Self-Run Sponsor)

Updated: 2026-06-26. Decision: build self-run account creation (Pioneer sponsor).
Supersedes the "What Exists Today" section of `HIVE-FIRMWARE-PLAN.md` — that doc's
v2 spec is still the reference for message shapes; the status below is current truth.

---

## 1. Status truth (verified 2026-06-26)

The expensive, irreversible part — firmware crypto + protocol — is **done**.
Everything between firmware and the user is stuck at v1, and v1 is **actively broken**.

| Layer | State | Evidence |
|---|---|---|
| device-protocol | ✅ Complete | messages 1600–1609 defined, SLIP-0048, `role` field (messages-hive.proto) |
| Firmware 7.15.0 | ✅ Complete | SLIP-0048 derive (hive.h:20-27, hive.c:42-46), 4 role keys (hive.c:58-83), account_create op 9 (hive.c:270-345), account_update op 10 (hive.c:352-426), on-device confirms + FSM wired (messagemap.def:183-193) |
| hdwallet | ⚠️ Half | `hiveGetPublicKey` + `hiveSignTx` only (hdwallet-keepkey/src/hive.ts:11-14). **Missing**: `hiveGetPublicKeys`, `hiveSignAccountCreate`, `hiveSignAccountUpdate` (1604–09). No SLIP-0048 helper. |
| Vault | ❌ v1 | `chains.ts` hive `defaultPath: [0x8000002C,0x800004FB,...]` = `m/44'/1275'/0'/0/0` (WRONG). `txbuilder/hive.ts` = transfer only. No onboarding UI/RPC. |
| Pioneer | ❌ Relay only | `hive.controller.ts`: account-by-pubkey, tx-params, history, broadcast. No create-account, no sponsor, no rate-limit. |

### The blocker bug (independent of onboarding)
Firmware's single-key handler derives exactly the path the host sends
(`fsm_msg_hive.h:22`). The vault sends `m/44'/1275'` — a path **no other Hive wallet
uses** (Ledger/Keychain/PeakD all use SLIP-0048 `m/48'/13'`). Result: the vault's STM
key is non-interoperable, and Pioneer's pubkey→account lookup can never match an account
made elsewhere. Any account funded against a v1 key is **unrecoverable in any other tool**.

→ The default-OFF settings flag (shipped, PR #293) is the correct holding position.
Hive must not reach a user until the path is fixed.

---

## 2. Phase 0 — Path fix (MANDATORY prerequisite, no onboarding yet)

Until this lands, nothing else is safe to ship. Breaking change is free: zero accounts
exist on v1 keys (flag has been off).

| Task | Layer | File | Size |
|---|---|---|---|
| `defaultPath` → `m/48'/13'/1'/0'/0'` (active role) | Vault | `shared/chains.ts` | S |
| Add `hiveRolePath(role, accountIndex)` helper | Vault | `shared/chains.ts` | S |
| Verify derived STM key == Hive Keychain output for same seed | — | device + Keychain | S |

**Exit check:** same KeepKey seed produces the **same** STM active key in vault and in
Hive Keychain. This is the single most important checkpoint in the whole effort.

---

## 3. Phase 1 — hdwallet plumbing (un-skippable for any onboarding)

The 3 proto messages exist but the JS wallet can't call them. Spec is fully written in
`HIVE-FIRMWARE-PLAN.md` Layer 2.

| Task | File | Size |
|---|---|---|
| Core interfaces: `HiveGetPublicKeys`, `HiveSignAccountCreate`, `HiveSignAccountUpdate` (+ Signed*) | hdwallet-core/src/hive.ts | S |
| `hiveSlip48Path()` + role constants | hdwallet-core/src/hive.ts | S |
| Wire shims 1604→1605, 1606→1607, 1608→1609 | hdwallet-keepkey/src/hive.ts | M |
| `keepkey.ts` methods: `hiveGetPublicKeys/hiveSignAccountCreate/hiveSignAccountUpdate` | hdwallet-keepkey/src/keepkey.ts | S |
| Submodule pin bump in vault after merge | vault | S |

**Exit check:** vault can call `hiveGetPublicKeys()` and get 4 STM keys from a real device.

---

## 4. Phase 2 — Sponsor service (the part with cost & ops)

This is what the "self-run" decision buys. **Economics first, code second.**

### 4a. How Hive account creation actually costs

Two on-chain ways to create an account:
- `account_create` — pays a flat **fee (currently ~3 HIVE)** per account. Cash out the door.
- `create_claimed_account` — spends a pre-claimed **Account Creation Token (ACT)**, which
  you mint with **`claim_account`**. `claim_account` costs **either** 3 HIVE **or** a large
  chunk of **Resource Credits (RC)** — and RC is free/regenerating if you've staked enough
  **Hive Power (HP)**.

**The cheap model = stake HP → mint ACTs with RC on a schedule → spend ACTs for users.**
HP stake is **locked capital, not burned cash** (power-down returns it over 13 weeks).
Cash only bleeds if we fall back to the 3-HIVE fee during bursts.

> ⚠️ RC cost of `claim_account` and the creation fee are **witness-tunable** — do NOT
> hardcode. Read live values from the chain (`get_dynamic_global_properties`,
> `rc_api.get_resource_params`, witness `account_creation_fee`) and size HP from the
> measured claim rate you want to sustain. Capacity-plan before staking.

### 4b. Sponsor ops (Pioneer)

| Task | Detail | Size |
|---|---|---|
| Sponsor account + key mgmt | Funded Hive account; **active key in secrets, never in repo/.env-in-git**. Sign `claim_account` / `create_claimed_account` server-side. | M |
| ACT minting cron | Periodic `claim_account` while RC allows; maintain a pool of pending ACTs | M |
| `POST /hive/create-account` | Validate 4 STM keys, build+broadcast `create_claimed_account` from sponsor, return txid | M |
| `GET /hive/username-available/:name` | Format check + on-chain availability | S |
| `GET /hive/sponsor-info` | Pool size, RC %, HP, ACT count — for UI warnings + monitoring | S |
| Monitoring/alerts | Alert on ACT pool low / RC depleted / HP power-down | M |

### 4c. Abuse defense (a free-account faucet WILL be attacked)

| Control | Notes |
|---|---|
| Per-IP rate limit (1/24h baseline) | Pioneer has **no** rate-limit middleware today — must add (`express-rate-limit` or equiv) |
| **Device attestation** (our advantage) | Require a device-signed challenge so only a genuine KeepKey can request creation. Strong sybil defense competitors lack — lean on it instead of CAPTCHA. |
| Username blacklist + format validation | Reserved/abusive names |
| Pool circuit-breaker | Refuse when ACT pool/RC below threshold rather than fall back to cash fee silently |

**Exit check:** end-to-end on testnet/mainnet — device keys → username check → device
confirm → sponsor `create_claimed_account` → `@username` resolves and shows in vault.

---

## 5. Phase 3 — Vault onboarding UI

Spec in `HIVE-FIRMWARE-PLAN.md` Layer 4 (state machine + wizard steps). Net-new in vault.

| Task | File | Size |
|---|---|---|
| `txbuilder/hive-account.ts`: `buildHiveAccountCreate` / `buildHiveAccountUpdate` | vault/bun | M |
| RPCs: `hiveGetPublicKeys`, `hiveCreateAccount`, (later) `hiveSecureAccount` | vault/bun | M |
| Asset-page state machine: `NO_ACCOUNT / PENDING / ACTIVE / UNSECURED` | vault/mainview | M |
| Onboarding wizard (Flow A): intro → derive 4 keys → username → device confirm → broadcast → done | vault/mainview | L |
| Hive card: `@username` as address, send/receive | vault/mainview | M |

**Exit check:** a brand-new KeepKey with no Hive account completes the wizard and lands on
an ACTIVE Hive card, fully device-controlled.

---

## 6. Phase 4 — Migration (Flow B, "secure existing account") — optional

For users who already have a Hive account (most of them). Uses the already-implemented
`account_update`. Lets existing Keychain/Ledger users move custody to KeepKey.

- Vault migration wizard (warning → account name → show new keys → user signs with current
  owner WIF in-memory once → device confirm `account_update` → done).
- Pioneer broadcasts `account_update` (broadcast path already exists).
- **Security:** owner WIF used in-memory for one broadcast, never stored/logged.

Lower priority than Phase 3 under the self-run decision, but cheap relative to the sponsor
work and high-value for adoption. Sequence after Phase 3 unless adoption data says otherwise.

---

## 7. Critical path & sequencing

```
Phase 0 (path fix) ─┬─→ Phase 1 (hdwallet) ─┬─→ Phase 2 (sponsor)  ─→ Phase 3 (wizard) ─→ ship (flag on)
   MANDATORY        │      MANDATORY         │     decision = yes        new-user onboarding
                    │                        └─→ Phase 4 (migration, optional, after P3)
                    └─ blocks everything; do first, verify against Keychain
```

Firmware/protocol: **0 work** (done). Heaviest remaining: Phase 2 (sponsor ops + abuse)
and Phase 3 (wizard UI). Capital: HP stake (recoverable). Recurring: ops + monitoring, plus
cash only if bursts exceed the ACT mint rate.

---

## 8. Decisions (resolved 2026-06-26)

1. **Gating → KeepKey owners only.** Creation requires a device-signed challenge; only a
   genuine KeepKey can request. Near-sybil-proof, caps abuse and cost. (Phase 2 endpoint
   must verify a device attestation, not just rate-limit.)
2. **Empty-pool policy → queue + circuit-breaker.** Refuse below a threshold and refill via
   the mint cron; never silently fall back to the cash fee. No surprise spend.
3. **Multi-account → single account, index 0 only** for v1. `m/48'/13'/role'/0'/0'`.
   Multi-account deferred (additive, non-breaking later).
4. **Key scope → active key only** for v1 (transfers, power up/down, staking). Posting-key
   signing deferred. Smallest signing surface first.

### Still needs a number (not a blocker for Phase 0/1)
- **HP stake size** — driven by target accounts/day. With KeepKey-owners-only gating, volume
  is bounded by device sales, so size the stake to that. Capacity-plan from live RC cost
  before committing capital in Phase 2.
