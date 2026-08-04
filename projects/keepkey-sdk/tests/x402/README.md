# x402 hardware tests

The EVM and SVM fixtures in this directory sign deliberately unusable payments
and never broadcast them. `venice-image.js` is different: its funded stages use
real Base USDC and the Venice production API.

## Venice image generation

Venice uses a wallet as identity and a prepaid balance as its spending layer.
The `top-up` stage is the on-chain x402 EIP-3009 payment. Image generation then
uses a fresh SIWE signature and charges the prepaid balance.

Build and inspect the current public payment challenge without touching the
device:

```sh
npm run test:x402:venice -- challenge
```

Read the wallet-bound Venice balance. This signs SIWE on the device but cannot
spend anything:

```sh
npm run test:x402:venice -- probe
```

Authorize the production top-up only after comparing the live amount and
recipient with the KeepKey screen:

```sh
npm run test:x402:venice -- top-up --confirm-top-up=5
```

Generate one `z-image-turbo` image from existing balance. The flag is a hard
maximum charge, not a request to spend the whole amount:

```sh
npm run test:x402:venice -- generate --confirm-image-spend=0.02
```

Run the complete sequence. A top-up occurs only when the initial balance cannot
cover the expected image price:

```sh
npm run test:x402:venice -- all --confirm-top-up=5 --confirm-image-spend=0.02
```

The generated PNG defaults to the operating system's temporary directory. Use
`--output=./venice-x402.png` to select another new file. Existing files are
never overwritten.

No Venice API key or raw wallet private key is used. The test intentionally
does not auto-top-up, auto-retry a submitted payment authorization, or accept
Permit2. Current firmware renders multiline SIWE as bytes; Vault provides the
readable authentication message. The top-up amount and recipient are the part
that firmware hardware-ClearSigns.

## BlockRun image generation on Solana

BlockRun's Solana gateway charges each request directly in mainnet SPL USDC.
The facilitator sponsors the network fee, so the KeepKey wallet needs Solana
USDC but does not need SOL. No BlockRun API key or raw wallet private key is
used.

Inspect the live x402 v2 challenge without touching the device:

```sh
npm run test:x402:blockrun-solana -- challenge
```

Derive the KeepKey Solana address and read its canonical USDC balance without
signing anything:

```sh
npm run test:x402:blockrun-solana -- probe
```

Generate one CogView-4 PNG. The flag is a hard maximum; the live challenge is
validated before the device is asked to sign:

```sh
npm run test:x402:blockrun-solana -- generate --confirm-image-spend=0.03
```

Use `BLOCKRUN_IMAGE_PROMPT='...'` to choose the image and
`--output=./blockrun-solana-x402.png` to select a new output file. Existing
files are never overwritten; if the provider returns JPEG, WebP, or AVIF, the
test corrects the extension before writing. The test requires the official transaction shape:
sponsored v0, zero address lookup tables, compute limit, compute price,
`TransferChecked`, and a uniqueness memo. It verifies the KeepKey signature,
leaves the facilitator signature slot empty, submits the payment only once,
and proves the exact payment on Solana before saving the PNG. If the service
omits `PAYMENT-RESPONSE`, the test locates the unique memo-bearing transaction
from the signed source account and checks its fee payer, four instructions,
mint, amount, decimals, authority, recipient owner, and token balance deltas
through read-only Solana RPC calls.
