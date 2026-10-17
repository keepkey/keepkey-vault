# fw-716: released 7.16.0 on real hardware

These suites target a production-root KeepKey on **signed release firmware
7.16.0** (bootloader 2.1.4, label `New7142signed`), driven through the running
Desktop on `:1646`. The device holds **real funds**. Every suite:

- **signs only.** Nothing is broadcast. No wipe, reset, recover or seed load.
- uses **`SENTINEL_NONCE`** (`0xffffffff`, or `KK716_NONCE`) on every EVM
  signature, so a signed transaction can never be mined, even if its bytes leak
  through a log or a shared report. TRON and Solana suites use random
  ref-block/blockhash values for the same reason.
- leaves **AdvancedMode off**. It is session state on 7.16 (forced off at boot,
  cleared on lock). A suite that turns it on ends with `clearSession`, which
  writes nothing to flash, and uses `applyPolicies(false)` only as a fallback.
- passes only on what the API returns: a signature that recovers to the device
  address, a refusal message, the report Desktop built. It never infers a press
  that did not happen. Which screens appeared is the owner's observation; it is
  printed and never asserted.
- **SKIPs honestly.** `skip(reason)` exits with code 3 and `run-all.js` counts it
  as skipped, never passed. A skip after a failed assertion exits 1.

## Pairing

Suites pair with Desktop **once**. The first suite that runs shows one pairing
prompt; its key is saved to `~/.keepkey/sdk-test-api-key` and every later suite
reuses it. Desktop only asks again if it rejects the saved key.

`KEEPKEY_API_KEY`, when set, wins over the saved key. If Desktop rejects it, the
suite pairs again, prints a WARNING, and does not save the new key: unset the
variable or every suite will ask to pair.

Only this branch has the saved key. A checkout without it (`tests/_helpers.js`
that reads only `KEEPKEY_API_KEY`) pairs once per suite.

## Run one suite at a time

From the vault repo root, with the two-digit number and a trailing dash:

    make test-sdk filter=fw-716/00-

Each `fw-716/NN-` filter matches exactly one file. `filter=fw-716/3` would run
all of 30-39 back to back. Env vars pass through make:

    KEEPKEY_SUITE_TIMEOUT_MS=600000 make test-sdk filter=fw-716/20-

`KEEPKEY_SUITE_TIMEOUT_MS` defaults to 180000 (3 min). Suites that need more
SKIP with 0 presses when it is too low, instead of being killed mid-sign: 32
and 33 need 360000, 20 and 50 need 600000.

## Run list, in order

Presses = device button presses. Clicks = Desktop approval cards. Any device
operation may first ask for the PIN if the device is locked.

| # | Command | Owner cost | What a pass proves |
|---|---|---|---|
| 00 | `make test-sdk filter=fw-716/00-` | 0 | The device is released 7.16.0 (hash `99ebac75…`), not the emulator; label, initialized, AdvancedMode off; capabilities 4/5/13/17/18/25/26/27 when Desktop exposes them. Prints the ETH/SOL/TRON addresses. |
| 01 | `make test-sdk filter=fw-716/01-` | 0 (network only) | The production worker is up (root `027c1fde`), 474+ catalog entries, a VERIFIED bridgeDeposit envelope (keyId 0x80, fingerprint `fdd258ec`), and the entries later suites need. |
| 02 | `make test-sdk filter=fw-716/02-` | 0 | **SKIP today**: production ERC-7730 answers 422 for every candidate. Once served: Desktop attaches the definition (source `erc7730`). |
| 03 | `make test-sdk filter=fw-716/03-` | 0 | Desktop's verdict matrix (shapes A-N): native, certified, raw data and red findings land where 7.16.0 says. |
| 04 | `make test-sdk filter=fw-716/04-` | 0 | Solana decode preview: a self-transfer is green with no consent; an unknown program is red; Relay depositNative decodes and the worker certifies it. |
| 05 | `make test-sdk filter=fw-716/05-` | 0 | Binance routes are gone (404); the SDK no longer exposes 4 dead methods; a CAIP swap quote works (SKIP if offline). |
| 06 | `make test-sdk filter=fw-716/06-` | 0 (PIN pad maybe) | Runtime signers need AdvancedMode; `persist:true` is refused by Desktop; nothing is loaded. |
| 10 | `make test-sdk filter=fw-716/10-` | 1 click (**Reject**) | An unknown contract is red and the card blocks it with AdvancedMode off. |
| 11 | `make test-sdk filter=fw-716/11-` | 1 click | hdwallet refuses a >1024-byte EIP-712 leaf on the host. Known gap: cap 26 not exercised. |
| 12 | `make test-sdk filter=fw-716/12-` | 1 click (Approve; grant consent if asked) | No signature when the device key is not a signer. **SKIPs today**: Desktop refuses first, so the firmware check is not reached. |
| 13 | `make test-sdk filter=fw-716/13-` | 2 clicks | An untrusted TRC-20 and a TIP-712 hash are not signed with AdvancedMode off. Prints which layer refused. |
| 14 | `make test-sdk filter=fw-716/14-` | 0-1 press (+1 with `KK716_ZCASH_DISPLAY=1`) | Zcash service ready and Desktop's cached view key matches this device. Never sends. |
| 20 | `KEEPKEY_SUITE_TIMEOUT_MS=600000 make test-sdk filter=fw-716/20-` | 1 press + PIN, 3 clicks | AdvancedMode turns on, certified claims that fail are refused (never downgraded), and a lock turns AdvancedMode off (cap 17). |
| 30 | `make test-sdk filter=fw-716/30-` | 1 click + ~3-4 presses | Certified Relay bridgeDeposit (0x02 body) signs with AdvancedMode off; source `certified`, P4. |
| 31 | `make test-sdk filter=fw-716/31-` | 1 click + ~3-5 presses | Certified intent: Base USDC transfer on chain 8453. |
| 32 | `KEEPKEY_SUITE_TIMEOUT_MS=360000 make test-sdk filter=fw-716/32-` | 2 clicks + ~6-10 presses | Certified Token approval and unlimited Shared approval to Permit2. |
| 33 | `KEEPKEY_SUITE_TIMEOUT_MS=360000 make test-sdk filter=fw-716/33-` | 2 clicks + ~6-10 presses | Certified Relay depositNative and depositErc20 on Base (`KK716_RELAY_CHAIN=42161` for Arbitrum). |
| 34 | `make test-sdk filter=fw-716/34-` | 1 click + ~3-4 presses | An approve of 2^255 counts as unlimited: red in the report, still signs. |
| 35 | `make test-sdk filter=fw-716/35-` | 2 clicks + ~9 and ~8 presses | THOR on Base and Maya on Arbitrum clear-sign natively with AdvancedMode off. |
| 36 | `make test-sdk filter=fw-716/36-` | 1 click + ~2 presses | TRC-20 USDT clear-signs; the signature recovers to the device's TRON address. |
| 37 | `make test-sdk filter=fw-716/37-` | 2 clicks + ~9 presses each | Permit2 typed data signs; signatures recover to the device. |
| 38 | `make test-sdk filter=fw-716/38-` | 1 click + ~4-6 presses | Certified Uniswap UR swap on a Base catalog router. |
| 39 | `make test-sdk filter=fw-716/39-` | 1 click + several presses | Certified Solana review signs with AdvancedMode off; source `certified`, `KKSOLSC1`. |
| 40 | `make test-sdk filter=fw-716/40-` | 0 (**SKIP today**) | Once production serves ERC-7730: a certified-tier ERC-7730 review signs with AdvancedMode off. |
| 50 | `KK716_ONE_CLICK=1 KEEPKEY_SUITE_TIMEOUT_MS=600000 make test-sdk filter=fw-716/50-` | 1 click + Enable Policy + PIN + ~2-3 presses | Opt-in. The card's main button turns AdvancedMode on and signs; a lock turns it off. |

`fw-715/10` and `fw-715/11` also count as 7.16 acceptance (7.15 was never
tagged); both use the sentinel nonce.

## Expected screens per suite (owner watches)

| Suite | Desktop | Device |
|---|---|---|
| 00-05 | nothing | nothing |
| 06 | maybe the PIN pad | no "Trust signer" screen; if one appears, press Cancel: FAIL |
| 10 | card offers Enable Advanced Mode: click **Reject** | nothing |
| 11 | card: Approve | nothing expected; a screen means FAIL |
| 12 | card: Approve, grant the one-shot consent | nothing. Desktop refuses before the device is asked ("is not a required transaction signer") |
| 13 | 2 cards: Approve both | nothing |
| 14 | nothing | export the Zcash view key: confirm (none if Desktop already holds it) |
| 20 | 3 cards: Approve | "Enable Policy" + PIN once; no signing screens; Desktop Cancel if any appears. (c) is refused by Desktop before the device |
| 30 | card: Approve | Verified by KeepKey / bridgeDeposit / depositor / orderId, amount, fee |
| 31 | card | certified intent: transfer of Base USDC to this device |
| 32 | 2 cards | certified Token approval; Shared approval to Permit2 (note when UNLIMITED shows) |
| 33 | 2 cards | certified Relay depositNative / depositErc20 |
| 34 | card | native approve, UNLIMITED warning |
| 35 | 2 cards | Routing through router, Pays UNVERIFIED vault, amount, expiry (THOR only), 3 swap screens, memo pages, final confirm |
| 36 | card | TRC-20 USDT transfer |
| 37 | 2 cards | Permit2 summary, Limits, Token, Spender, Details; "Uniswap Universal Router" named on (a); expiration 0 on (b) reads "until the end of the block that uses this permit"; a past "Signature valid until" |
| 38 | card | certified Uniswap UR swap; "Output goes to" this device |
| 39 | card | certified Solana review |
| 50 | card main button: Enable Advanced Mode | Enable Policy + PIN, then the blind-sign screens |

## Environment

| Var | Default | Used by |
|---|---|---|
| `KEEPKEY_API_KEY` | unset (saved key used) | every suite |
| `KK716_NONCE` | `0xffffffff` | every EVM signing suite |
| `KK716_LABEL` | `New7142signed` | 00 |
| `KK716_BOOTLOADER_HASH` | unset (printed only) | 00 |
| `KK716_CLEARSIGN_URL` | `https://keepkey-clearsign.bithighlander.workers.dev` | 01-03, 20, 30-40 |
| `KK716_EXPECT_FINGERPRINT` | `fdd258ec` | 01, 20, 30, 37 |
| `KK716_ALPHA_ENVELOPE` | unset | 20(b) |
| `KK716_RELAY_CHAIN` | `8453` | 33 |
| `KK716_ZCASH_DISPLAY` | unset | 14 |
| `KK716_ERC7730_CALL` | unset | 40 |
| `KK716_ONE_CLICK` | unset | 50 |
| `KEEPKEY_SUITE_TIMEOUT_MS` | `180000` | run-all.js; 20, 32, 33, 50 SKIP below their minimum |

Desktop's own `CLEARSIGN_SERVICE_URL` is not visible over REST; the suites query
the worker above directly.

Delegate fingerprints differ by catalog batch: batch 1 (chain-1 bridgeDeposit,
chain-1 names) is `fdd258ec` and is the only one gated on; batch 2 (Base and
Arbitrum intents, the UR swap) is `fc91f86a`; the Solana delegate is
`a6608649`. 31-33 and 39 print theirs.

## Shared helpers

`tests/_helpers.js`: `getSdk`, `run`, `assert`, `skip`, `atEnd`,
`SENTINEL_NONCE`, `recoverEvm`, `assertSignedByDevice`, `short`.

`tests/fw-716/_fw716.js` (not a suite: files starting with `_` are skipped):

- device: `deviceAddresses(sdk)`, `advancedMode(features)`, `waitFeatures(sdk)`,
  `requireAdvancedModeOff(sdk, assert)`, `restoreAdvancedMode(sdk)`
- report: `hasRed`, `hasLimitation`, `describeReport`, `assertDeviceConnected`
- worker: `worker(path, body)`, `catalogEntries()`, `findEvmEntry(query)`,
  `requireEvmEntry(name, query)`, `certifiedName(chainId, address)`,
  `evmSchema(...)`, `isProductionEnvelope(body)` (batch-1 fingerprint)
- ERC-7730: `ERC7730_CANDIDATES`, `probeErc7730(c)`, `servedErc7730Candidates()`
- builders: `evmTx({ from, to, data, value, chainId })` (sentinel nonce, 1559
  fees), `reportBody(tx)`, `word`, `randomHex`, `randomAddress`

`tests/fixtures/fw-716/solana-tron.js`: Solana and TRON transaction builders
for 04, 12, 13, 36 and 39.

## Not covered over REST, and how to check by hand

| Gap | Why | Check by hand |
|---|---|---|
| ERC-7730 device review | production serves no definitions yet (422) | rerun 02 and 40 once it does; emulator: `make test-emu-erc7730` |
| EIP-712 chunked values >1024 B (cap 26) | hdwallet caps leaves on the host | 11 proves only the host guard |
| Solana "not a signer" firmware check (F-715-1) | Desktop refuses first (12, 20c) | python-keepkey or the emulator, bypassing Desktop |
| Runtime-metadata refusal with AdvancedMode off | hdwallet swallows the Failure | read Desktop's log line |
| Which screens appeared | REST has no ButtonRequest counts on hardware | watch the device against the table above |
| Card colours and wording | UI only | 03 asserts the data behind them |
| ClearSign providers, certified contacts, passkeys | no REST route | Desktop Settings / send dialog / a browser WebAuthn ceremony (never "Delete all passkeys") |
| Zcash signing, shield, deshield, TEX; swap and sweep execute | every REST path broadcasts | Desktop UI with funds you intend to move |
| Bootloader 2.1.4 version | REST reports only its hash | compare the hash 00 prints |
| Trust across a physical replug | needs a replug | 20 covers the lock path |
| Power cut during a policy write | accepted pre-7.17 risk | 20 holds flash writes to one; 50 is opt-in |
