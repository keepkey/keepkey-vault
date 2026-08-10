# Handoff — Hive onboarding + ETH gate are LIVE on Pioneer (vault: flip the gate ON)

**Date:** 2026-07-02
**From:** Pioneer backend
**To:** vault app
**Prod:** `https://api.keepkey.info` (green, **v1.3.134**)

## TL;DR
Sponsored Hive onboarding is **enabled, funded, and gated** in production. Green is on **1.3.134** and `HIVE_ETH_GATE=true` — the ETH anti-drain gate is **enforced**. **Flip the vault's `HIVE_ETH_GATE = true`, rebuild, and ship** — the vault now sends `ethAddress`/`ethSignature` and Pioneer requires + verifies them.

## What's live (verified on green)
- **Onboarding ON** (`HIVE_ONBOARDING_ENABLED=true`).
- **Sponsor `keepkey` wired + funded** — 656.5 liquid HIVE, account_creation_fee 3 HIVE → **~218 accounts** via the cash-fee path (enabled; ACT path is 0 — low HP).
- **ETH gate ENFORCED** (`HIVE_ETH_GATE=true`) — create-account requires a valid EIP-191 sig from a mainnet-ETH-funded address, one account per address.
- Green health `1.3.134`; `GET /hive/sponsor-info` → `success:true`.

## create-account contract (gate ON — send the eth fields)
```jsonc
POST /api/v1/hive/create-account
{
  "username": "...", "ownerKey": "STM...", "activeKey": "STM...",
  "postingKey": "STM...", "memoKey": "STM...",
  "attestation": { "serializedTx": "<hex>", "signature": "<hex>" },
  "ethAddress":  "0x…",   // device ETH key m/44'/60'/0'/0/0, EIP-55
  "ethSignature":"0x…"    // 65-byte EIP-191 sig over the message below
}
```
**Byte-pinned gate message** (sign EXACTLY this — no trailing newline):
```
KeepKey Hive onboarding\nusername:${username}\nowner:${ownerKey}
```
Pioneer `ethers.verifyMessage(message, ethSignature)` must recover to `ethAddress`, that address must hold mainnet ETH, and it may claim only one sponsored account.

## Status codes (all handled in `HiveAccountPanel.tsx`)
- **200** `{success, txid, username}` → success screen.
- **403** → fund-ETH-address screen (address holds 0 ETH) + retry.
- **409** eth/address in `error` → "this device already has a sponsored account"; else name taken.
- **401** → bad device attestation OR ETH signature doesn't match `ethAddress`.
- **503** `{retryAfter}` → sponsor busy / ACT pool empty transient.
- **400** → validation (missing eth fields when gate on, bad address, etc.) — surface `error` verbatim.

## Vault cutover (do this now)
1. `HIVE_ETH_GATE = true` in `projects/keepkey-vault/src/bun/index.ts`, rebuild — re-adds the EIP-191 signing (one extra device confirm) + the two fields.
2. Verify on device: funded ETH addr → **200**; unfunded → **403**; second attempt same addr → **409**.

## Caveats
- **RC throttle:** ~11 HP → limited resource credits; `account_create` is RC-heavy, so creations may pace after a burst until RC regenerates. The 656 HIVE is the real budget (~218); throughput is RC-limited. Powering up HP smooths it (not required).
- `sponsor-info.creatable` reports **0** (ACT-only metric — ignores the ~218 cash-fee capacity). Reporting-only; creation works.

## Bottom line
Ship the gate-on vault build. Onboarding is live, funded (~218), and the ETH anti-drain gate is enforced end-to-end.
