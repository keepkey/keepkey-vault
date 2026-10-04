import { hostname } from 'node:os'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE
  || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const NETWORKS: Record<string, { endpoint: string; chainId: string; symbol: string; decimals: number; slip44: number }> = {
  'cosmos:cosmoshub-4/slip44:118': { endpoint: 'https://cosmos-rpc.publicnode.com/status',
    chainId: 'cosmoshub-4', symbol: 'ATOM', decimals: 6, slip44: 118 },
  'cosmos:osmosis-1/slip44:118': { endpoint: 'https://osmosis-rpc.publicnode.com/status',
    chainId: 'osmosis-1', symbol: 'OSMO', decimals: 6, slip44: 118 },
  'cosmos:mayachain-mainnet-v1/slip44:931': { endpoint: 'https://tendermint.mayachain.info/status',
    chainId: 'mayachain-mainnet-v1', symbol: 'CACAO', decimals: 10, slip44: 931 },
  'cosmos:thorchain-1/slip44:931': { endpoint: 'https://gateway.liquify.com/chain/thorchain_rpc/status',
    chainId: 'thorchain-1', symbol: 'RUNE', decimals: 8, slip44: 931 },
  'cosmos:thorchain-mainnet-v1/slip44:931': { endpoint: 'https://gateway.liquify.com/chain/thorchain_rpc/status',
    chainId: 'thorchain-1', symbol: 'RUNE', decimals: 8, slip44: 931 },
}

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function evidenceFor(lease: any) {
  const expected = NETWORKS[lease.caip]
  if (!expected) throw new Error('ASSET_CAIP_UNSUPPORTED')
  const url = new URL(expected.endpoint)
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const result: any = (await response.json())?.result
  const blockHeight = Number(result?.sync_info?.latest_block_height)
  const blockHash = String(result?.sync_info?.latest_block_hash || '').toLowerCase()
  const appHash = String(result?.sync_info?.latest_app_hash || '').toLowerCase()
  if (result?.node_info?.network !== expected.chainId || result?.sync_info?.catching_up !== false
    || !Number.isSafeInteger(blockHeight) || blockHeight < 1 || !/^[0-9a-f]{64}$/.test(blockHash)
    || !/^[0-9a-f]{64}$/.test(appHash)) throw new Error('RPC_CHAIN_STATE_INVALID')
  return { version: 1, kind: 'cosmos-native-asset', caip: lease.caip, network: lease.network,
    chainId: expected.chainId, symbol: expected.symbol, decimals: expected.decimals, slip44: expected.slip44,
    blockHeight, blockHash, appHash, rpcHost: url.hostname, auditedAt: Date.now(), result: 'candidate' }
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-cosmos-asset-auditor:${hostname()}`, namespace: 'cosmos', kind: 'native',
  })
  const lease = claimed?.lease
  if (!lease) return false
  try {
    const evidence = await evidenceFor(lease)
    if (process.env.CLEARSIGN_AUDIT_DEBUG === '1') console.error(JSON.stringify({ lease, evidence }))
    const submitted = await operator('/v1/admin/discovery/assets/audit', {
      caip: lease.caip, leaseToken: lease.leaseToken, evidence,
    })
    console.log(JSON.stringify({ audited: true, caip: lease.caip, auditStatus: submitted.auditStatus,
      coverageStatus: submitted.coverageStatus, evidenceHash: submitted.evidenceHash }))
  } catch (error: any) {
    const errorClass = String(error?.message || 'AUDIT_FAILED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64)
    await operator('/v1/admin/discovery/assets/fail', {
      caip: lease.caip, leaseToken: lease.leaseToken, errorClass,
    }).catch(() => {})
    console.error(JSON.stringify({ audited: false, caip: lease.caip, errorClass }))
  }
  return true
}

const daemon = process.argv.includes('--daemon')
do {
  let processed = 0
  while (processed < 4 && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
