# fw-715 — the 7.15 delta, and nothing else

Every other suite in `tests/` exercises the SDK surface as a whole. This one
covers only what **changed in 7.15 relative to 7.14.1**, so a release candidate
can be signed off without hand-confirming a hundred transactions that 7.14.1
already signed correctly.

Run it:

    make test-sdk filter=fw-715        # from the vault repo root

## Cost tiers

Suites are named so the cheap ones sort first, because device confirmations are
the scarce resource here.

| Tier | Suite | Device presses |
|---|---|---|
| 0 | `00-capabilities.js` | **none** |
| 1 | `10-evm-large-chainid.js` | 3 |
| — | `11-evm-1559-chunked-data.js` | **skipped by default** |

Three presses total. Tier 0 alone is worth running on every build — it is
instant, needs no interaction, and catches a device that is not what it claims
to be.

## What is covered, and why each one earns a press

**`00-capabilities.js`** — the device reports 7.15+, a non-zero firmware hash,
Taproot support, and the policy state the signing suites depend on. It also
fails loudly when `AdvancedMode` is ON, because that silently disables the
blind-sign gate and turns several "rejected correctly" results elsewhere into
false greens.

**`10-evm-large-chainid.js`** — the headline fix. On 7.14.1 and earlier, an
EIP-1559 transaction on any chain with `chainId >= 256` hashed only the low
byte of the chain id, so the signature recovered to a stranger's address and
the network dropped the transaction. Base (8453), Arbitrum (42161), and
Avalanche (43114) are all affected; `8453 & 0xFF == 5`, so Base was signing as
if it were Goerli. Every existing 1559 test in this repo uses `chainId: 1`,
which is exactly the value that cannot detect this.

**`11-evm-1559-chunked-data.js`** (opt-in) — firmware hashed the empty access-list byte
`0xC0` *between* data chunks when `data` exceeded the 1024-byte single-chunk
threshold, producing a non-canonical pre-image whose signature recovered to a
wrong-but-deterministic address. Every Uniswap Universal Router swap, Permit2
batch, and large multicall hit it. Fixed by
`finalize_eip1559_and_send_signature()` in `lib/firmware/ethereum.c`. The test
signs calldata deliberately larger than 1024 bytes and checks recovery.

Both signing suites assert `recovered == device address`. That is an objective
check with no human judgement in it: a wrong pre-image cannot recover to the
right address by accident.

## Deliberately not here

**Dice entropy and the RNG seed-time gate (#366).** Testing them means wiping
the device and creating a wallet, which cannot be a routine suite. Covered by
python-keepkey `test_msg_resetdevice.py::test_reset_device_dice` against the
emulator, and by on-device sign-off at release.

**Storage V17 / PIN across reboot (#368).** Needs a physical power cycle.
Covered by the native `Storage.PinUnlocksAfterRebootUnderV17` gtest, plus a
manual check at release.

**HASHES.txt manifest labelling (#367).** Release-artifact tooling; touches no
device code path. `00-capabilities.js` checks only that the device reports a
firmware hash at all.

**Zcash, Hive, and clear-signing.** These are 7.15 features, but they already
have dedicated suites (`tests/zcash/`, `tests/hive/`, `tests/evm-clearsign/`).
Duplicating them here would recreate the problem this directory exists to
solve. Run those directly when the feature is what changed.
