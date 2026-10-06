import { describe, expect, test } from 'bun:test'
import { buildCentralAssetReview, buildCentralContractReview } from './clearsign-central-review'

describe('central asset review statement', () => {
  test('matches the production worker canonical digest format', () => {
    const result = buildCentralAssetReview({
      caip: 'eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
      evidenceHash: 'ab'.repeat(32),
      reviewerPublicKey: `0x02${'11'.repeat(32)}`,
      role: 'semantics-review', decision: 'approve', reviewedAt: 1789970000000,
    })
    expect(result.statement.reviewerPublicKey).toBe(`02${'11'.repeat(32)}`)
    expect(result.canonical).toBe('{"caip":"eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9","decision":"approve","domain":"KEEPKEY_CLEARSIGN_ASSET_REVIEW_V1","evidenceHash":"abababababababababababababababababababababababababababababababab","reviewedAt":1789970000000,"reviewerPublicKey":"021111111111111111111111111111111111111111111111111111111111111111","role":"semantics-review","version":1}')
    expect(result.digest).toBe('edd26891a1bbcbc925b4af42a1d7b46341ed36481616b1d49e67bfdb438e831d')
  })

  test('refuses uncompressed or malformed reviewer keys', () => {
    expect(() => buildCentralAssetReview({ caip: 'solana:asset', evidenceHash: '00'.repeat(32), reviewerPublicKey: `04${'11'.repeat(64)}`, role: 'security-review', decision: 'reject', reviewedAt: 1 })).toThrow()
  })

  test('builds the contract-review domain separately from asset reviews', () => {
    const result = buildCentralContractReview({ auditId: '12'.repeat(32), evidenceHash: '34'.repeat(32),
      reviewerPublicKey: `03${'56'.repeat(32)}`, role: 'security-review', decision: 'approve', reviewedAt: 1789970000000 })
    expect(result.canonical).toContain('KEEPKEY_CLEARSIGN_DISCOVERY_REVIEW_V1')
    expect(result.statement.auditId).toBe('12'.repeat(32))
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
  })
})
