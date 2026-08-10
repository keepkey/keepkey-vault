# Clear-Signing Phase 1 — Final PDF Report + Real-Device Testing (Handoff, 2026-07-02)

**Where this picks up:** supersedes the V/clearsign portions of
`handoff-firmware-715-pdf-coverage.md` (whose Hive/zcash/bip85/frame-picker items are now
DONE). Firmware PR **#281** (`BitHighlander/keepkey-firmware`, `feat/clearsign-signer-warning`
→ develop) is the merge candidate. Everything below is emulator-verified; the next gate is
**real-device testing**, then merge → rc3.

---

## What ships in PR #281 (one PR, stacked on the 7.15.0 version bump #280)

**Phase-1 trust model — no hardcoded "KeepKey says this is safe":**
- `METADATA_PUBKEYS` all-zero (including the old DEBUG_LINK CI slot).
- `LoadClearsignSigner` (device-protocol msg **117**): host loads a 33-byte compressed
  secp256k1 pubkey + alias into a key slot. Mandatory on-device confirm (alias + sha256[:4]
  fingerprint). RAM-only; dropped on reboot AND WipeDevice. Alias is a strict
  `[A-Za-z0-9 _-]` allowlist (adversarial review found a quoted-region breakout:
  alias `x' verified by KeepKey. Safe (` — fixed).
- Every tx verified by a loaded signer shows **CLEARSIGN WARNING — Signer '<alias>' (<fp>)
  you loaded describes this tx. NOT verified by KeepKey.** BEFORE any clearsign page.
  The "Insight Verified" icon presentation is reserved for the future built-in key, which a
  loaded signer can never shadow.
- With AdvancedMode OFF, contract data without VERIFIED metadata is hard-rejected
  ("Blocked") — so the raw-hex "Confirm Ethereum Data" screen is **structurally
  unreachable**: if a contract tx signs at all, it clearsigned. tx-hash binding
  (`signed_metadata_enforce`) is fail-closed at send_signature.

**Human-readable WHAT (the who/what/why):**
- New attested arg formats: `ARG_FORMAT_STRING` (4) — printable label, e.g.
  `protocol: Aave V3`; `ARG_FORMAT_TOKEN_AMOUNT` (5) — decimals+symbol+amount, device
  renders `10.5 DAI` / `UNLIMITED USDC` (all-0xFF 32-byte amount). Both fail-closed
  validated at parse (`arg_value_ok`). Max arg value 32→44 bytes (legacy formats keep 32).
- Screens per flow: warning → `Call: <method>` → `Contract: 0x…` (full, never truncated)
  → each decoded arg (ADDRESS full / TOKEN_AMOUNT scaled / STRING label) → tx/gas confirm
  (nonzero ETH value IS shown: "Send 0.01 ETH from your wallet…").

**The 51-flow reference catalog** (`keepkeylib/clearsign_catalog.py`, python-keepkey
branch `feat/clearsign-load-signer`):
- 51 real mainnet tx types across: DEX swaps (Uniswap V2/V3/**V4 Universal Router**, Curve
  3pool), lending (Aave V3 borrow/repay/withdraw/supply, Compound V3, Spark), liquid
  staking/restaking (Lido, Rocket Pool, ether.fi, EigenLayer ×2), approvals/permits
  (approve/unlimited/increase/decrease, **EIP-2612 permit**, **Permit2 approve +
  permitTransferFrom**, **DAI's non-standard permit**, USDT, ERC-721/1155
  setApprovalForAll), NFTs (721/1155 single + batch transfer), governance/ENS, bridges
  (Hop, Wormhole, **Across depositV3 = ERC-7683-style intent**), ERC-4626 vaults
  (MetaMorpho, Yearn V2/V3), WETH wrap/unwrap, transferFrom, and the newest tx shapes:
  **ERC-4337 EntryPoint v0.7 handleOps**, **EIP-7702 set-code authorization**,
  **Safe execTransaction**.
- Calldata is never hand-typed: `keepkeylib/clearsign_abi.py` derives selectors via
  keccak256(signature) and ABI-encodes static types; the 8 genuinely-dynamic layouts
  (nested dynamic tuples) were each verified by offline round-trip decode. Every contract
  address web-sourced; 5 research transcription errors (off-by-one hex chars, incl. a wrong
  Permit2 address) were caught by length-checks before reaching a device — **always
  len-check hex from any external source**.
- Tests are GENERATED from the catalog (one device test per flow + a batch test that
  device-validates every blob and rejects a 1-byte tamper of each). Adding flow #52 =
  editing the catalog only.
- Offline reference vectors: `sign_metadata` is RFC 6979 deterministic; sha256+length
  snapshots for all 51 blobs frozen in `REFERENCE_BLOB_SNAPSHOTS`.
  `python3 tests/test_msg_ethereum_clear_signing.py --flows` dumps
  to/value/calldata/tx_hash/blob hex per flow — **the external contract for any signer
  implementation** (pioneer-insight, keepkey-sdk).
- Standards alignment: Ledger + Trezor (as of May 2026) both converge on **ERC-7730**
  descriptors (intent + typed fields: addressName/tokenAmount, "Unlimited" threshold,
  field hiding). Our STRING/ADDRESS/TOKEN_AMOUNT + curated-display-subset model maps
  1:1 onto it — an ERC-7730→metadata compiler is a natural later step for the signer
  service. ERC-8176 (descriptor integrity attestations) is the trust layer to watch.

**Verified state (emulator):** full compose run **491 passed / 0 failed / 27 skipped**
(all documented). PDF: **fw 7.15.0, 216 tests, 211 passed, 0 failed, 5 pending**. Report
V-section entries are generated from the catalog (fixed a drift bug where hand-typed
entries pointed at renamed tests) — verified 100% name-match against pytest collection.
Frames visually inspected for: Aave supply full sequence, UNLIMITED USDC approve,
ETH-value swap, EIP-7702 ("delegate: 0x4Cd2…"), handleOps ("sender: 0x9406…"),
Safe execTransaction, Permit2 permitTransferFrom. Zero calldata hex anywhere.

---

## Final-PDF remaining items (5 pendings, all enumerated — no silent skips)

| item | why pending | action |
|---|---|---|
| Z5–Z7 zcash Orchard legacy-sighash signing | real firmware capability gap (needs header/orchard digests) | DECISION: implement for 7.15 or ship as the documented post-7.15 gap (section text already states it) |
| V8 `test_ethereum_blind_sign_allowed` | test itself gates on 7.15.1 | leave; or retarget the gate to 7.15.0 if it's meant to run now |
| C31 bip39 invalid-word rejection | pending per original audit | verify it runs on rc3; it's the #272 feature |
| ~2 misc | see junit skips | `grep skipped junit.xml` on the CI artifact |

PDF hygiene criteria from the original audit are otherwise met: header 7.15.0, no
setup/blank frames (capture-time reset + density picker), every [NEW] section has real
feature screenshots, Hive G 5/5, Zcash 15/18 with real UA/QR screens, BIP-85 6/6
(fixed a false-skip: `requires_message` probe couldn't serialize required-field protos).

## The iteration loop (unchanged, for reference)

```bash
# local fast loop (arm64 Mac: DOCKER_DEFAULT_PLATFORM=linux/amd64)
cd <firmware>/scripts/emulator
docker compose down -v
docker compose up --build --exit-code-from python-keepkey python-keepkey
# artifacts in the emulator_test-reports volume; PDF also generatable locally:
python3 scripts/generate-test-report.py --junit junit.xml --fw-version 7.15.0 \
        --screenshots screenshots/ --output test-report.pdf
```
Pin train: edit python-keepkey `feat/clearsign-load-signer` → bump `deps/python-keepkey`
in the firmware branch → push (CI runs on PR #281 pushes) → download `test-report` /
`oled-screenshots` artifacts → judge the PDF.

## Real-device testing runbook (the next step after merge)

The python-keepkey suite runs unmodified against a physical device — this is the fastest
"run all the clearsign txs" path (vault/SDK path is NOT ready, see blockers below).

1. **Flash** the rc3 build (must be a DEBUG_LINK build for the automated suite; for a
   production-signed build, drive manually via keepkeyctl — no debuglink auto-confirm).
2. **⚠️ The device tests WIPE the device** (`common.KeepKeyTest.setUp`) and load the
   public mnemonic12 test seed. Never run against a device holding real funds.
3. Run: `cd python-keepkey/tests && python3 -m pytest test_msg_ethereum_clear_signing.py -v`
   with the USB transport configured in `tests/config.py` (device + debuglink interface).
4. What to verify by eye on the OLED (the point of doing it on hardware):
   - Load confirm: "Trust signer 'CI Test' (<fp>) to describe transactions? NOT verified
     by KeepKey." — fingerprint should match the one shown later on warnings.
   - Per tx: CLEARSIGN WARNING → Call → Contract (full addr) → args ("10.5 DAI",
     "UNLIMITED USDC", protocol labels) → tx/gas confirm. **No hex anywhere.**
   - Reject paths: cancel at the warning cancels the tx; wipe drops the signer
     (re-load required).
5. Known gotchas (from prior device sessions): USB transport can wedge after
   recovery/wipe → replug; unsigned-RC reboots hit the bootloader gate.

## Merge order + companion branches

1. Merge **#281** → develop (contains the #280 version bump; close #280 or merge first).
2. device-protocol: merge `feat/load-clearsign-signer` (2ec999a9, msg 117) into
   `up/release-protocol` so upstream PR #111 carries it (fork-only until release SOP).
3. python-keepkey: fold `feat/clearsign-load-signer` (tip `1545299`) into
   `reconcile/upstream-sync` — **user-gated** (that branch feeds upstream PR #196);
   the firmware pin references the SHA directly, so merge order is not blocking.
4. Cut `release/rc3` off develop per the release SOP; the CI PDF from that build is the
   test-plan artifact.

## Production blockers (host side — independent of rc3, but gate REAL-WORLD clearsign)

1. **Pioneer signer is incompatible with the firmware today**: the shipped
   `descriptor-signing.service` pre-signs blobs with **txHash zeroed + empty arg values +
   classification always VERIFIED**. This firmware refuses them at `signed_metadata_enforce`
   (fail-closed). Pioneer must sign **per-tx** (real tx_hash, real values, STRING/
   TOKEN_AMOUNT formats) — the catalog's `--flows` dump + snapshots are the contract to
   build against.
2. **Vault/SDK load-signer train**: proto → hdwallet-keepkey → vault REST → keepkey-sdk
   need `LoadClearsignSigner` support; the SDK's `tests/evm-clearsign` static fixtures
   (key_id 0, zero hash, protocol-as-RAW) must be replaced with runtime signing (the JS
   signer in pioneer-insight lib can do this in-test, like python does).
3. Signer discipline: RAW/BYTES args still render hex by design (honest fallback) —
   production blobs should use ADDRESS/STRING/TOKEN_AMOUNT only (the catalog's offline
   test enforces this for the reference set).

## Key files
- firmware: `lib/firmware/signed_metadata.c`, `fsm_msg_ethereum.h` (LoadClearsignSigner),
  `unittests/firmware/signed_metadata.cpp` (59 tests)
- python-keepkey: `keepkeylib/clearsign_catalog.py` (THE catalog),
  `keepkeylib/clearsign_abi.py`, `keepkeylib/signed_metadata.py` (RFC 6979),
  `tests/test_msg_ethereum_clear_signing.py`, `scripts/generate-test-report.py`
- specs: vault repo `docs/firmware/SIGNED-METADATA-CLEAR-SIGNING-PLAN.md` (who/what/why,
  "Amount: 1,000 USDC" mandate), ERC-7730 registry `github.com/ethereum/clear-signing-erc7730-registry`
