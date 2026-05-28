# Pioneer Bug: NEAR Intents ERC-20 — double `0x` prefix on `txParams.to`

**Date**: 2026-05-20
**Severity**: P1 — breaks all ERC-20 → * swaps via NEAR Intents (e.g. USDC on Base)
**Status**: Patched client-side in vault; Pioneer server needs a permanent fix.

---

## Symptom

User swaps USDC (Base) → anything via NEAR Intents. Vault shows:

```
Approval needed: 61.27821 USDC
Current allowance: 0 USDC · spender 0x0x833589…a02913
```

Then after clicking Confirm: `invalid hexadecimal string`.

## Root Cause

Pioneer's quote endpoint for NEAR Intents ERC-20 sources returns:

```json
{
  "txParams": {
    "to": "0x0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    ...
  }
}
```

The `to` field has a double `0x` prefix. The correct value is
`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (the USDC contract on Base).

## How NEAR Intents ERC-20 works (correct flow)

For ERC-20 sources, NEAR Intents encodes a direct `transfer(solverAddress, amount)`
call on the token contract — **not** `transferFrom()` via a router. Therefore:

- `txParams.to` = token contract address (the USDC contract)
- `txParams.data` = `transfer(solverAddress, amount)` calldata
- `txParams.value` = `"0"` (no ETH)
- **No ERC-20 approval needed** — the user signs one tx, not two

The vault was misidentifying this as a `transferFrom()` pattern and generating a
spurious `approve(USDC_contract, amount)` tx with the token contract as its own
spender — which is semantically invalid and would revert.

## Vault-side workaround (already merged)

Two patches in `src/bun/`:

### 1. `swap-parsing.ts` — strip duplicate `0x`

```typescript
const normalizeAddr = (addr: string | undefined): string | undefined =>
  addr ? addr.replace(/^(0x)+/i, '0x') : addr

relayTx = {
  to: normalizeAddr(txParams.to) as string,
  ...
}
```

### 2. `swap.ts` `buildRelaySwapTx()` — skip approval when `relay.to === tokenContract`

```typescript
const isDirectTransfer = relay.to.toLowerCase() === tokenContract
if (isDirectTransfer) {
  console.log(`[swap] Relay ERC-20: relay.to === token contract — direct transfer(), no approval needed`)
}
if (tokenContract && tokenContract.startsWith('0x') && !isDirectTransfer) {
  // ... allowance check + approveTx generation
}
```

## Pioneer fix needed

In pioneer-server's quote controller, wherever `txParams.to` is constructed for
NEAR Intents routes: ensure the address is emitted with exactly one `0x` prefix.

Search path: `pioneer-server/src/` — look for the NEAR Intents integration handler
that builds `txParams`. The double prefix likely comes from concatenating a
pre-existing `"0x"` string with an already-prefixed address (e.g.
`"0x" + "0x833589..."` or similar).

**Repro**: request a quote for `eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
→ any asset via NEAR Intents and inspect `quote.txs[0].txParams.to` in the raw
response.

## Validation after Pioneer fix

1. `txParams.to` has exactly one `0x` prefix in the raw Pioneer response
2. Vault swap flow for USDC (Base) → ETH (or any chain) via NEAR Intents shows:
   - **One** device confirmation (the transfer tx) — no spurious approval dialog
   - Tx broadcasts successfully with `to = 0x833589...` (correct USDC contract)
3. Vault client-side `normalizeAddr` workaround stays in place as a defensive guard
   (cheap and safe to keep even after the server fix)
