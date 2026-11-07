import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { firmwareSupportsMonero, MONERO_MIN_FIRMWARE } from '../src/shared/firmware-versions'
import { CHAINS, isChainSupported } from '../src/shared/chains'
import { bitcoinOnlyRpcRejection } from '../src/bun/bitcoin-only-boundary'

const src = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

describe('Monero preview gates', () => {
	test('firmware 7.17.0 or newer only', () => {
		expect(firmwareSupportsMonero('7.17.0')).toBe(true)
		expect(firmwareSupportsMonero('7.18.1')).toBe(true)
		expect(firmwareSupportsMonero('7.16.0')).toBe(false)
		expect(firmwareSupportsMonero(undefined)).toBe(false)
	})

	test('XMR is a chain-list row opening the standard asset page; the separate tab, panel and button are gone', () => {
		const monero = CHAINS.find(c => c.id === 'monero')!
		expect(monero).toMatchObject({ chainFamily: 'monero', symbol: 'XMR', decimals: 12, hidden: true, minFirmware: MONERO_MIN_FIRMWARE })
		expect(isChainSupported(monero, '7.16.0')).toBe(false)
		expect(existsSync(join(import.meta.dir, '..', 'src/mainview/components/MoneroPanel.tsx'))).toBe(false)
		expect(src('src/mainview/components/TopNav.tsx')).not.toContain('"monero"')
		expect(src('src/mainview/App.tsx')).not.toMatch(/Monero/)
		const dashboard = src('src/mainview/components/Dashboard.tsx')
		expect(dashboard).not.toContain('onOpenMonero')
		expect(dashboard).toContain('moneroChainVisible({ settingEnabled: moneroEnabled, firmwareVersion, watchOnly, bitcoinOnly: btcOnly })')
		expect(dashboard).toContain('<MoneroChainRow chain={moneroChain}')
		expect(dashboard).toContain('onOpen={() => openChainPage(moneroChain)}')
		const page = src('src/mainview/components/AssetPage.tsx')
		expect(page).toContain('? <MoneroSendSection monero={monero} client={rpcMoneroClient} />')
		expect(page).toContain(': <MoneroReceiveSection chain={chain} monero={monero}')
	})

	test('Pioneer, REST and audit loops never treat XMR as a Pioneer chain', () => {
		expect(src('src/bun/rest-api.ts')).toContain("c.chainFamily !== 'monero').map(c => c.networkId)")
		expect(src('src/bun/rest-api.ts')).toContain(".filter(c => c.chainFamily !== 'monero')")
		expect(src('src/bun/activity-history.ts')).toContain("chain.chainFamily !== 'monero'")
		expect(src('src/bun/index.ts')).toContain("if (c.chainFamily === 'monero') return false")
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
		const sections = src('src/mainview/components/MoneroAssetSections.tsx')
		expect(sections).toContain('const receiveOnly = wallet.sendBlocked === "emulator" || wallet.sendBlocked === "adapter"')
		expect(sections).toContain('{wallet.canSend && !review && (')
		expect(src('src/mainview/lib/monero-client.ts')).toContain('rpcRequest<{ txid: string }>("moneroSend", { prepareId }')
		expect(src('src/bun/index.ts')).toContain('signingEmulator: moneroSigningEmulatorActive')
	})

	test('bitcoin-only firmware refuses every monero RPC but still lets Monero be switched off', () => {
		expect(bitcoinOnlyRpcRejection('moneroPrepareSend', {})).toContain('not available on bitcoin-only firmware')
		expect(bitcoinOnlyRpcRejection('setMoneroEnabled', { enabled: false })).toBeNull()
	})
})
