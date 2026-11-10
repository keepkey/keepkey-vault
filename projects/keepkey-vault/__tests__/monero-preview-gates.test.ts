import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { firmwareSupportsMonero, MONERO_MIN_FIRMWARE } from '../src/shared/firmware-versions'
import { CHAINS, isChainSupported } from '../src/shared/chains'
import { bitcoinOnlyRpcRejection } from '../src/bun/bitcoin-only-boundary'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'
import { assertMoneroStandardWallet, moneroHiddenWallet, MONERO_STANDARD_WALLET_REQUIRED } from '../src/shared/monero-wallet-policy'

const src = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

/** Evaluate the actual settings/factory functions without importing app startup,
 * opening a profile, constructing a sidecar or contacting any API. */
function moneroSettingsFixture(enabled: boolean, hidden: boolean) {
  const file = ts.createSourceFile('index.ts', process.env.MONERO_SETTINGS_SOURCE
    ? readFileSync(process.env.MONERO_SETTINGS_SOURCE, 'utf8') : src('src/bun/index.ts'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const named = (name: string) => {
    const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!node) throw new Error(`Missing actual ${name}`)
    return node.getText(file)
  }
  let walletReads = 0, constructions = 0
  const context = {
    restApiEnabled: true, walletConnectEnabled: false, multisigFeature: { enabled: false }, moneroEnabled: enabled,
    passwordBank: { enabled: true }, zcashPrivacyEnabled: false, hiveEnabled: false, emulatorEnabled: false, offlineMode: false,
    disabledNetworks: [], preReleaseUpdates: false, alphaFirmware: false, addressBookClearsignEnabled: false, privateModeEnabled: false,
    getPioneerServers: () => [], getPioneerApiBase: () => 'https://synthetic.example', getSetting: () => null,
    supportedLanguage: () => 'en', validNumberLocale: () => 'en-US', isMoneroSidecarAvailable: () => true,
    MONERO_DEFAULT_NODE: 'http://127.0.0.1:18081', moneroNodeMode: () => 'local', storedRestoreHeight: () => 0,
    addressBookCertifyUnsupported: () => false, getEvmSimulationRpcUrls: () => ({}),
    engine: { isPassphraseWallet: hidden, getDeviceState: () => ({ isHiddenWallet: hidden }) },
    assertMoneroStandardWallet, moneroHiddenWallet, invalidateMoneroWallet() {}, moneroWallet: null,
    getMoneroWallet: () => { walletReads++; if (hidden) throw new Error(MONERO_STANDARD_WALLET_REQUIRED); return { pendingCount: () => 3 } },
    createMoneroFailoverVault: () => { constructions++; throw new Error('Must not construct a hidden monitor') },
  }
  const evaluate = (text: string) => runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { settings: () => evaluate(`${named('getAppSettings')}\ngetAppSettings()`),
    construct: () => evaluate(`${named('getMoneroWallet')}\ngetMoneroWallet()`), counts: () => ({ walletReads, constructions }) }
}

describe('Monero preview gates', () => {
	for (const enabled of [false, true]) test(`actual settings remain usable in a hidden wallet with Monero ${enabled ? 'on' : 'off'}`, () => {
		const fixture = moneroSettingsFixture(enabled, true)
		expect(fixture.settings()).toMatchObject({ restApiEnabled: true, moneroEnabled: enabled, passwordManagerEnabled: true, moneroPendingBroadcasts: 0 })
		expect(fixture.counts()).toEqual({ walletReads: 0, constructions: 0 })
		expect(() => fixture.construct()).toThrow(MONERO_STANDARD_WALLET_REQUIRED)
		expect(fixture.counts().constructions).toBe(0)
	})
	test('actual standard-wallet settings keep their pending-transaction count when enabled', () => {
		const fixture = moneroSettingsFixture(true, false)
		expect(fixture.settings().moneroPendingBroadcasts).toBe(3)
		expect(fixture.counts()).toEqual({ walletReads: 1, constructions: 0 })
	})
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
		expect(page).toContain('? <MoneroSendSection monero={monero} client={rpcMoneroClient} privateMode={privateModeEnabled} />')
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

	test('the form can collect a payment before automatic verification, and signing still confirms on the device', () => {
		const sections = src('src/mainview/components/MoneroAssetSections.tsx')
		expect(sections).toContain('const receiveOnly = wallet.sendBlocked === "emulator" || wallet.sendBlocked === "adapter"')
		expect(sections).toContain('{(wallet.canSend || wallet.sendBlocked === "key-images") && !wallet.unrelayedTxid && !review && (')
		expect(src('src/mainview/lib/monero-client.ts')).toContain('rpcRequest<{ txid: string }>("moneroSend", { prepareId }')
		expect(src('src/bun/index.ts')).toContain('signingEmulator: moneroSigningEmulatorActive')
	})

	test('bitcoin-only firmware refuses every monero RPC but still lets Monero be switched off', () => {
		expect(bitcoinOnlyRpcRejection('moneroPrepareSend', {})).toContain('not available on bitcoin-only firmware')
		expect(bitcoinOnlyRpcRejection('setMoneroEnabled', { enabled: false })).toBeNull()
	})
})
