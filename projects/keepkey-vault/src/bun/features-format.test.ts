/**
 * POST /system/info/get-features body: the device's Features.capabilities
 * reach REST callers, so a hardware suite can see which 7.15/7.16 features the
 * connected firmware claims instead of inferring them from behaviour.
 */
import { describe, expect, test } from 'bun:test'
import { formatFeatures } from './features-format'

describe('formatFeatures', () => {
  test('passes Features.capabilities through as a plain array', () => {
    const list = [4, 5, 13, 17, 18, 25, 26, 27]
    const out = formatFeatures({ majorVersion: 7, minorVersion: 16, patchVersion: 0, capabilitiesList: list })
    expect(out.capabilities).toEqual(list)
    expect(out.capabilities).not.toBe(list)
    expect(out.major_version).toBe(7)
  })

  test('leaves capabilities absent when the firmware reports none', () => {
    expect(formatFeatures({ majorVersion: 7, minorVersion: 14, patchVersion: 1 }).capabilities).toBeUndefined()
  })

  test('still decodes hashes and policies as before', () => {
    const out = formatFeatures({
      firmwareHash: Buffer.from('99eb', 'hex').toString('base64'),
      policiesList: [{ policyName: 'AdvancedMode', enabled: false }],
    })
    expect(out.firmware_hash).toBe('99eb')
    expect(out.policies).toEqual([{ policy_name: 'AdvancedMode', enabled: false }])
  })
})
