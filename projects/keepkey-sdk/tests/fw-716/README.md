# fw-716: released 7.16.0 on real hardware

These suites target a production-root KeepKey on **signed release firmware
7.16.0** (bootloader 2.1.4, label `New7142signed`), driven through the running
Desktop on `:1646`. The device holds **real funds**. Every suite:

- **signs only.** Nothing is broadcast. No wipe, reset, recover or seed load.
- uses **`SENTINEL_NONCE`** (`0xffffffff`, or `KK716_NONCE`) on every EVM
  signature, so a signed transaction can never be mined, even if its bytes leak
  through a log or a shared report.
- leaves **AdvancedMode off**. It is session state on 7.16 (forced off at boot,
  cleared on lock). A suite that turns it on ends with `clearSession`, which
  writes nothing to flash, and uses `applyPolicies(false)` only as a fallback.
- passes only on what the API returns: a signature that recovers to the device
  address, a refusal message, the report Desktop built. It never infers a press
  that did not happen. Which screens appeared is the owner's observation; it is
  printed and never asserted.
- **SKIPs honestly.** `skip(reason)` exits with code 3 and `run-all.js` counts it
  as skipped, never passed. Production's ERC-7730 route answers
  `422 NOT_IN_SIGNED_CATALOG` today, so 02 and 40 SKIP.

Suites pair with Desktop once. The key is saved to `~/.keepkey/sdk-test-api-key`
and reused by every later suite (or set `KEEPKEY_API_KEY`).

## Run one suite at a time

From the vault repo root, with an exact filter:

    make test-sdk filter=fw-716/00-
    make test-sdk filter=fw-716/30-

`filter=fw-716/3` would run all of 30-39 back to back. Env vars pass through
make:

    KK716_ONE_CLICK=1 KEEPKEY_SUITE_TIMEOUT_MS=600000 make test-sdk filter=fw-716/50-

`KEEPKEY_SUITE_TIMEOUT_MS` defaults to 180000 (3 min). Suite 20 needs about
600000.

## Cost tiers

| Tier | Suites | Owner cost |
|---|---|---|
| 0 | 00-06 | no presses (06 may ask for the PIN on Desktop's pad) |
| 1 | 10-14 | Desktop clicks; 14 = 1 view-key export press |
| 2 | 20 | one AdvancedMode session: 1 press + PIN, restored by lock |
| 3 | 30-39 | signing: 1 click + a few presses each |
| - | 40 | SKIP today (nothing served); signs once ERC-7730 is served |
| - | 50 | opt-in (`KK716_ONE_CLICK=1`) |

`fw-715/10` and `fw-715/11` count as 7.16 acceptance (7.15 was never tagged);
both use the sentinel nonce.

## Expected screens per suite (owner watches)

| Suite | Desktop | Device |
|---|---|---|
| 00-05 | nothing | nothing |
| 06 | maybe the PIN pad | no "Trust signer" screen; if one appears, press Cancel: FAIL |
| 10 | card offers Enable Advanced Mode: click **Reject** | nothing |
| 11 | card: Approve | nothing expected; a screen means FAIL |
| 12 | card: Approve, grant the one-shot consent | nothing (refused before any screen) |
| 13 | 2 cards: Approve both | nothing |
| 14 | nothing | export the Zcash view key: confirm |
| 20 | 3 cards: Approve | "Enable Policy" + PIN once; no signing screens; Desktop Cancel if any appears |
| 30 | card: Approve | Verified by KeepKey / bridgeDeposit / depositor / orderId, amount, fee |
| 31 | card | certified intent: transfer of Base USDC to this device |
| 32 | 2 cards | certified Token approval; Shared approval to Permit2 (note when UNLIMITED shows) |
| 33 | 2 cards | certified Relay depositNative / depositErc20 |
| 34 | card | native approve, UNLIMITED warning |
| 35 | 2 cards | THOR Base deposit, Maya Arbitrum deposit |
| 36 | card | TRC-20 USDT transfer |
| 37 | 2 cards | Permit2 in words; "Uniswap Universal Router" name on (a); "Unix time 0" on (b); a past "Signature valid until" |
| 38 | card | certified Uniswap UR swap; "Output goes to" this device |
| 39 | card | certified Solana review |
| 50 | card main button: Enable Advanced Mode | Enable Policy + PIN, then the blind-sign screens |

## Environment

| Var | Default | Used by |
|---|---|---|
| `KK716_NONCE` | `0xffffffff` | every EVM signing suite |
| `KK716_LABEL` | `New7142signed` | 00 |
| `KK716_BOOTLOADER_HASH` | unset (printed only) | 00 |
| `KK716_CLEARSIGN_URL` | `https://keepkey-clearsign.bithighlander.workers.dev` | 01-03, 20, 30-40 |
| `KK716_EXPECT_FINGERPRINT` | `fdd258ec` | 01, 20, 30 |
| `KK716_ALPHA_ENVELOPE` | unset | 20(b) |
| `KK716_RELAY_CHAIN` | `8453` | 33 |
| `KK716_ZCASH_DISPLAY` | unset | 14 |
| `KK716_ERC7730_CALL` | unset | 40 |
| `KK716_ONE_CLICK` | unset | 50 |
| `KEEPKEY_SUITE_TIMEOUT_MS` | `180000` | run-all.js |

Desktop's own `CLEARSIGN_SERVICE_URL` is not visible over REST; the suites query
the worker above directly.

## Shared helpers

`tests/_helpers.js`: `getSdk`, `run`, `assert`, `skip`, `atEnd`,
`SENTINEL_NONCE`, `recoverEvm`, `assertSignedByDevice`, `short`.

`tests/fw-716/_fw716.js` (not a suite: files starting with `_` are skipped):

- device: `deviceAddresses(sdk)`, `advancedMode(features)`, `waitFeatures(sdk)`,
  `requireAdvancedModeOff(sdk, assert)`, `restoreAdvancedMode(sdk)`
- report: `hasRed`, `hasLimitation`, `describeReport`, `assertDeviceConnected`
- worker: `worker(path, body)`, `catalogEntries()`, `findEvmEntry(query)`,
  `requireEvmEntry(name, query)`, `certifiedName(chainId, address)`,
  `evmSchema(...)`, `isProductionEnvelope(body)`
- ERC-7730: `ERC7730_CANDIDATES`, `probeErc7730(c)`, `servedErc7730Candidates()`
- builders: `evmTx({ from, to, data, value, chainId })` (sentinel nonce, 1559
  fees), `reportBody(tx)`, `word`, `randomHex`, `randomAddress`

## Not covered here

ERC-7730 device review on hardware (production serves no definitions yet: rerun
02 and 40 once it does); EIP-712 chunked values above 1024 B (hdwallet caps
leaves; 11 proves only the host guard); a runtime-metadata refusal with
AdvancedMode off (hdwallet swallows it); which screens appeared; card colours
and wording; ClearSign providers; certified contacts; passkeys; Zcash signing,
shield, deshield and TEX (every REST path broadcasts); swap and sweep execute
(they broadcast); the bootloader version (REST reports only its hash); trust
across a physical replug; a power cut during a policy write.
