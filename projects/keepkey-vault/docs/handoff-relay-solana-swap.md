# Handoff: Relay Solana→EVM Swap Support

## Status

**BLOCKED on Pioneer.** The vault cannot complete Solana-input Relay swaps until Pioneer
serializes the VersionedTransaction server-side. This doc describes exactly what Pioneer
must add and what the vault will do once it does.

## Root Cause

When a user swaps SOL→ETH via Relay, Pioneer's relay integration returns:

```json
{
  "integration": "relay",
  "quote": {
    "txs": [{
      "type": "SOLANA",
      "chain": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "txParams": {
        "senderAddress": "5y52MbSD...",
        "recipientAddress": "0x9f5f2e60...",
        "instructions": [ { "programId": "99vQ...", "keys": [...], "data": "0d9e..." } ],
        "addressLookupTableAddresses": ["Hm9fUg..."]
      }
    }]
  }
}
```

The vault has no `@solana/web3.js` to compile these into a signed transaction. It needs:
1. A recent blockhash (Solana RPC call)
2. `VersionedTransaction` with address lookup tables (v0 format)
3. Serialized to base64

Pioneer already has `@solana/web3.js` in its dependencies.

## What Pioneer Must Add

**File:** `modules/intergrations/relay/src/index.ts` — in the `getQuote()` function, after building the `txs` array for `sellChainType === 'solana'`.

### Step 1: Import Solana web3

```typescript
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from '@solana/web3.js'
```

### Step 2: Fetch blockhash + compile transaction

After extracting `txData.instructions` and `txData.addressLookupTableAddresses`, add:

```typescript
// Serialize Solana VersionedTransaction so vault can sign without @solana/web3.js
async function buildSerializedSolanaTx(
  senderAddress: string,
  instructions: any[],
  altAddresses: string[],
  rpcUrl = 'https://api.mainnet-beta.solana.com'
): Promise<string> {
  const connection = new Connection(rpcUrl, 'confirmed')

  // Fetch address lookup tables
  const alts: AddressLookupTableAccount[] = []
  for (const addr of altAddresses) {
    const resp = await connection.getAddressLookupTable(new PublicKey(addr))
    if (resp.value) alts.push(resp.value)
  }

  // Convert raw instruction objects to TransactionInstruction format
  const txInstructions = instructions.map((ix: any) => ({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k: any) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data, 'hex'),
  }))

  const { blockhash } = await connection.getLatestBlockhash('confirmed')

  const message = new TransactionMessage({
    payerKey: new PublicKey(senderAddress),
    recentBlockhash: blockhash,
    instructions: txInstructions,
  }).compileToV0Message(alts)

  const tx = new VersionedTransaction(message)
  // Return unsigned serialized tx — vault will inject signature
  return Buffer.from(tx.serialize()).toString('base64')
}
```

Then in the Solana branch of the `txs` builder:

```typescript
if (sellChainType === 'solana') {
  const serializedTx = await buildSerializedSolanaTx(
    quote.senderAddress,
    txData.instructions || [],
    txData.addressLookupTableAddresses || []
  )
  txs.push({
    type: 'SOLANA',
    chain: sellNetworkCaip,
    txParams: {
      senderAddress: quote.senderAddress,
      recipientAddress: quote.recipientAddress,
      instructions: txData.instructions || [],
      addressLookupTableAddresses: txData.addressLookupTableAddresses || [],
      serializedTx,  // ← NEW: base64 unsigned VersionedTransaction
    }
  })
}
```

## What the Vault Will Do (Already Wired)

`swap-parsing.ts` already detects `txParams.serializedTx` and will:
1. Extract it into `solanaTx: { serializedTx, senderAddress }`
2. Pass `hasPrebuiltTx = true` (no "MISSING memo" error)

The execution path (`swap.ts`) will need a small addition to handle `solanaTx` — call
`solanaSignTx({ rawTx: serializedTx })` and broadcast the signed result via Pioneer.
That work is straightforward and will be added once Pioneer ships the serialized tx.

## Error Today

Without `serializedTx`, the vault logs:

```
[swap] Relay Solana tx — instructions-only format not yet supported
[swap]   Pioneer must compile the VersionedTransaction and return txParams.serializedTx
```

And throws a user-visible error pointing to this doc.

## Testing

Once Pioneer adds `serializedTx`:
1. Run a SOL→ETH quote and confirm `txParams.serializedTx` is present (base64, ~300+ chars)
2. Decode it: `Buffer.from(serializedTx, 'base64')` → should parse as a valid VersionedTransaction
3. The vault's `solanaSignTx` will compile the rest

## Pioneer File

```
/Users/highlander/WebstormProjects/keepkey-stack/projects/pioneer/modules/intergrations/relay/src/index.ts
```

Lines ~400-413 (the `sellChainType === 'solana'` branch).
