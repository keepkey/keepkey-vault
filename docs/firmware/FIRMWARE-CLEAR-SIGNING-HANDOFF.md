# Firmware Clear-Signing Handoff Document

**Date**: 2026-03-17
**Status**: Phase 1 (host-side) complete, Phase 2-3 (firmware) ready for implementation
**Depends on**: Pioneer descriptor registry (deployed), vault v11 calldata decoder (merged)

---

## Executive Summary

KeepKey firmware currently hardcodes ~7 contract handlers (ERC-20, MakerDAO, THORChain, 0x). Adding new DeFi protocols requires firmware updates. This document specifies how to add **signed metadata verification** so the host can supply trusted transaction descriptions that the device verifies and renders — enabling clear-signing for 162+ dApps without firmware changes.

**What's already done (host-side)**:
- Pioneer-server descriptor registry: 3047 selectors across 114 dApps, 24 chains
- REST API: `POST /descriptors/decode` returns decoded calldata
- Vault v11: `calldata-decoder.ts` calls Pioneer, shows decoded info in signing approval UI
- Existing firmware plan: `docs/firmware/SIGNED-METADATA-CLEAR-SIGNING-PLAN.md`

**What firmware needs to implement**:
1. New protobuf messages for metadata transport
2. Signature verification against embedded public key
3. Transaction hash binding verification
4. Rich confirmation screen rendering from verified metadata
5. Backwards-compatible integration into existing signing flow

---

## Current Firmware Architecture (Reference)

### Ethereum Signing Flow (`ethereum.c:590-774`)

```
ethereum_signing_init()
  ├─ Validation (chain ID, data length, safety checks)
  ├─ ethereum_contractHandled() → check ~7 hardcoded protocols
  │   └─ If matched: ethereum_contractConfirmed() → protocol-specific screens
  ├─ ERC-20 detection (transfer 0xa9059cbb, approve 0x095ea7b3)
  ├─ If unknown contract data: "arbitrary contract data" warning + AdvancedMode gate
  ├─ Fee confirmation screen
  └─ RLP encoding + ECDSA signing
```

### Existing Contract Handlers (`ethereum_contracts.c`)

| Handler | File | Detection |
|---------|------|-----------|
| ShapeShift Salary | `saproxy.c` | `sa_isWithdrawFromSalary()` |
| 0x ERC-20 Transform | `zxtransERC20.c` | `zx_isZxTransformERC20()` |
| 0x Swap | `zxswap.c` | `zx_isZxSwap()` |
| 0x Liquidity | `zxliquidtx.c` | `zx_isZxLiquidTx()` |
| 0x Approve Liquidity | `zxappliquid.c` | `zx_isZxApproveLiquid()` |
| THORChain | `thortx.c` | `thor_isThorchainTx()` |
| MakerDAO | `makerdao.c` | `makerdao_isMakerDAO()` |

### ABI Parameter Parsing Pattern (all handlers use this)

```c
// Function selector: bytes 0-3
uint32_t selector = read_be(data_initial_chunk.bytes);

// Parameter N at offset 4 + N*32:
// Addresses: last 20 bytes of 32-byte field (skip first 12 zero bytes)
uint8_t *addr = data + 4 + N*32 + 12;

// Uint256: full 32 bytes, convert with bn_from_bytes()
bignum256 amount;
bn_from_bytes(data + 4 + N*32, 32, &amount);

// Format for display
char buf[40];
ethereumFormatAmount(&amount, tokenPtr, chainId, buf, sizeof(buf));
```

---

## Phase 2: New Protobuf Messages

### File: `projects/device-protocol/messages-ethereum.proto`

Add these new message types:

```protobuf
// Sent by host BEFORE EthereumSignTx to provide verified metadata
message EthereumTxMetadata {
    required bytes signed_payload = 1;    // Canonical binary (see format below)
    optional uint32 metadata_version = 2; // Schema version (start at 1)
    optional uint32 key_id = 3;           // Which embedded key to verify against (0-3)
}

// Device response after processing metadata
message EthereumMetadataAck {
    // Classification result
    required uint32 classification = 1;   // 0=OPAQUE, 1=VERIFIED, 2=MALFORMED
    optional string display_summary = 2;  // Brief summary for host logging
}
```

### Message Flow

```
HOST                                    DEVICE
  │                                       │
  ├─ EthereumTxMetadata ────────────────>│
  │    (signed_payload, key_id)          │
  │                                      ├─ Verify signature
  │                                      ├─ Store metadata temporarily
  │    <──────────── EthereumMetadataAck─┤
  │                  (classification)     │
  │                                       │
  ├─ EthereumSignTx ───────────────────>│
  │    (normal signing request)          │
  │                                      ├─ Match tx hash to stored metadata
  │                                      ├─ If VERIFIED: rich confirmation
  │                                      ├─ If OPAQUE: standard flow + warning
  │                                      ├─ If MALFORMED: reject
  │                                       │
  │    <──── EthereumTxRequest ──────────┤
  │         (signature_v, r, s)           │
```

---

## Phase 2: Canonical Binary Format

Deterministic serialization for the signed payload. Firmware must parse this efficiently (no JSON, no variable-length strings except method name).

```
Offset  Size    Field               Notes
──────  ──────  ──────────────────  ──────────────────────────
0       1       version             Always 0x01
1       4       chainId             Big-endian uint32
5       20      contractAddress     Raw 20-byte address
25      4       selector            Function selector bytes
29      32      txHash              Keccak-256 of unsigned RLP-encoded tx
61      2       methodNameLen       Big-endian uint16
63      var     methodName          UTF-8 (max 64 bytes)
var     1       numArgs             Number of decoded arguments (max 8)
  per arg:
  var   1       nameLen             Argument name length (max 32)
  var   var     name                UTF-8 argument name
  var   1       format              0=RAW, 1=ADDRESS, 2=AMOUNT, 3=BYTES
  var   2       valueLen            Big-endian uint16
  var   var     value               Raw bytes (address=20B, amount=32B, etc.)
var     1       classification      0=OPAQUE, 1=VERIFIED, 2=MALFORMED
var     4       timestamp           Big-endian uint32 (Unix seconds)
var     1       keyId               Which public key was used (0-3)
var     64      signature           ECDSA secp256k1 (r=32B || s=32B)
var     1       recovery            v value (27 or 28)
```

**Typical size**: 200-300 bytes for a 3-argument function call.

**Max size**: ~800 bytes (8 args with max-length names and values).

---

## Phase 3: Firmware Implementation

### New Files

| File | Purpose |
|------|---------|
| `include/keepkey/firmware/signed_metadata.h` | Public API |
| `lib/firmware/signed_metadata.c` | Binary parsing + signature verification + tx hash matching |
| `lib/firmware/signed_metadata_display.c` | Confirmation screen generation from verified metadata |

### `signed_metadata.h`

```c
#ifndef KEEPKEY_FIRMWARE_SIGNED_METADATA_H
#define KEEPKEY_FIRMWARE_SIGNED_METADATA_H

#include <stdint.h>
#include <stdbool.h>

#define METADATA_MAX_ARGS 8
#define METADATA_MAX_METHOD_LEN 64
#define METADATA_MAX_ARG_NAME_LEN 32
#define METADATA_MAX_ARG_VALUE_LEN 256
#define METADATA_MAX_KEYS 4

typedef enum {
    METADATA_OPAQUE = 0,
    METADATA_VERIFIED = 1,
    METADATA_MALFORMED = 2,
} MetadataClassification;

typedef enum {
    ARG_FORMAT_RAW = 0,
    ARG_FORMAT_ADDRESS = 1,
    ARG_FORMAT_AMOUNT = 2,
    ARG_FORMAT_BYTES = 3,
} ArgFormat;

typedef struct {
    char name[METADATA_MAX_ARG_NAME_LEN + 1];
    ArgFormat format;
    uint8_t value[METADATA_MAX_ARG_VALUE_LEN];
    uint16_t value_len;
} MetadataArg;

typedef struct {
    uint8_t version;
    uint32_t chain_id;
    uint8_t contract_address[20];
    uint8_t selector[4];
    uint8_t tx_hash[32];
    char method_name[METADATA_MAX_METHOD_LEN + 1];
    uint8_t num_args;
    MetadataArg args[METADATA_MAX_ARGS];
    MetadataClassification classification;
    uint32_t timestamp;
    uint8_t key_id;
    uint8_t signature[64];
    uint8_t recovery;
} SignedMetadata;

// State management
bool signed_metadata_available(void);
void signed_metadata_clear(void);

// Process incoming metadata message
MetadataClassification signed_metadata_process(
    const uint8_t *payload,
    size_t payload_len,
    uint8_t key_id
);

// Verify metadata matches transaction being signed
bool signed_metadata_matches_tx(const uint8_t *tx_hash);

// Display rich confirmation screens from verified metadata
bool signed_metadata_confirm(void);

// Get stored metadata (for logging/debugging)
const SignedMetadata *signed_metadata_get(void);

#endif
```

### Key Implementation Details

#### 1. Signature Verification

```c
// Embedded public keys (compile-time constants)
static const uint8_t METADATA_PUBKEYS[METADATA_MAX_KEYS][33] = {
    // Key 0: Production metadata signing key
    { 0x02, /* ... 32 bytes of compressed pubkey ... */ },
    // Key 1: Backup/rotation key
    { 0x02, /* ... */ },
    // Key 2-3: Reserved for future use
    { 0x00 },
    { 0x00 },
};

MetadataClassification signed_metadata_process(
    const uint8_t *payload, size_t payload_len, uint8_t key_id)
{
    // 1. Bounds check
    if (key_id >= METADATA_MAX_KEYS) return METADATA_MALFORMED;
    if (METADATA_PUBKEYS[key_id][0] == 0x00) return METADATA_MALFORMED;

    // 2. Parse binary format into SignedMetadata struct
    if (!parse_metadata_binary(payload, payload_len, &stored_metadata))
        return METADATA_MALFORMED;

    // 3. Compute SHA-256 of payload (everything before signature)
    uint8_t hash[32];
    size_t signed_len = payload_len - 65; // 64B sig + 1B recovery
    sha256_Raw(payload, signed_len, hash);

    // 4. Verify ECDSA signature against embedded public key
    if (ecdsa_verify_digest(&secp256k1, METADATA_PUBKEYS[key_id],
                            stored_metadata.signature,
                            hash) != 0) {
        signed_metadata_clear();
        return METADATA_MALFORMED;
    }

    // 5. Check timestamp freshness (reject if older than 5 minutes)
    // Note: firmware doesn't have real-time clock, but host provides
    // timestamp and firmware can compare against its own monotonic counter
    // if available, or skip this check in v1.

    stored_metadata.classification = METADATA_VERIFIED;
    metadata_available = true;
    return METADATA_VERIFIED;
}
```

#### 2. Transaction Hash Binding

```c
bool signed_metadata_matches_tx(const uint8_t *tx_hash)
{
    if (!metadata_available) return false;
    return memcmp(stored_metadata.tx_hash, tx_hash, 32) == 0;
}
```

This is called during `ethereum_signing_init()` AFTER the transaction hash is computed but BEFORE the confirmation screens.

#### 3. Rich Confirmation Screens

```c
bool signed_metadata_confirm(void)
{
    if (!metadata_available) return false;

    // Screen 1: dApp + method
    char title[80];
    snprintf(title, sizeof(title), "%s", stored_metadata.method_name);

    // Screen 2: Contract address (checksummed)
    char addr_display[43];
    ethereum_address_checksum(stored_metadata.contract_address,
                              addr_display, false,
                              stored_metadata.chain_id);

    if (!confirm(ButtonRequestType_ButtonRequest_ConfirmOutput,
                 title, "Contract:\n%s", addr_display)) {
        return false;
    }

    // Screen 3+: Each argument
    for (int i = 0; i < stored_metadata.num_args; i++) {
        MetadataArg *arg = &stored_metadata.args[i];
        char value_display[80];

        switch (arg->format) {
            case ARG_FORMAT_ADDRESS: {
                ethereum_address_checksum(arg->value, value_display,
                                         false, stored_metadata.chain_id);
                break;
            }
            case ARG_FORMAT_AMOUNT: {
                bignum256 bn;
                bn_from_bytes(arg->value, arg->value_len, &bn);
                // Note: without token info, display raw wei
                // Future: metadata could include decimals
                bn_format(&bn, NULL, NULL, 0, 0, false,
                          value_display, sizeof(value_display));
                break;
            }
            default:
                // Hex display for raw/bytes
                data2hex(arg->value, MIN(arg->value_len, 32),
                         value_display);
                break;
        }

        if (!confirm(ButtonRequestType_ButtonRequest_ConfirmOutput,
                     stored_metadata.method_name,
                     "%s:\n%s", arg->name, value_display)) {
            return false;
        }
    }

    return true;
}
```

#### 4. Integration into Signing Flow (`ethereum.c`)

Modify `ethereum_signing_init()` around line 681-690:

```c
// ── NEW: Signed metadata path (backwards compatible) ──
if (signed_metadata_available()) {
    // Verify metadata binds to this exact transaction
    if (signed_metadata_matches_tx(computed_tx_hash)) {
        const SignedMetadata *meta = signed_metadata_get();
        if (meta->classification == METADATA_VERIFIED) {
            // Rich confirmation from verified metadata
            if (!signed_metadata_confirm()) {
                fsm_sendFailure(FailureType_Failure_ActionCancelled,
                                "Transaction cancelled");
                ethereum_signing_abort();
                return;
            }
            needs_confirm = false;
            data_needs_confirm = false;
        }
        // else: fall through to existing flow (OPAQUE treated as unverified)
    } else {
        // Metadata doesn't match tx — treat as suspicious
        // Show warning but don't block (backwards compat)
        layoutDialog(
            &bmp_icon_warning, _("Cancel"), _("Continue"),
            NULL, _("Transaction metadata"), _("does not match."),
            _("Proceed with"), _("standard review."), NULL, NULL);
        if (!protectButton(ButtonRequestType_ButtonRequest_Other, false)) {
            fsm_sendFailure(FailureType_Failure_ActionCancelled, NULL);
            ethereum_signing_abort();
            return;
        }
    }
    signed_metadata_clear(); // Always clear after use
}

// ── EXISTING: Hardcoded contract handlers (unchanged) ──
if (ethereum_contractHandled(data_total, msg, node)) {
    if (!ethereum_contractConfirmed(data_total, msg, node)) {
        // ...
    }
}
```

#### 5. FSM Message Handler (`fsm_msg_ethereum.h`)

Add handler for the new `EthereumTxMetadata` message:

```c
void fsm_msgEthereumTxMetadata(const EthereumTxMetadata *msg)
{
    CHECK_INITIALIZED
    CHECK_PIN

    MetadataClassification result = signed_metadata_process(
        msg->signed_payload.bytes,
        msg->signed_payload.size,
        msg->has_key_id ? msg->key_id : 0
    );

    RESP_INIT(EthereumMetadataAck);
    resp->classification = result;

    switch (result) {
        case METADATA_VERIFIED:
            resp->has_display_summary = true;
            strlcpy(resp->display_summary, "Verified", sizeof(resp->display_summary));
            break;
        case METADATA_OPAQUE:
            resp->has_display_summary = true;
            strlcpy(resp->display_summary, "Unverified", sizeof(resp->display_summary));
            break;
        case METADATA_MALFORMED:
            resp->has_display_summary = true;
            strlcpy(resp->display_summary, "Invalid metadata", sizeof(resp->display_summary));
            break;
    }

    msg_write(MessageType_MessageType_EthereumMetadataAck, resp);
}
```

---

## Phase 2: Signing Service (Host-Side)

### File: `projects/pioneer/services/pioneer-server/src/services/descriptor-signing.service.ts`

The host-side signing service:

1. Receives `{txHash, networkId, contractAddress, data}` from vault
2. Looks up descriptor from MongoDB
3. Decodes calldata using ethers.js
4. Serializes to canonical binary format
5. Signs with metadata private key (HSM-protected)
6. Returns `SignedDescriptor` envelope

### Key Management

- **Production key**: secp256k1 keypair, private key in HSM
- **Public key**: Embedded in firmware at compile time
- **Key rotation**: `keyId` field supports 4 keys (0-3)
- **Published**: Public key on KeepKey GitHub for community verification

### Security Properties

1. **Transaction binding**: Metadata includes `txHash` — changing any tx byte invalidates signature
2. **No replay**: Each metadata blob is unique to one transaction
3. **No MITM**: Firmware verifies signature against embedded key
4. **Graceful degradation**: Invalid/missing metadata falls back to existing flow

---

## Phase 3: Host-Side Protocol Changes

### File: `projects/hdwallet/packages/hdwallet-keepkey/src/ethereum.ts`

Modify `ethSignTx()` to:

1. Check firmware version supports metadata (feature flag in `Features` message)
2. If supported and calldata present:
   a. Compute unsigned tx hash
   b. Call Pioneer `POST /descriptors/sign` with `{txHash, networkId, contractAddress, data}`
   c. If response contains signed metadata:
      - Send `EthereumTxMetadata` message
      - Wait for `EthereumMetadataAck`
      - If MALFORMED, log warning but continue (host-side display still works)
3. Proceed with normal `EthereumSignTx` flow

```typescript
export async function ethSignTx(transport: Transport, msg: core.ETHSignTx): Promise<core.ETHSignedTx> {
    // NEW: Send metadata if firmware supports it
    if (msg.data && msg.data.length > 2 && transport.supportsFeature('txMetadata')) {
        try {
            const txHash = computeUnsignedTxHash(msg)
            const metadata = await fetchSignedMetadata(txHash, msg.chainId, msg.to, msg.data)
            if (metadata) {
                const metaMsg = new Ethereum.EthereumTxMetadata()
                metaMsg.setSignedPayload(metadata.signedPayload)
                metaMsg.setMetadataVersion(1)
                metaMsg.setKeyId(metadata.keyId)

                const ack = await transport.call(
                    Messages.MessageType.MESSAGETYPE_ETHEREUMTXMETADATA,
                    metaMsg,
                    { msgTimeout: 5000 }
                )
                // Log classification but don't block on OPAQUE/MALFORMED
                console.log(`Metadata classification: ${ack.getClassification()}`)
            }
        } catch (e) {
            // Non-fatal: firmware will use existing confirmation flow
            console.warn('Metadata delivery failed, continuing with standard signing:', e)
        }
    }

    // EXISTING: Normal signing flow (unchanged)
    const est = new Ethereum.EthereumSignTx()
    // ... rest of existing implementation ...
}
```

---

## Testing Plan

### Phase 2 Testing (Signing Service)

1. Generate test keypair: `openssl ecparam -name secp256k1 -genkey -noout -out test_metadata_key.pem`
2. Sign a test descriptor for Aave supply (selector `0x617ba037`)
3. Verify signature round-trips: serialize → sign → verify → parse
4. Test transaction binding: change one tx byte → signature must fail
5. Test binary format: ensure firmware-compatible byte layout

### Phase 3 Testing (Firmware)

**Unit tests** (can run on emulator):
1. Parse valid canonical binary → verify all fields extracted correctly
2. Parse truncated binary → must return MALFORMED
3. Verify signature with embedded test key → VERIFIED
4. Verify signature with wrong key → MALFORMED
5. Matching tx hash → `signed_metadata_matches_tx()` returns true
6. Non-matching tx hash → returns false
7. Stale metadata (if timestamp check enabled) → OPAQUE or MALFORMED

**Integration tests** (requires device):
1. Send `EthereumTxMetadata` + `EthereumSignTx` for a known Aave contract call
2. Device should display: "supply" + contract address + decoded arguments
3. Approve → valid signature returned
4. Reject → ActionCancelled returned
5. Send `EthereumSignTx` WITHOUT metadata → existing flow (backwards compat)
6. Send metadata with invalid signature → device shows standard warning, not rich display
7. Send metadata for wrong transaction → device warns about mismatch

**Regression tests**:
1. ERC-20 transfer still works (no metadata needed)
2. THORChain handler still works (native parsing takes priority)
3. MakerDAO handler still works
4. "Advanced mode" gate still works for unknown contracts without metadata

---

## Implementation Order

### Week 1-2: Protobuf + Binary Format
- [ ] Add `EthereumTxMetadata` and `EthereumMetadataAck` to `messages-ethereum.proto`
- [ ] Implement canonical binary serialization in TypeScript (for signing service)
- [ ] Implement canonical binary parser in C (for firmware)
- [ ] Unit tests for serialization round-trip

### Week 3-4: Firmware Verification
- [ ] Implement `signed_metadata.c` (parse + verify)
- [ ] Embed test public key in firmware
- [ ] Implement FSM handler `fsm_msgEthereumTxMetadata`
- [ ] Unit tests on emulator

### Week 5-6: Firmware Display
- [ ] Implement `signed_metadata_display.c` (confirmation screens)
- [ ] Integrate into `ethereum_signing_init()` flow
- [ ] Test with real device + test signing key

### Week 7-8: Host Integration + Signing Service
- [ ] Implement `descriptor-signing.service.ts` in Pioneer
- [ ] Generate production keypair (HSM)
- [ ] Modify hdwallet `ethSignTx()` to send metadata
- [ ] End-to-end test: vault → Pioneer → device → rich display

---

## File Reference

| File | Status | Purpose |
|------|--------|---------|
| `projects/device-protocol/messages-ethereum.proto` | **MODIFY** | Add EthereumTxMetadata + EthereumMetadataAck |
| `projects/keepkey-firmware/include/keepkey/firmware/signed_metadata.h` | **CREATE** | Public API for metadata system |
| `projects/keepkey-firmware/lib/firmware/signed_metadata.c` | **CREATE** | Binary parsing + signature verification |
| `projects/keepkey-firmware/lib/firmware/signed_metadata_display.c` | **CREATE** | Rich confirmation screen generation |
| `projects/keepkey-firmware/lib/firmware/ethereum.c` | **MODIFY** | ~10 lines at line 681 to check metadata first |
| `projects/keepkey-firmware/lib/firmware/fsm_msg_ethereum.h` | **MODIFY** | Add fsm_msgEthereumTxMetadata handler |
| `projects/hdwallet/packages/hdwallet-keepkey/src/ethereum.ts` | **MODIFY** | Send metadata before signing |
| `projects/pioneer/services/pioneer-server/src/services/descriptor-signing.service.ts` | **CREATE** | Host-side metadata signing service |
| `projects/pioneer/services/pioneer-server/src/controllers/descriptors.controller.ts` | **MODIFY** | Add POST /descriptors/sign endpoint |

---

## Security Checklist

- [ ] No host-provided text displayed without signature verification
- [ ] Transaction hash computed on device, not trusted from host
- [ ] Metadata signature verified against compile-time embedded key
- [ ] All constraints checked against actual transaction bytes
- [ ] Invalid/expired metadata falls back to existing flow (never blocks)
- [ ] Metadata buffer cleared after each use (no stale data)
- [ ] Binary parser has strict bounds checking (no buffer overflows)
- [ ] Key rotation supported (4 key slots)
- [ ] Test key cannot be used in production builds (`#ifdef DEBUG_BUILD`)
