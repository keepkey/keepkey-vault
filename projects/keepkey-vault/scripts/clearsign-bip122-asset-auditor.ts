import { hostname } from 'node:os'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const endpoint = process.env.CLEARSIGN_BLOCKCHAIR_ENDPOINT || 'https://api.blockchair.com'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const assets: Record<string, { chain: string; symbol: string; slip44: number }> = {
  'bip122:000000000019d6689c085ae165831e93/slip44:0': { chain: 'bitcoin', symbol: 'BTC', slip44: 0 },
  'bip122:000000000000000000651ef99cb9fcbe/slip44:145': { chain: 'bitcoin-cash', symbol: 'BCH', slip44: 145 },
  'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2': { chain: 'litecoin', symbol: 'LTC', slip44: 2 },
  'bip122:00000000001a91e3dace36e2be3bf030/slip44:3': { chain: 'dogecoin', symbol: 'DOGE', slip44: 3 },
  'bip122:000007d91d1254d60e2dd1ae58038307/slip44:5': { chain: 'dash', symbol: 'DASH', slip44: 5 },
  'bip122:00040fe8ec8471911baa1db1266ea15d/slip44:133': { chain: 'zcash', symbol: 'ZEC', slip44: 133 },
  'bip122:4da631f2ac1bed857bd968c67c913978/slip44:20': { chain: 'digibyte', symbol: 'DGB', slip44: 20 },
}

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function evidenceFor(lease: any) {
  const asset = assets[lease.caip]
  if (!asset) throw new Error('ASSET_CAIP_UNSUPPORTED')
  const dgb = asset.chain === 'digibyte'
  const source = dgb ? 'https://chainz.cryptoid.info/dgb/api.dws' : endpoint
  const url = new URL(source)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')
  let blockHeight: number
  let blockHash: string
  if (dgb) {
    const heightResponse = await fetch(`${source}?q=getblockcount`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!heightResponse.ok) throw new Error(`RPC_HTTP_${heightResponse.status}`)
    blockHeight = Number(await heightResponse.json())
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 1) throw new Error('RPC_CHAIN_STATE_INVALID')
    const hashResponse = await fetch(`${source}?q=getblockhash&height=${blockHeight}`, {
      redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!hashResponse.ok) throw new Error(`RPC_HTTP_${hashResponse.status}`)
    blockHash = String(await hashResponse.json()).toLowerCase()
  } else {
    const response = await fetch(`${endpoint}/${asset.chain}/stats`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
    const body: any = await response.json()
    blockHeight = body?.data?.best_block_height
    blockHash = String(body?.data?.best_block_hash || '').toLowerCase()
    if (body?.context?.code !== 200) throw new Error('RPC_CHAIN_STATE_INVALID')
  }
  if (!Number.isSafeInteger(blockHeight) || blockHeight < 1 || !/^[0-9a-f]{64}$/.test(blockHash)) {
    throw new Error('RPC_CHAIN_STATE_INVALID')
  }
  return { version: 1, kind: 'bip122-native-asset', caip: lease.caip, network: lease.network,
    chain: asset.chain, symbol: asset.symbol, decimals: 8, slip44: asset.slip44, blockHeight, blockHash,
    rpcHost: url.hostname, auditedAt: Date.now(), result: 'candidate' }
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-bip122-asset-auditor:${hostname()}`, namespace: 'bip122', kind: 'native',
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
do {
  let processed = 0
  while (processed < 7 && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
