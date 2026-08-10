# Handoff — Pioneer: Hive sponsor key "Private key network id mismatch" (create-account 100% failing)

**Date:** 2026-07-02
**Owner:** Pioneer (`services/pioneer-server`)
**Severity:** blocks ALL Hive account creation + the ACT-mint worker. Vault side is done/correct.

## Symptom (from prod `pioneer-server-v3` logs)
```
ERROR [hive.controller.js:602]  CreateHiveAccount | Error: Private key network id mismatch
WARN  [hive-act-mint.worker.js:67] mint tick failed: Private key network id mismatch
POST /api/v1/hive/create-account … errors=100%
```
Every create-account request 400/500s with this after passing validation; the background ACT-mint worker also fails every tick.

## Root cause
`hive-sponsor.ts:33` does `PrivateKey.from(process.env.HIVE_SPONSOR_ACTIVE_WIF)` using **`hive-tx@7.2.0`**. `hive-tx` throws **"Private key network id mismatch"** when the decoded WIF's version/network byte ≠ the expected Hive mainnet id (`0x80`). The env var IS set (an unset key throws *"not configured"* instead), so the **value is wrong-network / malformed**, or the deployed hive-tx network config was altered.

This is independent of the request — the vault now sends a valid payload (gate on, correct attestation/keys/eth fields); Pioneer fails on its OWN sponsor key before signing/broadcasting. Note `sponsor-info` still returns `success:true` because reading the sponsor ACCOUNT only needs the name (`HIVE_SPONSOR_ACCOUNT`), not the WIF.

## Fix (in order of likelihood)
1. **Re-check `HIVE_SPONSOR_ACTIVE_WIF` on the `pioneer-server-v3` deploy.** It must be a valid Hive **mainnet ACTIVE** WIF: base58, starts with `5`, decodes to version byte `0x80`. Common breakage: a raw hex privkey, a STEEM/testnet key, a *public* key by mistake, or surrounding quotes/whitespace in the secret. Validate locally: `PrivateKey.from(wif)` should not throw; `PrivateKey.from(wif).createPublic().toString()` should equal the sponsor account's on-chain active key.
2. **Confirm hive-tx `config` network isn't overridden.** Defaults are Hive mainnet (chain_id `beeab0de…`, prefix `STM`, WIF net id `0x80`). Check `hive-sponsor.ts` doesn't set a conflicting network id, and review `patches/hive-tx+7.2.0.patch` (didn't touch net-id in the checked-in source — the patched `dist/index.cjs` hunk is an ESM-interop shim — but verify on the deployed build).
3. Same key powers `hive-act-mint.worker` — fixing the WIF clears both.

## Verify after fix
- `POST /hive/create-account` with a valid attestation → **200 `{txid}`** (signs + broadcasts via cash-fee path; sponsor holds ~656 HIVE).
- ACT-mint worker WARN stops.

## Vault status — DONE, no change needed
Gate is ON and shipping (`HIVE_ETH_GATE = true`, vault develop `6bf60399` / PR #313). The vault signs the account_create attestation + the EIP-191 ETH gate and sends all fields correctly. Once Pioneer's sponsor key is fixed, creation completes end-to-end.
