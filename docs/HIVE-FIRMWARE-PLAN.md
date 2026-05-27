# Hive Firmware Expansion Plan
# KeepKey-Native Account Creation — v2

Updated: 2026-05-22. Supersedes the initial `feature/hive` implementation.

---

## What Exists Today (feature/hive v1)

| Layer | Current State |
|---|---|
| device-protocol | `HiveGetPublicKey` (single key), `HiveSignTx` (transfer only). Wire IDs 1600–1603. |
| Firmware (hive.c) | BIP-44 path `m/44'/1275'/0'/0/0`. Transfer op serialization only. |
| hdwallet | `hiveGetPublicKey()`, `hiveSignTx()`. Single key, single role. |
| Vault chains.ts | `defaultPath: [0x8000002C, 0x800004FB, 0x80000000, 0, 0]` = `m/44'/1275'/0'/0/0` |

### Critical Problem with v1

The current derivation path (`m/44'/1275'/0'/0/0`) is incompatible with the rest of the Hive ecosystem.

Ledger, Hive Keychain v2.4, PeakD, and hiveledger.io all use **SLIP-0048**:

```
m/48'/13'/role'/0'/0'
```

A KeepKey user with v1 firmware derives a different key than every other Hive tool.
This means they cannot interoperate with existing Hive dapps or recover via other wallets.

v1 keys are safe to discard — no on-chain accounts exist yet using them.

---

## Target Architecture (v2)

### Derivation Standard: SLIP-0048

```
m/48'/13'/role'/account-index'/key-index'

Purpose:        48'  (hardened, SLIP-0048)
Network:        13'  (Hive's registered SLIP-0048 ID)
Role:           0' = owner  |  1' = active  |  3' = memo  |  4' = posting
Account index:  0' (first Hive account), 1' (second), etc.
Key index:      0' (normal), increment to rotate
```

All 5 path components are hardened. This matches Ledger's Hive app exactly.

### Four Role Keys

| Role | Path | Usage |
|---|---|---|
| owner | `m/48'/13'/0'/0'/0'` | Account recovery, authority changes |
| active | `m/48'/13'/1'/0'/0'` | HIVE/HBD transfers, staking |
| posting | `m/48'/13'/4'/0'/0'` | Votes, posts, follows |
| memo | `m/48'/13'/3'/0'/0'` | Memo field encryption |

> Note: memo = role 3', posting = role 4'. This matches SLIP-0048 spec and Ledger's implementation.

---

## Layer 0: device-protocol Changes

**Branch:** `feature/hive` on `BitHighlander/device-protocol`

**File:** `messages-hive.proto`

### Keep (unchanged)

`HiveGetPublicKey` (1600), `HivePublicKey` (1601) — single key fetch, extended with role field.
`HiveSignTx` (1602), `HiveSignedTx` (1603) — transfer signing, unchanged.

### Extend: HiveGetPublicKey

Add optional `role` field:

```protobuf
message HiveGetPublicKey {
    repeated uint32 address_n = 1;   // Full SLIP-0048 path (all 5 components hardened)
    optional bool show_display = 2;
    optional uint32 role = 3;        // 0=owner 1=active 3=memo 4=posting (informational, for display)
}
```

### New Message: HiveGetPublicKeys (wire IDs 1604/1605)

Fetch all 4 role keys in one device interaction (one confirm prompt showing all roles):

```protobuf
message HiveGetPublicKeys {
    optional uint32 account_index = 1 [default = 0];  // which account slot (0 = first)
    optional bool show_display = 2;
}

message HivePublicKeys {
    optional string owner_key   = 1;   // STM... at m/48'/13'/0'/account'/0'
    optional string active_key  = 2;   // STM... at m/48'/13'/1'/account'/0'
    optional string memo_key    = 3;   // STM... at m/48'/13'/3'/account'/0'
    optional string posting_key = 4;   // STM... at m/48'/13'/4'/account'/0'
}
```

### New Message: HiveSignAccountCreate (wire IDs 1606/1607)

Signs the Graphene `account_create` operation. Device displays username + "Secure from day one".

```protobuf
message HiveSignAccountCreate {
    repeated uint32 address_n = 1;      // Signing key path (owner: m/48'/13'/0'/0'/0')
    optional bytes  chain_id = 2;       // 32-byte chain ID
    optional uint32 ref_block_num = 3;
    optional uint32 ref_block_prefix = 4;
    optional uint32 expiration = 5;
    optional string creator = 6;        // Pioneer sponsor account name
    optional string new_account_name = 7;
    optional string owner_key = 8;      // STM... owner public key
    optional string active_key = 9;     // STM... active public key
    optional string posting_key = 10;   // STM... posting public key
    optional string memo_key = 11;      // STM... memo public key
    optional uint64 fee_amount = 12;    // creation fee (e.g. 3000 = 3.000 HIVE)
}

message HiveSignedAccountCreate {
    optional bytes signature = 1;        // 65-byte recoverable signature
    optional bytes serialized_tx = 2;    // full serialized transaction
}
```

> Note: Pioneer, not the user, broadcasts this. The device confirms the username and
> that all 4 keys are device-derived before signing.

### New Message: HiveSignAccountUpdate (wire IDs 1608/1609)

Signs `account_update` for Flow B (securing an existing account). Device shows a clear
warning that old keys are being replaced.

```protobuf
message HiveSignAccountUpdate {
    repeated uint32 address_n = 1;       // Signing key (owner key path)
    optional bytes  chain_id = 2;
    optional uint32 ref_block_num = 3;
    optional uint32 ref_block_prefix = 4;
    optional uint32 expiration = 5;
    optional string account = 6;         // Account name being updated
    optional string new_owner_key = 7;   // STM... new owner public key
    optional string new_active_key = 8;
    optional string new_posting_key = 9;
    optional string new_memo_key = 10;
}

message HiveSignedAccountUpdate {
    optional bytes signature = 1;
    optional bytes serialized_tx = 2;
}
```

### Wire ID Allocation

```
1600  HiveGetPublicKey     (exists)
1601  HivePublicKey        (exists)
1602  HiveSignTx           (exists)
1603  HiveSignedTx         (exists)
1604  HiveGetPublicKeys    (new)
1605  HivePublicKeys       (new)
1606  HiveSignAccountCreate   (new)
1607  HiveSignedAccountCreate (new)
1608  HiveSignAccountUpdate   (new)
1609  HiveSignedAccountUpdate (new)
```

---

## Layer 1: Firmware Changes

**Branch:** `feature/hive` on `BitHighlander/keepkey-firmware`

### hive.h — New Constants and Declarations

```c
// SLIP-0048 path constants (hardened)
#define HIVE_SLIP48_PURPOSE    (0x80000030)  // 48' hardened
#define HIVE_SLIP48_NETWORK    (0x8000000D)  // 13' hardened (Hive)
#define HIVE_ROLE_OWNER        (0x80000000)  // 0' hardened
#define HIVE_ROLE_ACTIVE       (0x80000001)  // 1' hardened
#define HIVE_ROLE_MEMO         (0x80000003)  // 3' hardened
#define HIVE_ROLE_POSTING      (0x80000004)  // 4' hardened

// New function signatures
bool hive_getPublicKeys(const HDNode* root, uint32_t account_index,
                        char* owner_out,   size_t owner_len,
                        char* active_out,  size_t active_len,
                        char* memo_out,    size_t memo_len,
                        char* posting_out, size_t posting_len);

void hive_signAccountCreate(const HDNode* node,
                            const HiveSignAccountCreate* msg,
                            HiveSignedAccountCreate* resp);

void hive_signAccountUpdate(const HDNode* node,
                            const HiveSignAccountUpdate* msg,
                            HiveSignedAccountUpdate* resp);
```

### hive.c — New Implementations

**1. SLIP-0048 multi-key derivation**

```c
bool hive_getPublicKeys(const HDNode* root, uint32_t account_index, ...) {
    uint32_t roles[] = {HIVE_ROLE_OWNER, HIVE_ROLE_ACTIVE,
                        HIVE_ROLE_MEMO, HIVE_ROLE_POSTING};
    char** outs[] = {&owner_out, &active_out, &memo_out, &posting_out};
    size_t lens[] = {owner_len, active_len, memo_len, posting_len};

    for (int i = 0; i < 4; i++) {
        HDNode node;
        memcpy(&node, root, sizeof(HDNode));
        // m/48'/13'/role'/account_index'/0'
        if (hdnode_private_ckd_cached(&node, HIVE_SLIP48_PURPOSE) != 0) return false;
        if (hdnode_private_ckd_cached(&node, HIVE_SLIP48_NETWORK) != 0) return false;
        if (hdnode_private_ckd_cached(&node, roles[i]) != 0) return false;
        if (hdnode_private_ckd_cached(&node, account_index | 0x80000000) != 0) return false;
        if (hdnode_private_ckd_cached(&node, 0x80000000) != 0) return false;
        hdnode_fill_public_key(&node);
        if (!hive_getPublicKey(node.public_key, *outs[i], lens[i])) return false;
        memzero(&node, sizeof(node));
    }
    return true;
}
```

**2. account_create Graphene serialization**

New op type constant: `HIVE_OP_ACCOUNT_CREATE = 9`

Authority structure (Graphene binary):
```
weight_threshold (uint32 LE)
num_account_auths (varint)       = 0
num_key_auths (varint)           = 1
public_key (33 bytes compressed)
weight (uint16 LE)               = 1
```

Transaction body:
```
ref_block_num    (uint16 LE)
ref_block_prefix (uint32 LE)
expiration       (uint32 LE)
num_ops          (varint) = 1
op_type          (varint) = 9
fee              (asset: int64 + uint8 precision + 7-byte symbol)
creator          (string)
new_account_name (string)
owner_authority  (authority struct)
active_authority (authority struct)
posting_authority(authority struct)
memo_key         (33 bytes compressed)
json_metadata    (string) = ""
num_extensions   (varint) = 0
```

**3. account_update Graphene serialization**

Op type: `HIVE_OP_ACCOUNT_UPDATE = 10`

Similar structure but with `account` (string) and optional authority fields.
All 4 authority fields present (owner, active, posting, memo_key).

**4. Device display for account_create**

```c
// Show on-device confirmation:
// Line 1: "Create Hive Account"
// Line 2: "@<new_account_name>"
// Line 3: "Secured by KeepKey"
// Line 4: "Keys from your device"
```

User must confirm on device before the transaction is signed.

### messagemap.def Additions

```
MDEF(HiveGetPublicKeys,    hiveGetPublicKeys,    NO_COIN_TYPE)
MDEF(HiveSignAccountCreate,hiveSignAccountCreate,NO_COIN_TYPE)
MDEF(HiveSignAccountUpdate,hiveSignAccountUpdate,NO_COIN_TYPE)
```

### fsm_msg_hive.h Additions

```c
void fsm_msgHiveGetPublicKeys(const HiveGetPublicKeys* msg);
void fsm_msgHiveSignAccountCreate(const HiveSignAccountCreate* msg);
void fsm_msgHiveSignAccountUpdate(const HiveSignAccountUpdate* msg);
```

---

## Layer 2: hdwallet Changes

**Branch:** `feature/hive` on `BitHighlander/hdwallet`

### hdwallet-core/src/hive.ts — New Interfaces

```typescript
// SLIP-0048 role constants (hardened)
export const HIVE_ROLE_OWNER   = 0x80000000  // 0'
export const HIVE_ROLE_ACTIVE  = 0x80000001  // 1'
export const HIVE_ROLE_MEMO    = 0x80000003  // 3'
export const HIVE_ROLE_POSTING = 0x80000004  // 4'

// Derive SLIP-0048 path for a given role + account index
export function hiveSlip48Path(role: number, accountIndex = 0): number[] {
  return [0x80000030, 0x8000000D, role, accountIndex | 0x80000000, 0x80000000]
}

export interface HiveGetPublicKeys {
  accountIndex?: number   // default 0
  showDisplay?: boolean
}

export interface HivePublicKeys {
  ownerKey:   string  // STM...
  activeKey:  string  // STM...
  memoKey:    string  // STM...
  postingKey: string  // STM...
}

export interface HiveSignAccountCreate {
  addressNList: BIP32Path  // owner key path: m/48'/13'/0'/0'/0'
  chainId?: Uint8Array | string
  refBlockNum: number
  refBlockPrefix: number
  expiration: number
  creator: string          // Pioneer sponsor account
  newAccountName: string
  ownerKey: string         // STM...
  activeKey: string
  postingKey: string
  memoKey: string
  feeAmount: number        // milliHIVE (3000 = 3.000 HIVE)
}

export interface HiveSignedAccountCreate {
  signature: Uint8Array
  serializedTx: Uint8Array
}

export interface HiveSignAccountUpdate {
  addressNList: BIP32Path  // owner key path
  chainId?: Uint8Array | string
  refBlockNum: number
  refBlockPrefix: number
  expiration: number
  account: string
  newOwnerKey: string
  newActiveKey: string
  newPostingKey: string
  newMemoKey: string
}

export interface HiveSignedAccountUpdate {
  signature: Uint8Array
  serializedTx: Uint8Array
}
```

### hdwallet-keepkey/src/hive.ts — New Transport Implementations

Wire shims for `HiveGetPublicKeys` (1604→1605), `HiveSignAccountCreate` (1606→1607),
`HiveSignAccountUpdate` (1608→1609). Same pattern as existing `hiveGetPublicKey` shim.

### hdwallet-keepkey/src/keepkey.ts

Add methods to HDWallet class:
```typescript
hiveGetPublicKeys(msg: HiveGetPublicKeys): Promise<HivePublicKeys | null>
hiveSignAccountCreate(msg: HiveSignAccountCreate): Promise<HiveSignedAccountCreate | null>
hiveSignAccountUpdate(msg: HiveSignAccountUpdate): Promise<HiveSignedAccountUpdate | null>
```

---

## Layer 3: Pioneer Changes

### New Endpoints

**`GET /api/v1/hive/username-available/:name`**
- Validates format (3-16 chars, lowercase letters/numbers/hyphens)
- Checks on-chain availability via `condenser_api.get_accounts`
- Returns `{available: bool, reason?: string}`

**`POST /api/v1/hive/create-account`**

```typescript
interface HiveCreateAccountRequest {
  username: string
  ownerKey:   string  // STM...
  activeKey:  string  // STM...
  postingKey: string  // STM...
  memoKey:    string  // STM...
}
```

Pioneer validates all 4 keys are valid STM-format public keys, then:
1. Fetches current block reference via `condenser_api.get_dynamic_global_properties`
2. Builds and broadcasts `account_create` from Pioneer's sponsor account
3. Returns `{success: true, txid: "...", username: "alice"}`

**Abuse prevention required:**
- Rate limit: 1 account per IP per 24h
- Username blacklist
- Valid STM key format validation (reject non-device keys)

**`GET /api/v1/hive/sponsor-info`**
- Returns `{balance: "XXX.XXX HIVE", capacity: N}` — UI can warn if sponsor is low

---

## Layer 4: Vault Changes

### chains.ts

**Critical path change:**

```typescript
// BEFORE (v1 — wrong, BIP-44)
defaultPath: [0x8000002C, 0x800004FB, 0x80000000, 0, 0]  // m/44'/1275'/0'/0/0

// AFTER (v2 — SLIP-0048, active key)
defaultPath: [0x80000030, 0x8000000D, 0x80000001, 0x80000000, 0x80000000]
// m/48'/13'/1'/0'/0'  (active role for day-to-day signing)
```

Export SLIP-0048 path helper:
```typescript
export function hiveRolePath(role: 'owner'|'active'|'memo'|'posting', accountIndex = 0): number[] {
  const roles = { owner: 0, active: 1, memo: 3, posting: 4 }
  return [0x80000030, 0x8000000D, roles[role] | 0x80000000, accountIndex | 0x80000000, 0x80000000]
}
```

### New txbuilder/hive-account.ts

`buildHiveAccountCreate` — constructs the signed payload using `HiveSignAccountCreate`.
`buildHiveAccountUpdate` — constructs the signed payload using `HiveSignAccountUpdate`.

These are separate from `txbuilder/hive.ts` (which handles transfers) because the
account operations involve different device messages and a different Pioneer endpoint.

### New Onboarding UI Component

**State machine for Hive asset page:**

```
NO_ACCOUNT    → show "Create Hive Account" button
                → launch onboarding wizard

PENDING       → waiting for Pioneer broadcast
                → spinner + username

ACTIVE        → show @username as "address"
                → enable send/receive

UNSECURED     → account exists but keys not from this device
                → show "Secure with KeepKey" (account_update flow)
```

**Onboarding wizard steps (Flow A — new account):**

1. **Intro** — "KeepKey will generate all Hive keys. No master password will be created."
2. **Key derivation** — vault calls `hiveGetPublicKeys()`, shows 4 STM keys (owner/active/posting/memo)
3. **Username** — text input + real-time availability check via Pioneer
4. **Confirm on device** — `hiveSignAccountCreate` triggers device prompt showing `@username`
5. **Broadcasting** — Pioneer's sponsor account broadcasts; show txid link
6. **Done** — `@username` active, controlled by KeepKey

**Migration wizard steps (Flow B — existing account):**

1. **Warning** — "This will permanently replace your existing Hive keys."
2. **Account name** — enter existing account name
3. **Key derivation** — show new KeepKey keys that will replace current ones
4. **Authorization** — user must sign with existing owner key (external, they import WIF once)
5. **Confirm on device** — `hiveSignAccountUpdate` triggers device prompt
6. **Done** — account now secured by KeepKey

> Flow B requires the user to temporarily paste their current owner WIF key to authorize
> the update. Vault must never store or log it — use it in-memory for one broadcast only.
> Display a clear warning: "Your old Hive keys are now retired. Do not use them."

---

## Breaking Change from v1

The path change (`m/44'/1275'/...` → `m/48'/13'/...`) derives a completely different key.

**Impact:** Zero. No on-chain Hive accounts exist using v1 keys. The `STM6RVs...` key
derived in v1 testing is unused. Safe to discard.

**If v1 is shipped to users before this plan is implemented:** add a migration notice
in the vault explaining that the path changed and guiding users to re-derive their key.
Given that account creation requires an extra step (the onboarding wizard), no one
will have funded an account on a v1 key without going through that wizard — which
doesn't exist yet.

---

## Implementation Order

```
Phase 1 — Path fix (no new messages, just the derivation change)
  ├── firmware: change HIVE_SLIP44 derivation → SLIP-0048
  ├── chains.ts: update defaultPath to m/48'/13'/1'/0'/0'
  └── verify: STM key matches Hive Keychain output for same device seed

Phase 2 — Multi-key support
  ├── proto: HiveGetPublicKeys (1604/1605)
  ├── firmware: hive_getPublicKeys()
  ├── hdwallet: hiveGetPublicKeys()
  └── vault: derive all 4 keys before account creation

Phase 3 — Account create (Flow A)
  ├── proto: HiveSignAccountCreate (1606/1607)
  ├── firmware: hive_signAccountCreate() + device display
  ├── hdwallet: hiveSignAccountCreate()
  ├── Pioneer: /api/v1/hive/create-account + /username-available
  └── vault: onboarding wizard UI

Phase 4 — Account update (Flow B)
  ├── proto: HiveSignAccountUpdate (1608/1609)
  ├── firmware: hive_signAccountUpdate()
  ├── hdwallet: hiveSignAccountUpdate()
  └── vault: migration wizard UI

Phase 5 — Polish
  ├── Pioneer: sponsor-info endpoint + balance monitoring
  ├── vault: UNSECURED state detection + prompt
  └── Hive asset page: @username display, send/receive with account name
```

---

## Open Questions

1. **Does Hivedex.io or any service expose an API for account creation with custom keys?**
   If yes, Phase 3 could skip the Pioneer sponsor work and integrate directly.

2. **Posting key for signing:** Most day-to-day Hive activity (votes, posts, follows) uses
   the posting key, not active. Should the vault expose posting-key signing for dapp
   interactions, or scope to active key only (transfers, power up/down)?

3. **Account index > 0:** Users can have multiple Hive accounts from one device.
   Should the vault expose account index selection in Phase 3, or default to 0 only?

4. **HBD (Hive Backed Dollar):** `HiveSignTx` already supports `asset_symbol: "HBD"`.
   Should Phase 5 include a separate HBD asset card, or display it on the Hive card?

---

## Checklist Before Merging feature/hive → develop

- [ ] Phase 1 complete: path verified against Hive Keychain for same seed
- [ ] Phase 2 complete: all 4 keys derivable from device
- [ ] Phase 3 complete: account creation wizard tested end-to-end
- [ ] Pioneer sponsor account funded and rate-limited
- [ ] device-protocol, firmware, hdwallet all on feature/hive and submodule pointers updated
- [ ] API verification checkpoints CP1-CP6 all pass
- [ ] No `m/44'/1275'` references remain in any file
