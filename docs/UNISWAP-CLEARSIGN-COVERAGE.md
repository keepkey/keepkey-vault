# Uniswap ClearSign coverage

Status: active implementation audit, 2026-09-20. “Decoded” below means Vault
round-trips the exact ABI encoding, derives human-readable economic bounds, and
fails closed on unknown nested operations. It does **not** mean device-authenticated
unless a signed definition is also present and verified by firmware.

## Proven real-world cases

| Flow | Evidence | Current result |
|---|---|---|
| Uniswap web ETH → USDC, Ethereum, Universal Router V2.1.2 | Captured from the live site through Vault; signing was rejected, never broadcast | `WRAP_ETH → V2_SWAP_EXACT_IN → SWEEP`; exact input, minimum output, WETH/USDC path, recipient, payer, and deadline decoded |
| Historical Uniswap web LINK → USDT capture, Ethereum, Universal Router V2.1.1 | Existing byte-for-byte SDK regression fixture | **Refused:** the calldata has ten non-canonical trailing bytes (`unix` plus padding). The canonical ABI prefix decodes to a Permit2 allowance, V2 hop, V3 hop and final WETH unwrap, but the submitted transaction is not counted as ClearSign coverage; it was never mined and its historical signature recovered to the wrong address |
| Uniswap v4 ETH → ONDO liquidity mint, Ethereum PositionManager | Successful mainnet transaction `0xee15d43263bd1fb2be6f53eea2e32e660aaa024e4bc8a4510a9be868e9131819`, fetched byte-for-byte from `eth_getTransactionByHash` | `MINT_POSITION → SETTLE_PAIR → SWEEP`; pool currencies, fee, tick spacing/range, liquidity target, token maxima, owner, deadline, and native refund recipient decoded |
| Device-bound SDK fixtures | The live ETH → USDC transaction and successful ETH → ONDO mint are vendored in the SDK suite and cross-checked byte-for-byte against Vault | Device display fields and host findings agree on spend/output bounds, routes, owners, deadlines and settlement; the older frozen `uniswap-v4-universal-router-swap` golden remains a format-only empty-plan fixture and is not counted as economic coverage |
| Filled UniswapX Exclusive Dutch order | Successful mainnet reactor transaction `0xfe89baf6e8b4df66d630611d4c8cf6a55539c80e1a2c8d6778f531d040a3d1f5`; order decoded from the public `execute(SignedOrder)` calldata against official UniswapX structs | The embedded Permit2 signature recovers to the order’s swapper; Vault authenticates the official reactor and shows the 16.190560 USDC maximum input, native-output bound/recipient, filler and auction times |
| Filled UniswapX V2 Dutch order | Successful mainnet reactor transaction `0x3b5c6d0545246d8d13e2114c249e262cc7e2870de7696ac61802baa00d999a15`; same public-calldata reconstruction | The embedded Permit2 signature recovers to the swapper; Vault authenticates the official V2 reactor and shows the 1,000 USDC maximum input, both output bounds/recipient and cosigner |
| Permit2 `PermitSingle` | SDK and hdwallet structured EIP-712 fixtures | Exact uint widths, token, amount, expiry, nonce, spender and deadline streamed to 7.15+ firmware |
| Arbitrum USDT → Permit2 unlimited setup approval | Exact live browser-extension request: token `0xfd086b…`, spender `0x000000000022…`, selector `approve(address,uint256)`, uint256 max | Correctly presented as persistent authority over this USDT token. Identity-first dispatch prevents the shared ERC-20/ERC-721 selector from being mislabeled as a Uniswap position-NFT approval |
| UniswapX V3 Dutch witness | Exact six-level device-state-machine fixture; domain and message hashes cross-checked against ethers 5.8 | All signed Permit2 envelope, order, input/output, nonlinear curve and recipient leaves stream to firmware; 31 firmware EIP-712 tests and the ARM release linker gate pass |

## Transaction families

| Family | Host report | Device path | Identity status | Remaining work |
|---|---|---|---|---|
| Universal Router V2.1.2 | All published command IDs decoded; nested v4 swap and v4 mint plans decoded; unknown items and non-canonical trailing calldata fail closed | The real `WRAP_ETH → V2_SWAP_EXACT_IN → SWEEP` route has a transaction-bound runtime envelope with exactly eight firmware fields; other command programs still need compact signed definitions | All 22 production deployments and three testnet deployments from the official 2.1.2 release are recognized; runtime bytecode hash is checked by live simulation when the RPC supports it | Expand compact envelopes to every economically complete command program; hardware screenshots |
| Universal Router V2.2.0 permissioned pools | Official Ethereum, Ink and Sepolia identities recognized; unchanged outer command ABI decoded; Vault resolves adapters through the router's factory at one pinned block and verifies the underlying token, swap-enabled flag, sender authorization, and pool hook authorization | The chain-state proof requires an RPC with `eth_call`; reports fail closed when it is unavailable or any authorization is false | State resolver is covered with deterministic RPC fixtures; live permissioned pools may not yet exist on every deployed chain | Capture and replay one production permissioned route and one standard v4 route through the 2.2 router |
| Universal Router V2.1.1 | Same reviewed command dialect; real production fixture covered | Same as above | Official Ethereum address recognized | Expand official addresses; hardware proof |
| Universal Router V2.0 and V1.x | Core Permit2, v2/v3 swap, payment, wrap/unwrap and recursive subplan commands decoded with the version-specific V1 `0x3f` mask; historical NFT marketplace commands are named and fail closed | Transaction calldata still needs authenticated device metadata | Official Ethereum V1, V1.2 and V2 addresses recognized | Implement and prove each historical NFT-marketplace payload before promoting those commands |
| Uniswap V2 Router02 | Exact-in/out token/native swaps, fee-on-transfer variants, add/remove liquidity, and remove-with-permit decoded | Canonical single-hop exact-input and exact-output swaps compile to eight typed transaction-bound device fields; existing static signed metadata covers another subset | Canonical deployments are recognized on 20 production/test chains, and a V2 call sent to another official Uniswap contract is rejected as the wrong family | Expand bounded rendering to multihop, liquidity and permit combinations; hardware proof |
| Uniswap V3 SwapRouter / SwapRouter02 | Exact input/output, single/multihop, all multicall guards, extended payments and fee payments, router-owned approvals, position forwarding, oracle slippage checks and all self-permit forms decoded | Existing static signed metadata covers a subset | Canonical deployments are recognized on 24 production/test chains, with method-family-specific identity checks | Signed generic definitions and device proof |
| Permit2 allowance permits | Single and batch exact schemas decoded | 7.15+ device-driven structured EIP-712 | Canonical Permit2 verifying contract required | Hardware proof for single and batch |
| Permit2 signature transfer | Single and batch exact schemas decoded | 7.15+ device-driven structured EIP-712 | Canonical Permit2 verifying contract required | Pair signed maximum with subsequent requested recipient/amount when available |
| Permit2 on-chain execution | `approve`, signed single/batch allowance submission, allowance transfers, signature transfers, witness transfers, lockdown, sequential nonce advance, and unordered bitmap invalidation decoded; signature bytes are never retained | Existing static device catalog covers `approve` and one single signature-transfer example; generic transaction definitions remain incomplete | Canonical address is authenticated on the 16 chains whose current Uniswap manifest explicitly records Permit2; other chains downgrade pending runtime-code proof | Add batch/witness device definitions and bind canonical runtime hashes on newer deployments |
| UniswapX witness orders | Exact V3 Dutch, Dutch V1/V2, Priority and Hybrid signed schemas decoded into maximum input, output bounds/recipients, reactor, swapper, deadlines, hooks and auction terms | 7.15+ structured EIP-712 traverses every signed field; the exact V3 path is proven through firmware at its measured 6-depth/17-slot/7-type bounds | Canonical Permit2, spender=reactor, and the official per-chain reactor manifest are required; all 18 current official V3 deployments are included | Resolved price-decay presentation and emulator/hardware screenshots for every order family |
| Direct v3/v4 liquidity management | Direct v3 position mint/increase/decrease/collect/burn/permit; direct v4 mint/increase/decrease/burn, settlement, pool initialization, Permit2 forwarding, NFT permits/approvals/transfers, subscriptions, nonce revocation and recursive multicalls; router-gated v3/v4 actions | Not yet authenticated on device | Canonical v3 NonfungiblePositionManager deployments are recognized on 24 production/test chains; all 21 production and two testnet standard v4 PositionManager deployments are recognized; real mainnet v4 mint fixture covered; Ethereum/Sepolia permissioned managers use block-pinned adapter, underlying-token, verification, hook, owner and `LIQUIDITY_ALLOWED` checks | Capture a production permissioned-liquidity call; signed definitions and device proof |
| Simulation/effects | `eth_simulateV1`, `debug_traceCall`, then `eth_call` fallback are implemented; invoked contract runtime bytecode is hashed at the same pinned block | Host evidence only, never replaces device authentication | User can configure and chain-ID-verify an explicit per-chain RPC under Settings → ClearSign simulation; endpoint and block are recorded | Prove provider capabilities in the UI; compare runtime hashes to reviewed release hashes; add quorum/divergence checks |
| 7.15 runtime reports | The in-tree Uniswap provider signs the exact final transaction fields and refuses unknown identity, incomplete reports, ambiguous fee models and reports that cannot fit without omission; Vault loads its public identity only after a mandatory device trust screen | Browser extension, WalletConnect, internal swaps and REST signing converge on this mechanism; an explicit provider `OPAQUE` refusal is a tested signing error and cannot degrade to blind signing | The provider private key remains in a separate process; its public key fingerprint and RAM slot are validated. This is user-trusted runtime authority, not KeepKey-certified authority | End-to-end emulator/hardware capture, expand compact formatters, and production signer operations |

## Measured ABI denominator

The legacy denominator is generated from exact function signatures and checked
for selector collisions in tests: V2 Router02 has 17 user-signing selectors,
the original V3 SwapRouter has 4, SwapRouter02 has 34, and the v3
NonfungiblePositionManager has 20. Universal Router coverage is measured by its
versioned command table instead of selectors; v4 coverage is measured by the
outer methods plus every nested action. Passing a selector test alone never
counts as coverage unless the target contract family is also authenticated.

The focused executable matrix currently has 70 passing Vault tests (57 router,
position, real-fixture and runtime-provider tests plus 13 Permit2/EIP-712 tests),
10 passing SDK offline provenance/binding cases, and 70 passing firmware signed-
metadata/envelope tests. These counts are regression evidence, not a claim that
every live Uniswap deployment has authenticated device labels.

## Honesty rules

- An official address from a source manifest is a protocol attribution, not a
  runtime bytecode proof. P5 requires code identity or an equivalent signed
  binding.
- Intermediate router minima can be zero. The report must consider the whole
  command program (for example a final `SWEEP`, `TAKE_ALL`, or `UNWRAP_WETH`)
  before describing the user’s effective minimum.
- Simulation is state-dependent and can be front-run or invalidated before
  inclusion. It reports observed effects at a pinned block, never “safe”.
- Permit2’s signed amount is a maximum. For signature transfer, the eventual
  caller selects the requested amount and recipient subject to that maximum.
- A decoder that recognizes a selector but cannot explain every nested command
  is incomplete and cannot promote the report.
- ABI decoders must prove canonical consumption of the complete calldata. A
  valid prefix followed by any trailing bytes is refused, even if a permissive
  ABI library can parse the prefix.

## Sources pinned during this audit

- `Uniswap/universal-router`: deployment manifests, `Commands.sol`,
  `Dispatcher.sol`, `IUniversalRouter.sol`, tags `2.1.1` and `2.1.2`.
- `Uniswap/v4-periphery`: `Actions.sol`, `IV4Router.sol`,
  `CalldataDecoder.sol`, `PositionManager.sol`.
- `Uniswap/permit2`: `IAllowanceTransfer.sol`, `ISignatureTransfer.sol`,
  `PermitHash.sol`.
- `Uniswap/UniswapX` revision `eb7ce077036258b9510b42ad37aa920cf3aaf308`:
  reactor interfaces, order structs, Permit2 witness types and settlement logic.

The source revision/hash and on-chain runtime hash still need to become
machine-readable coverage inputs rather than prose before this audit can be
called complete.
