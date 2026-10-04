# KeepKey ClearSign service

**Live at:** `https://keepkey-clearsign.bithighlander.workers.dev` (Cloudflare Worker `keepkey-clearsign`).
There is no custom domain yet; KeepKey Desktop has this URL built in
(`DEFAULT_CLEARSIGN_SERVICE_URL`, `src/bun/solana-certified-registry.ts`).

## What this is

A KeepKey can only show you what a transaction does if it understands the contract. For contracts it
does not know, it falls back to raw data and blocks unless AdvancedMode is on.

This service closes that gap without asking you to trust it blindly. For a transaction *shape* that
KeepKey has reviewed (a chain, a contract, a function, an exact calldata size), it returns a small
**signed description**: what each argument means, how to show it, and a one-line summary. Your KeepKey
checks the signature, then decodes the **real values from the transaction it is about to sign**, and
shows them as "certified by KeepKey". The service never supplies amounts or addresses; it cannot make
the device show something the transaction does not do.

If the service does not know a transaction, it says so (`422`, `OPAQUE`) and nothing changes: the
device uses its normal review.

## How trust works

```
Root key (offline, on a marked KeepKey)
   └─ signs a per-chain certificate:  "delegate a9531b9d may describe chain X until 2026-12-31"
        └─ delegate key (Cloudflare secret, used by this service)
             └─ signs a description for one transaction shape
                  └─ KeepKey firmware 7.16 checks: certificate → description → this exact transaction
```

- Root public key `02de9231…dae7` is built into 7.16 firmware. Its private key never leaves the root KeepKey.
- Delegate `0342f5f9…50cf`, fingerprint `a9531b9d`, alias "KeepKey Alpha 716", firmware key id `0x80`.
- **A certificate is per chain.** A chain without one cannot be certified, whatever the catalog says.
- Revocation: certificates expire (`2026-12-31`); firmware can raise its minimum expiry in a release.

## What it covers today

| Chain | Certificate | Certified transactions |
|---|---|---|
| Ethereum (1) | yes | Relay `bridgeDeposit`; Portals swap |
| Base (8453) | yes (root ceremony 2026-10-03) | ERC-20 approve/transfer for USDC, USDbC, WETH, DAI, cbBTC, cbETH |
| Arbitrum (42161) | yes (root ceremony 2026-10-03) | ERC-20 approve/transfer for USDC, USDT0, WETH, DAI, WBTC |
| Solana | yes | Pump AMM buy/sell; Relay deposits; SoltoshiDICE (session, tables, tournaments, Cee-lo) |

An approve to Uniswap Permit2 reads "Let the Uniswap approval contract spend up
to {amount} for trades you sign": the schema pins the Permit2 address, so the
words are true by construction. Any other spender gets the generic "Token
approval" entry. Name records (`/v1/evm/name`) cover Universal Router addresses.
`GET /v1/catalog` is the authoritative list.


## What leaves your computer

- **Ethereum:** chain id, contract address, function selector, calldata length. Never the arguments.
- **Solana:** the unsigned transaction (needed to resolve lookup tables and match the one reviewed
  instruction). Never keys, seeds, PINs, passphrases or signatures.
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
- The service stores no transaction database.

## API

All responses are JSON. CORS is open. Requests over the size limit get `413`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Human-readable status page |
| GET | `/health` | Liveness + readiness summary |
| GET | `/ready` | `200` when ready, `503` otherwise |
| GET | `/v1/status` | Full status: scopes, trust anchors, privacy, endpoints |
| GET | `/v1/catalog` | Every reviewed entry (cached 5 min) |
| GET | `/signer` | Delegate key, fingerprint, key id, scopes, certificate expiry |
| POST | `/v1/evm/schema` | Signed description for an EVM transaction shape (`/sign` is an alias) |
| POST | `/v1/evm/swap` | Signed Uniswap Universal Router decoder entry with token identities |
| POST | `/v1/evm/name` | Signed name for a reviewed EVM address |
| POST | `/v1/solana/certify` | Signed description (+ lookup-table proof, token identities) for a Solana transaction |

### Classifications

| `classification` | HTTP | Meaning |
|---|---|---|
| `VERIFIED` | 200 | Signed description returned; the device verifies it. |
| `OPAQUE` | 422 | Not in the reviewed catalog. Not an error: use the normal review. |
| `UNAVAILABLE` | 503 / 422 | The scope is not provisioned (no certificate or key), or a dependency (Solana RPC) failed. |

### `GET /signer`

```json
{"status":"ready","alias":"KeepKey Alpha 716","fingerprint":"a9531b9d",
 "publicKeyHex":"0342f5f9704494b3f9bd72295eecaf29d783d23ea02b2dc9f48abcd2e46d4850cf",
 "keyId":128,"scopes":{"ethereum":"ready","solana":"ready"},
 "certificateExpiresAt":"2026-12-31T00:00:00.000Z"}
```

### `POST /v1/evm/schema`

Request: only the transaction's shape.

```sh
curl -X POST https://keepkey-clearsign.bithighlander.workers.dev/v1/evm/schema \
  -H 'content-type: application/json' \
  -d '{"chainId":8453,"contract":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","selector":"0x095ea7b3","calldataLength":68}'
```

Not reviewed (today's answer for USDC approve on Base):

```json
{"classification":"OPAQUE","error":"contract, selector, or calldata shape is not in the reviewed catalog"}
```

Reviewed: `200` with `classification: "VERIFIED"`, `signedPayload` (hex, starts `03`), `keyId` (`128`),
`fingerprint`, and the matched `method`, `chainId`, `contract`, `selector`, `expectedCalldataLength`.
KeepKey Desktop passes `signedPayload` to the device as the transaction's metadata.

### `POST /v1/evm/name`

Request `{"chainId": 1, "address": "0x…"}`. Returns a signed name (`version: 6`) for a reviewed
address, or `422 OPAQUE`.

### `POST /v1/solana/certify`

Request `{"rawTx": "<base64 unsigned transaction>", "catalogKey": "<optional>"}`. Without
`catalogKey` the service finds the single reviewed instruction the transaction contains, and certifies
it only if the firmware's rule applies (at most 8 instructions; the others ComputeBudget, Memo or a
plain System transfer). Response: `schema` (payload, signature, signer key id), `certificate`,
`alias`, `fingerprint`, and when the transaction uses lookup tables, `lutProof` with the resolved
accounts.

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

## Not covered yet

- Uniswap V4-routed swaps (not decoded by the device; AdvancedMode path).
- Calls over 1,472 bytes or with more than 4 router commands.
- Tokens outside the reviewed list, and chains without a certificate.

`GET /v1/catalog` lists, for every EVM entry, its `title`, `template`, and
the `screens` KeepKey shows, in device order. Uniswap swap entries (one per
router) give the screens with `{in}`/`{out}` placeholders, an `exactOut`
variant, and a `when` on the conditional Recipient, Allowance and Fee
screens. `EXPECTED-SCREENS.md` has the same screens for owner review.

## Operating it

```sh
bun test clearsign-worker/src/index.test.ts
npx wrangler deploy --config clearsign-worker/wrangler.toml
```

Secrets (set through stdin, never in this repo or `wrangler.toml`): `CLEARSIGN_DELEGATE_PRIVATE_KEY`,
`CLEARSIGN_CERTIFICATE_HEX` (Ethereum mainnet), `CLEARSIGN_SOLANA_CERTIFICATE_HEX`, and
`CLEARSIGN_EVM_CERTIFICATES_JSON` (`{"<chainId>": "<certificate hex>"}` for Base, Arbitrum and any
other EVM chain).

`/ready` is `200` only when the delegate key matches `a9531b9d` and at least one root-signed,
scope-correct certificate is active. Before pointing KeepKey Desktop at a new deployment, test the
positive routes and the tampered ones (chain, contract, selector, length, program, lookup table,
certificate, signature).

Source: this folder plus the shared catalog and signing code in `src/bun/` —
`evm-certified-schema.ts` (EVM catalog + names), `solana-certified-schema.ts` (Solana catalog),
`clearsign-alpha-ceremony.ts` (root, delegate, certificates).
