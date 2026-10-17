/**
 * Desktop trusts only the production ClearSign root (027c1fde...e321). The
 * alpha root signs nothing a shipped build accepts: rehearsals and tests pass
 * it explicitly, from scripts/clearsign-alpha-rehearsal.ts.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import signed from './fixtures/clearsign-production-catalog-batch1.json'
import alphaArbitrum from '../../../docs/clearsign-case-studies/uniswap-usdt/arbitrum-certificate.json'
import { ALPHA_ROOT_PUBLIC_KEY } from '../scripts/clearsign-alpha-rehearsal'
import { delegateFingerprint, inspectAlphaCertificate } from '../src/bun/clearsign-alpha-ceremony'
import { CERTIFIED_EVM_CATALOG, expectedEvmScreens, expectedUniswapScreens } from '../src/bun/evm-certified-schema'
import { configureClearSignArtifactSnapshots, resolvePromotedEvmArtifact, resolvePromotedSolanaArtifact } from '../src/bun/clearsign-artifact-resolver'
import { clearSignIdentityHash } from '../src/bun/clearsign-promotion'
import { resolveEvmSchema } from '../src/bun/evm-schema-registry'
import { certifiedEnvelopeShown, configureProductionRootTrust } from '../src/shared/certified-evm-envelope'
import { supportsCertifiedClearSign } from '../src/bun/solana-certified-policy'
import { evmCallRequiresAdvancedMode } from '../src/bun/evm-signing-policy'
import noAltFixture from './fixtures/solana/relay-deposit-native-no-alt.json'
import { emulatorClearSignTestRoot, libraryReadsClearSignTestRoot } from '../src/bun/emulator-library'
import { homedir } from 'node:os'
import { join } from 'node:path'

const NOW = 1_790_000_000

describe('the production ClearSign root', () => {
  for (const [scope, certificate] of Object.entries(signed.certificates)) {
    test(`accepts the production certificate for scope ${scope} and its own delegate`, () => {
      const inspected = inspectAlphaCertificate(certificate, NOW)
      expect(inspected.chainId).toBe(Number(scope))
      expect(inspected.alias).toBe('KeepKey ClearSign')
      expect(inspected.delegatePublicKey).toBe(signed.delegate_pubkeys[scope as keyof typeof signed.delegate_pubkeys])
    })
  }

  test('refuses an alpha-root certificate unless a rehearsal names the alpha root', () => {
    expect(() => inspectAlphaCertificate(alphaArbitrum.certificateHex, NOW)).toThrow('not signed by the KeepKey ClearSign root')
    expect(inspectAlphaCertificate(alphaArbitrum.certificateHex, NOW, ALPHA_ROOT_PUBLIC_KEY).alias).toBe('KeepKey Alpha 716')
    expect(() => inspectAlphaCertificate(signed.certificates['1'], NOW, ALPHA_ROOT_PUBLIC_KEY)).toThrow('not signed by')
  })

  test('shipped Desktop code names no alpha root, delegate or alias', () => {
    const banned = ['02de9231b2094433', '0342f5f9704494b3', 'a9531b9d', 'KeepKey Alpha 716']
    const root = new URL('..', import.meta.url).pathname
    for (const file of new Bun.Glob('src/**/*.{ts,tsx,json}').scanSync({ cwd: root })) {
      if (/\.test\.tsx?$/.test(file)) continue
      const text = readFileSync(`${root}${file}`, 'utf8')
      expect({ file, alpha: banned.filter((s) => text.includes(s)) }).toEqual({ file, alpha: [] })
    }
  })

  test('expected screens name the alias and fingerprint of the certificate in use', () => {
    const inspected = inspectAlphaCertificate(signed.certificates['42161'], NOW)
    const fingerprint = delegateFingerprint(inspected.delegatePublicKey)
    const described = `Described by KeepKey ClearSign ${fingerprint}\ncertified by KeepKey`
    const spec = Object.values(CERTIFIED_EVM_CATALOG).find((s) => s.intent)!
    expect(expectedEvmScreens(spec, inspected.alias, fingerprint)!.at(-1)!.body).toBe(described)
    const router = '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
    expect(expectedUniswapScreens(42161, router, inspected.alias, fingerprint).at(-1)!.body).toBe(described)
  })
})

describe('artifacts saved before the production root (v1.6.1 checked imports against the alpha root)', () => {
  const to = '0x1111111111111111111111111111111111111111'
  const method = Buffer.from('doThing', 'ascii')
  const body = Buffer.concat([Buffer.from([2]), Buffer.from([0, 0, 0xa4, 0xb1]), Buffer.from(to.slice(2), 'hex'), Buffer.from('abcdef01', 'hex'),
    Buffer.from([0, method.length]), method, Buffer.from([1]), Buffer.alloc(71)])
  const data = '0xabcdef01' + '00'.repeat(32)
  const evidence = { identities: [{ x: 1 }], auditedAt: Date.now() } as any
  const snapshot = (certificateHex: string, solana = false) => ({
    artifact: {
      chain: solana ? 'Solana' : 'Ethereum', shapeKey: 'saved', payloadHex: body.toString('hex'), bundleHash: 'ab',
      identityHash: clearSignIdentityHash(evidence), expiresAt: Date.now() + 86_400_000, certificateHex,
      ...(solana
        ? { solana: { schemaPayloadHex: '00', schemaSignatureHex: '00', signerKeyId: 128, certificateHex } }
        : { evmCertifiedEnvelopeHex: Buffer.concat([Buffer.from([3]), Buffer.from(certificateHex, 'hex'), body, Buffer.alloc(65)]).toString('hex') }),
    },
    job: { status: 'covered', evidence },
  }) as any

  test('an alpha-root artifact is never sent as KeepKey-certified; a production-root one is', async () => {
    const realFetch = globalThis.fetch
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...m: unknown[]) => { warnings.push(m.join(' ')) }
    globalThis.fetch = (async () => new Response('{}', { status: 422 })) as unknown as typeof fetch
    try {
      configureClearSignArtifactSnapshots(() => [snapshot(alphaArbitrum.certificateHex), snapshot(alphaArbitrum.certificateHex, true)])
      expect(resolvePromotedEvmArtifact(42161, to, data).status).toBe('no-artifact')
      expect(await resolveEvmSchema(42161, to, data, true, '7.16.0')).toBeUndefined()
      expect(resolvePromotedSolanaArtifact(noAltFixture.rawTxBase64).status).toBe('no-artifact')
      expect(warnings.filter((w) => w.includes('not under the KeepKey ClearSign root'))).toHaveLength(1)

      configureClearSignArtifactSnapshots(() => [snapshot(signed.certificates['42161'])])
      expect(resolvePromotedEvmArtifact(42161, to, data).status).toBe('selected')
    } finally {
      configureClearSignArtifactSnapshots(() => [])
      globalThis.fetch = realFetch
      console.warn = warn
    }
  })
})

describe('the bundled emulator compiles in only the alpha root', () => {
  test('it gets no certified description and the AdvancedMode gate stays, so it never refuses a claim', () => {
    const UR = '0x2d01411773c8c24805306e89a41f7855c3c4fe65'
    const envelope = Uint8Array.from(Buffer.concat([Buffer.from([3]), Buffer.alloc(139, 7), Buffer.from([2]),
      Buffer.from('0000a4b1', 'hex'), Buffer.from(UR.slice(2), 'hex'), Buffer.from('3593564c', 'hex'), Buffer.alloc(65)]))
    const tx = { chainId: 42161, to: UR, data: '0x3593564c' + '00'.repeat(64) }
    const meta = { signedPayload: Buffer.from(envelope).toString('hex'), keyId: 0x80 }
    expect(supportsCertifiedClearSign('7.17.0')).toBe(true)
    expect(certifiedEnvelopeShown(envelope, 0x80, '7.17.0', tx)).toBe(true)
    try {
      configureProductionRootTrust(() => false)
      expect(supportsCertifiedClearSign('7.17.0')).toBe(false)
      expect(certifiedEnvelopeShown(envelope, 0x80, '7.17.0', tx)).toBe(false)
      expect(evmCallRequiresAdvancedMode(UR, tx.data, 42161, false, meta, undefined, '7.17.0')).toBe(true)
    } finally { configureProductionRootTrust(() => true) }
    // Desktop registers the emulator as not trusting the production root,
    // unless it was launched with a ClearSign TEST root its library reads.
    const index = readFileSync(new URL('../src/bun/index.ts', import.meta.url), 'utf8')
    expect(index).toContain('configureProductionRootTrust(() => !engine.isEmulator || (!!emulatorTestRoot && emulatorReadsClearSignTestRoot()))')
    expect(index).toContain('const emulatorTestRoot = emulatorClearSignTestRoot(process.env, DEFAULT_CLEARSIGN_SERVICE_URL)')
    const emulator = readFileSync(new URL('../src/bun/emulator.ts', import.meta.url), 'utf8')
    expect(emulator).toContain('readsTestRoot = libraryReadsClearSignTestRoot(dylibPath)')
  })

  const KEY = '02ec4954d2a274a8e8f05823471464dde86b675fbc675ddbb672a28c6953d9ef76'
  const TEST_SERVICE = 'http://127.0.0.1:8787'
  const PRODUCTION = 'https://keepkey-clearsign.bithighlander.workers.dev'
  const root = (value: string | undefined, service: string | undefined = TEST_SERVICE) =>
    emulatorClearSignTestRoot({ KK_CLEARSIGN_TEST_ROOT: value, CLEARSIGN_SERVICE_URL: service }, PRODUCTION)

  test('only a KK_CLEARSIGN_TEST_ROOT the firmware itself takes counts as a test root', () => {
    expect(root(KEY)).toBe(KEY)
    // The firmware's hex reader takes either case.
    expect(root(KEY.toUpperCase())).toBe(KEY)
    // It does not trim, wants exactly 66 hex characters, 02/03, and a point on the curve.
    for (const bad of [undefined, '', '1', ` ${KEY}`, `${KEY}\n`, KEY.slice(2), `04${KEY.slice(2)}`, `${KEY}00`,
      `02${'0'.repeat(64)}`, `03${'f'.repeat(64)}`]) {
      expect(root(bad)).toBeUndefined()
    }
  })

  test('the test root replaces the compiled-in root: only with a ClearSign service other than production', () => {
    expect(emulatorClearSignTestRoot({ KK_CLEARSIGN_TEST_ROOT: KEY }, PRODUCTION)).toBeUndefined()
    for (const service of ['', ' ', PRODUCTION, `${PRODUCTION}/`]) expect(root(KEY, service)).toBeUndefined()
  })

  test('a library that does not read KK_CLEARSIGN_TEST_ROOT is not a test-root emulator', () => {
    const system = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'win32' ? 'kernel32.dll' : 'libc.so.6'
    expect(libraryReadsClearSignTestRoot(system)).toBe(false)
    expect(libraryReadsClearSignTestRoot('/nonexistent/libkkemu.dylib')).toBe(false)
  })

  // The installed release library (no loader) and the stock 7.16 debug build (loader), when on this machine.
  const installed = join(homedir(), '.keepkey', 'emulator', 'libkkemu.dylib')
  const stock716 = join(homedir(), 'keepkey-toolchain', 'emu-v7.16.0-prodroot-arm64', 'lib', 'libkkemu.dylib')
  test.skipIf(!existsSync(installed) || readFileSync(installed).includes('KK_CLEARSIGN_TEST_ROOT'))('the installed release emulator library does not read it', () => {
    expect(libraryReadsClearSignTestRoot(installed)).toBe(false)
  })
  test.skipIf(!existsSync(stock716))('the stock 7.16 debug emulator library reads it', () => {
    expect(libraryReadsClearSignTestRoot(stock716)).toBe(true)
  })
})
