# Incident: 7.14 EIP-712 Signing Regression (Release Blocker)

**Date opened:** 2026-04-28
**Severity:** Release blocker
**Status:** Unresolved — repro path captured, root cause not yet identified
**Affected:** Vault EIP-712 signing path (Permit2 / Uniswap UniswapX surfaced first)
**Captured branch:** `feat/zcash-cli-submodule` (where the failing payloads were collected)

## Symptom

Production users report Uniswap permit signatures failing to verify. EIP-712 signatures produced by the vault on the captured device do not recover to the device's ETH address.

## Evidence on disk

- Captured payloads: `projects/keepkey-sdk/tests/fixtures/eip712-blobs.json`
- Test runner: `projects/keepkey-sdk/tests/evm-eip712/uniswap-permit-prod.js`
  - Offline half: re-derives sig from captured `(domain, types, primaryType, message, signature)` → recovers expected address.
  - Online half: re-signs the same blob via the live vault, recovers, and compares.

**Offline check passes.** Captured Permit2 sig `0x44b8eec…` recovers cleanly to `0x141D9959…`. So the captured fixture is internally consistent — the vault was producing correct sigs at capture time. The regression is *between then and now*: the vault is now producing sigs that don't recover for the same logical input.

## How to reproduce

```bash
cd projects/keepkey-sdk
KEEPKEY_API_KEY="${KEEPKEY_API_KEY:?set KEEPKEY_API_KEY}" \
  node tests/evm-eip712/uniswap-permit-prod.js
```

Approve the prompts on the device. If the freshly-signed sig fails to recover to the device address, the test prints the expected `domainSeparator` / `structHash` / `digest` so they can be diffed against what firmware actually hashed.

## Open hypotheses (in rough probability order)

1. **BEX path/account mapping drift** — captured blobs include a counterparty address `0xe24A8f2ae82F6829ef277E59268111BEE54B5D3e`. If that's a different ETH account from the wallet's, the BEX may be mapping it to a different derivation path than the device actually uses for signing. (Open question for whoever has the device.)
2. **Extension not reloaded after `make build`** — Chrome unpacked extensions don't hot-swap. The user-reported "bug persists" log might be the un-reloaded build still emitting the old EIP-1193 path. Confirm via `chrome://extensions` → reload card before re-running.
3. **Domain/struct hash mismatch from a recent decoder change** — `eip712-decoder.ts` or the firmware-side hashing has drifted. The online half of the test prints the digest the host computed; comparing to firmware would confirm.
4. **Wallet bytes corruption** — typed-data canonicalization differs (e.g., chainId number/string, missing `salt`, types ordering).

## Why this is now debuggable from REST

Until this PR, only the React UI could read signed-payload history (via internal RPC). Everything was already being persisted in the `api_log` table — request body, response body, txid, chain, timestamp — but there was no way to pull it from outside the vault process. That made it impossible for an SDK test or external diagnostic script to fetch "the last failing `/eth/sign-typed-data` and its output" to compare.

The new endpoints (`GET /api/v1/activity`, `GET /api/v1/activity/:id`) close that gap. See [handoff-signing-history.md](handoff-signing-history.md) for the workflow.

## Privacy posture (preserved)

- Passphrase wallets are not persisted to `api_log` (privacy guard in `index.ts:584`). Same guard protects the new REST surface — passphrase sessions yield empty history.
- Both new endpoints require `auth.requireAuth(req)` (paired-app API key), same as `/api/portfolio/:id`.

## Next steps for the next session

1. Trigger one failing sign on the live vault.
2. `curl` the new activity endpoint to retrieve full request/response bodies.
3. Compare the host-computed digest (printed by `uniswap-permit-prod.js`) against the firmware's actual hashing — that diff is the regression.
4. If digests match but sig still doesn't recover, the issue is in firmware ECDSA / RFC-6979 path — escalate to the firmware repo with the full payload from the audit log.

## Pointers

- Persistence: `src/bun/db.ts` — `api_log` schema, `insertApiLog`, `findApiLogs`, `getApiLogById`
- Logging hook: `src/bun/index.ts:580` (`onApiLog` callback)
- REST surface: `src/bun/rest-api.ts` — `/api/v1/activity` block
- Captured fixture / runner: `projects/keepkey-sdk/tests/evm-eip712/uniswap-permit-prod.js`
