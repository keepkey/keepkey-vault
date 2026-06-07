# Retro: Maya MAX swap reverted on-chain, twice, undetected

## What happened

A MAX CACAO → ETH swap reverted on-chain with `insufficient funds` and the vault never noticed — it showed "swap in progress" indefinitely. This was the **second** time: PR #212 ("reserve Maya native fee on MAX CACAO deposits") was shipped to fix exactly this, the next MAX swap still reverted.

- 1st failure: reserve was `0` → swept 100% of balance → nothing left for the 0.2 CACAO fee.
- PR #212: set reserve to **exactly** 0.2 CACAO (`FEES.mayachain = 0.2`).
- 2nd failure (this one): reserve was the exact fee with **zero headroom**. Pioneer reported the balance as `778.25133011`, but the real on-chain balance was ~301,100 base units (0.00003 CACAO) lower, so `amount + fee` overdrew the real balance by a hair → `code: 1, insufficient funds`.

## How we missed it the first pass (PR #212)

1. **Reserved the bare fee, no buffer.** We treated "reserve = exactly the native fee" as correct, ignoring that the reported balance the MAX is computed from is not base-unit-exact.

2. **The test encoded the bug instead of the safety property.** `cosmos-max-send.test.ts` asserted `amount === balance − exactFee` from a synthetic balance string. That proves the *arithmetic*, and it assumes `reportedBalance === realOnChainBalance` to the base unit — the exact assumption that fails in production. The test passed while the real path overdrew.

3. **We already knew this bug class and didn't generalize it.** The frontend MAX reserves (`SwapDialog.tsx`) explicitly document that Pioneer reports balances rounded to ~8 decimals, so EVM/Solana reserve a *real* buffer (the Solana one is ~2000× the fee) rather than draining to the last unit. That lesson was sitting in the codebase; it was never applied to the cosmos backend reserve.

4. **Conflated "broadcast accepted" with "tx succeeded."** Pioneer returns `success: true, code: 0` for a sync broadcast — that's the CheckTx (mempool) result, not DeliverTx. The vault marks the swap pending on it. The on-chain revert (`tx_response.code = 1`) is never observed, so a failed deposit looks identical to a successful one until the 24h stale cleanup.

5. **Didn't verify against the chain.** The fix was validated by a green unit test and Pioneer's `success: true`, not by checking the actual on-chain `tx_response.code` of a real MAX swap.

## Fixes

- **Vault (shipped):** reserve `2× the native fee` on MAX (`cosmos.ts`), headroom for balance drift. Test rewritten to assert the *property* — `amount < balance − bareFee` — not a magic number.
- **Pioneer (handoff):** detection of in-block reverts belongs in Pioneer, never in vault node calls. See `handoff-pioneer-cosmos-tx-revert-detection.md`. The reserve buffer lowers the *frequency*; only Pioneer surfacing the committed DeliverTx result actually *detects* a revert (and covers bad-memo / pool-halt / slippage failures the buffer can't prevent).

## Rules to carry forward

- A MAX reserve must leave headroom **above** the bare fee on every chain — reported balances are not base-unit exact. Generalize the EVM/Solana buffer rule; don't re-derive it per chain family.
- A test that asserts an exact MAX amount from a synthetic balance proves arithmetic, not safety. Assert headroom (`amount + fee < balance`), and/or feed a balance that is deliberately stale-high vs the "real" one.
- For Cosmos, **broadcast-accepted ≠ executed.** `code: 0` from a sync broadcast is CheckTx. Never treat it as terminal success.
- When fixing an on-chain failure, verify against the actual committed result, not just that the relay returned success.
- Never reach for a chain node in the vault to plug a detection gap — that's a Pioneer change + handoff.
