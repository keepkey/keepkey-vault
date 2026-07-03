# Hive Account-Creation Attestation Digest Spec

For the Pioneer `create-account` endpoint (§5/§6 of `handoff-pioneer-hive-sponsor.md`).
Derived from firmware 7.15.0 `lib/firmware/hive.c` + `include/keepkey/firmware/hive.h`,
verified 2026-06-26. **Byte-exact** — Pioneer's verification must match this or it silently fails.

---

## 0. TL;DR — not blocked on firmware

In Hive, `account_create` is signed by the **creator (sponsor)**, not the new account (it
doesn't exist yet). So the device's `HiveSignAccountCreate` signature is **not** a broadcast
authority — it is an **attestation**: proof that the owner key holder authorized creating
this account with these four keys, confirmed on-device.

The firmware already produces a well-defined digest and **returns the exact `serialized_tx`
it signed**. Pioneer verifies against those returned bytes — no reconstruction, no firmware
change. The earlier "blocked on firmware attestation-digest spec" status is **cleared**: the
digest below is the spec. A dedicated attestation message would be *nicer* (see §7) but is
not required to ship.

---

## 1. The digest

```
digest = SHA256( chain_id[32] || serialized_tx )
```

- `chain_id` (mainnet, `HIVE_CHAIN_ID`):
  `beeab0de` followed by 28 zero bytes (32 bytes total).
- `serialized_tx`: the Graphene `account_create` (op 9) bytes the device built and returned
  (§3). Hash the **returned** bytes verbatim; do not rebuild them.

Reference: `hive.c:183-202` (`hive_sign_digest`).

---

## 2. Signature format (65 bytes)

```
sig[0]      = 27 + recovery_id + 4      (compact header, compressed-key flag)
sig[1..33]  = r   (32 bytes)
sig[33..65] = s   (32 bytes, canonical low-S from trezor-crypto)
```

To recover the signer:
```
recovery_id = sig[0] - 31            // == 27 + recid + 4 → recid = sig[0]-31
pubkey33    = secp256k1_ecdsa_recover(digest, recovery_id, r, s)   // 33-byte compressed
```

Encode `pubkey33` as a Hive public key string: `"STM" + base58check(pubkey33, ripemd160-checksum)`
(Graphene pubkey encoding — 4-byte RIPEMD160 checksum, **not** double-SHA256). Compare against
the supplied `ownerKey`.

> Graphene's extra "is_canonical" retry loop is irrelevant here — Pioneer recovers a pubkey,
> it does not rebroadcast this signature. Reference: `hive.c:194-200`.

---

## 3. `serialized_tx` byte layout (account_create, op 9)

All multi-byte integers little-endian. `varint` = LEB128 unsigned. Reference:
`hive_serialize_account_create` (`hive.c:269-307`), `append_tx_header` (`165-173`),
`append_authority` (`152-161`), `append_asset`/`append_string`/`append_varint` (`hive.c:120-164`).

```
# header
ref_block_num       u16 LE        # = msg.ref_block_num & 0xFFFF
ref_block_prefix    u32 LE
expiration          u32 LE
num_ops             varint = 0x01
op_type             varint = 0x09  (HIVE_OP_ACCOUNT_CREATE)

# account_create body
fee                 asset:  amount u64 LE, precision u8 = 3, symbol[7] = "HIVE\0\0\0"
creator             string: varint len || bytes      # MUST equal sponsor account name
new_account_name    string: varint len || bytes
owner_authority     authority(owner_pubkey33)
active_authority    authority(active_pubkey33)
posting_authority   authority(posting_pubkey33)
memo_key            33 raw bytes                      # NO authority wrapper, NO type prefix
json_metadata       string = "" (varint 0x00)
num_extensions      varint = 0x00
```

`authority(pubkey33)`:
```
weight_threshold    u32 LE = 1
num_account_auths   varint = 0x00
num_key_auths       varint = 0x01
pubkey              33 bytes compressed (no type prefix)
weight              u16 LE = 1
```

`asset` (fee): `amount(u64 LE) || precision(u8) || symbol(7 bytes, NUL-padded)`.
`string`: `varint(len) || raw bytes`.

> Note: pubkeys inside `serialized_tx` are **raw 33-byte compressed**, not STM strings.
> The STM strings in the request are for the availability/echo path; the authoritative keys
> are these raw bytes — re-encode them to STM to compare against the request (§5 step 5).

---

## 4. account_update (op 10) — same digest, Flow B

Identical digest and signature rules. `serialized_tx` differs only in the body
(`hive_serialize_account_update`, `hive.c:351-388`): `op_type = 0x0A`, then `account`
(string) + the four new authorities/memo_key. Same verification shape; used by the
"secure existing account" flow, not create-account.

---

## 5. Pioneer verification algorithm (create-account)

Input from vault: `{ ownerKey, activeKey, postingKey, memoKey, newAccountName, creator,
refBlockNum, refBlockPrefix, expiration, feeAmount, signature(65B hex), serializedTx(hex) }`.

```
1. tx   = hexDecode(serializedTx)
   sig  = hexDecode(signature)            // assert length 65
2. digest = SHA256( HIVE_CHAIN_ID(32) || tx )
3. recid  = sig[0] - 31                   // assert 0 <= recid <= 3
   pub33  = ecdsaRecover(digest, recid, sig[1:33], sig[33:65])   // assert success
   recoveredStm = stmEncode(pub33)
4. ASSERT recoveredStm == ownerKey         // → 401 if not (proves owner-key control + on-device confirm)
5. Parse tx (§3) and ASSERT, else 400:
     - op_type == 9
     - new_account_name == newAccountName
     - stmEncode(owner_authority.key)   == ownerKey
     - stmEncode(active_authority.key)  == activeKey
     - stmEncode(posting_authority.key) == postingKey
     - stmEncode(memo_key)              == memoKey
     - creator == <OUR sponsor account>    // binds spend to us; client cannot redirect
6. Run §7 abuse + circuit-breaker gates (handoff). If ACT pool low → 503 queued.
7. Build create_claimed_account (op 23) with { creator: sponsor, new_account_name,
   owner/active/posting authorities + memo_key = the four verified keys, json_metadata: "" },
   sign with the SPONSOR active key, broadcast. fee_amount from the request is ignored
   (claimed-account creation has no fee — it spends one ACT).
```

Step 5 is load-bearing: without it a caller could submit a valid signature over
attacker-chosen bytes. The signature only matters once you've proven the bytes are exactly
what you're about to create.

---

## 6. What the vault must guarantee

- Set `creator = <sponsor account>` **before** calling `hiveSignAccountCreate`, so the
  device-signed bytes carry our sponsor (Pioneer rejects any other creator).
- Send Pioneer the device-returned `serializedTx` and `signature` unmodified, plus the four
  STM keys + `newAccountName` it used.
- `refBlockNum/Prefix/expiration/feeAmount` are echoed for transparency but Pioneer trusts
  only the parsed `serializedTx` for keys/name/creator.

---

## 7. Optional future: dedicated attestation digest (firmware change)

The op-9 digest couples attestation to Graphene serialization, so Pioneer must parse §3.
That parse is ~30 lines of fixed-layout decoding — acceptable. **Ship with this; do not block.**

If Graphene parsing later proves annoying or we want attestation decoupled from tx fields, add
a firmware message that signs a canonical, parse-free digest, e.g.:
```
digest = SHA256( "KK-HIVE-CREATE-v1" || new_account_name
                 || owner33 || active33 || posting33 || memo33 )
```
Pioneer would then verify with no Graphene decoding. This is a **new firmware message**
(separate PR), not a change to what 7.15.0 ships — track independently.

---

## 8. Test vector (capture before Pioneer codes verification)

On a real device (fw 7.15.0), call `hiveSignAccountCreate` with fixed inputs and record:
`{ inputs, signature(hex), serializedTx(hex), expected recoveredStm == ownerKey }`. Commit
the vector so Pioneer's verifier has a known-good fixture to test §5 against without a device.
Until this vector exists, treat §2's STM-encoding and recovery-byte handling as
**unverified-by-fixture** (correct by reading firmware, but confirm against device output).
