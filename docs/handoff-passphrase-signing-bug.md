# HANDOFF — passphrase (hidden) wallet produces invalid Ethereum signatures

**Severity: P0 / launch-blocking.** A funded production KeepKey **BIP39-passphrase (hidden) wallet cannot produce a valid Ethereum signature**. `GetAddress` under the passphrase returns the correct, stable hidden-wallet address, but every `SignTx` under the same passphrase returns an `(r,s,v)` that recovers to a *different garbage address per transaction digest*. The no-passphrase wallet on the same device signs and broadcasts flawlessly. This blocks a real mainnet token launch: the production passphrase wallet that owns the deployment cannot sign. Address (pubkey) derivation under the passphrase works; **signing under the passphrase is broken**, and the corruption is digest-dependent — which narrows the fault to either the device's passphrase signing path or a host-side preimage/transport divergence that only the passphrase flow exercises. A single already-wired diagnostic (the device echoes the digest it signed in `EthereumTxRequest.hash`) settles host-vs-firmware definitively; instructions are in §8.

---

## 1. Summary

A KeepKey hidden (BIP39-passphrase) wallet derives the **correct** Ethereum address but emits **cryptographically invalid** Ethereum signatures. The same device, same code path, with no passphrase, signs perfectly and has broadcast 8+ confirmed mainnet/testnet transactions. The defect is isolated to the passphrase wallet's signing operation. Because the recovered signer changes with each transaction digest (rather than being one constant wrong address), this is **not** the textbook "device fell back to the no-passphrase seed" bug. It is one of: (a) a firmware passphrase/seed-selection or digest-handling bug on the SignTx path, or (b) a host preimage/serialization/transport divergence that only the passphrase flow triggers. The evidence below, plus the single decisive test in §8, pin which.

---

## 2. Symptom & evidence

Running build under test: **Vault REST API on `localhost:1646`**, build = `keepkey-vault-v11/projects/keepkey-vault/_build/dev-macos-arm64`. This is the **Vault host middleware**, not firmware — the firmware runs on the device.

Path under test: **`m/44'/60'/0'/0/0`** = `addressNList [2147483692, 2147483708, 2147483648, 0, 0]`.

| Operation | Wallet | Chain / tx | Result | Recovered signer |
|---|---|---|---|---|
| `POST /addresses/eth` | **passphrase** | — | **CORRECT, stable, repeatable** | **`0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e`** |
| `POST /eth/sign-transaction` | passphrase | mainnet (chainId 8453), GOLDToken deploy, 3484B calldata | invalid | `0xef115ddc…02b` (deterministic for that tx, twice) |
| `POST /eth/sign-transaction` | passphrase | Sepolia (84532), same deploy | invalid | `0xa8b3…21a` |
| `POST /eth/sign-transaction` | passphrase | Sepolia (84532), tiny self-send (0 calldata, 21000 gas) | invalid | `0x6d7f…883` |
| `POST /eth/sign-transaction` | **no-passphrase** `0x141D9959…` | Sepolia: GOLDToken deploy, AMMRouter, CharacterSale, addLiquidity, purchaseCharacter, Sablier approve + createWithTimestampsLL (8+ txs) | **valid, broadcast, confirmed on-chain** | `0x141D9959…` every time |

Observations that constrain the fault:
- The recovered signer **varies with the transaction digest** (different garbage per tx), yet is **deterministic for a given tx**.
- **Tx size and chainId are not the variable.** The no-passphrase wallet signed the **identical 3484-byte GOLDToken deploy** on Sepolia and it recovered correctly. The passphrase fails on both a 3484-byte deploy and a 0-byte 21000-gas self-send. **The passphrase wallet is the only differing variable.**

---

## 3. What it is NOT (ruled out, with forensic basis)

Forensics performed with **viem** against the bad `(r,s)`:

1. **NOT a valid signature by `0x21c9…` over our digest** under *either* `yParity`.
2. **NOT a dropped-leading-zero / leading-byte truncation of `r` or `s`** — restoring a dropped leading byte of `r` or `s` does not recover `0x21c9…`. (The mainnet sig's `s` happened to end in `0x00` but the Sepolia sig's `s` ended in `0x6d` — coincidence, not truncation.)
3. **NOT calldata truncation/chunk-boundary corruption** — brute-forced **all 3484 byte positions**: the `(r,s)` is not a valid signature by `0x21c9…` over *any* prefix-truncation, single-byte-drop, or chunk-boundary-drop of the calldata.
4. **NOT a consistent wrong key.** A fixed wrong private key `K` signing the correct digest always recovers to the single fixed `addr(K)` for *every* tx. By ECDSA recovery algebra, `recovered = correctPub + (e_signed − e_recovered)·r⁻¹·G`: **different garbage per digest** means the signed digest differs from the host-recovered digest (or the key varies per call) — it is *inconsistent* with one stable wrong key.
5. **NOT a length/chunking-dependent fault.** It reproduces on a 0-calldata 21000-gas tx (single-frame, no `EthereumTxAck` chunking) as well as the 3484-byte multi-chunk deploy.

The `(r,s)` simply do not verify against the wallet key over the digest we reconstruct. This leaves two live hypotheses: a **wrong/garbage key inside firmware** (per-tx-varying scratch), or a **digest/preimage mismatch** between what the device signed and what the host recovers against (host serialization, or a firmware preimage divergence specific to the passphrase path).

---

## 4. Key diagnostic

**Under the same passphrase session: `GetAddress` is CORRECT; `SignTx` is INVALID.**

On KeepKey, `GetAddress` and `SignTx` derive the signing key through the **identical** code path (see §6) — there is no separate "signing key" derivation. So a correct `GetAddress` mathematically implies the device holds the right passphrase-derived `node->private_key`. The component that behaves differently between the two operations, under the same cached passphrase seed, is the **signing routine / its preimage**, not key derivation per se. Address derivation under passphrase works; signing under passphrase is broken.

---

## 5. Host vs firmware verdict (code evidence)

### 5a. The host (Vault) sign path is provably passphrase-invariant

Audited end-to-end in the running build's source tree (`projects/keepkey-vault/src` + vendored `modules/hdwallet`):

- **REST sign handler** — `projects/keepkey-vault/src/bun/rest-api.ts:2013-2098`. Builds a plain `msg` (`:2041-2049`: `addressNList, to, value, data, nonce, gasLimit, chainId`; EIP-1559 fields `:2052-2057`). **No passphrase / session_id / hidden-wallet field is ever attached.** Optional `txMetadata` clear-sign blob (`:2063-2080`) is driven by calldata decode, not passphrase. Calls `wallet.ethSignTx(msg)` at `:2087`; logs at `:2082` / `:2088`.
- **Delegation** — `modules/hdwallet/packages/hdwallet-keepkey/src/keepkey.ts:1375-1376` → `Eth.ethSignTx(this.transport, msg)`.
- **Proto build + assembly** — `modules/hdwallet/packages/hdwallet-keepkey/src/ethereum.ts:252-408`. `EthereumSignTx` carries only `addressNList, nonce, gasLimit, gasPrice|maxFeePerGas, value, to, dataInitialChunk/dataLength, chainId` (`:301-344`) — **no passphrase/session field exists on the message**. `r/s/v` are read **verbatim** from the device protobuf (`:383-386`: `getSignatureR_asU8()/getSignatureS_asU8()/getSignatureV()`); assembly via `Transaction.fromTxData`/`FeeMarketEIP1559Transaction.fromTxData` (`:390-399`) and `tx.serialize()` (`:405`) is **unconditional and passphrase-agnostic**.
- **Get-address for comparison** — `ethereum.ts:410-426`: `EthereumGetAddress` carries only `addressNList` + `showDisplay`; same transport, same lack of passphrase/session.
- **Transport** — `modules/hdwallet/packages/hdwallet-keepkey/src/transport.ts`. Real I/O via `TransportDelegate.writeChunk/readChunk` (`:18-19`); framing `write/read :66-103`, `toMessageBuffer/fromMessageBuffer :367-396`. Passphrase handling lives in the **shared** read loop `readResponse :154-255` (`MESSAGETYPE_PASSPHRASEREQUEST :218-228`), identical for get-address and sign-tx.
- **Passphrase / session model** — `sendPassphrase` → `PassphraseAck.setPassphrase` → one `transport.call` (`keepkey.ts:1016-1020`); engine wiring `engine-controller.ts:236-246`, `:1929-1948`. **KeepKey has no per-message session_id (unlike Trezor):** the passphrase is entered **once per USB session**; the device caches the passphrase-derived seed; every later op (get-address and sign-tx alike) reads that same cached seed. The host never re-sends or re-derives the passphrase per operation. The only structural host difference is that `/addresses/eth` (`rest-api.ts:1829-1845`) has an in-memory `addressCache` (keyed by deviceId+body, `scopedKey :309-312`) while sign-tx has none — this cannot manufacture a valid-address-but-invalid-signature outcome.

**Host conclusion:** there is zero passphrase/session branching in the sign path; assembly copies raw protobuf `r/s/v`; and the only host-plausible corruptions (dropped-leading-zero / truncation) are already excluded by the §3 forensics. The host construction, transport, and assembly are **passphrase-invariant**.

### 5b. The countervailing data point — and how to resolve it

The host audit concludes **FIRMWARE**: the only differing variable is the passphrase, which influences only the device's once-per-session cached seed; `GetAddress` proves the device holds the right passphrase key; both ops read that same seed; the host reads `r/s/v` verbatim. A signature that is consistent-per-digest yet doesn't verify against the device's own passphrase pubkey — and whose recovered signer changes with the digest — can only be generated where the key is selected and the digest is computed: **inside the firmware**.

The firmware-locus review adds the necessary caveat for honesty: **"different garbage per digest" is inconsistent with a *stable* wrong key** (§3 item 4). It implies a **digest divergence** — the device signed digest `e_signed` but the host recovers against `e_recovered ≠ e_signed`. Because the digest/RLP/keccak code is *shared* with the no-passphrase path that signs identical-structure txs correctly, a passphrase-only *digest* divergence inside firmware is a priori unlikely — which keeps a **host preimage/serialization mismatch** (legacy-vs-1559 framing, EIP-155 `v`/chainId encoding) in play as well.

These are not contradictory: both reviews agree the on-device **key derivation** is correct (GetAddress proves it) and the host **byte-handling** is clean (forensics prove it). What remains genuinely undetermined is **whose digest is wrong**. That is exactly what the §8 test measures, because **the firmware returns the digest it signed**.

---

## 6. Most-likely firmware root-cause locus

Canonical, maintained firmware repo on disk: **`/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-firmware`** (C, KeepKey fork of trezor-firmware; Trezor crypto vendored under `deps/crypto/trezor-firmware/crypto/`). ~6 sibling checkouts exist; this is the maintained one.

**Both handlers derive the key identically** — `lib/firmware/fsm_msg_ethereum.h`: `fsm_msgEthereumSignTx` (**line 98**) and `fsm_msgEthereumGetAddress` (**line 123**) both call:
```c
fsm_getDerivedNode(SECP256K1_NAME, msg->address_n, msg->address_n_count, NULL)
```
GetAddress → `hdnode_get_ethereum_pubkeyhash(node, …)`; SignTx → `ethereum_signing_init(msg, node, …)`. Same `node`. **GetAddress-correct implies `node->private_key` is correct.**

**Derivation chain (passphrase → seed → node → privkey):**
1. `fsm_getDerivedNode` — `lib/firmware/fsm.c:180` → `storage_getRootNode(curve, /*usePassphrase=*/true, &node)` then `hdnode_private_ckd_cached(...)`.
2. `storage_getRootNode` — `lib/firmware/storage.c:1896`; mnemonic path `:1944-1976` caches `session.seed`, then `hdnode_from_seed(...)`.
3. `storage_getSeed` — `storage.c:1843`: `mnemonic_to_seed(mnemonic, usePassphrase ? session.passphrase : "", session.seed, …)` — where the passphrase enters.
4. `hdnode_private_ckd_cached` — `deps/crypto/trezor-firmware/crypto/bip32.c:547`; cache root compared with full-node `memcmp` at `:566` → **this BIP32 child cache is sound** (passphrase change invalidates it correctly).
5. SignTx copies the key: `lib/firmware/ethereum.c:895` `memcpy(privkey, node->private_key, 32);`
6. ECDSA: `send_signature()` `ethereum.c:266` → `ecdsa_sign_digest(&secp256k1, privkey, hash, sig, &v, ethereum_is_canonic)` at **:282**, with `hash = keccak_Final(&keccak_ctx, …)` at `:281`.

**Latent firmware bug — the "stale-root / wrong-key" locus (would produce a *stable* wrong address):**
- `storage_getSeed` (`storage.c:1845`) **is** mode-aware: `if (usePassphrase == session.seedUsesPassphrase && session.seedCached) return session.seed;` — re-derives when passphrase mode changes.
- `storage_getRootNode` (the SECP256K1/Ethereum path) is **NOT** mode-aware: at `storage.c:1955` it only checks `if (!session.seedCached)`, then blindly `hdnode_from_seed(session.seed, …)`. It never compares `session.seedUsesPassphrase` to the requested `usePassphrase`.
- `session_cachePassphrase` (`storage.c:1996`) sets `passphraseCached = true` but does **not** reset `session.seedCached`.
- **Combined:** if a no-passphrase (or different-passphrase) seed is already cached and a passphrase is then entered without a session clear, `storage_getRootNode` reuses the **stale** seed → derives with the wrong root. This is the only firmware path that can sign under a different root than intended. **Fix:** mirror `storage_getSeed`'s `seedUsesPassphrase` guard at `storage.c:1955`, and set `session.seedCached = false` in `session_cachePassphrase` (`storage.c:1996`).
- **Caveat:** this bug yields a *stable* wrong address per session, so it explains "wrong key" but **not** the observed per-digest variance. Treat it as a real latent bug to fix regardless, not necessarily *this* symptom's cause.

**Sharp edge worth auditing for the per-tx-varying case:** `fsm_getDerivedNode` returns a pointer to a `static HDNode`, and `EthereumSignTx` does `ethereum_signing_init(msg, node, ...)` then **`memzero(node, sizeof(*node))` immediately** — so `ethereum_signing_init` (`ethereum.c:618`) must deep-copy the node before the zero, and the streaming Keccak/sign path (calldata arrives as `EthereumTxAck` chunks) must never reuse/clear the key buffer mid-transaction. A missed deep-copy or buffer reuse during streaming would sign against tx-dependent scratch memory → **a recovered signer that varies per tx**, matching the symptom.

**Files for the firmware team, priority order:**
1. `lib/firmware/storage.c` — `storage_getRootNode` (1896; seedCached gate at **1955**) and `session_cachePassphrase` (**1996**), cross-checked against `storage_getSeed` (1843).
2. `lib/firmware/ethereum.c` — `send_signature` (266; returned `hash` at **313-315**), `ethereum_signing_init` (618; `memcpy privkey` at 895).
3. `lib/firmware/fsm_msg_ethereum.h` — `fsm_msgEthereumSignTx` (98) vs `fsm_msgEthereumGetAddress` (123).
4. `lib/firmware/fsm.c` — `fsm_getDerivedNode` (180).

---

## 7. How to reproduce

Preconditions: real KeepKey device (not the emulator — see §8 note), the **passphrase/hidden wallet active**, Vault dev build running and serving `localhost:1646`.

1. `POST /addresses/eth` with `path m/44'/60'/0'/0/0` and the passphrase active → returns `0x21c9a94AF76B59b171b32fD125A4edF0e9A2Ad3e` (correct, stable).
2. `POST /eth/sign-transaction` with the **same path/passphrase** for any tx, e.g.:
   - Sepolia (chainId 84532) self-send: `value` to self, `0` calldata, `gasLimit 21000`.
   - and/or the GOLDToken deploy (chainId 8453 mainnet or 84532 Sepolia, 3484-byte calldata).
3. Recover the signer from the returned serialized tx (viem `recoverTransactionAddress` / ecrecover). It will be a garbage address that **differs per tx digest** and is **deterministic for a given tx** — never `0x21c9…`.
4. **Control:** repeat step 2 with the **no-passphrase** wallet (`0x141D9959…`) and the *identical* tx → recovers correctly to `0x141D9959…` and broadcasts/confirms. This proves the calldata/clear-sign/chunking/serialization path is good and the passphrase is the only variable.

---

## 8. How to capture the message-by-message proof (the decisive test)

The firmware **returns the exact digest it signed** in `EthereumTxRequest.hash`, set in `send_signature()` at `lib/firmware/ethereum.c:313-315` (the same `hash` passed to `ecdsa_sign_digest`). Compare it byte-for-byte to the host's locally-computed digest:
- **`EthereumTxRequest.hash` ≠ host digest** → digest/preimage construction mismatch (host serialization or firmware preimage), **not** a key bug.
- **They are equal yet recovery against `0x21c9…` fails** → genuine key bug; locus = the `storage_getRootNode` seed-mode gap (`storage.c:1955`) + `session_cachePassphrase` (`storage.c:1996`), and the streaming/deep-copy edge in `ethereum_signing_init`.

### 8a. What you already have, no rebuild

The Bun backend mirrors every `console.*` to a log file at boot (`projects/keepkey-vault/src/bun/index.ts:30-58`):
```
/Users/highlander/Library/Application Support/com.keepkey.vault/vault-backend.log
```
It already logs, per `/eth/sign-transaction` (`rest-api.ts:1508, 2082, 2088`):
- `[REST] Signing request /eth/sign-transaction: …`
- `[REST] ethSignTx hdwallet payload: {…}` ← exact host input
- `[REST] ethSignTx result: {"r":"0x…","s":"0x…","v":…,"serialized":"0x…"}` ← device `r/s/v` read straight off the proto (`ethereum.ts:383-386`)

The `[REST] EVM clear-sign` line tells you whether an `EthereumTxMetadata` blob was sent before `EthereumSignTx` (clear-sign vs blind) — rule this variable in/out. Tail/extract:
```bash
LOG="$HOME/Library/Application Support/com.keepkey.vault/vault-backend.log"
tail -f "$LOG"
grep -nE '\[REST\] (Signing request /eth|ethSignTx (hdwallet payload|result)|EVM clear-sign)' "$LOG"
```
(A passphrase-wallet `0x21c9…` self-send already appears in this log, e.g. `r=0x7cd512da… s=0x223785cc… v=0` at `04:26:37Z`.)

### 8b. Full raw wire hook (definitive)

Every message in both directions funnels through one `eventemitter2` chokepoint in the hdwallet transport (`transport.ts`): outgoing `Transport.call()` emits at `:290` (`from_wallet:false`); incoming `Transport.readResponse()` emits at `:167` (`from_wallet:true`). Add a wildcard `onAny` listener in the Vault's own code — **edit `projects/keepkey-vault/src/bun/engine-controller.ts`, inside `attachTransportListeners()`, right after `const transport = this.wallet.transport` (line 213):**

```ts
// MSGLOG: dump every protobuf message both directions to vault-backend.log.
transport.onAny((_name: string | string[], ev: any) => {
  if (!ev || typeof ev !== 'object' || ev.message_type === undefined) return
  const dir = ev.from_wallet ? 'DEV->HOST' : 'HOST->DEV'
  let wire = ''
  try { if (ev.proto?.serializeBinary) wire = Buffer.from(ev.proto.serializeBinary()).toString('hex') } catch {}
  console.log(`[MSGLOG] ${dir} ${ev.message_type}(${ev.message_enum}) ${JSON.stringify(ev.message)}${wire ? ' wire=' + wire : ''}`)
})
```
(`ev.message` is jspb `.toObject()`, so `bytes` fields print as base64; the appended `wire=<hex>` is the exact serialized protobuf for byte-level forensics. Optional: call `(transport as any).offAny?.()` in `cleanupTransportListeners()` ~`:204` so re-pairs don't stack listeners.)

Rebuild + restart so the hook takes effect (the dev app loads a pre-bundled backend; per project convention use `make` from the repo root):
```bash
# quit the running keepkey-vault-dev app first, then:
cd /Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-vault-v11
make dev        # bundle-backend → vite build → electrobun build → electrobun dev
# or: make dev-hmr
```
New `[MSGLOG]` lines land in the same `vault-backend.log`. Inspect:
```bash
LOG="$HOME/Library/Application Support/com.keepkey.vault/vault-backend.log"
grep -nE '\[MSGLOG\]|\[Engine\] (PASSPHRASE_REQUEST|BUTTON_REQUEST)' "$LOG" | tail -60
```

### 8c. What to check (in order)

1. **Passphrase session parity:** confirm `EthereumSignTx` is preceded by the **same** `PassphraseRequest → HOST->DEV PassphraseAck{passphrase:"…"}` handshake that `EthereumGetAddress` gets. If SignTx runs on a stale/empty/cleared passphrase cache, the device signs under the wrong seed.
2. **Outgoing `HOST->DEV EthereumSignTx`:** verify `addressNList = [2147483692, 2147483708, 2147483648, 0, 0]`, correct `chainId`, `data_length`, `data_initial_chunk` (first ≤1024 bytes), then each `EthereumTxAck.data_chunk` until `data_length` is exhausted — proves the host sent the right tx.
3. **Incoming `DEV->HOST EthereumTxRequest` (terminal):** carries `signatureR/S/V` **and `hash`**. (a) Compare `signatureR/S/V` (and `wire=` hex) byte-for-byte against `[REST] ethSignTx result` — if equal but non-verifying, **host is exonerated**. (b) Compare the device's `hash` against the host's locally-computed digest — this is the §8 decisive test (digest-mismatch vs key-bug).
4. **GetAddress comparison:** `HOST->DEV EthereumGetAddress{address_n}` → `DEV->HOST EthereumAddress{address}` should show `0x21c9a94A…`. Same path, same passphrase handshake — the only delta vs SignTx is the message type, isolating the fault to the device's passphrase-gated signing routine.

**Note:** recent log sessions show an **emulator** in use (`deviceId 5E4E6B69…`, fw `7.15.0`, `passphraseProtection:false`). Reproduce on the **real device with the passphrase wallet active** (`isPassphraseWallet`) — the emulator's passphrase state differs and will not reproduce the bug faithfully.

---

## 9. Recommended fix + safe interim workaround

### Interim workaround (unblock the launch now)
**Use the no-passphrase wallet `0x141D9959…` as the mainnet contract owner / deployer.** That path is *proven*: it has signed and broadcast 8+ confirmed transactions (GOLDToken deploy, AMMRouter, CharacterSale, addLiquidity, purchaseCharacter, Sablier approve + createWithTimestampsLL), all recovering correctly. Do **not** ship the passphrase wallet as the funded owner until it produces a signature that passes an on-host `ecrecover` gate. (Alternative if §8 implicates the host: the device key itself is proven correct by GetAddress, so the same tx signed through a known-good reference transport could be broadcast — but the no-passphrase wallet is the cleaner, fully-proven path.)

### Permanent safety net (host — do this regardless of root cause)
Add a **mandatory post-sign verification gate** in the Vault: after `wallet.ethSignTx`, run on-host `ecrecover(serialize(tx), r, s, v)` and compare to the cached GetAddress for that path. **If it does not equal the expected signer, refuse to return/broadcast and surface an error.** This single guard would have caught this before a mainnet deploy and is the correct permanent safeguard. (Sign path lives at `rest-api.ts:2013-2098`; the address is already derivable via the same handler's GetAddress.)

### Firmware fix (apply if §8 test (b) shows device `hash` == host digest yet recovery fails)
- Make `storage_getRootNode` mode-aware: compare `session.seedUsesPassphrase` against the requested `usePassphrase` before reusing `session.seed` (`storage.c:1955`), mirroring `storage_getSeed` (`storage.c:1845`).
- Have `session_cachePassphrase` reset `session.seedCached = false` (`storage.c:1996`).
- Ensure `ethereum_signing_init` (`ethereum.c:618`) **deep-copies** the derived node before `EthereumSignTx`'s `memzero(node)`, and that the streaming Keccak/sign path never reuses or clears the key buffer mid-transaction (the per-tx-varying-garbage locus). This is the class of bug Trezor fixed in #1659 / #525.

### If §8 test (a) shows device `hash` ≠ host digest (preimage/serialization mismatch)
Reconcile the host serialization with the device preimage (legacy RLP vs EIP-1559 `0x02` typed-tx, EIP-155 `v`/chainId encoding) on the passphrase path; the fix is host-side in `ethereum.ts` assembly (`:383-405`) / `rest-api.ts` msg build (`:2041-2057`).

---

## 10. References

**Running build / host source (Vault, `keepkey-vault-v11`):**
- Log writer + path: `projects/keepkey-vault/src/bun/index.ts:30-58` → `~/Library/Application Support/com.keepkey.vault/vault-backend.log`
- REST sign handler + logs: `projects/keepkey-vault/src/bun/rest-api.ts:2013-2098` (logs `:1508, 2082, 2088`; address handler `:1829-1845`; addressCache `scopedKey :309-312`)
- Hook site: `projects/keepkey-vault/src/bun/engine-controller.ts:207-257` (insert after `:213`; cleanup `:198-205`; PASSPHRASE_REQUEST listener `:236-246`; `sendPassphrase` `:1929-1948`)
- hdwallet delegation: `modules/hdwallet/packages/hdwallet-keepkey/src/keepkey.ts:1375-1376` (passphrase ack `:1016-1020`)
- ETH sign flow + verbatim r/s/v read: `modules/hdwallet/packages/hdwallet-keepkey/src/ethereum.ts:252-408` (assembly `:383-405`; GetAddress `:410-426`)
- Transport chokepoint: `modules/hdwallet/packages/hdwallet-keepkey/src/transport.ts:154-167, 218-228, 257-299, 66-103, 367-396`
- Proto field defs: `modules/device-protocol/messages-ethereum.proto:20-88`
- Build targets: `Makefile:270-276` (`dev` / `dev-hmr`)

**Firmware source (`keepkey-firmware`, on disk at `/Users/highlander/WebstormProjects/keepkey-stack/projects/keepkey-firmware`):**
- `lib/firmware/fsm_msg_ethereum.h` — `fsm_msgEthereumSignTx:98`, `fsm_msgEthereumGetAddress:123`
- `lib/firmware/fsm.c` — `fsm_getDerivedNode:180`
- `lib/firmware/storage.c` — `storage_getSeed:1843`, `storage_getRootNode:1896` (seedCached gate `:1955`), `session_cachePassphrase:1996`, root-seed-cache `:1255/1279`
- `lib/firmware/ethereum.c` — `send_signature:266` (returned `hash` `:313-315`, `ecdsa_sign_digest` `:282`, `keccak_Final` `:281`), `ethereum_signing_init:618`, `memcpy privkey:895`
- `deps/crypto/trezor-firmware/crypto/bip32.c` — `hdnode_private_ckd_cached:547` (cache `memcmp` `:566`)

**Upstream documentation / known issues (Trezor — KeepKey is a fork of Trezor firmware):**
- Trezor firmware — sessions model + silent fallback ("attempt to resume an unknown session ID will transparently allocate a new session ID"): https://docs.trezor.io/trezor-firmware/common/communication/sessions.html
- Trezor firmware — passphrase / seed caching + session_id guarantee: https://docs.trezor.io/trezor-firmware/common/communication/passphrase.html
- Trezor changelog — passphrase/session caching bugs (#1659 empty passphrase caching; #525 clear_session forgets passphrase state; `state`→`session_id`): https://github.com/trezor/trezor-firmware/blob/main/python/CHANGELOG.md
- Trezor-suite — "duplicated empty passphrase redirects to incorrect wallet" (#3517): https://github.com/trezor/trezor-suite/issues/3517
- **Trezor Forum — near-identical symptom:** ETH signing for second passphrase wallet returns the correct address but signs to a different address that changes every time; non-passphrase wallets work: https://forum.trezor.io/t/eth-signing-for-second-passphrase-wallet-signs-with-wrong-address-signature/19230
- Trezor support — "I can't sign my transaction" (key-derivation/passphrase mismatch): https://trezor.io/support/troubleshooting/trezor-suite-issues/i-can-t-sign-my-transaction
- Trezor support — passphrase / hidden wallet issues: https://trezor.io/support/troubleshooting/trezor-suite-issues/passphrase-hidden-wallets-issues
- **Sparrow #219 — KeepKey BIP39 passphrase send fails host-side (host-specific passphrase transmission; FW 7.2.1, wontfix):** https://github.com/sparrowwallet/sparrow/issues/219
- KeepKey firmware (GitHub mirror): `lib/firmware/fsm.c` https://github.com/keepkey/keepkey-firmware/blob/master/lib/firmware/fsm.c · `lib/firmware/passphrase_sm.c` https://github.com/keepkey/keepkey-firmware/blob/master/lib/firmware/passphrase_sm.c · `lib/firmware/fsm_msg_ethereum.h` https://github.com/keepkey/keepkey-firmware/blob/master/lib/firmware/fsm_msg_ethereum.h
- Passphrase *handling* advisories (related but a different class — unvalidated/ransom passphrases, not invalid signatures): https://benma.github.io/2020/09/02/trezor-keepkey-passphrase.html · https://blog.kraken.com/product/security/flaw-found-in-keepkey-crypto-hardware-wallet-part-2

**Note on novelty:** no published advisory was found describing *per-digest-varying, non-verifying* signatures from a KeepKey passphrase wallet (this exact corruption signature). The closest documented case is Trezor forum #19230 — symptomatically identical, but with no posted firmware root-cause.