# Swap API execution contract

All `/api/v2/swap/*` endpoints require a paired bearer token. The physical
KeepKey still confirms every signature.

Fetch `/quote` with `fromCaip`, `toCaip`, a positive decimal `amount`,
`fromAddress` and `toAddress`. Optional fields include `slippageBps`, `isMax`,
`feeLevel` (default 5) and `fromEvmAddressIndex` (default 0). Supported CAIPs are
resolved from chain and token metadata; `/assets` is a convenient picker list,
not an exhaustive list of possible routes. The provider establishes availability.

The response includes a Vault-issued `quoteId`, `quoteCreatedAt`,
`quoteExpiresAt` and `risk`. Quotes expire after 60 seconds for small trades
with a known input value, or 30 seconds for large/unknown-value trades. An
earlier provider deadline takes precedence. Independent market prices determine
cost risk; missing prices are reported as unknown.

Pass `quoteId` to `/execute` with the quoted asset/chain identities, amount and
unchanged `memo`, `inboundAddress`, `router`, `expiry`, `expectedOutput`,
`integration`, `swapper` and `relayTx`. Preserve absent fields. Optional address
overrides must equal the quoted addresses; otherwise Vault supplies them from
the saved quote. The source account index, token precision, fee level and MAX
selection must also match. Caller-supplied route replacements are rejected.

When `netFromAmount` is present, review it as the actual source amount: MAX
reserved fees/account reserves before quoting. Vault sends exactly that amount
with MAX recalculation disabled. The original request amount remains accepted
as the execution identity.

If `risk.requiresAcknowledgment` is true, review the returned cost and minimum
output, then pass `riskAcknowledged: true` with that same `quoteId`.
`risk.blocked` cannot be overridden: expected losses of at least 5% on trades
worth $1,000 or more are refused.

Only one swap execution may run at a time. A quote belongs to its wallet/API
session, and cannot be reused after a device signing attempt or successful
execution. After a timeout or lost response, reconcile transaction history
before requesting a new quote. A pre-sign build failure can retry while the
quote remains fresh. Switching wallet/API sessions or restarting Vault requires
a new quote. Expiry/session checks run again before every signature, including
an approval followed by a swap; a lengthy approval can require a new quote.

The `/open` and `/set` controls accept picker keys or CAIPs, resolve asset
definitions on the server and seed the dialog after it mounts. Navigation and
field updates are locked while signing or displaying a submitted receipt.
Close the receipt before opening another swap.
