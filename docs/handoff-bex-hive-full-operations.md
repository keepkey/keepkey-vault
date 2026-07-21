# Handoff — BEX: full Hive operation support

**For:** the BEX (browser extension) agent
**Goal:** confirm the extension can construct and dispatch every Hive operation the device now clear-signs, then drive a live test through the vault.
**Status of the layers below you:** firmware ✅ shipped, vault ✅ shipped and un-staged, SDK ✅ wired + tested.

---

## 1. What just shipped beneath you

| Layer | Change | Where |
|---|---|---|
| Firmware | `#315` — 11 more clear-sign ops (phase 3), merged to fork `develop` | `release/7.15.0-rc15`, SHA `23ef39c03e1c13f3e95cf2cd4e41d6d9517c1992` |
| Vault | `#373` — `limit_order_create` / `limit_order_cancel` serializers | `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/txbuilder/hive-ops.ts` |
| Vault | un-staged `/hive/sign-operations` (live-device smoke passed) | `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-vault/src/bun/rest-api.ts` |
| SDK | `hive.hiveSignOperations` / `hiveSignTransfer` / `hiveSignMessage`, `address.hiveGetAddress` | `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-sdk/src/index.ts` |

Verified on-device (emulator, `EmulatorZcash` variant, fw revision `23ef39c0`):
`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-sdk/tests/hive/phase3-ops.js` → **7/7 pass**.

**Your job:** audit the extension against the op table in §3, then run §6.

---

## 2. Endpoints you call

All on the vault's local REST API, `http://localhost:1646`, bearer-token auth (pair first).

### `POST /hive/sign-operations` — the main one

```jsonc
// request
{
  "operations": [ ["limit_order_create", { /* op params, see §3 */ }] ],
  "address_n": [ ... ]   // OPTIONAL — omit and the role is picked from op tier
}
// response
{
  "signature": "<hex>",
  "ref_block_num": 12345,
  "ref_block_prefix": 3735928559,
  "expiration": "2026-07-20T18:30:00",   // ISO, derived from the SIGNED header
  "operations": [ ... ]                  // echoed back
}
```

**Broadcast using the returned `ref_block_num` / `ref_block_prefix` / `expiration` verbatim.** The vault fetches the TaPoS header from Pioneer itself and returns the exact values baked into the signed bytes. If you re-fetch your own header or use a different expiration, you reconstruct a *different* transaction and the signature is invalid.

### `POST /hive/sign-transfer` — dedicated transfer path

You supply the TaPoS header here. `amount` is **integer milli-units** (3 decimals): `1.000 HIVE` = `1000`.

```jsonc
{ "ref_block_num": 4660, "ref_block_prefix": 3735928559, "expiration": 1700003600,
  "from": "alice", "to": "bob", "amount": 1000, "asset_symbol": "HIVE", "memo": "gm" }
// → { "signature": "<hex>", "serialized_tx": "<hex>" }
```

### `POST /hive/sign-message` — Keychain `signBuffer` (dApp login)

```jsonc
{ "message": "login to skatehive", "is_text": true }
// → { "signature": "<hex>", "public_key": "STM..." }
```

Defaults to the **posting** role. Response `public_key` is STM-encoded (`'STM' + base58(pub33 || ripemd160(pub33)[0:4])`).

### `POST /addresses/hive` — derive a role key

---

## 3. The op table — the contract you must produce

14 ops. Field names below are **exactly** what the vault serializer expects
(`hive-ops.ts` `serializeOp`); anything else throws a 400 before the device is touched.

| # | op | tier | params |
|---|---|---|---|
| 0 | `vote` | posting | `voter`, `author`, `permlink`, `weight` (−10000..10000) |
| 1 | `comment` | posting | `parent_author`, `parent_permlink`, `author`, `permlink`, `title`, `body`, `json_metadata` |
| 3 | `transfer_to_vesting` | active | `from`, `to` (may be `""` = self), `amount` (**HIVE**, > 0) |
| 4 | `withdraw_vesting` | active | `account`, `vesting_shares` (**VESTS**, `0` = stop power-down) |
| 5 | `limit_order_create` | active | `owner`, `orderid`, `amount_to_sell`, `min_to_receive` (**HIVE/HBD**, both > 0, symbols must differ), `fill_or_kill` (bool), `expiration` (unix) |
| 6 | `limit_order_cancel` | active | `owner`, `orderid` |
| 8 | `convert` | active | `owner`, `requestid`, `amount` (**HBD**, > 0) |
| 18 | `custom_json` | **either** | `required_auths[]`, `required_posting_auths[]`, `id`, `json` — tier = active if `required_auths` non-empty |
| 19 | `comment_options` | posting | `author`, `permlink`, `max_accepted_payout` (**HBD**), `percent_hbd` (0..10000), `allow_votes`, `allow_curation_rewards`, `extensions` |
| 32 | `transfer_to_savings` | active | `from`, `to`, `amount` (**HIVE/HBD**, > 0), `memo` |
| 33 | `transfer_from_savings` | active | `from`, `request_id`, `to`, `amount` (**HIVE/HBD**, > 0), `memo` |
| 39 | `claim_reward_balance` | posting | `account`, `reward_hive` (**HIVE**), `reward_hbd` (**HBD**), `reward_vests` (**VESTS**) — not all three zero |
| 40 | `delegate_vesting_shares` | active | `delegator`, `delegatee`, `vesting_shares` (**VESTS**, `0` = remove delegation) |
| 43 | `account_update2` | either | `account`, `json_metadata`, `posting_json_metadata` — tier = active if `json_metadata` non-empty |

### Permanently excluded — do not attempt

- **2 `transfer`** — has its own endpoint (`/hive/sign-transfer`)
- **9 `account_create`**, **10 `account_update`** — would rotate account keys, violating the device-derived-keys invariant

`account_update2` is allowed **only** in its profile-metadata form. Any `owner` / `active` / `posting` / `memo_key` field present is a hard reject at both the vault and the firmware. Do not send authority changes.

### Asset string format

`"<whole>.<frac> <SYMBOL>"` with **exactly** the protocol decimal count, or it throws:

- `HIVE` → 3 decimals — `"1.500 HIVE"`
- `HBD` → 3 decimals — `"0.400 HBD"`
- `VESTS` → 6 decimals — `"1000.000000 VESTS"`

`"1.5 HIVE"` and `"1.50 HIVE"` are both **rejected**. The device pins symbol→precision because a swapped symbol hides a ~2000× value difference behind an identical-looking number.

---

## 4. Hard constraints (rejections you will hit)

1. **1–4 operations per transaction.** More throws.
2. **Single tier per transaction.** One signature cannot satisfy posting- and active-tier ops post-HF28. Mixing throws `Cannot mix posting-tier and active-tier operations`. Split into two transactions.
3. **`comment_options` must immediately follow its own `comment`** in the same array, with identical `author` **and** `permlink`. Standalone, or after a different comment, throws. This is anti-beneficiary-hijack: it stops a host attaching payout redirection to a post the user published earlier and isn't reviewing on screen.
4. **Beneficiaries:** 1–8, strictly ascending by account name (hived requires it — also enforces uniqueness), each weight 0..10000, sum ≤ 10000, and at most **one** extension (tag `0` = `comment_payout_beneficiaries`).
5. **Serialized tx ≤ 2048 bytes.**
6. **Memos ≤ 440 bytes.**
7. **`fill_or_kill` must be a real boolean** — `1` / `"true"` throw. Graphene serializes bool as one byte and non-0/1 is treated as a host bug, not a truthy value.

All of these are enforced **host-side in the vault** with a readable message before the device is touched, so you get a clean 400 rather than a device reject.

---

## 5. Gotchas that will cost you time

- **Firmware gate is version-only.** `requireChainSupport('hive')` compares `>=7.15.0`, which *every* 7.15.0-rc reports. A device on rc1–rc9 (no `HiveSignOperations` handler) or rc10–rc14 (no phase-3 ops) passes the gate and then rejects on-device with `"Hive tx: unsupported operation type"`. There is no capability flag to check. **Confirm the device is on rc15+ before blaming your payload** — `system/info/get-features` → `revision` is hex-encoded ASCII of the firmware git SHA; decode it and expect `23ef39c0…`.
- **Hive is behind a vault setting.** `hive_enabled` must be `1` or every endpoint 403s with `"Hive is disabled"`. Toggle in vault Settings (requires fw ≥ 7.15.0). Quick check: `GET /api/health` → `supportedChains` contains `hive:beeab0de`.
- **Signing on the emulator is user-gated, always.** `emulator-window.ts` `emuGatedConfirm`: auto-press exists only for setup ops (wipe/load/settings); *"Signing ops are always interactive and must be approved by the user."* Several ops are multi-screen by firmware design — `claim_reward_balance` = 2 screens, `limit_order_create` = 2, `comment_options` = 2 + one per beneficiary + permlink. **Expect to click through each one**; a "hung" request is almost always a confirm frame waiting on you.
- A `[Bun.serve]: request timed out after 10 seconds` was observed once against `/hive/sign-operations` and is **NOT a bug** — it was a wedged emulator, not the request path. `/hive/sign-operations` is in `SIGNING_ROUTES` and correctly gets `server.timeout(req, 0)` (`rest-api.ts` ~line 1162), so a pending confirm holds the socket open as intended. If you see it, restart the emulator rather than going hunting in the REST layer.
- **`/hive/sign-operations` calls live Pioneer** (`/api/v1/hive/tx-params`) on every request. A 502 there is Pioneer, not you.

---

## 6. Test procedure

Prereqs: vault running (`make vault` from `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11`), emulator on rc15, Hive enabled in Settings.

1. **Audit first** — for each op in §3, find where the extension builds it. Report ops the extension *cannot* currently construct; that's the real deliverable.
2. **Baseline the plumbing** (already passing, confirms your environment):
   ```
   cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-sdk   # ← see note
   node tests/hive/phase3-ops.js
   ```
   Actual path: `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11/projects/keepkey-sdk`
3. **Drive it from the extension** — internal-market swap (`limit_order_create` → `limit_order_cancel`) is the highest-value path, since that's the flow that was failing with `Operation not in the KeepKey clear-sign table (got limit_order_create)`.
4. **Confirm on the OLED that the rendered values match what the dApp asked for** — the whole point of the clear-sign table is that the screen is authoritative. Amount, symbol, and destination account, per screen.

---

## 7. Still owed elsewhere (not your blocker)

- **Gate-3 OLED proof for rc15** — screenshots of the new Hive/Osmosis confirm screens. Artifact `oled-screenshots` on run `29768388349`. Nothing tags 7.15.0 final until this is done.
- rc15 is **not** a final tag. It is `release/7.15.0-rc15` on the fork; upstream PR `keepkey/keepkey-firmware#450` is still a draft.
