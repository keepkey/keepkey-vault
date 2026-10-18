# fw-716: released 7.16.0 on real hardware

These suites target a production-root KeepKey on **signed release firmware
7.16.0** (bootloader 2.1.4, label `New7142signed`), driven through the running
Desktop on `:1646`. The device holds **real funds**. Every suite:

- **signs only.** Nothing is broadcast. No wipe, reset, recover or seed load.
- uses **`SENTINEL_NONCE`** (`0xffffffff`, fixed, no override) on every EVM
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
  as skipped, never passed. A skip after a failed assertion exits 1. A suite
  where some part did not run (`NOT COVERED: ...` lines) and nothing failed
  ends **PARTIAL**, also exit 3: a half-run suite never reads as passed.
- **cleans up when killed.** A run-all timeout (SIGTERM) or Ctrl-C (SIGINT)
  still runs the suite's end checks, e.g. turning AdvancedMode back off.

## Pairing

Suites pair with Desktop **once**. The first suite that runs shows one pairing
prompt; its key is saved to `~/.keepkey/sdk-test-api-key` (mode 600) and every
later suite reuses it. The key a suite ends with is saved at exit, so a
re-pair in the middle of a suite (a 401) does not make the next suite pair
again.

Desktop asks again only when the saved key is refused. A slow or busy Desktop
can also cause that: the SDK treats a timed-out key check as a rejected key.

`KEEPKEY_API_KEY`, when set, is tried first. If Desktop rejects it and a saved
key exists, the saved key is used instead (WARNING printed).

Only this branch (`test/sdk-fw716`) has the saved key. A checkout without it,
such as `local/erc7730-test`, whose `tests/_helpers.js` reads only
`KEEPKEY_API_KEY`, **pairs once per suite**. Run the suites from this branch's
checkout.

## Desktop build

The capability checks (00, and the cap-17 flag in 20) need Desktop to expose
`Features.capabilities` (commit `faa3c6da4`, on this branch).
`local/erc7730-test` does not have it: on that build 00 ends PARTIAL with
"capabilities NOT CHECKED". Rebuild Desktop with `faa3c6da4` to check them.

## Run one suite at a time

From the vault repo root, with the two-digit number and a trailing dash:

    make test-sdk filter=fw-716/00-

Each `fw-716/NN-` filter matches exactly one file. `filter=fw-716/3` would run
all of 30-39 back to back. Env vars pass through make:

    KEEPKEY_SUITE_TIMEOUT_MS=900000 make test-sdk filter=fw-716/20-

`KEEPKEY_SUITE_TIMEOUT_MS` defaults to 180000 (3 min). Suites that need more
SKIP with 0 presses when it is too low, instead of being killed mid-sign: 32,
33, 35 and 37 need 360000; 41 and 43 need 540000; 20 and 50 (which turn
AdvancedMode on) need 900000.

## Run list, in order

Presses = device button presses. Clicks = Desktop approval cards. Any device
operation may first ask for the PIN if the device is locked.

| # | Command | Owner cost | What a pass proves |
|---|---|---|---|
| 00 | `make test-sdk filter=fw-716/00-` | 0 | The device is released 7.16.0 (hash `99ebac75…`), not the emulator; label, initialized, AdvancedMode off; capabilities 4/5/13/17/18/25/26/27 (PARTIAL when Desktop lacks `faa3c6da4`). Prints the ETH/SOL/TRON addresses. |
| 01 | `make test-sdk filter=fw-716/01-` | 0 (network only) | The production worker is up (root `027c1fde`), 474+ catalog entries, a VERIFIED bridgeDeposit envelope (keyId 0x80, fingerprint `fdd258ec`), and the entries later suites need. |
| 02 | `make test-sdk filter=fw-716/02-` | 0 | **SKIP today**: production ERC-7730 answers 404/422 for every candidate. Once served: Desktop attaches the definition (source `erc7730`). |
| 03 | `make test-sdk filter=fw-716/03-` | 0 | Desktop's verdict matrix (shapes A-N): native, certified, raw data, red and yellow lines land where 7.16.0 says. |
| 04 | `make test-sdk filter=fw-716/04-` | 0 | Solana decode preview: a self-transfer is green with no consent; an unknown program is red; Relay depositNative decodes and the worker certifies it. |
| 05 | `make test-sdk filter=fw-716/05-` | 0 | Binance routes are gone (404); the SDK no longer exposes 4 dead methods; a CAIP swap quote works (SKIP if offline). |
| 06 | `make test-sdk filter=fw-716/06-` | 0 (PIN pad maybe) | Runtime signers need AdvancedMode; `persist:true` is refused by Desktop; nothing is loaded. |
| 10 | `make test-sdk filter=fw-716/10-` | 1 click (**Reject**) | An unknown contract is red in Desktop's report (source `none`, raw data) and nothing is signed. That the card blocks Approve is owner-observed. |
| 11 | `make test-sdk filter=fw-716/11-` | 1 click | hdwallet refuses a >1024-byte EIP-712 leaf on the host. Known gap: cap 26 not exercised. |
| 12 | `make test-sdk filter=fw-716/12-` | 1 click (Approve; grant consent if asked) | No signature when the device key is not a signer. **SKIPs today**: Desktop refuses first, so the firmware check is not reached. |
| 13 | `make test-sdk filter=fw-716/13-` | 1 click (**Approve**) | The FIRMWARE refuses an untrusted TRC-20 with AdvancedMode off ("Enable AdvancedMode to blind-sign"). A card 403 is INCONCLUSIVE (FAIL). |
| 14 | `KK716_ZCASH_DISPLAY=1 make test-sdk filter=fw-716/14-` | 1 press (+1 if Desktop has no remembered view key) | Zcash service ready, and the address the device derives equals Desktop's cached address. Without `KK716_ZCASH_DISPLAY=1` it SKIPs (ownership not proven). Never sends. |
| 20 | `KEEPKEY_SUITE_TIMEOUT_MS=900000 make test-sdk filter=fw-716/20-` | 1 press + PIN, 2 clicks | AdvancedMode turns on, certified claims that fail are refused before any screen (never downgraded), and a lock turns AdvancedMode off (cap 17). |
| 30 | `make test-sdk filter=fw-716/30-` | 1 click + ~3-4 presses | Certified Relay bridgeDeposit (0x02 body) signs with AdvancedMode off; source `certified`, P4. |
| 31 | `make test-sdk filter=fw-716/31-` | 1 click + ~3-5 presses | Certified intent: Base USDC transfer on chain 8453. |
| 32 | `KEEPKEY_SUITE_TIMEOUT_MS=360000 make test-sdk filter=fw-716/32-` | 2 clicks + ~6-10 presses | Certified Token approval and unlimited Shared approval to Permit2. |
| 33 | `KEEPKEY_SUITE_TIMEOUT_MS=360000 make test-sdk filter=fw-716/33-` | 2 clicks + ~6-10 presses | Certified Relay depositNative and depositErc20 on Base (`KK716_RELAY_CHAIN=42161` for Arbitrum). |
| 34 | `make test-sdk filter=fw-716/34-` | 1 click + ~3-4 presses | A native approve of 2^255 signs with AdvancedMode off; Desktop's report is red. The device's UNLIMITED threshold is owner-observed, NOT PROVEN. |
| 35 | `KEEPKEY_SUITE_TIMEOUT_MS=360000 make test-sdk filter=fw-716/35-` | 2 clicks + ~9 and ~8 presses | THOR on Base and Maya on Arbitrum clear-sign natively with AdvancedMode off. |
| 36 | `make test-sdk filter=fw-716/36-` | 1 click + ~2 presses | TRC-20 USDT clear-signs; the signature recovers to the device's TRON address. |
| 37 | `KEEPKEY_SUITE_TIMEOUT_MS=360000 make test-sdk filter=fw-716/37-` | 2 clicks + ~9 presses each | Permit2 typed data signs; signatures recover to the device; a certified name record exists for the Universal Router. The review in words and the name on the device are owner-observed. |
| 38 | `make test-sdk filter=fw-716/38-` | 1 click + ~4-6 presses | Certified Uniswap UR swap on a Base catalog router. |
| 39 | `make test-sdk filter=fw-716/39-` | 1 click + several presses | Certified Solana review signs with AdvancedMode off; source `certified`, `KKSOLSC1`. |
| 40 | `make test-sdk filter=fw-716/40-` | 0 (**SKIP today**) | Once production serves ERC-7730: a certified-tier ERC-7730 review signs with AdvancedMode off. |
| 41 | `KEEPKEY_SUITE_TIMEOUT_MS=540000 make test-sdk filter=fw-716/41-` | 3 clicks + ~3-4 presses each | ERC-20 calls sign with AdvancedMode off: USDT transfer and LINK approve on chain 1 (native controls: both are in the 7.16 token table, so Desktop never uses their batch 3a entry), USDC transfer on Polygon (batch 3a, certified). SKIPs if AdvancedMode is on. |
| 42 | `make test-sdk filter=fw-716/42-` | 1 click + ~3-4 presses | Batch 2: certified Shared approval of USDT0 to Permit2 on Arbitrum signs with AdvancedMode off. SKIPs if AdvancedMode is on. |
| 43 | `KEEPKEY_SUITE_TIMEOUT_MS=540000 make test-sdk filter=fw-716/43-` | 3 clicks + several presses each | Batch 4 ERC-7730: Aave supply on Base and Arbitrum, Lido submit on chain 1 sign with AdvancedMode off (source `erc7730`). SKIPs if AdvancedMode is on. |
| 50 | `KK716_ONE_CLICK=1 KEEPKEY_SUITE_TIMEOUT_MS=900000 make test-sdk filter=fw-716/50-` | 1 click + Enable Policy + PIN + ~2-3 presses | Opt-in. The card's main button turns AdvancedMode on and signs; a lock turns it off. |
| 715/10 | `make test-sdk filter=fw-715/10-` | 3 clicks + ~3-6 presses | 7.15 fix carried into 7.16: type-2 signatures on Base, Arbitrum and Avalanche (chainId >= 256) recover to the device. Self-send, sentinel nonce. |
| 715/11 | `KK_ALLOW_BLIND=1 make test-sdk filter=fw-715/11-` | Opt-in: turn AdvancedMode on in Desktop first (Enable Policy + PIN), then 1 click + ~2-3 blind-sign presses | 7.15 fix carried into 7.16: >1024-byte calldata keeps the access list last. SKIPs unless AdvancedMode is on; ends with clearSession (AdvancedMode off, no press). |

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
| 13 | card: **Approve** (never Enable Advanced Mode) | nothing; the firmware refuses before any screen |
| 14 | nothing | maybe "Export Zcash view key" (only if Desktop has none remembered): confirm; then the unified address: note start and end, confirm |
| 20 | 2 cards: Approve | "Enable Policy" + PIN once; no signing screens; Desktop Cancel if any appears. If the suite says the policy prompt may still be up, press Cancel on the device |
| 30 | card: Approve | Verified by KeepKey / bridgeDeposit / depositor / orderId, amount, fee |
| 31 | card | certified intent: transfer of Base USDC to this device |
| 32 | 2 cards | certified Token approval; Shared approval to Permit2 (note when UNLIMITED shows) |
| 33 | 2 cards | certified Relay depositNative / depositErc20 |
| 34 | card | native approve; note whether UNLIMITED shows (owner-observed) |
| 35 | 2 cards | Routing through router, Pays UNVERIFIED vault, amount, expiry (THOR only), 3 swap screens, memo pages, final confirm |
| 36 | card | TRC-20 USDT transfer |
| 37 | 2 cards | Permit2 summary, Limits, Token, Spender, Details; "Uniswap Universal Router" named on (a); expiration 0 on (b) reads "until the end of the block that uses this permit"; a past "Signature valid until" |
| 38 | card | certified Uniswap UR swap; "Output goes to" this device |
| 39 | card (a card offering Enable Advanced Mode means Desktop did not attach the review: Reject) | certified Solana review |
| 41 | 3 cards (a second card offering Enable Advanced Mode: Reject) | send 1 USDT; approve Permit2 for 1 LINK; certified "USDC transfer" 1 USDC on Polygon |
| 42 | card | certified "Shared approval": Permit2 may spend up to 1 USDT0 |
| 43 | 3 cards (a second card offering Enable Advanced Mode: Reject) | ERC-7730 review: Aave "Supply" 1 USDC (Base, Arbitrum); Lido "Stake ETH" 0.000001 ETH |
| 50 | card main button: Enable Advanced Mode | Enable Policy + PIN, then the blind-sign screens |
| 715/10 | 3 cards: Approve | 3 self-sends (Base, Arbitrum, Avalanche): amount and fee |
| 715/11 | card: Approve | blind-sign data screens, then amount and fee |

## Environment

| Var | Default | Used by |
|---|---|---|
| `KEEPKEY_API_KEY` | unset (saved key used) | every suite |
| `KK716_LABEL` | `New7142signed` | 00 |
| `KK716_BOOTLOADER_HASH` | unset (printed only) | 00 |
| `KK716_CLEARSIGN_URL` | `https://keepkey-clearsign.bithighlander.workers.dev` | 01-03, 20, 30-43 |
| `KK716_EXPECT_FINGERPRINT` | `fdd258ec` | 01, 20, 30, 37 |
| `KK716_ALPHA_ENVELOPE` | unset (20(b) then uses a tampered production envelope) | 20(b) |
| `KK716_RELAY_CHAIN` | `8453` | 33 |
| `KK716_ZCASH_DISPLAY` | unset | 14 |
| `KK716_ERC7730_CALL` | unset | 40 |
| `KK716_ONE_CLICK` | unset | 50 |
| `KEEPKEY_SUITE_TIMEOUT_MS` | `180000` | run-all.js; 32, 33, 35, 37 SKIP below 360000, 41 and 43 below 540000, 20 and 50 below 900000 |

Desktop's own `CLEARSIGN_SERVICE_URL` is not visible over REST; the suites query
the worker above directly.

Delegate fingerprints differ by catalog batch: batch 1 (chain-1 bridgeDeposit,
chain-1 names) is `fdd258ec` and is the only one gated on; batch 2 (Base and
Arbitrum intents, the UR swap) is `fc91f86a`; the Solana delegate is
`a6608649`. 31-33 and 39 print theirs.

## Shared helpers

`tests/_helpers.js`: `getSdk`, `run`, `assert`, `skip`, `notCovered`, `atEnd`,
`SENTINEL_NONCE`, `recoverEvm`, `assertSignedByDevice`, `short`.

`tests/fw-716/_fw716.js` (not a suite: files starting with `_` are skipped):

- device: `deviceAddresses(sdk)`, `advancedMode(features)`, `waitFeatures(sdk)`,
  `requireAdvancedModeOff(sdk, assert)`, `requireClearSignOnly(sdk, cap)` (SKIP
  before 7.16.0, without `cap`, or with AdvancedMode on), `restoreAdvancedMode(sdk)`,
  `guardAdvancedModeOff(sdk, assert)` (end check: still off, else restore and FAIL)
- report: `hasRed`, `hasLimitation`, `describeReport`, `assertDeviceConnected`
- worker: `worker(path, body)`, `catalogEntries()`, `findEvmEntry(query)`,
  `requireEvmEntry(name, query)`, `certifiedName(chainId, address)`,
  `evmSchema(...)`, `isProductionEnvelope(body)` (batch-1 fingerprint)
- ERC-7730: `ERC7730_CANDIDATES`, `probeErc7730(c)`, `servedErc7730Candidates()`
- sign cases (41-43): `signCases(getSdk, assert, cases, { cap, minBudgetMs })`,
  `probeEvmSchema(...)`, `probeErc7730Case(...)` (a worker non-200 is NOT COVERED, named)
- builders: `evmTx({ from, to, data, value, chainId })` (sentinel nonce, 1559
  fees), `reportBody(tx)`, `word`, `randomHex`, `randomAddress`

`tests/fixtures/fw-716/solana-tron.js`: Solana and TRON transaction builders
for 04, 12, 13, 36 and 39.

## Not covered over REST, and how to check by hand

| Gap | Why | Check by hand |
|---|---|---|
| ERC-7730 device review | production serves no definitions yet (404/422) | rerun 02 and 40 once it does; emulator: `make test-emu-erc7730` |
| EIP-712 chunked values >1024 B (cap 26) | hdwallet caps leaves on the host | 11 proves only the host guard |
| Solana "not a signer" firmware check (F-715-1) | Desktop's signer check refuses first (12) | python-keepkey or the emulator, bypassing Desktop |
| Solana strict parse (trailing bytes: "Malformed Solana transaction"; a padded instruction: OPAQUE) | Desktop's parser refuses trailing bytes before the device (solana-signing.ts); a padded instruction is predicted OPAQUE, so the card asks for AdvancedMode up front | python-keepkey or the emulator, bypassing Desktop |
| TRON TIP-712 hash refusal with AdvancedMode off | Desktop's card disables Approve until AdvancedMode is on (`/tron/sign-typed-hash` is blind) | python-keepkey or the emulator |
| Device refusing an alpha/test-root envelope | no alpha-root fixture in the repo; 20(b) then checks a tampered production envelope | get a 0x03 envelope from an alpha worker (`POST /v1/evm/schema` for Relay bridgeDeposit chain 1, calldataLength 68), set `KK716_ALPHA_ENVELOPE`, rerun 20: (b) then proves the alpha root is refused |
| The card disabling Approve with AdvancedMode off (10) | a 403 shows only that Reject was clicked | watch the card: Approve greyed, main button Enable Advanced Mode |
| Device UNLIMITED threshold at 2^255 (34) | Desktop's red line is its own uint96 rule; screens are not visible over REST | watch for UNLIMITED in 34 |
| Permit2 in words (cap 13) and the certified spender name (37) | released 7.16 streams EIP-712 regardless of AdvancedMode; a signature proves only that a review was confirmed | watch 37 against the screens table |
| Capabilities 4/5/13/17/18/25/26/27 | `local/erc7730-test` Desktop lacks `faa3c6da4` | rebuild Desktop with it and rerun 00 |
| Zcash view-key ownership via verify-device | Desktop answers from the key it remembers | 14 with `KK716_ZCASH_DISPLAY=1` (the device derives the address) |
| Runtime-metadata refusal with AdvancedMode off | hdwallet swallows the Failure | read Desktop's log line |
| Which screens appeared | REST has no ButtonRequest counts on hardware | watch the device against the table above |
| Card colours and wording | UI only | 03 asserts the data behind them |
| Adding a ClearSign provider | Desktop Settings only | add it in Settings; then, in an AdvancedMode session, a REST `/eth/sign-transaction` to its contract carries `descriptor.provider` in the report (opt-in: `evm-clearsign/provider-live-sign-flow.js`) |
| Certified contacts, passkeys | no REST route | Desktop send dialog / a browser WebAuthn ceremony (never "Delete all passkeys") |
| Zcash signing, shield, deshield, TEX; swap and sweep execute | every REST path broadcasts | Desktop UI with funds you intend to move |
| Bootloader 2.1.4 version | REST reports only its hash | compare the hash 00 prints |
| Trust across a physical replug | needs a replug | 20 covers the lock path |
| Power cut during a policy write | accepted pre-7.17 risk | 20 holds flash writes to one; 50 is opt-in |
