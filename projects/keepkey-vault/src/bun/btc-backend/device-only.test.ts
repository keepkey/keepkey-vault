/**
 * DeviceOnlyBackend must refuse every network op in offline (airplane) mode —
 * the "stays offline" guarantee. Import-free (device-only.ts only imports types),
 * so no electrobun/pioneer chain. Run: bun src/bun/btc-backend/device-only.test.ts
 */
import { DeviceOnlyBackend } from './device-only'

let pass = 0
async function throwsOffline(fn: () => Promise<unknown>, label: string) {
  try {
    await fn()
    throw new Error(`FAIL ${label}: did not throw`)
  } catch (e: any) {
    if (!/OFFLINE/.test(e.message)) throw new Error(`FAIL ${label}: wrong error ${e.message}`)
    pass++
  }
}

await throwsOffline(() => DeviceOnlyBackend.listUnspent({ network: 'x', xpub: 'y' }), 'listUnspent')
await throwsOffline(() => DeviceOnlyBackend.feeRate('x'), 'feeRate')
await throwsOffline(() => DeviceOnlyBackend.broadcast({ network: 'x', rawTxHex: 'y' }), 'broadcast')
await throwsOffline(() => DeviceOnlyBackend.rawTxHex({ network: 'x', txid: 'y' }), 'rawTxHex')

if (DeviceOnlyBackend.capabilities.history || DeviceOnlyBackend.capabilities.push)
  throw new Error('FAIL: offline backend must advertise no history/push')
pass++

console.log(`[btc-backend] device-only OK — ${pass} assertions passed`)
