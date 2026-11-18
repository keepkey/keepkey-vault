import { describe, expect, test } from 'bun:test'
import { signingReviewGuide, signingReviewPreferences, emulatorReviewPixels } from './signing-review-guide'
import type { SigningRequestInfo } from './types'

const request = (fields: Partial<SigningRequestInfo> = {}): SigningRequestInfo => ({ id: 'review', method: '/eth/sign-transaction', appName: 'Example app', from: `0x${'22'.repeat(20)}`, ...fields })
describe('readable signing guide', () => {
  test('the EVM network is readable and an unknown chain keeps its exact ID', () => {
    expect(signingReviewGuide(request({ chainId: 1 })).fields).toContainEqual({ label: 'Network', value: 'Ethereum' })
    expect(signingReviewGuide(request({ chainId: 999999 })).fields).toContainEqual({ label: 'Network', value: 'Chain 999999' })
  })
  test('preserves the complete message, with a signature-authority warning', () => {
    const text = 'Review every character.\n' + 'long message '.repeat(120)
    const guide = signingReviewGuide(request({ method: '/eth/sign', ethMessageDecoded: { address: 'account', messageRaw: '0x1234', messageText: text, isUtf8Text: true } }))
    expect(guide.fields.find(f => f.label === 'Message')?.value).toBe(text)
    expect(guide.warnings.some(w => w.includes('authorize actions'))).toBe(true)
    expect(guide.raw).toBe('0x1234')
  })
  test('hidden Unicode and transaction-shaped Solana messages remain explicit', () => {
    expect(signingReviewGuide(request({ method: '/eth/sign', ethMessageDecoded: { address: 'a', messageRaw: 'hex', messageText: 'hello\u202eworld', isUtf8Text: true } })).warnings.join()).toContain('direction-changing')
    expect(signingReviewGuide(request({ method: '/solana/sign-message', solanaMessageDecoded: { messageRaw: 'raw', messageHex: '0102', encoding: 'hex', byteLength: 2, classification: 'solana-transaction' } })).warnings.join()).toContain('authorize a Solana transaction')
  })
  test('a token transfer compares the actual recipient rather than the token contract', () => {
    const token = `0x${'33'.repeat(20)}`, recipient = '11'.repeat(20)
    const guide = signingReviewGuide(request({ to: token, data: `0xa9059cbb${'0'.repeat(24)}${recipient}${'0'.repeat(63)}1` }))
    expect(guide.fields).toContainEqual({ label: 'Recipient', value: `0x${recipient}` })
    expect(guide.fields).toContainEqual({ label: 'Token contract', value: token })
    expect(guide.fields).not.toContainEqual({ label: 'Recipient', value: token })
  })
  test('unlimited allowance and its spender are visible, while malformed address words stay opaque', () => {
    const to = `0x${'33'.repeat(20)}`, spender = '11'.repeat(20)
    const guide = signingReviewGuide(request({ to, data: `0x095ea7b3${'0'.repeat(24)}${spender}${'f'.repeat(64)}` }))
    expect(guide.fields).toContainEqual({ label: 'Allowance', value: 'Unlimited' })
    expect(guide.fields).toContainEqual({ label: 'Spender', value: `0x${spender}` })
    expect(guide.warnings.join()).toContain('unlimited allowance')
    const malformed = signingReviewGuide(request({ to, data: `0x095ea7b3${'f'.repeat(24)}${spender}${'f'.repeat(64)}` }))
    expect(malformed.fields.some(f => f.label === 'Spender')).toBe(false)
    expect(malformed.fields).toContainEqual({ label: 'Contract', value: to })
  })
  test('typed data retains the entire domain, fields and legacy digest reference', () => {
    const typedDataDecoded = { operationName: 'Permit', primaryType: 'Permit', isKnownType: true,
      domain: { name: 'Example', chainId: 1, verifyingContract: 'contract' }, fields: [{ label: 'Spender', value: 'spender', format: 'address' as const }], hashes: { domainHash: 'aa'.repeat(32), messageHash: 'bb'.repeat(32) } }
    const guide = signingReviewGuide(request({ method: '/eth/sign-typed-data', typedDataDecoded }))
    expect(guide.fields).toContainEqual({ label: 'Verifying contract', value: 'contract' })
    expect(guide.fields).toContainEqual({ label: 'Spender', value: 'spender' })
    expect(guide.raw).toContain(typedDataDecoded.hashes.messageHash)
  })
  test('all external UTXO outputs and exact fee remain available in a payment review', () => {
    const guide = signingReviewGuide(request({ method: '/utxo/sign-transaction', rawRequestBody: { coin: 'Bitcoin', inputs: [{ amount: '3000' }], outputs: [{ address: 'first', amount: '1000' }, { address: 'second', amount: '1000' }, { amount: '500', isChange: true }] } }))
    expect(guide.fields).toContainEqual({ label: 'Output 1 address', value: 'first' })
    expect(guide.fields).toContainEqual({ label: 'Output 2 address', value: 'second' })
    expect(guide.fields).toContainEqual({ label: 'Network fee', value: '0.00000500 BTC' })
  })
  test('a zero XRP destination tag is distinct from no tag', () => {
    const withTag = signingReviewGuide(request({ method: '/xrp/sign-transaction', rawRequestBody: { payment: { destinationTag: '0' } } }))
    expect(withTag.fields).toContainEqual({ label: 'Destination tag', value: '0' })
    expect(signingReviewGuide(request({ method: '/xrp/sign-transaction' })).fields.some(f => f.label === 'Destination tag')).toBe(false)
  })
  test('the audit view never walks private witness or arbitrary authentication fields', () => {
    const guide = signingReviewGuide(request({ data: '0xabcd', rawRequestBody: { privateKey: 'SECRET', inputs: [{ mask: 'SECRET' }], authorization: 'SECRET' } }))
    expect(guide.raw).toBe('0xabcd')
    expect(JSON.stringify(guide)).not.toContain('SECRET')
  })
  test('blocked and blind requests keep their warnings independent of display preferences', () => {
    const fields = request({ firmwareCannotSign: true, needsBlindSigning: true })
    expect(signingReviewGuide(fields).warnings).toHaveLength(2)
    for (const depth of ['essentials', 'guided', 'audit'] as const) expect(signingReviewPreferences({ depth }).depth).toBe(depth)
    expect(signingReviewPreferences({ depth: 'off', largeText: 'yes' })).toEqual({ depth: 'guided', largeText: false })
  })
})

test('OLED enlargement preserves the exact SSD1306 bit positions', () => {
  const frame = new Uint8Array(2048); frame[0] = 1; frame[256 + 1] = 128
  const rgba = emulatorReviewPixels(frame)
  expect(Array.from(rgba.slice(0, 4))).toEqual([232, 224, 208, 255])
  expect(Array.from(rgba.slice((15 * 256 + 1) * 4, (15 * 256 + 1) * 4 + 4))).toEqual([232, 224, 208, 255])
  expect(Array.from(rgba.slice(4, 8))).toEqual([15, 19, 25, 255])
  expect(() => emulatorReviewPixels(new Uint8Array(2047))).toThrow()
})
