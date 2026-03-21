# Firmware 7.14.0 Release Plan

## Overview
Release 7.14.0 adds BTC-only build variant, security hardening, BIP-85, Solana, Tron, TON, Lynx coin, and Zcash NU6 transparent branch ID. **Zcash Orchard (shielded) is NOT included** — deferred to 7.15.0 pending bignum reduction fixes and proper test coverage.

## Repository Dependency Chain

```
keepkey/device-protocol  (proto definitions — wire format source of truth)
  ↓ submodule of
keepkey/keepkey-firmware  (C implementation)
  ↓ submodule of
keepkey/python-keepkey    (integration test harness)
  ↓ submodule of
keepkey/keepkey-firmware  (CI runs tests from here)
```

Changes flow: device-protocol → firmware → python-keepkey → firmware CI

## Phase 0: Prerequisites (before any merging)

### 0.1 Clean device-protocol fork
- [x] Sync fork master with upstream master
- [x] Delete stale branches (24 deleted)
- [x] Create `release/7.14.0` with: BIP-85 + Solana + Tron + TON protos
- [x] NO Zcash Orchard protos in release
- [ ] Verify `release/7.14.0` proto content is correct

### 0.2 Clean python-keepkey fork
- [ ] Sync fork master with upstream master (already synced)
- [ ] Delete stale branches (~30 to delete)
- [ ] Create `release/7.14.0` branch from master with:
  - [ ] Updated device-protocol submodule → `release/7.14.0`
  - [ ] New proto bindings: `messages_bip85_pb2.py` (or add to messages_pb2)
  - [ ] New proto bindings: `messages_solana_pb2.py`
  - [ ] New proto bindings: `messages_tron_pb2.py`
  - [ ] New proto bindings: `messages_ton_pb2.py`
  - [ ] Updated `mapping.py` with new message types
  - [ ] Updated `client.py` with new client methods
  - [ ] New tests (see §Test Matrix below)

### 0.3 Clean keepkey-firmware fork
- [x] Sync fork develop with upstream develop
- [x] Delete stale branches
- [x] Create feature PRs (8 PRs, all targeting develop)
- [ ] Update device-protocol submodule in each PR → `release/7.14.0`
- [ ] Update python-keepkey submodule in each PR → `release/7.14.0`

## Phase 1: Test Infrastructure (python-keepkey)

### New Proto Bindings Needed
Must be compiled with protoc 3.5.x (matching CI Docker image `kktech/firmware:v15`).

| Proto File | Binding File | Wire IDs |
|-----------|-------------|----------|
| messages.proto (BIP-85 section) | messages_pb2.py (rebuild) | 120-121 |
| messages-solana.proto | messages_solana_pb2.py | 750-755 |
| messages-tron.proto | messages_tron_pb2.py | 1400-1403 |
| messages-ton.proto | messages_ton_pb2.py | 1500-1503 |

### New Client Methods Needed
| Method | Proto Message | Response |
|--------|--------------|----------|
| `bip85_get_mnemonic(word_count, index)` | GetBip85Mnemonic | Bip85Mnemonic |
| `solana_get_address(address_n)` | SolanaGetAddress | SolanaAddress |
| `solana_sign_tx(address_n, raw_tx)` | SolanaSignTx | SolanaSignedTx |
| `solana_sign_message(address_n, message)` | SolanaSignMessage | SolanaMessageSignature |
| `tron_get_address(address_n)` | TronGetAddress | TronAddress |
| `tron_sign_tx(address_n, raw_tx)` | TronSignTx | TronSignedTx |
| `ton_get_address(address_n)` | TonGetAddress | TonAddress |
| `ton_sign_tx(address_n, raw_tx)` | TonSignTx | TonSignedTx |

### Mapping Registration
Add to `mapping.py`:
- `elif msg_type.startswith('MessageType_Solana')` → solana_proto
- `elif msg_type.startswith('MessageType_Tron')` → tron_proto
- `elif msg_type.startswith('MessageType_Ton')` → ton_proto
- Manual BIP-85 wire ID registration (120, 121)

## Phase 2: Test Matrix

### Integration Tests (python-keepkey, run against emulator)

#### BIP-85 Tests (`test_msg_bip85.py`)
- [ ] `test_bip85_12word` — derive 12-word mnemonic at index 0, verify against BIP-85 test vectors
- [ ] `test_bip85_18word` — derive 18-word mnemonic
- [ ] `test_bip85_24word` — derive 24-word mnemonic
- [ ] `test_bip85_different_indices` — different index → different mnemonic
- [ ] `test_bip85_deterministic` — same params → same result
- [ ] `test_bip85_requires_pin` — fails without PIN/init

#### Solana Tests (`test_msg_solana_getaddress.py`, `test_msg_solana_signtx.py`)
- [ ] `test_solana_get_address` — derive address at m/44'/501'/0'/0', verify Base58
- [ ] `test_solana_get_address_show_display` — with show_display=true
- [ ] `test_solana_different_accounts` — different account → different address
- [ ] `test_solana_sign_system_transfer` — sign a System.Transfer instruction
- [ ] `test_solana_sign_message` — sign arbitrary message, verify Ed25519 sig

#### Tron Tests (`test_msg_tron_getaddress.py`, `test_msg_tron_signtx.py`)
- [ ] `test_tron_get_address` — derive address at m/44'/195'/0'/0/0, verify T-prefix Base58Check
- [ ] `test_tron_get_address_deterministic` — same seed → same address
- [ ] `test_tron_sign_tx` — sign raw transaction, verify secp256k1 recoverable sig

#### TON Tests (`test_msg_ton_getaddress.py`, `test_msg_ton_signtx.py`)
- [ ] `test_ton_get_address` — derive address at m/44'/607'/0'/0'/0'/0', verify Base64URL format
- [ ] `test_ton_address_correct_derivation` — verify against known TON v4r2 address (StateInit hash)
- [ ] `test_ton_sign_tx` — sign raw transaction, verify Ed25519 sig

#### Lynx Tests (extend `test_msg_getaddress.py` or new file)
- [ ] `test_lynx_get_address` — derive address at m/44'/191'/0'/0/0
- [ ] `test_lynx_get_segwit_address` — derive bech32 address with "lynx" prefix

#### BTC-only Variant Tests
- [ ] Verify all altcoin tests are skipped when firmware is BTC-only
- [ ] Verify BTC tests still pass on BTC-only build
- [ ] (Already partially covered by existing skip logic)

#### Security Fix Tests
- [ ] `test_recovery_wordlist_validation` — extend existing recovery tests to verify invalid words are rejected
- [ ] Fault injection / nanopb — hard to test in emulator, skip for now

### Unit Tests (firmware C, run via GoogleTest)

#### Existing unit test files
```
unittests/crypto/  — crypto primitives (currently: ckd_public)
```

#### New Unit Tests Needed
| File | Tests | Purpose |
|------|-------|---------|
| `unittests/crypto/bip85.cpp` | BIP-85 derivation against test vectors | Verify HMAC-SHA512 + mnemonic generation matches spec |
| `unittests/crypto/solana.cpp` | Ed25519 address derivation, Base58 encoding | Verify Solana address format |
| `unittests/crypto/tron.cpp` | Keccak256 + Base58Check address derivation | Verify TRON T-address format |
| `unittests/crypto/ton.cpp` | Ed25519 + StateInit hash address derivation | **Critical: verify TON v4r2 address is correct** |

#### TON Unit Test Priority: CRITICAL
The TON address derivation is known-broken (SHA256(pubkey) instead of SHA256(StateInit)). Unit test MUST verify against known v4r2 address before TON ships.

## Phase 3: Firmware Feature Merge Order

After python-keepkey tests are in place:

| Order | PR | Firmware Feature | Depends On |
|-------|-----|-----------------|------------|
| 1 | #39 | Glitch/fault injection hardening | None |
| 2 | #40 | Nanopb oneof memory leak | None |
| 3 | #41 | BIP39 wordlist validation | None |
| 4 | #43 | BIP-85 mnemonic derivation | device-protocol (BIP-85 protos) |
| 5 | #47 | BTC-only firmware build | #39 (memcmp_s.h dependency) |
| 6 | #42 | Lynx coin | None |
| 7 | #44 | Solana | device-protocol (Solana protos) |
| 8 | #45 | Tron + TON | device-protocol (Tron/TON protos), #43 (nanopb options), **TON address fix** |
| 9 | #46 | Zcash NU6 branch ID | None |

### PR #45 Blockers (Tron/TON)
- **TON address derivation is WRONG** — needs StateInit hash fix before merge
- Build depends on BIP-85 nanopb options (#43 must merge first)
- Bounceable tag computation is broken (0x11 | 0x11 = 0x11, no-op)

## Phase 4: Release Branch

1. All PRs merged to fork develop
2. Cut `release/7.14.0` branch on firmware fork
3. Bump version to 7.14.0
4. Full CI run (all tests green)
5. Build firmware artifact, flash to device, manual test
6. Fix any issues on release branch

## Phase 5: Push Upstream

1. PR `release/7.14.0` device-protocol → keepkey/device-protocol master
2. PR `release/7.14.0` python-keepkey → keepkey/python-keepkey master
3. PR `release/7.14.0` firmware → keepkey/keepkey-firmware develop
4. Single clean release PR with full test coverage

## Known Issues / Deferred

### Deferred to 7.15.0
- Zcash Orchard (shielded transactions)
  - trezor-crypto bignum256 incompatible with Pallas curve
  - bn_is_odd / bn_mod unreliable for ~254-bit values
  - Needs force_reduce_le + byte-level parity in redpallas.c
  - Needs unit tests matching orchard Rust crate test vectors
  - Needs python-keepkey integration tests
- Zcash transparent shielding (transparent → Orchard)

### Stuck ZEC Funds
- `u1cylr7cx6dvddtmp97q...` — 0.002 ZEC (old FVK, unreduced keys)
- `u1pf72hdcmgz6rlky6uk...` — 0.003 ZEC (partially-reduced FVK)
- `u166u3hjvawug2yq7qrx...` — 0.0036 ZEC (sign bit issue)
- Recoverable once Orchard FVK derivation is fixed in 7.15.0

### Open Upstream PRs (stale, we handle in 7.14.0)
- #367 — dead ERC-20 tokens (already in develop)
- #361 — nanopb memleak (our #40)
- #360 — CVE-2797 (relates to our #39)
- #357 — build update (stale, superseded)
