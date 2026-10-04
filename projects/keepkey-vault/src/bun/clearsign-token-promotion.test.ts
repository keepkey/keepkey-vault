import { describe, expect, test } from 'bun:test'
import { compileApprovedErc20TokenSchema } from './clearsign-token-promotion'
import { compileApprovedErc20TokenArtifact } from './clearsign-artifact-compiler'

const NOW = 1_800_000_000_000
const contract = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'
const hash = `0x${'ab'.repeat(32)}`
const evidenceHash = '12'.repeat(32)
const caip = `eip155:42161/erc20:${contract}`
const contractAudit: any = {
  auditId: '34'.repeat(32), requestId: '56'.repeat(32), evidenceHash: '78'.repeat(32), submittedAt: NOW,
  status: 'approved', shape: { network: 'eip155:42161', contract, selector: '0xa9059cbb', calldataLength: 68 },
  evidence: { identities: [{ role: 'contract', address: contract, codeHash: hash }] },
}
const asset: any = {
  caip, network: 'eip155:42161', standard: 'erc20', identity: `42161:${contract}`, symbol: 'USDT', decimals: 6,
  coverage_status: 'needs-work', audit_status: 'candidate', approval_status: 'approved', audit_attempts: 1,
  audit_evidence_hash: evidenceHash, current_asset_audit_id: evidenceHash, next_recheck_at: NOW + 100_000, blockers: [],
}
const assetAudit: any = {
  auditId: evidenceHash, caip, evidenceHash, submittedAt: NOW,
  evidence: { version: 1, kind: 'evm-token-metadata', result: 'candidate', auditedAt: NOW - 1, caip,
    chainId: 42161, contract, codeHash: hash, symbol: 'USDT', decimals: 6, blockNumber: 123, rpcHost: 'arb.example' },
}

describe('approved ERC-20 promotion join', () => {
  test('compiles named token amount only when both approved identities agree', () => {
    const schema = compileApprovedErc20TokenSchema({ contractAudit, asset, assetAudit, now: NOW })
    expect(schema.method).toBe('USDT transfer')
    expect(schema.args[1]).toEqual({ name: 'Amount', format: 5, symbol: 'USDT', decimals: 6 })
  })

  test('emits an unsigned firmware v2 artifact for the certified signing stage', () => {
    const artifact = compileApprovedErc20TokenArtifact({ contractAudit, asset, assetAudit, now: NOW })
    const body = Buffer.from(artifact.payloadHex, 'hex')
    expect(body[0]).toBe(2)
    expect(body.includes(Buffer.from('USDT'))).toBe(true)
    expect(body.subarray(-6).toString('hex')).toBe('010000000080')
    expect(artifact.payloadHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('fails closed on pending approval, stale evidence, or changed bytecode', () => {
    expect(() => compileApprovedErc20TokenSchema({ contractAudit, asset: { ...asset, approval_status: 'pending' }, assetAudit, now: NOW })).toThrow('NOT_APPROVED')
    expect(() => compileApprovedErc20TokenSchema({ contractAudit, asset: { ...asset, next_recheck_at: NOW }, assetAudit, now: NOW })).toThrow('EXPIRED')
    expect(() => compileApprovedErc20TokenSchema({ contractAudit, asset, assetAudit: { ...assetAudit, evidence: { ...assetAudit.evidence, codeHash: `0x${'cd'.repeat(32)}` } }, now: NOW })).toThrow('CODE_IDENTITY_CHANGED')
  })

  test('refuses symbols the device cannot render honestly', () => {
    expect(() => compileApprovedErc20TokenSchema({ contractAudit, asset, assetAudit: { ...assetAudit, evidence: { ...assetAudit.evidence, symbol: 'PT-SYRUPUSDC-30OCT2025' } }, now: NOW })).toThrow('Unsupported token identity')
  })
})
