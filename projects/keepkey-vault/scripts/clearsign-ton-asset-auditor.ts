import { hostname } from 'node:os'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const endpoint = process.env.CLEARSIGN_TON_RPC_ENDPOINT || 'https://toncenter.com/api/v2/getMasterchainInfo'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

function hash(value: unknown): string {
  const bytes = Buffer.from(String(value || ''), 'base64')
  if (bytes.length !== 32) throw new Error('RPC_HASH_INVALID')
  return bytes.toString('hex')
}

async function evidenceFor(lease: any) {
  if (lease.caip !== 'ton:-239/slip44:607') throw new Error('ASSET_CAIP_UNSUPPORTED')
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body: any = await response.json()
  const info = body?.result
  const seqno = info?.last?.seqno
  if (body?.ok !== true || info?.last?.workchain !== -1 || info?.init?.workchain !== -1 || info?.init?.seqno !== 0
    || !Number.isSafeInteger(seqno) || seqno < 1) throw new Error('RPC_CHAIN_STATE_INVALID')
  return { version: 1, kind: 'ton-native-asset', caip: lease.caip, network: 'ton:-239', workchain: -1,
    initRootHash: hash(info.init.root_hash), initFileHash: hash(info.init.file_hash), symbol: 'TON', decimals: 9,
    slip44: 607, masterSeqno: seqno, masterRootHash: hash(info.last.root_hash), masterFileHash: hash(info.last.file_hash),
    rpcHost: url.hostname, auditedAt: Date.now(), result: 'candidate' }
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/assets/claim', {
    workerId: `vault-ton-asset-auditor:${hostname()}`, namespace: 'ton', kind: 'native',
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
  const processed = await auditOne()
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
