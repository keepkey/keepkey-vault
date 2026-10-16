/**
 * Desktop trusts only the production ClearSign root (027c1fde...e321). The
 * alpha root signs nothing a shipped build accepts: rehearsals and tests pass
 * it explicitly, from scripts/clearsign-alpha-rehearsal.ts.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import signed from './fixtures/clearsign-production-catalog-batch1.json'
import alphaArbitrum from '../../../docs/clearsign-case-studies/uniswap-usdt/arbitrum-certificate.json'
import { ALPHA_ROOT_PUBLIC_KEY } from '../scripts/clearsign-alpha-rehearsal'
import { delegateFingerprint, inspectAlphaCertificate } from '../src/bun/clearsign-alpha-ceremony'
import { CERTIFIED_EVM_CATALOG, expectedEvmScreens, expectedUniswapScreens } from '../src/bun/evm-certified-schema'

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
