import { expect, test } from 'bun:test'
import { getConfiguredReviewerIdentity, signCentralReview } from './clearsign-review-signer-client'

const statement: any = { version: 1, caip: 'eip155:1/erc20:0x' + '11'.repeat(20), evidenceHash: 'ab'.repeat(32),
  reviewerPublicKey: '02' + '22'.repeat(32), role: 'semantics-review', decision: 'approve', reviewedAt: 1789977000000 }

test('uses only the fixed backend role configuration and preserves the exact statement', async () => {
  const signed = await signCentralReview(statement, { env: {
    CLEARSIGN_SEMANTICS_REVIEW_SIGNER_URL: 'https://reviews.example',
    CLEARSIGN_SEMANTICS_REVIEW_SIGNER_TOKEN_FILE: '/secret/token',
  }, readToken: async () => 'x'.repeat(32), fetcher: (async (url: any, init: any) => {
    expect(url).toBe('https://reviews.example/sign-review')
    expect(init.headers.authorization).toBe(`Bearer ${'x'.repeat(32)}`)
    expect(JSON.parse(init.body)).toEqual(statement)
    return Response.json({ ...statement, signature: '33'.repeat(65), digest: '44'.repeat(32), kind: 'asset' })
  }) as any })
  expect(signed).toEqual({ ...statement, signature: '33'.repeat(65) })
})

test('rejects unsafe endpoints and any signer mutation of the reviewed statement', async () => {
  const base = { CLEARSIGN_SEMANTICS_REVIEW_SIGNER_TOKEN_FILE: '/secret/token' }
  expect(signCentralReview(statement, { env: { ...base,
    CLEARSIGN_SEMANTICS_REVIEW_SIGNER_URL: 'http://remote.example' }, readToken: async () => 'x'.repeat(32) }))
    .rejects.toThrow('unsafe')
  expect(signCentralReview(statement, { env: { ...base,
    CLEARSIGN_SEMANTICS_REVIEW_SIGNER_URL: 'http://127.0.0.1:1648' }, readToken: async () => 'x'.repeat(32),
    fetcher: (async () => Response.json({ ...statement, decision: 'reject', signature: '33'.repeat(65) })) as any }))
    .rejects.toThrow('mismatched')
})

test('loads only a valid identity for the configured fixed role', async () => {
  const identity = await getConfiguredReviewerIdentity('security-review', {
    env: { CLEARSIGN_SECURITY_REVIEW_SIGNER_URL: 'http://localhost:1649' },
    fetcher: (async (url: any) => {
      expect(url).toBe('http://localhost:1649/identity')
      return Response.json({ role: 'security-review', publicKey: '03' + '44'.repeat(32),
        fingerprint: '55'.repeat(8) })
    }) as any,
  })
  expect(identity).toEqual({ role: 'security-review', publicKey: '03' + '44'.repeat(32),
    fingerprint: '55'.repeat(8) })
  expect(getConfiguredReviewerIdentity('security-review', {
    env: { CLEARSIGN_SECURITY_REVIEW_SIGNER_URL: 'http://localhost:1649' },
    fetcher: (async () => Response.json({ role: 'semantics-review',
      publicKey: '03' + '44'.repeat(32), fingerprint: '55'.repeat(8) })) as any,
  })).rejects.toThrow('identity is invalid')
})
