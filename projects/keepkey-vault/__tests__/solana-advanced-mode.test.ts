/**
 * Vault asks for AdvancedMode before a Solana signature exactly where the
 * device would refuse without it, and never where the device clear-signs.
 *
 * The expectations come from the FIRMWARE, not from Vault.
 * fixtures/solana/advanced-mode-firmware-verdicts.json holds each wire
 * transaction's review verdict from the real lib/firmware/solana.c of every
 * build listed there (scripts/solana-fw-review-oracle/gen-verdicts.sh).
 * fsm_msgSolanaSignTx refuses an OPAQUE review with "Enable AdvancedMode to
 * blind-sign", signs a VERIFIED one without it, and refuses MALFORMED either
 * way. Several builds report the same version, so AdvancedMode is required at
 * a version when every build of that version says OPAQUE.
 *
 * Run: bun test __tests__/solana-advanced-mode.test.ts
 */
import { describe, expect, test } from 'bun:test'
import corpus from './fixtures/solana/advanced-mode-firmware-verdicts.json'
import { buildSolanaDecodedInfo } from '../src/bun/solana-clearsign'
import { applySolanaSigningGates, solanaFirmwareRequiresAdvancedMode } from '../src/bun/solana-consent'
import type { SigningRequestInfo } from '../src/shared/types'

const PINNED_FIRMWARE = 'e507d0c6f6ea3e5fcbaceec08fd26bb8f6e46192' // modules/keepkey-firmware
const V7141 = '5482e7366a36e81336074f53a9defb6cff45ed72'
const versions = [...new Set(corpus.builds.map((b) => b.version))]
const rawTx = (name: string) => {
  const c = corpus.cases.find((x) => x.name === name)
  if (!c) throw new Error(`no corpus case "${name}"`)
  return c
}

describe('AdvancedMode is required exactly where every firmware build of the version refuses', () => {
  test('the corpus covers the released 7.14.1, the pinned alpha, and 7.14.2 through 7.16', () => {
    expect(corpus.builds.map((b) => b.sha)).toContain(V7141)
    expect(corpus.builds.map((b) => b.sha)).toContain(PINNED_FIRMWARE)
    expect(versions).toEqual(['7.14.1', '7.14.2', '7.15.0', '7.16.0'])
  })

  for (const c of corpus.cases) {
    test(c.name, () => {
      const verdicts = c.verdicts as Record<string, string>
      for (const version of versions) {
        const refused = corpus.builds
          .filter((b) => b.version === version)
          .every((b) => verdicts[b.sha] === 'OPAQUE')
        expect({ version, requiresAdvancedMode: solanaFirmwareRequiresAdvancedMode(c.rawTx, version) })
          .toEqual({ version, requiresAdvancedMode: refused })
      }
    })
  }
})

describe('what the firmware verdicts mean for common transactions', () => {
  const verdict = (name: string, sha: string) => (rawTx(name).verdicts as Record<string, string>)[sha]

  test('an SPL send with createIdempotent clear-signs from 7.15 and is opaque on 7.14', () => {
    const name = 'SPL send: ATA createIdempotent + transferChecked (@solana/spl-token default)'
    expect(verdict(name, PINNED_FIRMWARE)).toBe('VERIFIED')
    expect(verdict(name, V7141)).toBe('OPAQUE')
    expect(solanaFirmwareRequiresAdvancedMode(rawTx(name).rawTx, '7.16.0')).toBe(false)
    expect(solanaFirmwareRequiresAdvancedMode(rawTx(name).rawTx, '7.15.0')).toBe(false)
    expect(solanaFirmwareRequiresAdvancedMode(rawTx(name).rawTx, '7.14.1')).toBe(true)
  })

  test('stake Deactivate, SyncNative and durable nonce clear-sign on every version', () => {
    for (const name of ['native stake Deactivate', 'durable nonce: AdvanceNonceAccount + transfer']) {
      for (const version of versions) {
        expect(solanaFirmwareRequiresAdvancedMode(rawTx(name).rawTx, version)).toBe(false)
      }
    }
    const wrap = rawTx('wrap SOL: ATA createIdempotent + transfer + SyncNative').rawTx
    expect(solanaFirmwareRequiresAdvancedMode(wrap, '7.16.0')).toBe(false)
  })

  test('an unknown program needs AdvancedMode on every version', () => {
    for (const version of versions) {
      expect(solanaFirmwareRequiresAdvancedMode(rawTx('unknown program').rawTx, version)).toBe(true)
    }
  })

  test('a lookup-table transaction needs AdvancedMode from 7.15; 7.14 refuses it outright', () => {
    const name = 'Relay depositNative, v0 with one lookup table (mainnet)'
    expect(verdict(name, V7141)).toBe('MALFORMED')
    expect(solanaFirmwareRequiresAdvancedMode(rawTx(name).rawTx, '7.14.1')).toBe(false)
    expect(solanaFirmwareRequiresAdvancedMode(rawTx(name).rawTx, '7.16.0')).toBe(true)
  })

  test('an unknown firmware version or an unparseable transaction asks for nothing', () => {
    expect(solanaFirmwareRequiresAdvancedMode(rawTx('unknown program').rawTx, undefined)).toBe(false)
    expect(solanaFirmwareRequiresAdvancedMode('AA==', '7.16.0')).toBe(false)
  })
})

describe('attached proof material follows fsm_msgSolanaSignTx', () => {
  const transfer = rawTx('plain SOL transfer').rawTx
  const unknown = rawTx('unknown program').rawTx
  const relayAlt = rawTx('Relay depositNative, v0 with one lookup table (mainnet)').rawTx
  const runtimeSchema = { schema: { signerKeyId: 1 } }
  const certified = { schema: { signerKeyId: 0x80 }, certificate: 'cert' }

  test('7.16 verifies a runtime-signer schema only with AdvancedMode on, even for a clear-signable tx', () => {
    // fsm_msg_solana.h (e507d0c6) non-certified branch: signed_metadata_verify_attestation
    // refuses a loaded signer while AdvancedMode is off, and runtime signers are all loaded.
    expect(solanaFirmwareRequiresAdvancedMode(transfer, '7.16.0', runtimeSchema)).toBe(true)
  })

  test('before 7.16 a runtime schema does not change the review', () => {
    // 7.14 has no schema fields (nanopb skips them); release/7.15 only annotates an opaque review.
    expect(solanaFirmwareRequiresAdvancedMode(transfer, '7.14.1', runtimeSchema)).toBe(false)
    expect(solanaFirmwareRequiresAdvancedMode(transfer, '7.15.0', runtimeSchema)).toBe(false)
    expect(solanaFirmwareRequiresAdvancedMode(unknown, '7.15.0', runtimeSchema)).toBe(true)
  })

  test('a runtime lutProof never makes a lookup-table tx reviewable', () => {
    const lutProof = { lutProof: { signerKeyId: 2 } }
    expect(solanaFirmwareRequiresAdvancedMode(relayAlt, '7.16.0', lutProof)).toBe(true)
    expect(solanaFirmwareRequiresAdvancedMode(relayAlt, '7.15.0', lutProof)).toBe(true)
  })

  test('certified material skips the gate only on firmware that verifies it', () => {
    expect(solanaFirmwareRequiresAdvancedMode(unknown, '7.16.0', certified)).toBe(false)
    expect(solanaFirmwareRequiresAdvancedMode(unknown, '7.15.0', certified)).toBe(true)
    // signerKeyId 0x80 without a certificate is not certified material.
    expect(solanaFirmwareRequiresAdvancedMode(unknown, '7.16.0', { schema: { signerKeyId: 0x80 } })).toBe(true)
  })
})

describe('the approval gates REST and WalletConnect attach', () => {
  const gates = async (name: string, version: string, metadata = {}) => {
    const info = { id: 'x', method: '/solana/sign-transaction' } as SigningRequestInfo
    const raw = rawTx(name).rawTx
    info.solanaDecoded = await buildSolanaDecodedInfo(raw, async (keys) => keys.map(() => null))
    applySolanaSigningGates(info, raw, version, metadata)
    return {
      consent: info.requiresBlindSigningConsent,
      advancedMode: info.requiresAdvancedMode,
      blind: info.needsBlindSigning,
    }
  }

  test('a firmware-clear-signed SPL send keeps its consent step and needs no AdvancedMode', async () => {
    // The consent allowlist is conservative; the device clear-signs this on 7.15+.
    expect(await gates('SPL send: ATA createIdempotent + transferChecked (@solana/spl-token default)', '7.16.0'))
      .toEqual({ consent: true, advancedMode: false, blind: true })
  })

  test('an opaque transaction needs consent and AdvancedMode before approval', async () => {
    expect(await gates('unknown program', '7.16.0')).toEqual({ consent: true, advancedMode: true, blind: true })
  })

  test('a runtime schema needs AdvancedMode without the consent step', async () => {
    expect(await gates('plain SOL transfer', '7.16.0', { schema: { signerKeyId: 1 } }))
      .toEqual({ consent: false, advancedMode: true, blind: true })
  })

  test('certified material and a plain transfer stay unflagged', async () => {
    expect(await gates('unknown program', '7.16.0', { schema: { signerKeyId: 0x80 }, certificate: 'cert' }))
      .toEqual({ consent: false, advancedMode: false, blind: undefined })
    expect(await gates('plain SOL transfer', '7.16.0')).toEqual({ consent: false, advancedMode: false, blind: undefined })
  })
})
