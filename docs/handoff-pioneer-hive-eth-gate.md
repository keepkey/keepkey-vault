# Handoff — Pioneer: implement the Hive sponsor ETH anti-drain gate

**Date:** 2026-07-02
**Owner:** Pioneer (`services/pioneer-server`) — this is the server half of a gate the vault already implements.
**Confirmed via prod logs:** `pioneer-server-v3` pod threw a TSOA `ValidateError` on `POST /api/v1/hive/create-account`:
`"body.ethAddress": excess property not allowed` / `"body.ethSignature": excess property not allowed`.

## Context
Hive sponsored account creation now works end-to-end EXCEPT the ETH gate. The vault signs an EIP-191 message and sends `ethAddress` + `ethSignature`, but deployed Pioneer's `HiveCreateAccountRequest` doesn't declare them and TSOA rejects excess fields → 400. Pioneer's own controller comment says it has *"no abuse gate yet."*

**Vault status:** the gate is flagged OFF (`const HIVE_ETH_GATE = false` in `projects/keepkey-vault/src/bun/index.ts`), so the vault currently sends only `{username, ownerKey, activeKey, postingKey, memoKey, attestation}` and account creation succeeds without abuse protection. **When Pioneer ships the gate below, flip `HIVE_ETH_GATE = true` and rebuild.**

## What Pioneer must implement

1. **Accept the fields.** Add to `HiveCreateAccountRequest` (`controllers/hive.controller.ts`), OPTIONAL so both gated-off and gated-on vault builds validate:
   ```ts
   ethAddress?: string;    // 0x… EIP-55, device ETH key m/44'/60'/0'/0/0
   ethSignature?: string;  // 0x… 65-byte r||s||v over the gate message
   ```

2. **Verify the signature.** The vault signs this EXACT message (no trailing newline — byte-pinned, do not reformat):
   ```
   KeepKey Hive onboarding\nusername:${username}\nowner:${ownerKey}
   ```
   Recover with `ethers.verifyMessage(message, ethSignature)` and require the recovered address to equal `ethAddress` (checksum-insensitive compare). `username`/`ownerKey` come from the same request body, binding the gate to this account.

3. **Require the address to hold mainnet ETH.** If balance is 0 → **HTTP 403** (the vault shows a dedicated "fund your ETH address" screen and offers retry). Any non-zero balance passes (or pick a small threshold).

4. **One sponsored account per ETH address.** Persist claimed addresses. On a repeat claim → **HTTP 409** with `eth` or `address` in the `error` string (the vault's 409 branch does `/eth|address/i.test(r.error)` to show "This device already has a sponsored Hive account").

## Status codes the vault already handles (`HiveAccountPanel.tsx`)
- **200** `{success|txid}` → success screen.
- **403** → fund-ETH-address screen (`getEvmAddresses` idx0) + retry.
- **409** with eth/address in error → "already has a sponsored account"; otherwise → "name just taken".
- **401** → "device confirmation didn't verify".
- **503** `{retryAfter}` → "sponsor busy, try again in Ns".
- **400** → surfaces Pioneer's `error` string verbatim.

## Cutover
1. Ship + deploy the Pioneer gate (optional fields, so it's backward-compatible with the current flagged-off vault).
2. Vault: `HIVE_ETH_GATE = true`, rebuild. The vault re-adds the EIP-191 signing (one extra device confirm) + the two fields.
3. Verify on device: create-account with a funded ETH addr → 200; unfunded → 403; second attempt same addr → 409.

Reference (vault side): `projects/keepkey-vault/src/bun/index.ts` `hiveCreateAccount` (the `if (HIVE_ETH_GATE)` block builds the message + signs; step 4 sends the fields).
