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

	test('switching Monero off keeps a research emulator selection (the next start names it; see emulator-build-unavailable.test.ts)', () => {
		expect(src('src/bun/index.ts')).not.toContain('if (listEmulatorBuilds().find(build => build.selected)?.research) clearSelectedEmulatorBuild()')
	})

	test('research signing artifacts are copied only by the dev-only flag that signed releases refuse', () => {
		expect(src('scripts/build-signed.ts')).toContain("if (process.env.KEEPKEY_INCLUDE_MONERO_EMULATOR === '1') {")
		const config = src('electrobun.config.ts')
		expect(config).toContain("const includeMoneroResearch = process.env.KEEPKEY_INCLUDE_MONERO_EMULATOR === '1';")
		for (const artifact of ['libkkemu-monero-signing.dylib', 'monero-host-adapter']) {
			const lines = config.split('\n').filter(line => line.includes(artifact) && line.includes('existsSync'))
			expect(lines.length).toBeGreaterThan(0)
			for (const line of lines) expect(line).toContain('includeMoneroResearch &&')
		}
	})

	test('the send form appears only past every backend gate, and confirms on the device', () => {
		const panel = src('src/mainview/components/MoneroPanel.tsx')
		expect(panel).toContain('const receiveOnly = !wallet || wallet.sendBlocked === "emulator" || wallet.sendBlocked === "adapter"')
		expect(panel).toContain('{wallet.canSend && !review && (')
		expect(panel).toContain('"moneroSend", { prepareId: review.prepareId }')
		expect(src('src/bun/index.ts')).toContain('signingEmulator: moneroSigningEmulatorActive')
	})
})
