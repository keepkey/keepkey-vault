# Handoff: Pioneer UTXO CAIP support — verified live on api-blue

**Date:** 2026-05-18
**From:** Pioneer server team
**To:** Vault v11
**Status:** DONE — safe to merge vault-side CAIP cleanup

---

## TL;DR

Pioneer **already accepts CAIP-2 networkIds** on all 5 UTXO endpoints as of
`v1.3.67` (deployed to `api-blue.keepkey.info` today). The vault-side change
from `chain.chain` → `chain.networkId` is safe to merge immediately.

---

## Verified behaviour on api-blue v1.3.67

All results confirmed identical between symbol and CAIP form:

| Test | Symbol | CAIP | Result |
|---|---|---|---|
| `GET /api/v1/utxo/unspent/BTC/<xpub>` | ✅ | ✅ | same list |
| `GET /api/v1/utxo/balance/BTC/<xpub>` | ✅ | ✅ | same balance |
| `GET /api/v1/utxo/fees/BTC` | ✅ | ✅ | same fee rates |
| Unknown CAIP `bip122:deadbeef` | — | ✅ 400 | error, not `[]` |

> **Note on empty UTXO results:** If your xpub returns `[]`, check that the
> wallet actually has unspent outputs. `balance: '0'` and `unspent: []` are
> correct responses for a spent or empty wallet — they are **not** a CAIP
> routing error. Verify with a funded xpub.

---

## Correct CAIP values for all UTXO chains

| Chain | CAIP-2 networkId | Symbol |
|---|---|---|
| Bitcoin | `bip122:000000000019d6689c085ae165831e93` | `BTC` |
| Litecoin | `bip122:12a765e31ffd4059bada1e25190f6e98` | `LTC` |
| Dogecoin | `bip122:00000000001a91e3dace36e2be3bf030` | `DOGE` |
| Bitcoin Cash | `bip122:000000000000000000651ef99cb9fcbe` | `BCH` |
| Dash | `bip122:000007d91d1254d60e2dd1ae58038307` | `DASH` |
| Zcash | `bip122:00040fe8ec8471911baa1db1266ea15d` | `ZEC` |
| DigiByte | `bip122:4da631f2ac1bed857bd968c67c913978` | `DGB` |

These match the `chain.networkId` values in vault's chain config exactly.

---

## Smoke test commands

```bash
BASE="https://api-blue.keepkey.info/api/v1"
XPUB="<your funded xpub>"

# Should return UTXOs (CAIP form)
curl "$BASE/utxo/unspent/bip122:000000000019d6689c085ae165831e93/$XPUB"

# Should still work (symbol form — backwards compat preserved)
curl "$BASE/utxo/unspent/BTC/$XPUB"

# Unknown CAIP — must return 400, not []
curl "$BASE/utxo/unspent/bip122:deadbeef/$XPUB"
# → {"success":false,"error":"Unsupported UTXO networkId: bip122:deadbeef..."}
```

---

## Vault call sites to update

Once you confirm tests pass, these can be migrated from `chain.chain` →
`chain.networkId` for consistency:

| File | Location | Current | Safe to change |
|---|---|---|---|
| `src/bun/txbuilder/utxo.ts` | `fetchUtxosForXpub(...)` lines ~197,201,269,280 | `chain.networkId` (already CAIP) | already correct |
| `src/bun/txbuilder/utxo.ts` | `GetPubkeyInfo({ network: chain.chain, ... })` line ~417 | symbol | → `chain.networkId` |
| `src/bun/sweep-engine.ts` | `ListUnspent({ network: BTC_NETWORK_ID, ... })` line ~202 | CAIP (already correct) | already correct |
| `src/bun/reports.ts` | `GetPubkeyInfo({ network: 'BTC', ... })` | hardcoded symbol | → `chain.networkId` |
| `src/bun/index.ts` | `GetPubkeyInfo({ network: 'BTC', ... })` | hardcoded symbol | → `chain.networkId` |

---

## What Pioneer is shipping next (v1.3.68)

- 400 status code (instead of 200) when an unrecognised CAIP is passed — this
  is the only remaining gap from the original handoff. Not blocking for vault.
