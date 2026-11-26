import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'path'
import { supportsMoneroSigning } from '../src/shared/monero-capability'
import { CHAINS, isChainSupported } from '../src/shared/chains'
import { bitcoinOnlyRpcRejection } from '../src/bun/bitcoin-only-boundary'
import ts from 'typescript'
import { runInNewContext } from 'node:vm'
import { assertMoneroStandardWallet, moneroHiddenWallet, MONERO_STANDARD_WALLET_REQUIRED } from '../src/shared/monero-wallet-policy'

const src = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

/** Evaluate the actual settings/factory functions without importing app startup,
 * opening a profile, constructing a sidecar or contacting any API. */
function moneroSettingsFixture(enabled: boolean, hidden: boolean, readiness: { worker?: boolean; tools?: boolean; verifier?: boolean } = {}) {
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
    supportedLanguage: () => 'en', validNumberLocale: () => 'en-US', isMoneroSidecarAvailable: () => readiness.worker ?? true,
    hasMoneroSigningTools: () => readiness.tools ?? true, createMoneroCoreVerifier: () => ({ available: () => readiness.verifier ?? true }),
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

const packagingDirectories: string[] = []
afterEach(() => { for (const directory of packagingDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** Run the actual config and adapter verifier against public synthetic bytes.
 * Only the compiled review manifest is substituted; neither guard is mocked. */
async function moneroPackagingFixture(arch: 'arm64' | 'x64' = 'arm64') {
  const directory = mkdtempSync(join(tmpdir(), 'monero-preview-package-'))
  packagingDirectories.push(directory)
  const vendor = 'monero-cli/vendor/darwin-arm64'
  const adapter = Buffer.from('PUBLIC SYNTHETIC READ-ONLY DECODER')
  const sha256 = createHash('sha256').update(new Uint8Array(adapter)).digest('hex')
  const core = Buffer.from('PUBLIC SYNTHETIC CORE VERIFIER')
  const coreManifest = { files: { 'darwin-arm64': { filename: 'libmonero_core_verify.dylib', sha256: createHash('sha256').update(core).digest('hex'), size: core.length, minimumMacosVersion: '13.0', minimumDarwinMajor: 22 } } }
  const manifest = { schemaVersion: 1, protocol: 'keepkey-monero-wallet-export-v1', moneroVersion: '0.18.5.4',
    files: { 'darwin-arm64': { filename: 'monero-host-adapter', sha256, size: adapter.length } } }
  const write = (path: string, bytes: string | Buffer) => {
    mkdirSync(join(directory, path, '..'), { recursive: true })
    writeFileSync(join(directory, path), bytes, { mode: 0o755 })
  }
  write('monero-cli/dist/monero-cli', 'synthetic worker')
  write(`${vendor}/monero-wallet-rpc`, 'synthetic wallet RPC')
  write(`${vendor}/LICENSE`, 'synthetic license')
  write(`${vendor}/monero-host-adapter`, adapter)
  const metadata = (hash = sha256) => write(`${vendor}/monero-tools.json`, JSON.stringify({
    version: '0.18.5.4', platform: 'darwin-arm64', hostAdapterSha256: hash,
  }))
  metadata()
  for (const path of ['monero-device-bundle/libmonero_device_proof.dylib', 'monero-device-bundle/libmonero_core_verify.dylib',
    'monero-emulator-bundle/libkkemu-monero.dylib', 'monero-emulator-bundle/libkkemu-monero-signing.dylib',
    'monero-emulator-bundle/manifest.json', 'monero-emulator-bundle/signing-manifest.json']) write(path, 'synthetic research fixture')
  write('monero-device-bundle/libmonero_core_verify.dylib', core)
  const entry = join(directory, 'entry.ts')
  writeFileSync(entry, `import config from ${JSON.stringify(join(import.meta.dir, '../electrobun.config.ts'))}; console.log(JSON.stringify(config.build.copy))`)
  const built = await Bun.build({ entrypoints: [entry], target: 'bun', outdir: directory, naming: 'config.mjs',
    define: { 'process.platform': '"darwin"', 'process.arch': JSON.stringify(arch) },
    plugins: [{ name: 'public-adapter-review-pin', setup(build) {
      build.onResolve({ filter: /core-verifier-manifest\.json$/ }, () => ({ path: 'reviewed-core-pin', namespace: 'public-core-review-pin' }))
      build.onLoad({ filter: /.*/, namespace: 'public-core-review-pin' }, () => ({ loader: 'json', contents: JSON.stringify(coreManifest) }))
      build.onResolve({ filter: /host-adapter-manifest\.json$/ }, () => ({ path: 'reviewed-pin', namespace: 'public-adapter-review-pin' }))
      build.onLoad({ filter: /.*/, namespace: 'public-adapter-review-pin' }, () => ({ loader: 'json', contents: JSON.stringify(manifest) }))
    } }],
  })
  if (!built.success) throw new Error(built.logs.join('\n'))
  return { corruptReceipt: () => metadata('00'.repeat(32)), run: (research: boolean) => {
    const env = { ...process.env, KEEPKEY_INCLUDE_MONERO_EMULATOR: research ? '1' : '0' }
    for (const key of ['KEEPKEY_MONERO_CLI_SOURCE', 'KEEPKEY_MONERO_RPC_SOURCE', 'KEEPKEY_MONERO_METADATA_SOURCE',
      'KEEPKEY_MONERO_ADAPTER_SOURCE', 'KEEPKEY_MONERO_DAEMON_SOURCE', 'KEEPKEY_EMULATOR_SOURCE',
      'KEEPKEY_EMULATOR_RECEIPT_SOURCE', 'KEEPKEY_ZCASH_CLI_SOURCE', 'KEEPKEY_MONERO_CORE_VERIFIER_SOURCE', 'KEEPKEY_MONERO_CORE_VERIFIER_RECEIPT_SOURCE']) delete env[key]
    const result = Bun.spawnSync([process.execPath, join(directory, 'config.mjs')], {
      cwd: directory, env, stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
    })
    return { code: result.exitCode, error: result.stderr.toString(), copy: result.exitCode === 0 ? JSON.parse(result.stdout.toString()) as Record<string, string> : {} }
  } }
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
	test('Monero is gated by the feature flag and firmware only, never by platform or bundled tools', () => {
		for (const readiness of [{}, { worker: false }, { tools: false }, { verifier: false }]) {
			const settings = moneroSettingsFixture(true, false, readiness).settings()
			expect(settings.moneroEnabled).toBe(true)
			expect('moneroAvailable' in settings).toBe(false)
		}
	})
	test('monero-signing capability only', () => {
		expect(supportsMoneroSigning([31])).toBe(true)
		expect(supportsMoneroSigning([30])).toBe(false)
		expect(supportsMoneroSigning(undefined)).toBe(false)
	})

	test('XMR is a chain-list row opening the standard asset page; the separate tab, panel and button are gone', () => {
		const monero = CHAINS.find(c => c.id === 'monero')!
		expect(monero).toMatchObject({ chainFamily: 'monero', symbol: 'XMR', decimals: 12, hidden: true })
		expect(monero.minFirmware).toBeUndefined() // visibility uses Features.capabilities
		expect(isChainSupported(monero, '7.16.0')).toBe(true)
		expect(existsSync(join(import.meta.dir, '..', 'src/mainview/components/MoneroPanel.tsx'))).toBe(false)
		expect(src('src/mainview/components/TopNav.tsx')).not.toContain('"monero"')
		expect(src('src/mainview/App.tsx')).not.toMatch(/Monero/)
		const dashboard = src('src/mainview/components/Dashboard.tsx')
		expect(dashboard).not.toContain('onOpenMonero')
		expect(dashboard).toContain('moneroChainVisible({ settingEnabled: moneroEnabled, capabilities, isEmulator, watchOnly, bitcoinOnly: btcOnly })')
		expect(dashboard).toContain('<MoneroChainRow chain={moneroChain}')
		expect(dashboard).toContain('onOpen={() => openChainPage(moneroChain)}')
		const page = src('src/mainview/components/AssetPage.tsx')
		expect(page).toContain('? <MoneroSendSection monero={monero} client={rpcMoneroClient} privateMode={privateModeEnabled} />')
		expect(page).toContain(': <MoneroReceiveSection chain={chain} monero={monero}')
	})

	test('Pioneer, REST and audit loops never treat XMR as a Pioneer chain', () => {
		expect(src('src/bun/rest-api.ts')).toContain("c.chainFamily !== 'monero').map(c => c.networkId)")
		expect(src('src/bun/rest-api.ts')).toContain(".filter(c => c.chainFamily !== 'monero')")
		// #700 moved the activity-history chain filter into one shared predicate.
		expect(src('src/bun/history-scan-eligibility.ts')).toContain("chain.chainFamily !== 'monero'")
		expect(src('src/bun/activity-history.ts')).toContain('isHistoryScanChain(chain, firmwareVersion')
		expect(src('src/bun/index.ts')).toContain("if (c.chainFamily === 'monero') return false")
	})

	test('switching Monero off keeps a research emulator selection (the next start names it; see emulator-build-unavailable.test.ts)', () => {
		expect(src('src/bun/index.ts')).not.toContain('if (listEmulatorBuilds().find(build => build.selected)?.research) clearSelectedEmulatorBuild()')
	})

	test('verified read-only adapters ship by default while research libraries require the dev-only flag', async () => {
		expect(src('scripts/build-signed.ts')).toContain("if (process.env.KEEPKEY_INCLUDE_MONERO_EMULATOR === '1') {")
		const fixture = await moneroPackagingFixture()
		for (const research of [false, true]) {
			const result = fixture.run(research)
			if (result.code) throw new Error(result.error)
			expect(result.copy['monero-cli/vendor/darwin-arm64/monero-host-adapter']).toBe('monero-tools/monero-host-adapter')
			expect(result.copy['monero-device-bundle/libmonero_core_verify.dylib']).toBe('monero-device/libmonero_core_verify.dylib')
			expect(result.copy['monero-device-bundle/libmonero_device_proof.dylib']).toBeUndefined()
			for (const [source, destination] of [
				['monero-emulator-bundle/libkkemu-monero.dylib', 'monero-emulator/libkkemu-monero.dylib'],
				['monero-emulator-bundle/libkkemu-monero-signing.dylib', 'monero-emulator/libkkemu-monero-signing.dylib'],
			]) expect(result.copy[source]).toBe(research ? destination : undefined)
		}
	})

	test('neither normal nor research packaging can copy a read-only adapter with a mismatched receipt', async () => {
		const fixture = await moneroPackagingFixture()
		fixture.corruptReceipt()
		for (const research of [false, true]) {
			const result = fixture.run(research)
			expect(result.code).not.toBe(0)
			expect(result.error).toContain('The Monero host adapter does not match its reviewed metadata')
		}
	})

	test('an unqualified architecture excludes a staged ARM verifier', async () => {
		const fixture = await moneroPackagingFixture('x64')
		const result = fixture.run(false)
		expect(result.code).toBe(0)
		expect(result.copy['monero-device-bundle/libmonero_core_verify.dylib']).toBeUndefined()
	})

	test('the form can collect a payment before automatic verification, and signing still confirms on the device', () => {
		const sections = src('src/mainview/components/MoneroAssetSections.tsx')
		expect(sections).toContain('const signingUnavailable = wallet.signingReady !== true')
		expect(sections).toContain('{(wallet.canSend || wallet.sendBlocked === "key-images") && !wallet.unrelayedTxid && !review && (')
		expect(src('src/mainview/lib/monero-client.ts')).toContain('rpcRequest<{ txid: string }>("moneroSend", { prepareId }')
		expect(src('src/bun/index.ts')).toContain('signingEmulator: moneroSigningEmulatorActive')
	})

	test('bitcoin-only firmware refuses every monero RPC but still lets Monero be switched off', () => {
		expect(bitcoinOnlyRpcRejection('moneroPrepareSend', {})).toContain('not available on bitcoin-only firmware')
		expect(bitcoinOnlyRpcRejection('setMoneroEnabled', { enabled: false })).toBeNull()
	})
})
