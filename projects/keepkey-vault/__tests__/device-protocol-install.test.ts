import { describe, expect, test } from 'bun:test'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import ts from 'typescript'

// Vault and hdwallet-keepkey must both load the 7.16 firmware protocol.
// hdwallet-keepkey resolves it from its real path (modules/hdwallet), so a
// stale copy there decodes Features without capabilities and drops the Zcash
// TEX hint while Vault's own copy has both.
const require = createRequire(import.meta.url)

const consumers = {
  vault: require,
  'hdwallet-keepkey': createRequire(realpathSync(require.resolve('@keepkey/hdwallet-keepkey'))),
}

// Features with capabilities = [1, 26, 27]: field 30, packed, as firmware sends it.
const FEATURES_WITH_CAPABILITIES = new Uint8Array([0xf2, 0x01, 0x03, 1, 26, 27])

test('fresh installs lock every SDK protocol dependency to the reviewed local file override', () => {
  const project = resolve(import.meta.dir, '..')
  const manifest = JSON.parse(readFileSync(resolve(project, 'package.json'), 'utf8'))
  const protocol = '@keepkey/device-protocol'
  const fileSpec = manifest.overrides[protocol] as string
  expect(fileSpec.startsWith('file:')).toBe(true)
  expect(manifest.dependencies[protocol]).toBe(fileSpec)
  const moduleManifest = JSON.parse(readFileSync(resolve(project, fileSpec.slice(5), 'package.json'), 'utf8'))
  const expected = `${moduleManifest.name}@${fileSpec}`
  const parsed = ts.parseConfigFileTextToJson('bun.lock', readFileSync(resolve(project, 'bun.lock'), 'utf8'))
  expect(parsed.error).toBeUndefined()
  const lock = parsed.config as { overrides: Record<string, string>; packages: Record<string, [string, ...unknown[]]> }
  expect(lock.overrides[protocol]).toBe(fileSpec)
  expect(lock.packages[protocol]?.[0]).toBe(expected)
  const sdkEntries = Object.entries(lock.packages).filter(([name]) => name.includes('hdwallet-keepkey') && name.endsWith(`/${protocol}`))
  expect(sdkEntries.length).toBeGreaterThan(0)
  // Bun 1.3.14 can regenerate npm aliases as a registry dependency despite
  // the file override. A top-level local entry alone does not protect the SDK.
  for (const [name, entry] of sdkEntries) expect({ name, target: entry[0] }).toEqual({ name, target: expected })
})

describe.each(Object.entries(consumers))('device-protocol seen by %s', (_name, req) => {
  test('decodes Features.capabilities', () => {
    const { Features } = req('@keepkey/device-protocol/lib/messages_pb')
    const features = Features.deserializeBinary(FEATURES_WITH_CAPABILITIES)
    expect(typeof features.getCapabilitiesList).toBe('function')
    expect(features.getCapabilitiesList()).toEqual([1, 26, 27])
  })

  test('has ZcashTransparentOutput.is_tex', () => {
    const { ZcashTransparentOutput } = req('@keepkey/device-protocol/lib/messages-zcash_pb')
    expect(typeof ZcashTransparentOutput.prototype.setIsTex).toBe('function')
  })
})
