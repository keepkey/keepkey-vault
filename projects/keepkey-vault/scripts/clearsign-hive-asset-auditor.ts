import { hostname } from 'node:os'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const endpoint = process.env.CLEARSIGN_HIVE_RPC_ENDPOINT || 'https://api.hive.blog/'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE
  || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const HIVE_CHAIN_ID = 'beeab0de' + '0'.repeat(56)

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function rpc(method: string) {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body: any = await response.json()
  if (body?.error || !body?.result) throw new Error('RPC_RESULT_INVALID')
  return body.result
}

async function evidenceFor(lease: any) {
  if (lease.caip !== 'hive:beeab0de/slip44:1275' || lease.network !== 'hive:beeab0de') {
    throw new Error('ASSET_CAIP_UNSUPPORTED')
  }
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')
  const [config, state] = await Promise.all([
    rpc('database_api.get_config'), rpc('database_api.get_dynamic_global_properties'),
  ])
  const blockNumber = Number(state.head_block_number)
  const irreversibleBlockNumber = Number(state.last_irreversible_block_num)
  const blockId = String(state.head_block_id || '').toLowerCase()
  if (config.HIVE_CHAIN_ID !== HIVE_CHAIN_ID || config.IS_TEST_NET !== false
    || config?.HIVE_SYMBOL?.nai !== '@@000000021' || config?.HIVE_SYMBOL?.decimals !== 3
    || state?.current_supply?.nai !== '@@000000021' || state?.current_supply?.precision !== 3
    || !Number.isSafeInteger(blockNumber) || blockNumber < 1 || !/^[0-9a-f]{40}$/.test(blockId)
    || !Number.isSafeInteger(irreversibleBlockNumber) || irreversibleBlockNumber < 1
    || irreversibleBlockNumber > blockNumber) throw new Error('RPC_CHAIN_STATE_INVALID')
  return { version: 1, kind: 'hive-native-asset', caip: lease.caip, network: lease.network,
    chainId: HIVE_CHAIN_ID, symbol: 'HIVE', decimals: 3, slip44: 1275, blockNumber, blockId,
    irreversibleBlockNumber, rpcHost: url.hostname, auditedAt: Date.now(), result: 'candidate' }
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-hive-asset-auditor:${hostname()}`, namespace: 'hive', kind: 'native',
  })
  const lease = claimed?.lease
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
