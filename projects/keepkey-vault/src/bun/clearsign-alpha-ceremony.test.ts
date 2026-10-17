import { utils as ethersUtils } from 'ethers'

import {
  CLEARSIGN_DOMAIN_SEPARATOR,
  CLEARSIGN_EVM_SCOPES,
  buildAlphaCertificateBody,
  inspectAlphaCertificateBody,
} from './clearsign-alpha-ceremony'
import { ALPHA_DELEGATE_PUBLIC_KEY, inspectAlphaCeremonyRequest } from '../../scripts/clearsign-alpha-rehearsal'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function bodyHex(overrides: { flags?: number; chain?: number; expiry?: number; delegate?: string } = {}): string {
  const body = Buffer.alloc(75)
  body[0] = 1
  body[1] = overrides.flags ?? 1
  body.writeUInt32BE(overrides.chain ?? 1, 2)
  body.writeUInt32BE(overrides.expiry ?? 1818806400, 6)
  body.write('KeepKey Alpha 716', 10, 'ascii')
  Buffer.from(overrides.delegate ?? ALPHA_DELEGATE_PUBLIC_KEY, 'hex').copy(body, 42)
  return body.toString('hex')
}

describe('7.16 alpha certificate ceremony', () => {
  it.each(CLEARSIGN_EVM_SCOPES)('binds the reviewed EVM certificate to chain %i', (chainId) => {
    const request = buildAlphaCertificateBody('KeepKey Alpha 716', 1798675200, chainId, ALPHA_DELEGATE_PUBLIC_KEY)
    const certificate = inspectAlphaCertificateBody(request.signedBodyHex, request.expectedMessageHashHex, 1787500000)
    expect(certificate.chainId).toBe(chainId)
    expect(certificate.delegatePublicKey).toBe(ALPHA_DELEGATE_PUBLIC_KEY)
  })
  it('builds the canonical body for the reviewed alpha delegate', () => {
    const built = buildAlphaCertificateBody('KeepKey Vault', 1818806400, 1, ALPHA_DELEGATE_PUBLIC_KEY)
    const inspected = inspectAlphaCertificateBody(
      built.signedBodyHex,
      built.expectedMessageHashHex,
      1787500000,
    )
    expect(Buffer.from(built.signedBodyHex, 'hex').length).toBe(75)
    expect(inspected.alias).toBe('KeepKey Vault')
    expect(inspected.chainId).toBe(1)
    expect(inspected.notAfter).toBe(1818806400)
    expect(inspected.delegatePublicKey).toBe(ALPHA_DELEGATE_PUBLIC_KEY)
  })

  it('rejects aliases the OLED cannot render honestly', () => {
    expect(() => buildAlphaCertificateBody('', 1818806400, 1, ALPHA_DELEGATE_PUBLIC_KEY)).toThrow()
    expect(() => buildAlphaCertificateBody('x'.repeat(32), 1818806400, 1, ALPHA_DELEGATE_PUBLIC_KEY)).toThrow()
    expect(() => buildAlphaCertificateBody('KeepKey\nVault', 1818806400, 1, ALPHA_DELEGATE_PUBLIC_KEY)).toThrow()
  })

  it('recomputes the EIP-712 digest', () => {
    const body = bodyHex()
    const messageHash = ethersUtils.keccak256(`0x${body}`).slice(2)
    const result = inspectAlphaCertificateBody(body, messageHash, 1787500000)
    expect(result.alias).toBe('KeepKey Alpha 716')
    expect(result.chainId).toBe(1)
    expect(result.delegatePublicKey).toBe(ALPHA_DELEGATE_PUBLIC_KEY)
    expect(result.signingDigest).toBe(ethersUtils.keccak256(ethersUtils.concat([
      '0x1901',
      `0x${CLEARSIGN_DOMAIN_SEPARATOR}`,
      `0x${messageHash}`,
    ])).slice(2))
  })

  it.each([
    ['wrong capability', { flags: 0 }],
    ['wrong chain', { chain: 999999 }],
    ['expired', { expiry: 1787270400 }],
  ])('rejects %s', (_label, overrides) => {
    const body = bodyHex(overrides)
    const hash = ethersUtils.keccak256(`0x${body}`).slice(2)
    expect(() => inspectAlphaCertificateBody(body, hash, 1787500000)).toThrow()
  })

  it.each([8453, 42161])('accepts reviewed EVM chain %d', (chain) => {
    const body = bodyHex({ chain })
    const hash = ethersUtils.keccak256(`0x${body}`).slice(2)
    expect(inspectAlphaCertificateBody(body, hash, 1787500000).chainId).toBe(chain)
  })

  it('names any delegate: the root signature, not a pinned key, vouches for it', () => {
    // A production delegate (scope 1, 2026-10-16 ceremony).
    const delegate = '03bb5314410309cc4e56b8140565106714e4dbf33f6d75e2c89b78e0e6cb1cd165'
    const body = bodyHex({ delegate })
    const hash = ethersUtils.keccak256(`0x${body}`).slice(2)
    expect(inspectAlphaCertificateBody(body, hash, 1787500000).delegatePublicKey).toBe(delegate)
  })

  it('rejects an independent hash mismatch', () => {
    expect(() => inspectAlphaCertificateBody(bodyHex(), '11'.repeat(32), 1787500000))
      .toThrow('independent message hash does not match')
  })
})

describe('scripts/clearsign-root-ceremony.ts', () => {
  it('signs a request only for the reviewed alpha delegate', () => {
    const other = `02${'01'.repeat(32)}`
    const forged = buildAlphaCertificateBody('KeepKey Vault', 1818806400, 1, other)
    expect(() => inspectAlphaCeremonyRequest(forged, 1787500000)).toThrow('is not the reviewed alpha delegate')
    const reviewed = buildAlphaCertificateBody('KeepKey Vault', 1818806400, 1, ALPHA_DELEGATE_PUBLIC_KEY)
    expect(inspectAlphaCeremonyRequest(reviewed, 1787500000).delegatePublicKey).toBe(ALPHA_DELEGATE_PUBLIC_KEY)
    const script = readFileSync(join(import.meta.dir, '../../scripts/clearsign-root-ceremony.ts'), 'utf8')
    expect(script).toContain('const inspection = request ? inspectAlphaCeremonyRequest(request) : undefined')
    expect(script).not.toContain('inspectAlphaCertificateBody(')
  })
})
