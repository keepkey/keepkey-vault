import { afterEach, describe, expect, test } from 'bun:test'

import { findZcashCliBinary } from './zcash-sidecar'

const originalOverride = process.env.ZCASH_CLI_BIN

afterEach(() => {
	if (originalOverride === undefined) delete process.env.ZCASH_CLI_BIN
	else process.env.ZCASH_CLI_BIN = originalOverride
})

describe('Zcash sidecar release capability', () => {
	test('honors an existing explicit binary override', () => {
		process.env.ZCASH_CLI_BIN = process.execPath
		expect(findZcashCliBinary()).toBe(process.execPath)
	})
})
