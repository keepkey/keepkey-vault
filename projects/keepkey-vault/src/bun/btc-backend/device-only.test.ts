/**
 * DeviceOnlyBackend must refuse every network op in offline (airplane) mode —
 * the "stays offline" guarantee. It also exercises the network selector so
 * testnet/altcoin requests cannot retain a Pioneer path while offline.
 * Run: bun src/bun/btc-backend/device-only.test.ts
 */
import { DeviceOnlyBackend } from './device-only'
import {
  broadcastBtcTx,
  getBackendForNetwork,
  setBtcBackendOffline,
} from './index'

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

// Selection must be global while offline. Testnet and non-BTC UTXO networks
// must not retain a hidden Pioneer path.
setBtcBackendOffline(true)
for (const network of [
  'bip122:000000000019d6689c085ae165831e93',
  'bip122:000000000933ea01ad0ee984209779ba',
  'bip122:12a765e31ffd4059bada1e25190f6e98',
]) {
  if (getBackendForNetwork(network).kind !== 'device-only') {
    throw new Error(`FAIL: offline ${network} did not select device-only`)
  }
  pass++
}
await throwsOffline(
  () => broadcastBtcTx({ Broadcast: () => { throw new Error('Pioneer reached') } },
    'bip122:000000000933ea01ad0ee984209779ba', '00'),
  'testnet broadcast selection',
)
setBtcBackendOffline(false)

console.log(`[btc-backend] device-only OK — ${pass} assertions passed`)
