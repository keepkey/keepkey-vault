import { expect, test } from 'bun:test'
import { utils } from 'ethers'
import { createHash } from 'node:crypto'
import { verifyPioneerSignatures } from './pioneer-signature-verifier'

function fixture() {
  const key = new utils.SigningKey(`0x${'01'.padStart(64, '0')}`)
  const payload = Buffer.from('signed pioneer fixture')
  const digest = createHash('sha256').update(payload).digest()
  const signature = key.signDigest(digest)
  const blob = Buffer.concat([payload, Buffer.from(signature.r.slice(2) + signature.s.slice(2), 'hex'),
    Buffer.from([27 + signature.recoveryParam])]).toString('base64')
  return { publicKey: utils.computePublicKey(key.publicKey, true).slice(2), blob }
}

test('verifies declared Pioneer blob counts and signer identity', () => {
  const { publicKey, blob } = fixture()
  expect(verifyPioneerSignatures(publicKey, [{ kind: 'test', declared: 1, source: { id: blob } }]))
    .toMatchObject({ publicKey: publicKey.toLowerCase(), total: 1,
      results: [{ discovered: 1, valid: 1, invalid: [] }] })
})

test('rejects count drift and tampered signed payloads', () => {
  const { publicKey, blob } = fixture()
  expect(() => verifyPioneerSignatures(publicKey, [{ kind: 'test', declared: 2, source: { id: blob } }]))
    .toThrow()
  const bytes = Buffer.from(blob, 'base64'); bytes[0] ^= 1
  expect(() => verifyPioneerSignatures(publicKey,
    [{ kind: 'test', declared: 1, source: { id: bytes.toString('base64') } }])).toThrow()
})
