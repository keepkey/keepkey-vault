# Pioneer Handoff: NEAR Intents returned as sole route for BTC→ETH

**Date**: 2026-05-19  
**Severity**: P1 — swap broken for this pair  
**Repo**: pioneer-server / pioneer SDK quote endpoint

---

## What's broken

When the vault requests a BTC→ETH quote, Pioneer returns **only** the `nearIntents` integration:

```
integration: nearIntents
swapper:     NEAR Intents
```

The vault explicitly filters out NEAR Intents (P0 fund-loss risk — unreviewed integration, see commit `4d748b82`). After filtering, no supported routes remain, so the swap fails with:

> No supported routes for this pair — Pioneer returned only "NEAR Intents" (unsupported).

## Expected behaviour

For a BTC→ETH swap, Pioneer should return **THORChain** and/or **Chainflip** routes in addition to (or instead of) NEAR Intents. Both of those integrations work correctly in the vault.

## Captured response (2026-05-19 19:03:15 UTC)

```json
{
  "integration": "nearIntents",
  "quote": {
    "source": "near-intents",
    "swapper": "NEAR Intents",
    "buyAmount": 0.008864145002842468,
    "txs": [{
      "type": "transfer",
      "chain": "bip122:000000000019d6689c085ae165831e93",
      "txParams": {
        "to": "bc1qsj366r6t2792gvgqd65fnq62xz3mftdn5hhkr4",
        "recipientAddress": "bc1qsj366r6t2792gvgqd65fnq62xz3mftdn5hhkr4",
        "senderAddress": "bc1qcn9nu9z0vn3my44d0xfpk7zjhxp37umyrc9jj8",
        "amount": "0.0002458",
        "token": "bip122:000000000019d6689c085ae165831e93/slip44:0",
        "swapper": "NEAR Intents"
      }
    }],
    "meta": {
      "depositAddress": "bc1qsj366r6t2792gvgqd65fnq62xz3mftdn5hhkr4",
      "depositMemo": null,
      "submitUrl": "https://1click.chaindefuser.com/v0/deposit/submit"
    }
  }
}
```

Key observations:
- `txParams.memo` is absent — no THORChain/Maya routing memo
- `txParams.data` is absent — no EVM calldata
- The route is a plain BTC transfer to a NEAR Intents deposit address controlled by `1click.chaindefuser.com`
- Pair: `bip122:000000000019d6689c085ae165831e93/slip44:0` → `eip155:1/slip44:60`
- Amount: 0.0002458 BTC (~$18.87)

## Fix required in Pioneer

1. **Ensure THORChain / Chainflip routes are surfaced for BTC→ETH** — this pair has deep liquidity on both protocols; Pioneer should be returning them.
2. **Route ordering**: if NEAR Intents is included, it should not be ranked first/only when established routes exist — vault (and likely other clients) will reject it.
3. **Optional defensive fix**: Pioneer could omit integrations that have no `memo` and no `calldata` from the response entirely, so clients that don't know about NEAR Intents don't receive unexecutable quotes.

## Vault-side status

- NEAR Intents is filtered by `UNSUPPORTED_SWAPPER = /^near/i` in `swap-parsing.ts`
- Vault error message now names the rejected swapper so users/support can identify the cause
- No vault changes needed once Pioneer surfaces correct routes
