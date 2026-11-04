# Firmware 7.16 swap routing

Implemented November 2, 2026. Gateway changes are merged in [PR 3](https://github.com/BitHighlander/keepkey-gateway/pull/3) and [PR 4](https://github.com/BitHighlander/keepkey-gateway/pull/4). Production health reports revision `87c715a23009df0bb6628a8de8a52accdb3cfc88`; the matching [deployment](https://github.com/BitHighlander/keepkey-gateway/actions/runs/41494366880) passed. Vault changes are in the local working tree; the development app was rebuilt and relaunched against oracles.cc.

| Route | Behavior | Review boundary |
| --- | --- | --- |
| Ethereum ETH → USDT/USDC | Direct Uniswap v3 pool through certified Universal Router 1.2; compares 500/3000 pool fee tiers | Exact input, net minimum, recipient and 30 bps KeepKey fee are in the atomic transaction |
| Relay EVM source | Vault requests `solver-deposit`; gateway checks returned contract, chain, depositor, input value/token/amount and calldata shape | Existing source-deposit certificate; destination swap terms remain off chain |
| ETH → Base USDC | Live quote returned the reviewed Relay source deposit | Source deposit only |
| BTC ↔ ETH | Live quotes returned Chainflip through ShapeShift | Existing deposit-channel flow; this probe does not certify destination terms |
| THORChain/Maya/0x | Existing adapters retained; availability is checked for the requested pair | Final transaction policy remains authoritative |

Vault uses the engine's firmware/capabilities, independently resolves the description for the actual call, then ranks reviewed atomic calls before source deposits, followed by existing routes requiring explicit blind-signing consent. Output comparison remains within each review level. Preview and execution resolve the same Uniswap decoder or deposit schema. No provider label or gateway metadata grants ClearSign support.

Uniswap is deliberately limited to native ETH input on Ethereum; token input, reverse swaps, other networks, multihop routing and arbitrary hooks have not been added. It encodes a three-minute deadline and a final sweep enforcing the net minimum. Gateway receipt tracking matches the transaction, token and recipient, records the actual received token amount, and waits for two confirmations. Vault persists the actual source/destination addresses and base units, including custom recipients, for retry/resume. Passphrase-wallet tracking remains in memory.

Relay receives the selected slippage in basis points and an explicit refund address equal to the sender. Solver-mode completion requires a separate payout hash even on the same chain; the input deposit is never substituted for the payout. ShapeShift remains the Chainflip fallback; no direct broker was configured. No new catalog signatures or firmware changes were required.

Validation: 153 gateway tests passed, two database integration tests skipped without a dedicated test database; both gateway TypeScript projects passed. The focused Vault suite passed 162 tests, plus the SQLite context persistence/reopen test. The native macOS development build passed and the running backend reports healthy. The broader Vault typecheck still reports existing errors; it is not a clean project-wide check.

`uniswap-716-live.json` records successful pending gas estimates and pinned production-certificate checks for ETH → USDT and ETH → USDC. `reviewed-swaps-live.json` records the final EVM quote checks through Vault's actual Pioneer SDK, including exact base-unit checks of the selected 1% slippage. `reviewed-swaps-before-slippage-fix.json` retains the earlier four-pair probe: BTC ↔ ETH quotes succeeded there, and the ETH → Base result exposed Relay's automatic 2% default before the correction. Reproduce all pairs with `bun scripts/audit-reviewed-swaps.ts https://oracles.cc`, or add `--evm-only` for the final two EVM checks. The script uses public addresses, verifies certificates against the pinned production root, and never signs or broadcasts. Market amounts are snapshots, not reusable quotes.

No physical-device screens or funded swaps were exercised. The connected-device check reported no device. A hardware test with blind signing disabled is still needed before calling this hardware-validated.
