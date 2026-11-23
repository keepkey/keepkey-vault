# Bitcoin.com Explorer in Vault

Public Bitcoin-mainnet transaction details in BTC reports now read
`https://www.bitcoin.com/explorer/btc/tx/{txid}/?format=json` first. Pioneer remains
the fallback when that record is unavailable, rate-limited, or invalid. Explicit
self-hosted and offline backends retain their existing routes.

The adapter also supports individual address and block record reads for future
consumers. Address totals are not substituted for account/xpub balances. It does
not upload xpubs or use the Explorer's generic search tool. The service's
documented REST surface does not supply spendable UTXOs, raw transaction hex,
broadcasting, or recommended fee rates, so those operations keep their existing
backend.

## Data and request handling

- The envelope includes `kind`, `id`, `explanation`, `url`, `asOf`, and `data`.
  The downloaded record must match the requested mainnet record and URL.
- Transaction `vin`/`vout` use the Blockbook shape already consumed by Vault's
  money-flow reports. Monetary fields must be integer satoshi strings. The
  adapter retains those strings and rejects fractional/numeric amounts.
- The provider's explanation describes the entire transaction. Vault computes
  wallet direction, payment amount, fees, change, and running balance itself.
  The report includes transaction-detail source counts.
- Reads request the CDN-cacheable `?format=json` form, deduplicate concurrent
  requests, and cache records for 30 seconds. Cached objects are cloned before
  being returned to callers.
- The client limits itself to 55 uncached reads per rolling minute. The service
  documents 60 uncached requests per IP per minute; other clients sharing that
  IP may use some of that allowance. HTTP 429 starts a shared cooldown using
  `Retry-After` seconds or an HTTP date. There is no immediate retry loop.
- Responses have a 15-second timeout, reject redirects, and are bounded before
  JSON parsing. Malformed or substituted records fall back to Pioneer.

## Verification

```sh
cd projects/keepkey-vault
bun test src/bun/bitcoin-explorer.test.ts src/bun/report-btc-flow.test.ts src/bun/btc-backend src/bun/pioneer-guard.test.ts
bun scripts/bundle-backend.ts
```

Live public responses for the documentation's transaction, address, and block
examples were downloaded on 2026-11-17 and accepted by the production validator.
Tests check wallet net flow independently of the explorer sentence, precision,
record identity, cache isolation, request deduplication, both Retry-After forms,
the local request ceiling, alternate-chain exclusion, and fallback behavior.

References: [API documentation](https://www.bitcoin.com/explorer/api/),
[OpenAPI](https://www.bitcoin.com/api/explorer/openapi.json),
[record schema notes](https://www.bitcoin.com/explorer/llms-full.txt).

The optional remote MCP endpoint at `https://www.bitcoin.com/api/explorer/mcp/`
offers read-only transaction, block, address, chain-tip, and search tools for
agent clients. Vault's integration uses HTTPS JSON reads directly and does not
install an MCP server or change the operator's MCP configuration.
