# Adding a New Coin/Chain to KeepKey

End-to-end guide for adding a new cryptocurrency to the KeepKey stack: firmware through frontend.
Updated with lessons from Hive integration (May 2026).

## Overview

Adding a coin touches 6 layers. Each must be done in order.

```
Layer 0: device-protocol (proto)         → Wire messages between device and SDK
Layer 1: Firmware (C, embedded)          → Device can handle the coin's messages
Layer 2: hdwallet (TypeScript, npm)      → App can talk to the device about the coin
Layer 3: Pioneer (backend service)       → Balance fetch, broadcast, CAIP metadata
Layer 4: Vault chains.ts + REST API      → Vault shows the asset, REST callers can use it
Layer 5: Frontend (React)                → Dashboard card, asset page, send flow
```

---

## Layer 0: device-protocol

**Where:** `modules/device-protocol/` (on a feature branch, e.g. `feature/hive`)

### 0.1 Add `.proto` file

Create `messages-<chain>.proto`. Use `proto2` syntax. Minimum messages:
- `<Chain>GetPublicKey` / `<Chain>GetAddress` — request with `address_n`
- `<Chain>PublicKey` / `<Chain>Address` — response
- `<Chain>SignTx` — request with transaction fields
- `<Chain>SignedTx` — response with signature (and optionally serialized bytes)

**Hive note:** Hive uses `publicKey` (STM-prefixed base58) rather than `address` in the
response. Anything that extracts addresses generically must handle this — see Layer 4.

### 0.2 Register message types in `messages.proto`

Add entries to the `MessageType` enum (use wire IDs from the firmware PR):
```protobuf
MESSAGETYPE_HIVEGETPUBLICKEY = 1600;
MESSAGETYPE_HIVEPUBLICKEY    = 1601;
MESSAGETYPE_HIVESIGNTX       = 1602;
MESSAGETYPE_HIVESIGNEDTX     = 1603;
```

### 0.3 Add to `build:js` in `package.json`

Add `messages-<chain>.proto` to the `protoc` command in `build:js`. **Do NOT** add it to
`build:json` — `pbjs` v0.0.5 (used by `build:json`) cannot parse `reserved` fields that
appear in many proto files, and `proto.json` is unused by the vault. The `build:json` step
is kept in the file but excluded from the `build` script chain.

```json
"build": "npm run build:js && npm run build:postprocess",
"build:js": "protoc ... messages-ton.proto messages-zcash.proto messages-hive.proto",
```

### 0.4 Commit and push to the feature branch

```bash
cd modules/device-protocol
git add package.json package-lock.json yarn.lock
git commit -m "feat(hive): add messages-hive.proto to build"
git push origin feature/hive
```

Then update the submodule pointer in the main repo.

---

## Layer 1: Firmware

**Where:** `modules/keepkey-firmware/` (feature branch)

### 1.1 Implement crypto + FSM handler

- `lib/firmware/<chain>.c` — key derivation, serialization
- `lib/firmware/fsm_msg_<chain>.h` — handler for GetPublicKey and SignTx
- `include/keepkey/firmware/<chain>.h` — public header
- `lib/firmware/CMakeLists.txt` — add source file
- `lib/firmware/messagemap.def` — add MDEF entries
- `lib/firmware/fsm.h` — add forward declarations for every handler

**Common mistake:** forgetting the forward decl in `fsm.h` causes a silent link error.

### 1.2 (UTXO coins only) Add to `coins.def`

For Bitcoin-like coins, add the coin definition with network parameters.

### 1.3 Build and flash

```bash
# From the firmware submodule
cmake .. -DKK_EMULATOR=OFF && make -j$(nproc)
# Flash via bootloader or python-keepkey
```

---

## Layer 2: hdwallet

**Where:** `modules/hdwallet/packages/`

### 2.1 Add TypeScript interfaces (`hdwallet-core`)

**File:** `packages/hdwallet-core/src/<chain>.ts`

Define `<Chain>GetPublicKeyParams`, `<Chain>PublicKey`, `<Chain>SignTxParams`, `<Chain>SignedTx`.
Export from `packages/hdwallet-core/src/index.ts`.

### 2.2 Implement KeepKey adapter (`hdwallet-keepkey`)

**File:** `packages/hdwallet-keepkey/src/<chain>.ts`

- Load the protobuf message from `@keepkey/device-protocol/lib/messages-<chain>_pb`
- Encode params → protobuf, send via transport, decode response
- Handle bytes ↔ Uint8Array conversions carefully

**File:** `packages/hdwallet-keepkey/src/keepkey.ts`

Wire the new methods: `hiveGetPublicKey`, `hiveSignTx` added to the HDWallet class.

### 2.3 Build

```bash
cd modules/hdwallet && yarn build
```

The vault and CLI link to hdwallet via `file:` references, so a rebuild makes new methods available immediately.

---

## Layer 3: Pioneer

**Where:** Pioneer monorepo (`coinmastersguild/pioneer`)

Pioneer needs changes before the vault can show balances. These can be done in parallel with
vault work but must be deployed before balances appear.

### 3.1 CAIP mappings (`pioneer-caip`)

**File:** `modules/pioneer/pioneer-caip/src/data.ts`

Add to `Chain` enum, `ChainToNetworkId`, `ChainToCaip`, `BaseDecimal`:
```typescript
Chain.Hive = 'HIVE'
ChainToNetworkId['HIVE'] = 'hive:beeab0de'
ChainToCaip['HIVE'] = 'hive:beeab0de/slip44:1275'
BaseDecimal['HIVE'] = 3
```

Also update `supported-caips.ts`, `pioneer-coins/src/paths.ts`, `pioneer-types`.

### 3.2 Balance fetch (`pioneer-balance`)

Add a `case 'HIVE':` handler. Hive requires two RPC calls:
1. `condenser_api.get_key_references([[pubkey]])` → account name(s)
2. `condenser_api.get_accounts([[accountName]])` → balance

A freshly-derived key with no on-chain account returns balance `'0'` (not an error).

### 3.3 Broadcast (`pioneer-server`)

Add a Hive case in `broadcast.controller.ts` routing to
`condenser_api.broadcast_transaction` (use `anyx.io` as fallback node).

### 3.4 Until Pioneer packages are published

The vault's `chains.ts` uses a fallback pattern (same as GNO/TRX/TON). Add entries to:
```typescript
const CAIP_FALLBACKS: Record<string, string> = { ..., HIVE: 'hive:beeab0de/slip44:1275' }
const NETWORKID_FALLBACKS: Record<string, string> = { ..., HIVE: 'hive:beeab0de' }
const DECIMAL_FALLBACKS: Record<string, number> = { ..., HIVE: 3 }
```
This lets the vault show the asset card and derive the key even before pioneer-caip is
published to npm.

---

## Layer 4: Vault chains.ts + REST API

**Where:** `projects/keepkey-vault/src/`

### 4.1 Extend `chainFamily` union (`shared/chains.ts`)

```typescript
chainFamily: 'utxo' | 'evm' | 'cosmos' | 'xrp' | 'solana' | 'zcash-shielded' | 'tron' | 'ton' | 'hive'
```

### 4.2 Add entry to `CONFIGS` array (`shared/chains.ts`)

```typescript
{
  id: 'hive', chain: 'HIVE' as any, coin: 'Hive', symbol: 'HIVE',
  chainFamily: 'hive', color: '#E31337',
  rpcMethod: 'hiveGetPublicKey', signMethod: 'hiveSignTx',
  defaultPath: [0x8000002C, 0x800004FB, 0x80000000, 0, 0],  // m/44'/1275'/0'/0/0
  explorerAddressUrl: 'https://hiveblocks.com/@{{address}}',
  explorerTxUrl: 'https://hiveblocks.com/tx/{{txid}}',
  minFirmware: '7.14.0',
},
```

**`minFirmware` gate:** chains with this set are excluded from `supportedChains` when no
device is connected. This is expected. Once a device with firmware >= the gate is connected,
they appear automatically.

### 4.3 Fix address extraction if response field is non-standard (`bun/index.ts`)

The generic `getBalances` loop extracts `result?.address`. For Hive, `hiveGetPublicKey`
returns `{ publicKey: 'STM...' }`, not `{ address: '...' }`. One-line fix:

```typescript
// before
const address = typeof result === 'string' ? result : result?.address || ''
// after
const address = typeof result === 'string' ? result : result?.address || result?.publicKey || ''
```

### 4.4 Add REST endpoint (`bun/rest-api.ts`)

Follow the pattern of `/addresses/ton`. For Hive, extract `result?.publicKey`:

```typescript
if (path === '/addresses/hive' && method === 'POST') {
  auth.requireAuth(req)
  const fwBlock = requireChainSupport('hive')
  if (fwBlock) return fwBlock
  const wallet = requireWallet(engine)
  const body = await parseRequest(req, S.AddressRequest)
  const cacheKey = scopedKey(engine, 'hive', body)
  const cached = addressCache.get(cacheKey)
  if (cached) return json({ address: cached })
  const sd = showDisplay(body.show_display)
  const result = await emuWrap(() => (wallet as any).hiveGetPublicKey({
    addressNList: body.address_n, showDisplay: sd, coin: 'Hive',
  }), { operation: 'hiveGetPublicKey', chain: 'HIVE' }, sd)
  const address = result?.publicKey || ''
  addressCache.set(cacheKey, address)
  auth.saveAccount(String(address), body.address_n)
  return json({ address })
}
```

### 4.5 Add swagger entry (`bun/swagger.json`)

Add under `/paths`, modeled on the `/addresses/ton` entry. Key differences:
- `operationId: "HiveGetPublicKey"` (not `GetAddress`)
- Example `address_n` uses decimal encoding of `m/44'/1275'/0'/0/0`:
  `[2147483692, 2147485179, 2147483648, 0, 0]`
- Note firmware requirement in description

### 4.6 Update Makefile

If the new chain requires a submodule build step not already in the Makefile, add a stamp:

```makefile
DEVICE_PROTOCOL_BUILD_STAMP := $(STAMP_DIR)/device-protocol-build.stamp
DEVICE_PROTOCOL_INPUTS := $(shell find modules/device-protocol -maxdepth 1 -name '*.proto' -o -name 'package.json' 2>/dev/null)

$(DEVICE_PROTOCOL_BUILD_STAMP): $(DEVICE_PROTOCOL_INPUTS) $(SUBMODULES_STAMP) | $(STAMP_DIR)
	@echo "=== device-protocol: installing + building ==="
	cd modules/device-protocol && npm install
	cd modules/device-protocol && npm run build
	@test -f modules/device-protocol/lib/messages_pb.js || (echo "ERROR: build failed"; exit 1)
	@touch $@
```

Wire into `$(VAULT_INSTALL_STAMP)` deps so `make dev` builds it automatically.

---

## API Verification Checkpoints

Run these after `make dev` to validate the integration. All tests require the vault
running on port 1646.

```bash
TOKEN=$(curl -s -X POST http://localhost:1646/auth/pair \
  -H "Content-Type: application/json" \
  -d '{"name":"api-test","imageUrl":"","features":[]}' | jq -r '.apiKey')
```

### Checkpoint 1: Chain appears in `supportedChains` (requires connected device)

```bash
curl -s http://localhost:1646/api/v1/health | jq '.supportedChains | map(select(test("hive")))'
# Expected: ["hive:beeab0de"]
# If empty: device not connected, or firmware < minFirmware
```

### Checkpoint 2: Address derivation

```bash
curl -s -X POST http://localhost:1646/addresses/hive \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"address_n":[2147483692,2147485179,2147483648,0,0],"show_display":false,"coin":"Hive"}'
# Expected: {"address":"STM6..."}
# If 404: vault build predates the endpoint — run make dev
# If firmware error: firmware doesn't support Hive (needs feature/hive fw)
```

### Checkpoint 3: Endpoint in swagger spec

```bash
curl -s http://localhost:1646/spec/swagger.json | jq '.paths | keys[] | select(test("hive"))'
# Expected: "/addresses/hive"
```

### Checkpoint 4: CAIP + networkId correct

```bash
curl -s http://localhost:1646/api/v1/health | jq '.supportedChains[] | select(test("hive"))'
# Expected: "hive:beeab0de"
```

### Checkpoint 5: Balance in portfolio (requires Pioneer with Hive support deployed)

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:1646/api/portfolio | \
  jq '[.devices[]?.balances[]? | select(.symbol == "HIVE")]'
# Expected: [{caip:"hive:beeab0de/slip44:1275", balance:"...", symbol:"HIVE"}]
# If []: Pioneer PR not yet deployed, or address not yet derived
```

### Checkpoint 6: `minFirmware` gate behavior

```bash
# With NO device connected:
curl -s http://localhost:1646/api/v1/health | jq '.supportedChains | map(select(test("hive")))'
# Expected: []  ← correct, gate requires firmware version

# With device connected (firmware >= 7.14.0):
# Expected: ["hive:beeab0de"]  ← appears
```

---

## Common Pitfalls

| Symptom | Root cause | Fix |
|---|---|---|
| `FATAL: messages_pb.js is MISSING` | device-protocol not built | `cd modules/device-protocol && npm install && npm run build` — or `make` picks it up via stamp |
| `build:json` fails with `Expected = but found 3` | `pbjs` v0.0.5 can't parse `reserved` fields | Exclude new proto from `build:json`; remove `build:json` from the `build` script chain |
| `result?.address` is `undefined` | Chain returns `publicKey` not `address` | Add `result?.publicKey` fallback in `getBalances` loop |
| Chain not in `supportedChains` with device connected | `minFirmware` too high or firmware doesn't include the feature | Check device firmware version; ensure feature branch flashed |
| `/addresses/<chain>` returns 404 | REST endpoint added but vault not rebuilt | `make dev` |
| Chain in `supportedChains` but no balance | Pioneer not deployed with balance support | Deploy Pioneer with the chain's balance handler |
| Balance always `0` for fresh key | Hive key has no on-chain account yet | Expected — Hive accounts must be created externally |
| `Chain.Hive is not a value` TypeScript error | pioneer-caip doesn't export it yet | Use `'HIVE' as any` + CAIP/networkId/decimal fallbacks |

---

## Checklist

### device-protocol
- [ ] `messages-<chain>.proto` created with GetPublicKey/Address + SignTx/SignedTx
- [ ] Wire IDs registered in `messages.proto` MessageType enum
- [ ] Added to `build:js` in `package.json` (NOT `build:json`)
- [ ] Committed and pushed to feature branch
- [ ] Submodule pointer updated in vault repo

### Firmware
- [ ] Crypto functions implemented (`<chain>.c`)
- [ ] FSM handlers implemented (`fsm_msg_<chain>.h`)
- [ ] Forward declarations added to `fsm.h`
- [ ] `messagemap.def` updated
- [ ] `CMakeLists.txt` updated
- [ ] Built and flashed to device

### hdwallet
- [ ] TypeScript interfaces in `hdwallet-core/src/<chain>.ts`
- [ ] Exported from `hdwallet-core/src/index.ts`
- [ ] KeepKey implementation in `hdwallet-keepkey/src/<chain>.ts`
- [ ] Wired into `hdwallet-keepkey/src/keepkey.ts`
- [ ] `yarn build` passes

### Pioneer
- [ ] `Chain.<X>` added to `pioneer-caip` with CAIP, networkId, decimals
- [ ] BIP44 path added to `pioneer-coins`
- [ ] Balance handler added to `pioneer-balance`
- [ ] Broadcast handler added to `pioneer-server`
- [ ] PR merged and deployed

### Vault — chains.ts
- [ ] `chainFamily` union extended
- [ ] CONFIGS entry added (id, chain, coin, symbol, chainFamily, color, rpcMethod, signMethod, defaultPath, minFirmware, explorerUrls)
- [ ] CAIP/networkId/decimal fallbacks added (until pioneer-caip published)

### Vault — index.ts
- [ ] Address extraction handles non-standard return field (e.g., `publicKey`)

### Vault — REST API
- [ ] `/addresses/<chain>` endpoint in `rest-api.ts`
- [ ] Entry in `swagger.json`

### Vault — build
- [ ] Makefile device-protocol build stamp present (if needed)
- [ ] `make dev` succeeds clean

### API verification (all pass before marking done)
- [ ] CP1: `hive:beeab0de` in `supportedChains` (with device)
- [ ] CP2: `/addresses/hive` returns `STM6...` key
- [ ] CP3: Endpoint in swagger `/spec/swagger.json`
- [ ] CP4: CAIP `hive:beeab0de` correct
- [ ] CP5: Portfolio shows HIVE balance (after Pioneer deployed)
- [ ] CP6: `minFirmware` gate excludes chain when no device connected
