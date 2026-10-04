import { hostname } from 'node:os'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const endpoint = process.env.CLEARSIGN_XRPL_RPC_ENDPOINT || 'https://s1.ripple.com:51234/'
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

async function rpc(method: string, params: unknown = {}) {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: [params] }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`RPC_HTTP_${response.status}`)
  const body: any = await response.json()
  if (body?.result?.status !== 'success') throw new Error('RPC_RESULT_INVALID')
  return body.result
}

let cached: { expiresAt: number; ledgerIndex: number; ledgerHash: string; rpcHost: string } | undefined
async function chainState() {
  if (cached && cached.expiresAt > Date.now()) return cached
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('RPC_ENDPOINT_UNSAFE')
  const [server, ledger] = await Promise.all([rpc('server_info'), rpc('ledger', {
    ledger_index: 'validated', transactions: false, expand: false,
  })])
  const ledgerIndex = Number(ledger.ledger_index)
  const ledgerHash = String(ledger.ledger_hash || ledger?.ledger?.hash || '').toLowerCase()
  if (server?.info?.network_id !== 0 || ledger.validated !== true || !Number.isSafeInteger(ledgerIndex)
    || ledgerIndex < 1 || !/^[0-9a-f]{64}$/.test(ledgerHash)) throw new Error('RPC_CHAIN_STATE_INVALID')
  cached = { expiresAt: Date.now() + 30_000, ledgerIndex, ledgerHash, rpcHost: url.hostname }
  return cached
}

async function evidenceFor(lease: any) {
  if (!['ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144', 'xrpl:1/slip44:144'].includes(lease.caip)) {
    throw new Error('ASSET_CAIP_UNSUPPORTED')
  }
  const state = await chainState()
  return { version: 1, kind: 'xrpl-native-asset', caip: lease.caip, network: lease.network, networkId: 0,
    symbol: 'XRP', decimals: 6, slip44: 144, ledgerIndex: state.ledgerIndex, ledgerHash: state.ledgerHash,
    rpcHost: state.rpcHost, auditedAt: Date.now(), result: 'candidate' }
}

async function auditOne(): Promise<boolean> {
  let claimed: any
  for (const namespace of ['ripple', 'xrpl']) {
    claimed = await operator('/v1/admin/discovery/assets/claim', {
      workerId: `vault-xrpl-asset-auditor:${hostname()}`, namespace, kind: 'native',
    })
    if (claimed.lease) break
  }
  const lease = claimed?.lease
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
  while (processed < 2 && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 60_000 : 5 * 60_000)
} while (true)
