import { describe, expect, test } from 'bun:test'

import { supportsZcashPrivacyBuild } from './zcash-capability'
import { CHAINS } from '../shared/chains'
import { getUpgradeFeatures, getVersionInfo } from '../shared/firmware-versions'

describe('Zcash release capability', () => {
	test('requires both firmware support and a packaged sidecar', () => {
		expect(supportsZcashPrivacyBuild('7.16.0', undefined)).toBe(false)
		expect(supportsZcashPrivacyBuild('7.14.1', '/app/zcash-cli')).toBe(false)
		expect(supportsZcashPrivacyBuild('7.15.0', '/app/zcash-cli')).toBe(false)
		expect(supportsZcashPrivacyBuild('7.16.0', '/app/zcash-cli')).toBe(false)
		expect(supportsZcashPrivacyBuild('7.17.0', '/app/zcash-cli')).toBe(true)
		expect(supportsZcashPrivacyBuild('7.17.0', undefined)).toBe(false)
	})
	test('the 7.17 upgrade advertises Zcash with the actual emulator-only sending boundary', () => {
		for (const id of ['zcash', 'zcash-shielded']) expect(CHAINS.find(chain => chain.id === id)?.minFirmware).toBe('7.17.0')
		const zcash = getUpgradeFeatures('7.16.0', '7.17.0').find(feature => feature.chains?.includes('zcash'))
		expect(zcash?.description).toContain('reviewed 7.17 alpha emulator')
		expect(zcash?.description).toContain('Physical-device and private-pool sends are not yet qualified')
		expect(getVersionInfo('7.15.0')?.features.some(feature => feature.chains?.includes('zcash'))).toBe(false)
	})
})
