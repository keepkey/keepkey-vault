# keepkey-sdk device tests

These suites drive a KeepKey through KeepKey Desktop's REST API (port 1646),
the same way a third-party app does. Run them with the Makefile at the repo
root:

```
make test-sdk                       # every suite except recovery/*
make test-sdk filter=evm-native     # suites whose path contains "evm-native"
```

`recovery/*` wipes the device and runs only with `KEEPKEY_ALLOW_WIPE=1`.

## Two things are checked

1. **The request works.** Each suite asserts on what the SDK call returns
   (a signature, an address, a refusal).
2. **The user was shown the right thing.** A signature coming back does not
   prove that. While a suite runs, Desktop records what it and the device
   showed, and the runner compares it with a reviewed copy.

The second check needs the emulator; see "Reviewing what was shown" below.
Against real hardware, or without the test switch, suites still run and the
runner prints `NOT REVIEWED`.

## Suite classes

Every suite is listed in `review/suites.json` with a class and a reason. A
suite that is not listed fails the run as `UNCLASSIFIED`.

| Class | What it is | What the runner requires |
|---|---|---|
| `real-world` | A trade or action a normal user or dapp performs | The suite passes and shows at least one approval card; every card reads "Low risk" (or has no risk bar); no blind-signing prompt; no device screen says BLOCKED, AdvancedMode, blind or Unknown; and everything shown matches the reviewed copy exactly |
| `must-warn` | A request that is risky on purpose (unlimited approval, unreadable call, an app that lies) | At least one warning is shown, and what is shown matches the reviewed copy |
| `edge-case` | Hostile or invalid input, firmware regressions, signer-mechanism tests | Recorded, not judged |
| `no-signing` | Reads data or runs offline | Nothing is shown for approval |

When you add a suite, add it to `review/suites.json`. If it is a normal user
action, it is `real-world`, and a warning on it is a bug in Desktop, the
ClearSign catalog or the firmware, not something to reclassify away.

## Reviewing what was shown

Start Desktop on the emulator with a **throwaway** wallet and the test
switches:

```
KEEPKEY_AUTOSTART_EMULATOR_FLASH=<throwaway wallet name> \
KEEPKEY_TEST_EMULATOR_CONTROL=1 \
KEEPKEY_TEST_APPROVE_HOST_SIGNING=1 \
make dev
```

- `KEEPKEY_TEST_EMULATOR_CONTROL=1` turns on `POST /emulator/test-tape` and
  makes the emulator ignore clicks in its own window.
- `KEEPKEY_TEST_APPROVE_HOST_SIGNING=1` approves Desktop's own card so the
  request reaches the device. The card's content is still recorded.

Never point this at a wallet that holds funds: every device confirmation is
pressed automatically while a suite is being recorded.

For each suite the runner turns the tape on, runs the suite, and takes the
tape. An entry is one of:

```json
{ "card": "/eth/sign-transaction", "level": "low",
  "reasons": ["low: Sends 0.0001 ETH to 0x0000…0001."], "blind": false }

{ "screen": "ethSignTx",
  "lines": ["SEND", "Send 0.0001 ETH to", "0x00000000000000000000000000000000000", "00001"] }
```

- **card**: the risk bar of the Desktop approval card for that request. `level`
  is `low` (teal), `medium` (gold), `high` or `critical` (red), or `none` when
  the request type has no risk bar.
- **screen**: the text of one device confirmation, top to bottom, in the order
  the device showed them.

### How device screens are read

Desktop hands over the raw display buffer the firmware drew (256x64, one bit
per pixel). `_review.js` matches it against the firmware's own font tables
(`fixtures/oled-font.json`), so each character is an exact pixel match of a
firmware glyph. There is no OCR and nothing is guessed. Icons and progress
bars are not text and are left out.

Regenerate the font table when the firmware fonts change:

```
node scripts/build-oled-font.js <keepkey-firmware>/lib/board/font.c
```

### Reviewed copies

`review/shown/<suite>.json` is the reviewed copy of a suite's tape: what the
user is supposed to see for that suite, card by card and screen by screen.
The runner fails a `real-world` or `must-warn` suite whose tape differs.

To write or update the copies:

```
KEEPKEY_REVIEW=record make test-sdk filter=<suite>
git diff projects/keepkey-sdk/tests/review/shown
```

Read the diff before committing it. Recording does not make a suite healthy:
the health rules above still apply to what was recorded.

The copies depend on the firmware in the emulator. A firmware change that
rewords a screen shows up here as a diff, which is the point.

## Reading the result

```
What was shown (cards = Desktop approval cards, screens = device confirmations):
healthy      pass  cards  1  screens   2  evm-native/eth-send.js
UNHEALTHY    pass  cards  1  screens   3  evm-clearsign/…
```

`pass`/`FAIL` is the suite's own assertions. The first column is the review:
`healthy`, `warned` (a `must-warn` suite that warned), `UNHEALTHY`,
`edge-case`, `no-signing` or `UNCLASSIFIED`. The run exits non-zero when any
suite fails, is `UNHEALTHY` or is `UNCLASSIFIED`.
