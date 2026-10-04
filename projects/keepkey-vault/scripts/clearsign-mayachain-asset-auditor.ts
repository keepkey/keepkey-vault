import { hostname } from 'node:os'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const rpc = process.env.CLEARSIGN_MAYACHAIN_RPC || 'https://tendermint.mayachain.info'
const api = process.env.CLEARSIGN_MAYACHAIN_API || 'https://mayanode.mayachain.info'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE
  || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const NETWORK = 'cosmos:mayachain-mainnet-v1'

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function getJson(base: string, path: string) {
  const url = new URL(path, base)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('RPC_ENDPOINT_UNSAFE')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  return response.json() as Promise<any>
}

async function evidenceFor(lease: any) {
  if (lease.caip !== `${NETWORK}/denom:maya` || lease.network !== NETWORK
    || lease.claimedSymbol !== 'MAYA' || lease.claimedDecimals !== 4) throw new Error('ASSET_CAIP_UNSUPPORTED')
  const [status, supply, pool] = await Promise.all([
    getJson(rpc, '/status'), getJson(api, '/cosmos/bank/v1beta1/supply/maya'),
    getJson(api, '/mayachain/pool/MAYA.MAYA'),
  ])
  const sync = status?.result?.sync_info
  const blockHeight = Number(sync?.latest_block_height)
  const blockHash = String(sync?.latest_block_hash || '').toLowerCase()
  const appHash = String(sync?.latest_app_hash || '').toLowerCase()
  const rawSupply = String(supply?.amount?.amount || '')
  if (status?.result?.node_info?.network !== 'mayachain-mainnet-v1' || sync?.catching_up !== false
    || !Number.isSafeInteger(blockHeight) || blockHeight < 1 || !/^[0-9a-f]{64}$/.test(blockHash)
    || !/^[0-9a-f]{64}$/.test(appHash) || supply?.amount?.denom !== 'maya'
    || !/^[1-9][0-9]*$/.test(rawSupply) || pool?.asset !== 'MAYA.MAYA' || pool?.status !== 'Available') {
    throw new Error('RPC_CHAIN_STATE_INVALID')
  }
  return { version: 1, kind: 'mayachain-maya-asset', caip: lease.caip, network: NETWORK,
    reportedChainId: 'mayachain-mainnet-v1', denom: 'maya', symbol: 'MAYA', decimals: 4,
    rawSupply, poolAsset: 'MAYA.MAYA', poolStatus: 'Available', blockHeight, blockHash, appHash,
    rpcHost: new URL(rpc).hostname, apiHost: new URL(api).hostname, auditedAt: Date.now(), result: 'candidate' }
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-mayachain-asset-auditor:${hostname()}`, namespace: 'cosmos', kind: 'denom', network: NETWORK,
  })
  const lease = claimed.lease
  if (!lease) return false
  try {
    const evidence = await evidenceFor(lease)
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
  const processed = await auditOne() ? 1 : 0
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
