import { hostname } from 'node:os'
import snapshot from '../../../.worktrees/keepkey-vault-solana-certified/projects/keepkey-vault/clearsign-worker/src/evm-discovery-snapshot.json'
import { auditEvmIdentity, auditSolanaIdentity } from '../src/bun/clearsign-live-auditor'

const service = process.env.CLEARSIGN_SERVICE_URL || 'https://keepkey-clearsign.bithighlander.workers.dev'
const tokenPath = process.env.CLEARSIGN_ADMIN_TOKEN_FILE || '/Users/highlander/Library/Application Support/com.keepkey.vault/clearsign-admin-token'
const token = (await Bun.file(tokenPath).text()).trim()
if (token.length < 32) throw new Error('ClearSign operator credential is missing')
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
async function operator(path: string, body: unknown) {
  const response = await fetch(`${service}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
  const result: any = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result?.error || `HTTP_${response.status}`}`)
  return result
}

async function auditOne(): Promise<boolean> {
  const claimed = await operator('/v1/admin/discovery/claim', { workerId: `vault-auditor:${hostname()}` })
  const lease = claimed.lease
  if (!lease) return false
  try {
    let evidence
    if (lease.network === 'solana:mainnet') {
      if (!lease.shape) throw new Error('SOLANA_SHAPE_MISSING')
      evidence = await auditSolanaIdentity({
        chain: 'Solana', requestKind: 'solana-transaction', shapeKey: lease.requestId,
        shape: { components: [lease.shape] }, protectionLevel: 'P0', definitionSource: 'none',
        simulationStatus: 'not-requested', definitionResolution: 'no-artifact', exposureClass: 'not-evaluated',
      }, process.env.CLEARSIGN_SOLANA_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com')
    } else {
      const chainId = Number(String(lease.network).replace(/^eip155:/, ''))
      const endpoints = (snapshot.rpc as Record<string, string[]>)[String(chainId)] || []
      if (!endpoints.length) throw new Error('RPC_UNAVAILABLE')
      evidence = await auditEvmIdentity({
        chain: 'Ethereum', requestKind: 'evm-call', shapeKey: lease.requestId,
        shape: { chainId, contract: lease.contract, selector: lease.selector, calldataLength: lease.calldataLength },
        protectionLevel: 'P0', definitionSource: 'none', simulationStatus: 'not-requested',
        definitionResolution: 'no-artifact', exposureClass: 'not-evaluated',
      }, endpoints[0])
    }
    const submitted = await operator('/v1/admin/discovery/audit', { requestId: lease.requestId, leaseToken: lease.leaseToken, evidence })
    console.log(JSON.stringify({ audited: true, requestId: lease.requestId, auditId: submitted.auditId,
      status: submitted.status, candidates: evidence.candidates?.length || 0, identities: evidence.identities.length }))
    return true
  } catch (error: any) {
    const errorClass = String(error?.message || 'AUDIT_FAILED').replace(/[^A-Z0-9_-]/gi, '_').slice(0, 64)
    await operator('/v1/admin/discovery/fail', { requestId: lease.requestId, leaseToken: lease.leaseToken, errorClass }).catch(() => {})
    console.error(JSON.stringify({ audited: false, requestId: lease.requestId, errorClass }))
    return true
  }
}

const daemon = process.argv.includes('--daemon')
const drain = daemon || process.argv.includes('--drain')
do {
  let processed = 0
  while (processed < 50 && await auditOne()) processed++
  if (!daemon) {
    if (!processed) console.log(JSON.stringify({ audited: false, reason: 'queue-empty' }))
    break
  }
  await Bun.sleep(processed ? 5_000 : 60_000)
} while (true)
