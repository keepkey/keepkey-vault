import { hostname } from 'node:os'
import { createHash } from 'node:crypto'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const endpoints = (process.env.CLEARSIGN_THORCHAIN_ENDPOINTS
  || 'https://api-thorchain.rorcual.xyz,https://thornode.ninerealms.com').split(',').map(value => value.trim()).filter(Boolean)
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const NETWORK = 'cosmos:thorchain-mainnet-v1'

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function getJson(base: string, path: string) {
  const response = await fetch(`${base}${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  return response.json() as Promise<any>
}

let cached: { expiresAt: number; endpoint: string; height: number; hash: string; pools: Map<string, any> } | undefined
async function chainState() {
  if (cached && cached.expiresAt > Date.now()) return cached
  let lastError: unknown
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')
      const [latest, rows] = await Promise.all([
        getJson(endpoint, '/cosmos/base/tendermint/v1beta1/blocks/latest'), getJson(endpoint, '/thorchain/pools'),
      ])
      const height = Number(latest?.block?.header?.height)
      const chainId = latest?.block?.header?.chain_id
      const hashBytes = Buffer.from(String(latest?.block_id?.hash || ''), 'base64')
      if (chainId !== 'thorchain-1' || !Number.isSafeInteger(height) || height < 1 || hashBytes.length !== 32
        || !Array.isArray(rows)) throw new Error('RPC_CHAIN_STATE_INVALID')
      const pools = new Map<string, any>()
      for (const row of rows) if (typeof row?.asset === 'string') pools.set(row.asset, row)
      cached = { expiresAt: Date.now() + 30_000, endpoint, height, hash: `0x${hashBytes.toString('hex')}`, pools }
      return cached
    } catch (error) { lastError = error }
  }
  throw lastError || new Error('RPC_UNAVAILABLE')
}

async function evidenceFor(lease: any) {
  const denom = String(lease.caip).match(/^cosmos:thorchain-mainnet-v1\/denom:([a-z0-9-]+)$/)?.[1]
  const state = await chainState()
  if (!denom || !denom.includes('-')) {
    if (lease.network !== NETWORK) throw new Error('ASSET_CAIP_UNSUPPORTED')
    return { version: 1, kind: 'thorchain-pool-asset', caip: lease.caip, network: NETWORK,
      reportedChainId: 'thorchain-1', rejectionReason: 'unsupported-denom-identity',
      displayDecimals: 8, amountEncoding: 'thorchain-e8',
      blockHeight: state.height, blockHash: state.hash, rpcHost: new URL(state.endpoint).hostname,
      auditedAt: Date.now(), result: 'identity-unavailable' }
  }
  const poolAsset = denom.replace(/^([a-z0-9]+)-/, '$1.').toUpperCase()
  const pool = state.pools.get(poolAsset)
  if (!pool) throw new Error('POOL_NOT_LISTED')
  const decimals = Number(pool.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255
    || !['Available','Staged','Suspended'].includes(pool.status)) {
    return { version: 1, kind: 'thorchain-pool-asset', caip: lease.caip, network: NETWORK,
      reportedChainId: 'thorchain-1', poolAsset, rejectionReason: 'invalid-pool-identity',
      poolSnapshotHash: createHash('sha256').update(JSON.stringify(pool)).digest('hex'),
      displayDecimals: 8, amountEncoding: 'thorchain-e8',
      blockHeight: state.height, blockHash: state.hash, rpcHost: new URL(state.endpoint).hostname,
      auditedAt: Date.now(), result: 'identity-unavailable' }
  }
  return { version: 1, kind: 'thorchain-pool-asset', caip: lease.caip, network: NETWORK,
    reportedChainId: 'thorchain-1', poolAsset, poolStatus: pool.status, nativeDecimals: decimals,
    displayDecimals: 8, amountEncoding: 'thorchain-e8',
    blockHeight: state.height, blockHash: state.hash, rpcHost: new URL(state.endpoint).hostname,
    auditedAt: Date.now(), result: 'candidate' }
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-thorchain-asset-auditor:${hostname()}`, namespace: 'cosmos', kind: 'denom', network: NETWORK,
  })
  const lease = claimed.lease
  if (!lease) return false
  try {
    const evidence = await evidenceFor(lease)
    const submitted = await operator('/v1/admin/discovery/assets/audit', { caip: lease.caip,
      leaseToken: lease.leaseToken, evidence })
    console.log(JSON.stringify({ audited: true, caip: lease.caip, auditStatus: submitted.auditStatus,
      coverageStatus: submitted.coverageStatus, evidenceHash: submitted.evidenceHash }))
  } catch (error: any) {
    const errorClass = String(error?.message || 'AUDIT_FAILED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64)
    await operator('/v1/admin/discovery/assets/fail', { caip: lease.caip, leaseToken: lease.leaseToken, errorClass }).catch(() => {})
    console.error(JSON.stringify({ audited: false, caip: lease.caip, errorClass }))
  }
  return true
}

const daemon = process.argv.includes('--daemon')
const requested = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] || (daemon ? 5 : 1))
const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(50, requested)) : 1
do {
  let processed = 0
  while (processed < limit && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
