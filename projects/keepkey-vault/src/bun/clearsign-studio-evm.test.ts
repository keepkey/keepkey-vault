import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildEvmSchemaBody, EVM_ARG_ADDRESS, EVM_ARG_TOKEN_AMOUNT } from './evm-certified-schema'
import {
  buildProviderBundle,
  buildStudioEvmSchema,
  inspectSignedEvmEntry,
  parseProviderBundle,
  PROVIDER_BUNDLE_FORMAT,
  providerBundleFileName,
} from './clearsign-studio-evm'
import { createProviderKeySession } from './clearsign-provider-session'
import { deriveProviderKey } from '../shared/clearsign-provider-key'
import type { ClearSignEvmSchemaDraft } from '../shared/types'

// BIP-39 test vector. NEVER a real provider key.
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const USDC_TRANSFER: ClearSignEvmSchemaDraft = {
  chainId: 1,
  contract: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eB48',
  selector: '0xa9059cbb',
  method: 'transfer',
  args: [
    { name: 'To', format: 'address' },
    { name: 'Amount', format: 'token-amount', decimals: 6, symbol: 'USDC' },
  ],
}

// keepkey-clearsign-server src/v2.ts buildV2Body / buildSignedV2 for the same
// schema at keyId 1, signed with the ABANDON provider key.
const SERVER_BODY = '0200000001a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48a9059cbb00087472616e736665720202546f0106416d6f756e7405060455534443010000000001'
const SERVER_SIGNED = `${SERVER_BODY}f17603c879f1d740598c1e8c0707a77ffbbe7d6930acd4dc9fe6902e517d964114d20acabb611133e740ff24547afaaed7254618c681b58d214161a59145982a1c`

function signedSession(advanced = { on: true }) {
  const session = createProviderKeySession(() => {
    if (!advanced.on) throw new Error('ClearSign Studio requires AdvancedMode on the connected device')
  })
  return { session, advanced }
}

describe('Studio EVM v0x02 authoring', () => {
  it('builds the provider server bytes with the shared encoder, slot in the trailer', () => {
    const artifact = buildStudioEvmSchema(USDC_TRANSFER, 1)
    expect(artifact.body).toBe(SERVER_BODY)
    expect(artifact.calldataLength).toBe(68)
    expect(artifact.draft.contract).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')
    const certified = buildEvmSchemaBody({
      chainId: 1, contract: USDC_TRANSFER.contract, selector: USDC_TRANSFER.selector, method: 'transfer',
      args: [{ name: 'To', format: EVM_ARG_ADDRESS }, { name: 'Amount', format: EVM_ARG_TOKEN_AMOUNT, decimals: 6, symbol: 'USDC' }],
      expectedCalldataLength: 68,
    }).toString('hex')
    expect(certified.slice(0, -2)).toBe(SERVER_BODY.slice(0, -2))
    expect(certified.slice(-2)).toBe('80')
  })

  it('authors runtime slots and v0x02 only', () => {
    expect(() => buildStudioEvmSchema(USDC_TRANSFER, 0x80)).toThrow('0 to 3')
    expect(() => buildStudioEvmSchema({ ...USDC_TRANSFER, args: Array(9).fill({ name: 'W', format: 'bytes' }) }, 1)).toThrow('at most 8')
    expect(() => buildStudioEvmSchema({ ...USDC_TRANSFER, method: '100% safe' }, 1)).toThrow('will not render')
    expect(() => buildStudioEvmSchema({ ...USDC_TRANSFER, args: [{ name: 'Amount', format: 'token-amount', decimals: 6, symbol: 'US-D' }] }, 1)).toThrow('symbol')
    expect(() => buildStudioEvmSchema({ ...USDC_TRANSFER, args: [{ name: 'X', format: 'intent' as any }] }, 1)).toThrow('unsupported format')
  })
})

describe('Studio EVM signing with the session provider key', () => {
  const ceremony = { childMnemonic: ABANDON, alias: 'Acme Labs', wordCount: 12, index: 0 }

  it('requires AdvancedMode and a key derived from the device words this session', () => {
    const { session, advanced } = signedSession()
    expect(() => session.signEvmSchema(USDC_TRANSFER, 1)).toThrow('Derive the provider key')
    session.derive(ceremony)
    advanced.on = false
    expect(() => session.signEvmSchema(USDC_TRANSFER, 1)).toThrow('AdvancedMode')
    advanced.on = true
    // The failed gate cleared the key: it must be re-derived.
    expect(() => session.signEvmSchema(USDC_TRANSFER, 1)).toThrow('Derive the provider key')
  })

  it('signs byte-identically to the provider server, and the signature verifies', () => {
    const { session } = signedSession()
    session.derive(ceremony)
    const signed = session.signEvmSchema(USDC_TRANSFER, 1)
    expect(signed.signedPayload).toBe(SERVER_SIGNED)
    expect(signed.fingerprint).toBe('b690735f')
    expect(inspectSignedEvmEntry(signed.signedPayload, signed.publicKeyHex).draft).toEqual(buildStudioEvmSchema(USDC_TRANSFER, 1).draft)
  })
})

describe('provider bundle export/import', () => {
  const { publicKeyHex, privateKey } = deriveProviderKey(ABANDON)
  const privateHex = Buffer.from(privateKey).toString('hex')
  const bundle = buildProviderBundle({ alias: 'Acme Labs', publicKeyHex, keyId: 1, signedPayloads: [SERVER_SIGNED] })
  const json = JSON.stringify(bundle)

  it('carries the public key, alias and signed descriptions, never the private key', () => {
    expect(bundle.format).toBe(PROVIDER_BUNDLE_FORMAT)
    expect(bundle.provider).toEqual({ alias: 'Acme Labs', publicKeyHex, fingerprint: 'b690735f', keyId: 1 })
    expect(bundle.entries).toEqual([{ chainId: 1, contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', selector: '0xa9059cbb', method: 'transfer', signedPayload: SERVER_SIGNED }])
    expect(bundle.notice).toContain('NOT verified by KeepKey')
    expect(json).not.toContain(privateHex)
    expect(json).not.toMatch(/private[A-Z_]?key|mnemonic/i)
  })

  it('round-trips through import', () => {
    const imported = parseProviderBundle(json)
    expect(imported.bundle).toEqual(bundle)
    expect(imported.entries[0].draft.method).toBe('transfer')
  })

  it('refuses a tampered, foreign or mismatched bundle', () => {
    const tampered = SERVER_SIGNED.replace('7472616e73666572', '7472616e73666571') // transfer -> transfeq
    expect(() => parseProviderBundle(JSON.stringify({ ...bundle, entries: [{ ...bundle.entries[0], signedPayload: tampered }] }))).toThrow('does not verify')
    const other = deriveProviderKey('legal winner thank year wave sausage worth useful legal winner thank yellow').publicKeyHex
    expect(() => parseProviderBundle(JSON.stringify({ ...bundle, provider: { ...bundle.provider, publicKeyHex: other } }))).toThrow('does not verify')
    expect(() => parseProviderBundle(JSON.stringify({ ...bundle, provider: { ...bundle.provider, keyId: 2 } }))).toThrow('slot 1, not 2')
    expect(() => parseProviderBundle(JSON.stringify({ ...bundle, entries: [{ ...bundle.entries[0], method: 'approve' }] }))).toThrow('does not match')
    expect(() => parseProviderBundle(JSON.stringify({ ...bundle, provider: { ...bundle.provider, fingerprint: 'deadbeef' } }))).toThrow('fingerprint')
    expect(() => parseProviderBundle(JSON.stringify({ ...bundle, format: 'other' }))).toThrow('format')
    expect(() => buildProviderBundle({ alias: 'Acme Labs', publicKeyHex, keyId: 1, signedPayloads: [SERVER_SIGNED, SERVER_SIGNED] })).toThrow('twice')
    // An imported file states its slot.
    expect(() => parseProviderBundle(JSON.stringify({ ...bundle, provider: { ...bundle.provider, keyId: undefined } }))).toThrow()
  })

  it('exports with the slot the descriptions were signed for, whatever the picker shows now', () => {
    const { session } = signedSession()
    session.derive({ childMnemonic: ABANDON, alias: 'Acme Labs', wordCount: 12, index: 0 })
    const slot2 = session.signEvmSchema({ ...USDC_TRANSFER, selector: '0x095ea7b3', method: 'approve' }, 2)
    // The renderer sends no slot: the bundle takes the entries' own.
    expect(buildProviderBundle({ alias: 'Acme Labs', publicKeyHex, signedPayloads: [slot2.signedPayload] }).provider.keyId).toBe(2)
    expect(buildProviderBundle({ alias: 'Acme Labs', publicKeyHex, signedPayloads: [SERVER_SIGNED] }).provider.keyId).toBe(1)
    // Entries from two slots never make one bundle.
    expect(() => buildProviderBundle({ alias: 'Acme Labs', publicKeyHex, signedPayloads: [SERVER_SIGNED, slot2.signedPayload] })).toThrow('one slot')
    const studio = readFileSync(join(import.meta.dir, '../mainview/components/ClearSignStudio.tsx'), 'utf8')
    const exportCall = studio.slice(studio.indexOf('"clearsignExportProviderBundle"'), studio.indexOf('setNotice(`Bundle written'))
    expect(exportCall).not.toContain('keyId: slot')
  })

  it('names the export file even when the alias has no letters or digits', () => {
    expect(providerBundleFileName(bundle)).toBe('keepkey-clearsign-bundle-acme-labs-b690735f.json')
    expect(providerBundleFileName({ ...bundle, provider: { ...bundle.provider, alias: '___' } })).toBe('keepkey-clearsign-bundle-provider-b690735f.json')
  })
})
