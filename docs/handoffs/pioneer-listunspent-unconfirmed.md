# Handoff: Pioneer ListUnspent — include unconfirmed (0-conf) UTXOs

**Date:** 2026-05-18  
**From:** Vault v11  
**To:** Pioneer server (`api-blue.keepkey.info`)  
**Priority:** P1 — swap build preview fails for users with pending BTC transactions

---

## Problem

`GET /utxo/unspent/{network}/{xpub}` (ListUnspent) returns 0 UTXOs for a zpub that `GetPortfolioBalances` reports has 0.00078150 BTC balance.

**Diagnostic proof (from vault logs):**
```
[btc-accounts] getFundedXpubs: 1/3 funded — p2pkh=0.00000000, p2sh-p2wpkh=0.00000000, p2wpkh=0.00078150
[txbuilder:utxo] Fetching UTXOs: network=bip122:000000000019d6689c085ae165831e93, xpub=zpub6rXHd37...
[txbuilder:utxo] zpub6rXH...: 0 UTXOs, 0
Build preview failed: No confirmed UTXOs found for Bitcoin
```

The zpub `zpub6rXHd37fxCQN5Rn5...` reports balance > 0 via `GetPortfolioBalances` but 0 UTXOs via `ListUnspent`.

**Root cause hypothesis:** `GetPortfolioBalances` includes unconfirmed (mempool) balance, but `ListUnspent` only returns confirmed UTXOs. A UTXO that is in the mempool but not yet in a block shows up in one endpoint and not the other.

---

## Required fix

`GET /utxo/unspent/{network}/{xpub}` should return UTXOs with 0 confirmations (mempool) in addition to confirmed ones. This matches the standard blockbook/Electrs behavior.

Each returned UTXO should include a `confirmations` field so the vault can differentiate:

```json
[
  {
    "txid": "abc123...",
    "vout": 0,
    "value": 78150,
    "confirmations": 0,
    "path": "m/84'/0'/0'/0/1"
  }
]
```

The vault's coin selection (`coinselect`) works on unconfirmed UTXOs — standard Bitcoin wallets allow spending unconfirmed change outputs, and THORChain/NEAR Intents accept 0-conf deposits.

---

## Alternative (if including unconfirmed is not safe)

Add a `?includeUnconfirmed=true` query parameter so the vault can opt in. The vault would pass it when building swap transactions (where the user is actively trying to spend their full balance) but not for balance-display purposes.

---

## Verification

```bash
# This xpub has balance per GetPortfolioBalances but 0 UTXOs per ListUnspent
XPUB="zpub6rXHd37fxCQN5Rn5..."

# Should return 0 now (broken)
curl "https://api-blue.keepkey.info/utxo/unspent/bip122:000000000019d6689c085ae165831e93/$XPUB"

# After fix — should return the pending UTXO with confirmations=0
curl "https://api-blue.keepkey.info/utxo/unspent/bip122:000000000019d6689c085ae165831e93/$XPUB"
```

Cross-check: verify the same xpub's balance via `GetPortfolioBalances` shows > 0 — confirms the data is in blockbook but being filtered out of `ListUnspent`.
