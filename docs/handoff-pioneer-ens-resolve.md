# Handoff: Pioneer ENS Resolution Endpoint

## Context

The Vault's `resolveEns` RPC (added in `feat/ens-resolution`) sends ENS lookups to Pioneer at:

```
POST /api/v1/names/ens-resolve
Body: { "name": "vitalik.eth" }
Response: { "data": { "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" | null } }
```

The Vault degrades gracefully when the endpoint is missing (returns `{ address: null }`, shows "ENS name not found"). But the feature is broken for users until this is implemented on Pioneer.

## What to build

Add a new route to the name controller (`src/controllers/name.controller.ts`):

```typescript
@Post('/names/ens-resolve')
@OperationId('ResolveEns')
@SuccessResponse('200', 'OK')
public async ResolveEns(@Body() body: { name: string }): Promise<{ data: { address: string | null } }> {
    if (!body?.name?.endsWith('.eth')) throw httpError(400, 'Only .eth names are supported')
    
    const { ethers } = await import('ethers')
    // Reuse the ETH mainnet network object if pioneerNetworks has it, otherwise public RPC.
    const rpcUrl = (global as any).pioneerNetworks?.['eip155:1']?.rpcUrl 
        ?? 'https://ethereum-rpc.publicnode.com'
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
    const address = await provider.resolveName(body.name).catch(() => null)
    return { data: { address } }
}
```

Also register the route in `routes.ts` (tsoa auto-generates this — just re-run `npx tsoa routes` after adding the method).

## Caching (optional but recommended)

ENS records are stable for hours. A simple in-memory TTL cache (e.g. 1 hour) would eliminate redundant eth_call traffic:

```typescript
const ensCache = new Map<string, { address: string | null; expiresAt: number }>()
const TTL_MS = 60 * 60 * 1000

function getCached(name: string) {
    const entry = ensCache.get(name)
    if (entry && entry.expiresAt > Date.now()) return entry.address
    return undefined
}
```

## Future: reverse lookup (address → ENS name)

For the Address Book display, it would be useful to also have:
```
POST /api/v1/names/ens-reverse
Body: { "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }
Response: { "data": { "name": "vitalik.eth" | null } }
```

This isn't needed for v1 (send flow only) but would let the Address Book show ENS names for known contacts.
