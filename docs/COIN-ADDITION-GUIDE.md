# Adding a New Coin/Chain to KeepKey

End-to-end guide for adding a new cryptocurrency to the KeepKey stack: firmware through frontend.

## Overview

Adding a coin touches 5 layers. Each layer must be completed before the next can use it.

```
Layer 1: Firmware (C, embedded)          → Device can handle the coin's messages
Layer 2: hdwallet (TypeScript, npm)      → App can talk to the device about the coin
Layer 3: REST API (Bun, TypeScript)      → External apps can use the coin via HTTP
Layer 4: Frontend (React, TypeScript)    → Desktop app shows the coin in UI
Layer 5: CLI (Bun, TypeScript)           → CLI tool can derive addresses / sign
```

---

## Layer 1: Firmware

**Where:** `modules/keepkey-firmware/` + `modules/device-protocol/`

### 1.1 Define Protobuf Messages

**File:** `modules/device-protocol/messages-<coin>.proto`

Every coin needs at least:
- `<Coin>GetAddress` — request message with address_n path
- `<Coin>Address` — response message with address string
- `<Coin>SignTx` — request message with transaction details
- `<Coin>SignedTx` — response with signature

```protobuf
// Example: messages-solana.proto
message SolanaGetAddress {
    repeated uint32 address_n = 1;
    optional bool show_display = 2;
}
message SolanaAddress {
    optional string address = 1;
}
message SolanaSignTx {
    repeated uint32 address_n = 1;
    optional bytes raw_tx = 2;
}
message SolanaSignedTx {
    optional bytes signature = 1;
}
```

### 1.2 Register Message Types

**File:** `modules/device-protocol/messages.proto`

Add entries to the `MessageType` enum:
```protobuf
MESSAGETYPE_SOLANAGETADDRESS = 900;
MESSAGETYPE_SOLANAADDRESS = 901;
MESSAGETYPE_SOLANASIGNTX = 902;
MESSAGETYPE_SOLANASIGNEDTX = 903;
```

### 1.3 Add Message Mapping

**File:** `modules/keepkey-firmware/lib/firmware/messagemap.def`

Map message types to handler functions:
```c
MDEF(MessageType_SolanaGetAddress, SolanaGetAddress, fsm_msgSolanaGetAddress)
MDEF(MessageType_SolanaSignTx,     SolanaSignTx,     fsm_msgSolanaSignTx)
```

### 1.4 Implement FSM Handlers

**File:** `modules/keepkey-firmware/lib/firmware/fsm_msg_<coin>.h`

```c
void fsm_msgSolanaGetAddress(const SolanaGetAddress *msg) {
    // 1. Validate path (address_n)
    // 2. Derive keypair using coin's curve (ed25519 for Solana)
    // 3. Compute address from public key
    // 4. If show_display: render address on OLED, wait for button confirm
    // 5. Send SolanaAddress response
}
```

### 1.5 Implement Crypto Functions

**Files:**
- `modules/keepkey-firmware/lib/firmware/<coin>.c`
- `modules/keepkey-firmware/include/keepkey/firmware/<coin>.h`

Key functions needed:
- Address derivation from public key
- Transaction serialization (if firmware signs raw bytes, this may be minimal)
- Address validation / checksum

### 1.6 Update Build System

**File:** `modules/keepkey-firmware/lib/firmware/CMakeLists.txt`

Add the new `.c` source file to the build.

### 1.7 (UTXO coins only) Add to coins.def

**File:** `modules/keepkey-firmware/include/keepkey/firmware/coins.def`

For Bitcoin-like coins, add the coin definition with network parameters.

### 1.8 Build & Flash

```bash
make firmware-build                  # Build via Docker
make firmware-flash FW_PATH=<bin>    # Flash to device in bootloader mode
```

---

## Layer 2: hdwallet

**Where:** `modules/hdwallet/`

### 2.1 Add Message Types to Core

**File:** `modules/hdwallet/packages/hdwallet-core/src/`

- Add TypeScript interfaces: `SolanaGetAddress`, `SolanaSignTx`, `SolanaSignedTx`
- Add to wallet interface: `solanaGetAddress(params)`, `solanaSignTx(params)`

### 2.2 Implement KeepKey Support

**File:** `modules/hdwallet/packages/hdwallet-keepkey/src/`

- Implement `solanaGetAddress()` — encode protobuf, send to device, decode response
- Implement `solanaSignTx()` — encode transaction, send, decode signature

### 2.3 Build

```bash
cd modules/hdwallet && yarn build
```

The vault and CLI link to hdwallet via `file:` references in `package.json`, so rebuilding hdwallet makes the new methods available immediately.

---

## Layer 3: REST API

**Where:** `projects/keepkey-vault/src/bun/rest-api.ts`

### 3.1 Add Endpoints

```typescript
// GET /api/v1/solana/address
router.get('/api/v1/solana/address', async (req) => {
    const wallet = requireWallet(engine)
    const result = await wallet.solanaGetAddress({
        addressNList: [0x8000002C, 0x800001F5, 0x80000000],
        showDisplay: false,
    })
    return json({ address: result })
})

// POST /api/v1/solana/sign-transaction
router.post('/api/v1/solana/sign-transaction', async (req) => {
    const wallet = requireWallet(engine)
    const body = await req.json()
    const result = await wallet.solanaSignTx(body)
    return json(result)
})
```

### 3.2 Add Zod Schemas

**File:** `projects/keepkey-vault/src/bun/schemas.ts`

Add request/response schemas for validation.

### 3.3 Update Swagger Spec

Add the new endpoints to the OpenAPI schema.

---

## Layer 4: Frontend

**Where:** `projects/keepkey-vault/src/mainview/`

### 4.1 Add Chain Definition

**File:** `projects/keepkey-vault/src/shared/chains.ts`

```typescript
{ id: 'solana', coin: 'Solana', symbol: 'SOL', chainFamily: 'solana',
  defaultPath: [0x8000002C, 0x800001F5, 0x80000000],
  rpcMethod: 'solanaGetAddress', caip: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  networkId: 'solana:mainnet' }
```

### 4.2 Add UI Components

- Address display in the addresses view
- Send form with coin-specific fields
- Portfolio row showing balance

### 4.3 Add RPC Method

**File:** `projects/keepkey-vault/src/shared/rpc-schema.ts`

Register `solanaGetAddress` and `solanaSignTx` in the RPC schema.

---

## Layer 5: CLI

**Where:** `projects/keepkey-cli/`

### 5.1 Add Address Entry

**File:** `projects/keepkey-cli/src/commands/address.ts`

Add the coin to the `COINS` map with correct path, method, and curve.

### 5.2 (Optional) Add Coin-Specific Command

**File:** `projects/keepkey-cli/src/commands/<coin>.ts`

For coins with special workflows (e.g., Zcash shielded transactions).

### 5.3 Register in Router

**File:** `projects/keepkey-cli/src/index.ts`

Add the new command to the switch statement.

---

## Checklist

```
- [ ] Firmware: protobuf messages defined (messages-<coin>.proto)
- [ ] Firmware: message types registered (messages.proto enum)
- [ ] Firmware: message map entries (messagemap.def)
- [ ] Firmware: FSM handlers implemented (fsm_msg_<coin>.h)
- [ ] Firmware: crypto functions (address derivation, signing)
- [ ] Firmware: CMakeLists.txt updated
- [ ] Firmware: built and flashed to device
- [ ] hdwallet: TypeScript interfaces in hdwallet-core
- [ ] hdwallet: KeepKey implementation in hdwallet-keepkey
- [ ] hdwallet: built successfully
- [ ] REST API: GET /address endpoint
- [ ] REST API: POST /sign-transaction endpoint
- [ ] REST API: Zod schemas + Swagger
- [ ] Frontend: chain definition in chains.ts
- [ ] Frontend: RPC schema updated
- [ ] Frontend: UI components (address, send, portfolio)
- [ ] CLI: address command entry
- [ ] Tests: address derivation verified
- [ ] Tests: transaction signing verified
```
