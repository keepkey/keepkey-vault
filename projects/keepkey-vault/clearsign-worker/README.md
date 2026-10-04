# KeepKey ClearSign Worker

Production-facing 7.16 certified-description service for reviewed Relay and
Portals actions on Ethereum and Solana. It publishes status and provenance,
refuses unknown transaction shapes, and signs only with Cloudflare encrypted
secrets.

The delegate private key never belongs in this repository, `wrangler.toml`, a
command argument, or a Worker variable. The two public certificates are also
stored as secrets so provisioning is atomic and consistent across deployments.

## What leaves Vault

- Ethereum sends `chainId`, contract, selector, and calldata length. It does
  not send transaction arguments or calldata. KeepKey decodes the real values;
  the service cannot supply them.
- Solana sends the unsigned transaction and, optionally, a reviewed catalog
  id. Without one, the service finds the single catalog entry whose program,
  discriminator, and exact instruction length match, and certifies it only
  when the firmware's certified rule applies (at most 8 instructions, and
  every other instruction a ComputeBudget, Memo, or static System transfer);
  anything else gets 422 and stays on the opaque path. It parses the
  transaction, resolves its lookup-table accounts from Solana RPC, and signs a
  binding to the exact message. For each token amount the matched schema
  shows, it attests the mint's immutable on-chain symbol and decimals when the
  mint is eligible; otherwise KeepKey shows the raw amount and full mint. Seeds, private keys, PINs,
  passphrases, and device signatures never leave KeepKey.

The Worker writes no transaction database. Cloudflare's platform-level
request and security telemetry remains governed by the account configuration.

## Verification and deployment

```sh
bun test clearsign-worker/src/index.test.ts
npx wrangler deploy --config clearsign-worker/wrangler.toml
```

Provision these encrypted secrets through stdin:

```sh
npx wrangler secret put CLEARSIGN_DELEGATE_PRIVATE_KEY --config clearsign-worker/wrangler.toml
npx wrangler secret put CLEARSIGN_CERTIFICATE_HEX --config clearsign-worker/wrangler.toml
npx wrangler secret put CLEARSIGN_SOLANA_CERTIFICATE_HEX --config clearsign-worker/wrangler.toml
```

`/ready` returns 200 when the delegate key matches fingerprint `a9531b9d` and
at least one root-signed, scope-correct certificate is active. `/v1/status`
reports Ethereum and Solana readiness separately; an unprovisioned scope always
fails closed. Before pointing Vault at a new deployment, test exact positive
routes and tampered chain, contract, selector, instruction length, program,
lookup table, certificate, and signature cases.
