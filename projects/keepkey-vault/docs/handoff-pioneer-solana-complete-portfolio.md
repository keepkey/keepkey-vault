# Pioneer handoff: complete Solana token portfolios

## Problem

Vault can derive the Solana owner address and query balances, but the portfolio response does not consistently include every SPL token held by that owner. The asset picker therefore shows SOL and catalogued/authored tokens while omitting newer or long-tail SPL mints that are present on-chain.

Vault currently has a direct Solana RPC fallback for a known mint. That helps reconcile a swap destination, but it cannot discover an unknown token universe and should not replace the Pioneer portfolio response.

## Required Pioneer behavior

For every Solana owner address, the portfolio/balances endpoint should:

1. Enumerate all non-zero SPL token accounts owned by the address, including Token-2022 accounts where supported.
2. Aggregate multiple token accounts for the same mint.
3. Return one token entry per mint with `caip`, `symbol`, `name`, `balance`, `decimals`, `balanceUsd`, `priceUsd`, `contractAddress` (the mint), `networkId`, and `icon` when available.
4. Use the canonical Solana mainnet CAIP-2 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` and a consistent token namespace (`/token:` or `/spl:`). Do not vary casing between requests.
5. Return tokens even when market metadata is unavailable. Missing price, icon, or catalog rank must not remove a held token.
6. Support pagination or an explicit complete-result marker so Vault can distinguish “no more tokens” from a truncated response.
7. Define commitment/finality and freshness in the response. Vault needs a recent finalized balance for portfolio display and swap reconciliation.

## Acceptance examples

- A wallet holding an uncatalogued SPL mint receives that mint in the normal portfolio response without first adding it as a custom token.
- Two token accounts for the same mint produce one aggregated balance.
- A token with no USD price still appears with `balanceUsd: 0` and its correct decimals.
- A Token-2022 account is either included or explicitly reported as unsupported; it must not silently disappear.
- The same mint is returned with the same canonical CAIP on portfolio, asset search, swap quote, and transaction history endpoints.

## Vault-side compatibility

Vault accepts Pioneer token entries from `ChainBalance.tokens` and matches them by canonical CAIP. Until Pioneer provides complete discovery, Vault keeps a balance-only fallback for held tokens and performs direct RPC reconciliation only for known post-swap destination mints.

## Suggested diagnostic payload

For support investigations, expose the owner address, queried RPC commitment, token-account count, unique-mint count, pagination state, indexed-at timestamp, and any provider error. Do not omit the entry solely because metadata enrichment failed.
