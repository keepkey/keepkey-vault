import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { firmwareSupportsMonero } from '../src/shared/firmware-versions'

const src = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

describe('Monero preview gates', () => {
	test('firmware 7.17.0 or newer only', () => {
		expect(firmwareSupportsMonero('7.17.0')).toBe(true)
		expect(firmwareSupportsMonero('7.18.1')).toBe(true)
		expect(firmwareSupportsMonero('7.16.0')).toBe(false)
		expect(firmwareSupportsMonero(undefined)).toBe(false)
	})

	test('the tab and panel need the setting AND the firmware', () => {
		expect(src('src/mainview/App.tsx')).toContain('const moneroEnabled = moneroSetting && firmwareSupportsMonero(deviceState.firmwareVersion)')
	})

	test('no balance is shown before the first scan finishes', () => {
		const panel = src('src/mainview/components/MoneroPanel.tsx')
		expect(panel).toContain('const scanned = !!wallet && wallet.walletHeight > 0')
		expect(panel).toContain('const balance = scanned ? atomicAmount(wallet.balanceAtomic) : null')
	})

	test('switching Monero off drops a research emulator selection', () => {
		expect(src('src/bun/index.ts')).toContain('if (listEmulatorBuilds().find(build => build.selected)?.research) clearSelectedEmulatorBuild()')
	})
})
