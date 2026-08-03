# keepkey-vault-sdk

Typed TypeScript SDK for the KeepKey hardware wallet REST API.

Zero dependencies, native `fetch`. Works in browser, Node, Bun, and edge runtimes.

## Install

```bash
npm install keepkey-vault-sdk
# or
pnpm add keepkey-vault-sdk
# or
bun add keepkey-vault-sdk
```

```ts
import { KeepKeySdk } from 'keepkey-vault-sdk'
```

## Requirements

The KeepKey desktop application must be running on the same machine as your app. It exposes the REST API on `http://localhost:1646`.

Download the latest desktop application: https://github.com/keepkey/keepkey-vault/releases/latest

## Quick start

```ts
import { KeepKeySdk } from 'keepkey-vault-sdk'

// Auto-pairs on first run — prompts the user to approve in the KeepKey app.
const sdk = await KeepKeySdk.create({
  serviceName: 'My App',
  serviceImageUrl: 'https://example.com/icon.png',
})

// Derive an ETH address
const { address } = await sdk.address.ethGetAddress({
  address_n: [0x8000002C, 0x8000003C, 0x80000000, 0, 0],
  show_display: true,
})

console.log(address)
```

## Reusing a saved API key

After the first successful pairing, save the API key and reuse it on subsequent runs to skip the approval prompt:

```ts
const sdk = await KeepKeySdk.create({
  apiKey: process.env.KEEPKEY_API_KEY,
  serviceName: 'My App',
})

console.log(sdk.apiKey) // store this somewhere safe
```

If the key is invalid or revoked, the SDK will re-pair automatically.

## API surface

All methods are grouped by domain on the `KeepKeySdk` instance:

| Namespace       | What it does                                                        |
|-----------------|---------------------------------------------------------------------|
| `sdk.system`    | Device info, health, PIN management, initialization, firmware      |
| `sdk.address`   | Derive addresses (BTC, ETH, Cosmos, Osmosis, Solana, XRP, TRON, …) |
| `sdk.eth`       | Ethereum signing — tx, message, EIP-712 typed data                 |
| `sdk.btc`       | Bitcoin / UTXO transaction signing                                  |
| `sdk.cosmos`    | Cosmos Hub amino signing — transfer, staking, IBC                  |
| `sdk.osmosis`   | Osmosis amino signing — transfer, staking, IBC, LP, swap           |
| `sdk.thorchain` | THORChain transfer and deposit                                      |
| `sdk.mayachain` | MAYAChain transfer and deposit                                      |
| `sdk.ripple`    | XRP transaction signing                                             |
| `sdk.binance`   | BNB Beacon Chain signing                                            |
| `sdk.solana`    | Solana transaction signing (incl. SPL tokens)                      |
| `sdk.tron`      | TRON signing (incl. TRC-20)                                         |
| `sdk.ton`       | TON signing (incl. Jettons)                                         |
| `sdk.xpub`      | Extended public key derivation — single and batch                  |
| `sdk.chain`     | Portfolio balances, market info, UTXOs, tx history, swap quotes    |
| `sdk.sweep`     | Recover BTC from non-standard derivation paths                      |

## OpenAPI spec

The REST API specification is bundled with the package:

```ts
import spec from 'keepkey-vault-sdk/openapi/swagger.json'
```

Use it with Swagger UI, Redoc, or any OpenAPI-compatible tool.

## RC24 hardware acceptance

The RC24 gate runs through the production SDK → Vault → hdwallet → KeepKey
path. It is interactive, never wipes or loads a device, never broadcasts, and
is excluded from normal test runs unless its hardware guard and one explicit
phase are supplied.

```bash
RC24_EXPECT_FIRMWARE_HASH=<sha256> KEEPKEY_API_KEY=... npm run test:rc24:hardware -- taproot
RC24_EXPECT_FIRMWARE_HASH=<sha256> KEEPKEY_API_KEY=... npm run test:rc24:hardware -- p2wpkh-control
RC24_EXPECT_FIRMWARE_HASH=<sha256> KEEPKEY_API_KEY=... npm run test:rc24:hardware -- locked-entropy
RC24_EXPECT_FIRMWARE_HASH=<sha256> KEEPKEY_API_KEY=... npm run test:rc24:hardware -- entropy-budget
```

Run `locked-entropy` on an initialized PIN-protected test device. Run
`entropy-budget` only on a disposable, uninitialized device immediately after
a power cycle. The runner itself never changes device initialization state.

## Security

- Every signing operation requires the user to confirm on the KeepKey hardware device.
- Signing endpoints block until the user approves or rejects. Default timeout is 10 minutes.
- The API key grants the holder the ability to *request* signatures from the device. The device is still the only place the user's keys exist.

## License

MIT
