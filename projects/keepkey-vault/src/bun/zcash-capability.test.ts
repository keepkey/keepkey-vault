import { describe, expect, test } from 'bun:test'

import { supportsZcashPrivacyBuild } from './zcash-capability'

describe('Zcash release capability', () => {
	test('requires both firmware support and a packaged sidecar', () => {
		expect(supportsZcashPrivacyBuild('7.16.0', undefined)).toBe(false)
		expect(supportsZcashPrivacyBuild('7.14.1', '/app/zcash-cli')).toBe(false)
		expect(supportsZcashPrivacyBuild('7.15.0', '/app/zcash-cli')).toBe(true)
	})
})
