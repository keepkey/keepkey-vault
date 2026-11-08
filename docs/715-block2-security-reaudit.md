# Firmware 7.15.0 security re-audit — block 2 review packet

Date: 2026-09-22. Target: `BitHighlander/keepkey-firmware` annotated tag
`v7.15.0-rc29`, commit `dd38324e3ffa1178d632e4da58f27cab7c0494a4`.
This is the newest 7.15 release-candidate tag on the fork. The target is
checked out separately at `/private/tmp/kk-715-block2`; the vault's current
firmware submodule pin is `e507d0c6` and declares 7.16.0, so it is not the
7.15 audit source. The main firmware worktree has unresolved merge conflicts
and was left untouched. The ten findings below are the **second
full-tree re-audit block** in firmware
`docs/security/7.15.0-rc17-hardening.md`.

## Finding disposition

"Source check" means the relevant call path and fail-closed behavior were
inspected at this exact tag. It is not a physical OLED observation.

| Finding | Source check at rc29 | Regression evidence |
| --- | --- | --- |
| Binance denomination stack overwrite | `lib/firmware/binance.c:19-49` rejects denominations longer than 31 characters, noncanonical characters, nonpositive or mismatched transfer amounts, and malformed input/output cardinality. `lib/firmware/fsm_msg_binance.h:115-139` formats the validated denomination into a 33-byte buffer, checks `snprintf`, checks `bn_format_uint64`, and aborts on failure. The protocol allocation is 32 bytes (`include/keepkey/transport/messages-binance.options:19`). | `unittests/firmware/binance.cpp:32-94` tests the 31/32-character boundary, grammar, malformed transfer, and envelope state through helpers. It does not invoke `fsm_msgBinanceTransferMsg`; a handler-level maximum-denomination formatting and rejected-confirmation test was not found. |
| Bitcoin-family `SignMessage` NUL or out-of-bounds disclosure | `lib/firmware/fsm_msg_coin.h:283-305` passes the protobuf byte pointer **and size** to `confirm_bytes`, then signs the same pointer and size. `lib/firmware/app_confirm.c:420-554` sends control or binary payloads through hex pagination and aborts if any page is rejected. | `unittests/firmware/app_confirm.cpp:23-42` checks only that embedded NUL and other controls select hex mode. It does not render pages or exercise the signing handler. A handler-level adversarial NUL signing test was not found. |
| Ethereum `SignMessage` hidden suffix | `lib/firmware/fsm_msg_ethereum.h:340-360` confirms the entire sized payload before `ethereum_message_sign`; no capped preview remains in the handler. | The byte-classification test above does not exercise pagination or this handler. A handler-level long-suffix display/cancel test was not found. |
| TRON `SignMessage` hidden suffix | `lib/firmware/fsm_msg_tron.h:220-246` confirms the entire sized payload before `tron_message_sign`; rejection returns before signing. | The byte-classification test above does not exercise pagination or this handler. A handler-level long-suffix display/cancel test was not found. |
| Ethereum typed-hash AdvancedMode bypass | `lib/firmware/fsm_msg_ethereum.h:389-414` checks `AdvancedMode` and returns before signing when it is off. | `unittests/firmware/ethereum.cpp:50-53` tests `ethereum_typed_hash_policy_allows` directly. It does not prove that `fsm_msgEthereumSignTypedHash` invokes the predicate or returns on rejection; a handler-level policy-off test was not found. |
| EIP-712 display not bound to canonical values | `lib/firmware/ethereum.c:1275-1369` confirms the primary type before hashing; `lib/firmware/eip712.c:403-421,530-875` confirms each field name and value and validates the value's JSON type before encoding. Source inspection shows fail-closed handling of address, bytes, integer width, boolean spelling, fixed-array cardinality, and missing-value boundaries. | `unittests/firmware/eip712.cpp:9-107` tests address and bytes encoding, integer width, fixed-array cardinality, and missing values. It has no boolean-spelling test. The full OLED rendering of nested fields still needs final reviewer scrutiny. |
| EOS unknown-action AdvancedMode bypass | `lib/firmware/eos.c:389-435` includes `EOS_NewAccount` in the structured-action allowlist, rejects an attempt to send it as unknown data, and aborts an unknown action when `AdvancedMode` is off. | `unittests/firmware/eos.cpp:10-24` tests only `eos_unknownActionPolicyAllows` and `eos_isSupportedAction`. It does not exercise `eos_compileActionUnknown` or the FSM policy-off path; a handler-level rejection test was not found. |
| Cosmos IBC receiver omitted from review | `lib/firmware/fsm_msg_cosmos.h:380-468` requires sender, receiver, channel, port, timeout fields, amount, and literal `uatom`; it pages sender and receiver, displays the remaining IBC routing fields, then hashes those same message fields. Any refused screen aborts. | No targeted handler-level IBC display/cancel test was found. |
| Tendermint ACK asset/protocol substitution | `lib/firmware/fsm_msg_tendermint.h:110-126` compares ACK chain name, denomination, and message prefix with the active signing session; `lib/firmware/signtx_tendermint.c:581-593` enforces the initialized generic protocol and exact string matches. The handler pages chain ID, chain name, denomination, and prefix before final signature (`fsm_msg_tendermint.h:198-218`). | `unittests/firmware/cosmos.cpp:81-118` tests the generic session helper: it rejects substituted denomination, chain name, prefix, and protocol when called directly. It does not exercise `fsm_msgTendermintMsgAck`; a handler-level substituted-ACK rejection test was not found. |
| Binance, Tendermint, Cosmos, Osmosis memo suffixes hidden | Each completion path calls the same full-length `confirm_bytes` pager: `fsm_msg_binance.h:168-177`, `fsm_msg_tendermint.h:190-198`, `fsm_msg_cosmos.h:478-487`, and `fsm_msg_osmosis.h:734-744`. Source inspection shows cancellation aborts before finalization. | `unittests/firmware/app_confirm.cpp:23-42` tests only byte classification, not page rendering or cancellation. No per-chain maximum-length memo display/cancel regression was found. |

## Verification and review limits

- The tag's GitHub checks were queried on 2026-09-22. Firmware builds, full and
  bitcoin-only unit tests, Python integration and dylib tests, static analysis,
  format, and submodule checks all reported success. The relevant run is
  [31758472443](https://github.com/BitHighlander/keepkey-firmware/actions/runs/31758472443);
  the tagged release run passed on
  [attempt 2](https://github.com/BitHighlander/keepkey-firmware/actions/runs/31758498352/attempts/2).
  [Attempt 1](https://github.com/BitHighlander/keepkey-firmware/actions/runs/31758498352/attempts/1)
  stopped at the validation gate because its query found no completed successful
  CI run for the tagged commit at that time. The gate passed on attempt 2.
- The SOP's Docker firmware-unit step completed locally on this exact rc29
  checkout with exit code 0: 424 firmware tests passed, followed by 7 board,
  18 crypto, and 7 constant-time Pallas tests passed. A native macOS CMake
  attempt stopped before compilation because this host lacks the required
  nanopb 0.3.9.4 generator; Docker supplies the supported toolchain.
- The SOP's Docker Python/emulator step completed locally with exit code 0.
  The report-driven OLED screenshot phase passed **194/194** selected tests;
  the full integration phase reported **600 passed, 12 skipped**, with no
  failures. Report-catalog validation passed. The generated
  [7.15 test report](security/715-block2-test-report.pdf) contains 20 sections
  and 330 catalog tests (327 passed, 3 skipped, none failed or pending).
- The source review found no reopened path among these ten listed defects.
  Final review should inspect the EIP-712 nested-value display and the missing
  handler-level adversarial tests above. OLED evidence and a physical-device
  release decision are separate gates; this packet does not assert them.

## Reproduce

```sh
git -C modules/keepkey-firmware fetch origin --tags
git -C modules/keepkey-firmware show --no-patch v7.15.0-rc29^{}
git -C modules/keepkey-firmware show v7.15.0-rc29:docs/security/7.15.0-rc17-hardening.md
gh api repos/BitHighlander/keepkey-firmware/commits/dd38324e3ffa1178d632e4da58f27cab7c0494a4/check-runs
```

From a clean checkout of `v7.15.0-rc29` with its submodules initialized,
run the SOP Docker suites in this order (see `docs/RELEASE-CONTROL-7.15.md:149-152`):

```sh
cd scripts/emulator
docker compose up --build --exit-code-from firmware-unit firmware-unit
docker compose up --build --exit-code-from python-keepkey python-keepkey
```

The `python-keepkey` container runs the report-selected screenshot phase,
full Python suite, JUnit merge, `generate-test-report.py --validate-junit`,
and PDF generation in `scripts/emulator/python-keepkey-tests.sh:45-148`.
Its shared volume output is `test-reports/test-report.pdf`; the copy attached
to this packet is `docs/security/715-block2-test-report.pdf` (SHA-256
`e4aec604632eecf3d83a0f91b10ac6b04b644dcdc286ef85b30f389b4150dae5`).
