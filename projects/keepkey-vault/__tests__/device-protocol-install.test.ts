import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

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
