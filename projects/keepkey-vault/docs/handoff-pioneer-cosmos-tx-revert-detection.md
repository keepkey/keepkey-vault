# Handoff: Pioneer must detect Cosmos in-block reverts (DeliverTx code ≠ 0)

## Problem

A MAX CACAO → ETH swap (MsgDeposit) **failed on-chain but the vault reported success** and showed the "swap in progress" animation forever.

- Tx: `FAF55806AD5322FED4EFB8102711843ED5A0C0E582D4AE9ADCAEBDFE6BC01A70`
- On-chain result: `tx_response.code = 1`, `raw_log = "failed to execute message; message index: 0: insufficient funds"`
- What Pioneer's `Broadcast` returned to the vault:

```json
{
  "success": true,
  "txid": "FAF55806AD5322FED4EFB8102711843ED5A0C0E582D4AE9ADCAEBDFE6BC01A70",
  "provider": "https://mayanode.mayachain.info",
  "results": { "success": true, "txid": "...", "endpoint": "https://mayanode.mayachain.info", "code": 0 }
}
```

That `code: 0` is the **CheckTx (mempool-acceptance) result**, not the **DeliverTx (in-block execution) result**. A Cosmos tx can pass CheckTx and then revert when it's included in a block — especially MsgDeposit, whose deposit-handler checks (balance, memo, pool state) run in DeliverTx. THORChain/Maya `MsgDeposit` sets `fee.amount: "0"` and charges the native fee at the bank layer, so an overdraw or bad memo is only caught in-block.

Result: Pioneer says `success: true, code: 0`, the vault registers a pending swap, and nothing ever transitions it to failed (no Midgard action is created for a reverted deposit either). The swap dialog spins on `shifting.gif` until the 24h stale-swap cleanup marks it "Timed out".

**The vault must not call chain nodes to discover this** — broadcast/status/confirmation all go through Pioneer. This is Pioneer's to surface.

## What Pioneer needs to do

Pioneer already has the `txid` and the node `endpoint` it broadcast through. It needs to confirm the **committed** result and report a revert.

### Preferred: `Broadcast` returns the committed result for Cosmos

After a successful sync broadcast, poll the node's standard endpoint until the tx is in a block (~1–2 blocks; Maya ≈ 6s each), then return the DeliverTx outcome:

```
GET {endpoint}/cosmos/tx/v1beta1/txs/{txHash}   →  tx_response.{code, raw_log}
```

Broadcast response should distinguish the two cases:

```json
// reverted in-block
{ "success": false, "txid": "...", "committed": true, "code": 1,
  "raw_log": "failed to execute message; message index: 0: insufficient funds" }

// executed cleanly
{ "success": true,  "txid": "...", "committed": true, "code": 0 }
```

The vault's existing broadcast-failure check already looks for `data.results.raw.tx_response` with a non-zero code (`src/bun/txbuilder/index.ts`, `broadcastTx`) and throws `Broadcast rejected: <raw_log>`. If Pioneer populates a committed result in that shape, the vault surfaces the revert **with no vault change** — the swap dialog already maps `insufficient funds` → a clear error and returns the user to review.

Timeout caveat: if the tx isn't in a block within the wait window, return the current mempool-accepted response (don't block forever) — same as today. Only a *positive* revert flips `success` to false.

### Alternative: `GetPendingSwap` reports the inbound revert

If changing `Broadcast` latency is undesirable, the swap monitor should detect that the inbound `txHash` landed in a block with `code ≠ 0` and move the swap to a terminal **failed** status with the `raw_log` as the error message (surfaced via the existing `error.message` / `error.userMessage` fields the tracker already reads). Today the monitor watches for confirmations/Midgard actions and never inspects the inbound tx's own execution code, so a reverted deposit stays pending forever.

`Broadcast`-side is preferred because it catches the failure immediately and covers plain MsgSend reverts too, not just swaps.

## Scope / where

- pioneer-server: `/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer/services/pioneer-server`
- Applies to all Cosmos-family broadcasts; the acute case is THORChain/Maya `MsgDeposit`.
- No vault changes required once Pioneer returns the committed result in the `results.raw.tx_response` shape the vault already checks.

## Related vault-side fix (already shipped in this PR)

The specific revert above was an overdraw: the MAX reserve held back **exactly** the 0.2 CACAO fee, but Pioneer's reported balance (`778.25133011`) was a few hundred base units higher than the real on-chain balance, so `amount + fee` overdrew. Fixed in `src/bun/txbuilder/cosmos.ts` by reserving `2× the native fee` on MAX (headroom for balance drift), mirroring the frontend EVM/Solana MAX reserves. **That reduces the frequency of this failure but does not detect it** — any future revert (bad memo, pool halt, slippage at deposit) still needs the Pioneer-side detection above.
