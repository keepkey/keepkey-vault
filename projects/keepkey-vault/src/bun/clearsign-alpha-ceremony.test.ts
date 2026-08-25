import { utils as ethersUtils } from 'ethers'

import {
  ALPHA_DELEGATE_PUBLIC_KEY,
  CLEARSIGN_DOMAIN_SEPARATOR,
  buildAlphaCertificateBody,
  inspectAlphaCertificateBody,
} from './clearsign-alpha-ceremony'

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
  it('builds the canonical body for the reviewed alpha delegate', () => {
    const built = buildAlphaCertificateBody('KeepKey Vault', 1818806400)
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
    expect(() => buildAlphaCertificateBody('', 1818806400)).toThrow()
    expect(() => buildAlphaCertificateBody('x'.repeat(32), 1818806400)).toThrow()
    expect(() => buildAlphaCertificateBody('KeepKey\nVault', 1818806400)).toThrow()
  })

  it('accepts only the reviewed delegate and recomputes the EIP-712 digest', () => {
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
    ['wrong chain', { chain: 8453 }],
    ['expired', { expiry: 1787270400 }],
    ['wrong delegate', { delegate: `02${'11'.repeat(32)}` }],
  ])('rejects %s', (_label, overrides) => {
    const body = bodyHex(overrides)
    const hash = ethersUtils.keccak256(`0x${body}`).slice(2)
    expect(() => inspectAlphaCertificateBody(body, hash, 1787500000)).toThrow()
  })

  it('rejects an independent hash mismatch', () => {
    expect(() => inspectAlphaCertificateBody(bodyHex(), '11'.repeat(32), 1787500000))
      .toThrow('independent message hash does not match')
  })
})
