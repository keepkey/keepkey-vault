import { describe, expect, test } from 'bun:test'

import { hasCompleteCertifiedSolanaEnvelope } from './solana-certified-policy'

describe('hasCompleteCertifiedSolanaEnvelope', () => {
  const schema = { payload: 'aa', signature: 'bb', signerKeyId: 0x80 }
  const certificate = 'cc'

  test('recognizes the self-contained schema + certificate shape', () => {
    expect(hasCompleteCertifiedSolanaEnvelope({ schema, certificate })).toBe(true)
  })

  test('recognizes ALT-backed proof only when its delegate id is certified', () => {
    expect(hasCompleteCertifiedSolanaEnvelope({
      schema,
      certificate,
      lutProof: { accounts: ['account'], signature: 'dd', signerKeyId: 0x80 },
    })).toBe(true)
    expect(hasCompleteCertifiedSolanaEnvelope({
      schema,
      certificate,
      lutProof: { accounts: ['account'], signature: 'dd', signerKeyId: 3 },
    })).toBe(false)
  })

  test('does not let partial material bypass explicit blind-sign consent', () => {
    expect(hasCompleteCertifiedSolanaEnvelope({ schema })).toBe(false)
    expect(hasCompleteCertifiedSolanaEnvelope({ certificate })).toBe(false)
    expect(hasCompleteCertifiedSolanaEnvelope({
      schema,
      certificate,
      lutProof: { accounts: ['account'], signerKeyId: 0x80 },
    })).toBe(false)
    expect(hasCompleteCertifiedSolanaEnvelope({
      schema,
      certificate,
      lutProof: { accounts: [], signature: 'dd', signerKeyId: 0x80 },
    })).toBe(false)
    expect(hasCompleteCertifiedSolanaEnvelope({
      schema: { ...schema, signerKeyId: 3 },
      certificate,
    })).toBe(false)
  })
})
