import { afterAll, describe, expect, test } from 'bun:test'
import { planApprovedPromotions } from './clearsign-promotion-planner'

const NOW = Date.now()
const contract = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
const caip = `eip155:42161/erc20:${contract}`
const codeHash = `0x${'ab'.repeat(32)}`
const auditId = '12'.repeat(32)
const evidenceHash = '34'.repeat(32)
let stale = false
const server = Bun.serve({ port: 0, fetch(request) {
  const url = new URL(request.url)
  if (request.headers.get('authorization') !== 'Bearer test-token-that-is-long-enough-123') return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (url.pathname.endsWith('/requests')) return Response.json({ requests: [{ id: '56'.repeat(32), network: 'eip155:42161', contract,
    selector: '0xa9059cbb', calldata_length: 68, reason: 'unknown-shape', status: 'approved', first_seen_at: NOW,
    last_seen_at: NOW, sightings: 1, attempts: 1, current_audit_id: auditId }] })
  if (url.pathname.endsWith('/audit')) return Response.json({ auditId, requestId: '56'.repeat(32), evidenceHash: '78'.repeat(32),
    submittedAt: NOW, status: 'approved', shape: { network: 'eip155:42161', contract, selector: '0xa9059cbb', calldataLength: 68 },
    evidence: { identities: [{ role: 'contract', address: contract, codeHash }] } })
  if (url.pathname.endsWith('/assets/item')) return Response.json({ asset: { caip, network: 'eip155:42161', standard: 'erc20', identity: `42161:${contract}`,
    symbol: 'USDT', decimals: 6, coverage_status: 'needs-work', audit_status: 'candidate', approval_status: 'approved', audit_attempts: 1,
    blockers: [], audit_evidence_hash: evidenceHash, current_asset_audit_id: evidenceHash, next_recheck_at: stale ? NOW - 1 : NOW + 60_000 } })
  if (url.pathname.endsWith('/assets/history')) return Response.json({ audits: [{ auditId: evidenceHash, caip, evidenceHash, submittedAt: NOW,
    evidence: { version: 1, kind: 'evm-token-metadata', result: 'candidate', auditedAt: NOW - 1, caip, chainId: 42161,
      contract, codeHash, symbol: 'USDT', decimals: 6, blockNumber: 123, rpcHost: 'arb.example' } }] })
  return Response.json({ error: 'not found' }, { status: 404 })
} })
afterAll(() => server.stop(true))

describe('central promotion planner', () => {
  test('emits an unsigned artifact only after both approved records join', async () => {
    stale = false
    const result = await planApprovedPromotions('test-token-that-is-long-enough-123', server.url.toString())
    expect(result).toMatchObject({ approvedRequests: 1, ready: 1, blocked: 0 })
    expect(result.plans[0].artifact.payloadHex).toContain(Buffer.from('USDT').toString('hex'))
  })

  test('reports an explicit blocker instead of producing stale artifacts', async () => {
    stale = true
    const result = await planApprovedPromotions('test-token-that-is-long-enough-123', server.url.toString())
    expect(result).toMatchObject({ approvedRequests: 1, ready: 0, blocked: 1 })
    expect(result.plans[0].blocker).toBe('TOKEN_EVIDENCE_EXPIRED')
  })
})
