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
- One exception: for an ERC-20 `approve` of a reviewed token, the request may
  include `spender`, the address in the calldata's first word. It is used to
  pick the description:
  - If `spender` is Uniswap Permit2 (`0x000000000022d473030f116ddee9f6b43ac78ba3`),
    the service returns the Uniswap entry. That schema pins Permit2 by
    address (argument format 6).
  - If `spender` is any other address, or is absent, the service returns the
    generic "Token approval" entry.

  The spender address therefore leaves the host for approvals only. No
  amount or other argument does. The value must be the real calldata
  spender. A pinned schema whose address differs from the calldata does not
  match on the device, and a failed certified claim is refused, not
  downgraded.
- Uniswap swaps (`POST /v1/evm/swap`) send `chainId`, the router, the
  selector, and the token addresses the device review will name. They send
  no amounts, recipients, or calldata. Token addresses do reveal which pair
  is being swapped; that is the price of a certified token identity.
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

## Uniswap swap entries: `POST /v1/evm/swap`

A separate route, not an extension of `/v1/evm/schema`: the entry is keyed by
a token set rather than a calldata length, and its inner version (0x07) is a
firmware decoder, not an argument schema.

Request:

```json
{ "chainId": 8453, "contract": "<router>", "selector": "0x3593564c", "tokens": ["<token>", "..."] }
```

- `contract`: a reviewed Universal Router on that chain
  (`REVIEWED_UNIVERSAL_ROUTERS`: UR 1.2, UR 2.0 and UR 2.1.2 on Base, Ethereum and
  Arbitrum, from Uniswap's `deploy-addresses`).
- `selector`: `0x3593564c` (`execute(bytes,bytes[],uint256)`) or `0x24856bc3`
  (`execute(bytes,bytes[])`). It is signed into the entry.
- `tokens`: 1 to 4 distinct addresses, every one in `REVIEWED_EVM_TOKENS` for
  that exact chain. They are matched by address only, never by symbol. Send
  every token the device names: the input token (unless ETH is wrapped from
  msg.value), the output token (unless unwrapped to ETH), and the Permit2
  token. The device refuses an entry that lacks one, with no blind fallback.

Responses:

- `400`: `tokens` is not an array of 0x addresses, or the JSON is invalid.
- `422 {classification: "OPAQUE"}`: the router or selector is not reviewed,
  or a token is not reviewed, is repeated, or there are 0 or more than 4.
- `503 {classification: "UNAVAILABLE", entry}`: the chain has no valid
  certificate, or the delegate key is not provisioned.
- `200`:
  ```json
  { "success": true, "classification": "VERIFIED", "version": 7,
    "entry": "eip155:<chain>:<router>:uniswap-ur",
    "signedPayload": "0x03…", "keyId": 128, "fingerprint": "a9531b9d", "alias": "…",
    "chainId": 8453, "contract": "<router>", "selector": "0x3593564c",
    "method": "execute", "decoder": 1, "title": "Uniswap",
    "tokens": [{ "address": "…", "symbol": "USDC", "decimals": 6 }],
    "provenance": { "source": "<Uniswap deploy-addresses URL>", "entry": "base.json UniversalRouterV1_2_V2Support" } }
  ```

`signedPayload` is `0x03 | certificate (139) | body | r s v (65)`. The body is
`0x07 | chain_id u32 | router 20 | selector 4 | u16 len "execute" | 0x01
(UNISWAP_UR) | u8 len "Uniswap" | u8 n | n × (address 20, decimals u8, u8 len
symbol) | 0x01 VERIFIED | u32 0 | 0x80`. Desktop rebuilds the body from its
own reviewed table and refuses a response whose body differs.

Desktop asks only after its own pre-check, a port of the firmware decoder
(`src/bun/uniswap-ur.ts`): the call is to a reviewed router, the calldata is
at most 1472 bytes (a longer call than the first signing chunk is held and
decoded after its last byte), and it decodes to at most 4 commands shaped
`[PERMIT2_PERMIT | WRAP_ETH] -> one V2 or V3 swap -> [PAY_PORTION] -> [SWEEP |
UNWRAP_WETH] -> [clean-up]`. Otherwise the call stays on the AdvancedMode path.

- Split route: the swap may be two exact-in swaps of the same pair (same
  input and output token, recipient and payer). The device shows the totals:
  the summed input and the summed minimums. A second swap of a different pair
  (a multi-hop through two pool versions) is refused.
- Clean-up: one trailing `UNWRAP_WETH`, or `SWEEP` of ETH (token address 0),
  that returns leftovers. It is allowed only to the recipient the review
  names. When the swap delivers to the router, the first trailing step
  delivers the output and the next is the clean-up; when the swap delivers
  directly, a single trailing step is the clean-up.
- Floor: for exact input with no fee, the minimum shown is the larger of the
  swap minimum and the delivering step's minimum.

The entries are static: each names only a router, the selector, and the
identities (symbol, decimals) of reviewed tokens. Nothing in an entry depends
on a particular transaction. Per owner decision D-018 (2026-10-04, no live
signing), they are planned to be signed offline and shipped as a fixed set.
Today the Worker still signs an entry with the delegate key on request.

`GET /v1/catalog` lists, for every EVM entry, its `title`, `template`, and
the `screens` KeepKey shows, in device order. Uniswap swap entries (one per
router) give the screens with `{in}`/`{out}` placeholders, an `exactOut`
variant, and a `when` on the conditional Recipient, Allowance and Fee
screens. `EXPECTED-SCREENS.md` has the same screens for owner review.

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
