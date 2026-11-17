/**
 * Offline audit probes against the existing sibling checkouts.
 * Run from any directory: bun /absolute/path/to/this/probe.ts
 * No network, device, real wallet data, production database, or source mutations.
 * The probes reproduce current weaknesses; they are not future acceptance tests.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createHash, createHmac } from 'node:crypto'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sibling = (name: string, file: string) => resolve(root, '..', name, file)
const read = (path: string) => readFileSync(path, 'utf8')
const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
const results: Record<string, unknown> = {}
const silent = { log() {}, warn() {}, error() {} }

// Execute original storage logic, with its periodic cleanup timer disabled.
const storageSource = read(sibling('keepkey-vault', 'src/lib/pairing/PairingStorage.ts'))
const storageJs = transpiler.transformSync(storageSource.replace('export const pairingStorage', 'const pairingStorage'))
const Storage = new Function('setInterval', 'console', `${storageJs}; return PairingStorageService`)(() => 0, silent)
const storage = new Storage()
const realRandom = Math.random
let created: { code: string }
try {
  Math.random = () => 0
  created = await storage.createPairing('SYNTHETIC-DEVICE', 'Audit fixture', [{ pubkey: 'SYNTHETIC' }], 'https://vault.keepkey.com')
} finally {
  Math.random = realRandom
}
assert.equal(created!.code, 'AAAAAAAA')
assert.ok(await storage.consumePairing(created!.code))
assert.equal(await storage.consumePairing(created!.code), null)
const restartCode = await storage.createPairing('SYNTHETIC-DEVICE', 'Audit fixture', [], 'https://vault.keepkey.com')
assert.equal(await new Storage().consumePairing(restartCode.code), null)
results.relay = {
  codeUsesMathRandom: true,
  controlledRandomProduces: created!.code,
  secondConsumptionReturns: 404,
  newServiceLosesOutstandingCode: true,
  note: 'Controlled PRNG dependency check, not a production token prediction attack. 404 follows the route mapping for null.',
}

// Execute the scanner's original URL normalization with synthetic QR payloads.
const scanner = read(sibling('keepkey-mobile-expo', 'src/screens/QRScannerScreen.js'))
const start = scanner.indexOf('let baseUrl = pairingPayload.url;')
const end = scanner.indexOf('// Fetch wallet data from vault using pairing code', start)
assert.ok(start >= 0 && end > start)
const normalize = new Function('pairingPayload', 'console', scanner.slice(start, end) + '\nreturn baseUrl;')
assert.equal(normalize({ url: 'https://attacker.invalid' }, silent), 'https://attacker.invalid')
assert.equal(normalize({ url: 'http://192.0.2.1' }, silent), 'http://192.0.2.1')
results.scanner = { arbitraryHttpsOriginAccepted: true, explicitHttpAcceptedByJs: true, note: 'OS transport policy can still reject HTTP.' }

// Execute the exact injected script in a synthetic foreign-origin JS context.
const webview = read(sibling('keepkey-mobile-expo', 'src/screens/VaultWebViewScreen.js'))
const template = webview.match(/const injectedJavaScript = (`[\s\S]*?`);/)
assert.ok(template)
const fixturePubkeys = [{ pubkey: 'SYNTHETIC-XPUB', networks: ['bip122:fixture'] }]
const fixtureDevice = { label: 'Audit fixture', deviceId: 'SYNTHETIC-DEVICE' }
const script = new Function('pubkeys', 'deviceInfo', `return ${template![1]}`)(fixturePubkeys, fixtureDevice)
const local = new Map<string, string>()
const context = {
  console: silent,
  location: { origin: 'https://attacker.invalid' },
  localStorage: { setItem: (key: string, value: string) => local.set(key, value) },
  window: { dispatchEvent() {} },
  CustomEvent: class { constructor(..._args: unknown[]) {} },
}
runInNewContext(script, context)
assert.equal(JSON.parse(local.get('keepkey_vault_pubkeys')!).pubkeys[0].pubkey, 'SYNTHETIC-XPUB')
assert.ok(!webview.includes('onShouldStartLoadWithRequest='))
assert.ok(!webview.includes('originWhitelist='))
const cleanup = webview.slice(webview.indexOf('const handleUnpair'), webview.indexOf('const vaultUrl'))
assert.ok(!/localStorage|clearCache|clearAll|clearCookies|clearWebsiteData/.test(cleanup))
results.webview = {
  injectedScriptWritesAtForeignOrigin: true,
  explicitNavigationGuardPresent: false,
  unpairDoesNotClearWebStorageInHandler: true,
  note: 'JS harness proves the missing script guard; physical iOS/Android navigation and persistence need device reproduction.',
}

// Run original prototype authentication logic. Mock DB uses synthetic records;
// CBOR is stubbed to throw because authentication does not encode any CBOR.
const prototype = read(sibling('keepkey-vault-v11-passkey', 'projects/keepkey-vault/src/bun/passkey.ts'))
const stripped = prototype.replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '').replace('export class PasskeyStore', 'class PasskeyStore')
assert.ok(!/^import\b/m.test(stripped))
const db = new Map<string, string>()
const credentials = new Map<string, any>()
const challenges = new Map<string, any>()
const mocks = {
  getSetting: (key: string) => db.get(key) || null,
  setSetting: (key: string, value: string) => db.set(key, value),
  getPasskey: (key: string) => credentials.get(key),
  getPasskeysByRpId: (rpId: string) => [...credentials.values()].filter(c => c.rpId === rpId),
  getAndDeleteChallenge: (key: string) => { const value = challenges.get(key); challenges.delete(key); return value },
  updatePasskeyCounter: (key: string, counter: number) => { credentials.get(key).counter = counter },
  savePasskey() {}, dbListPasskeys() {}, dbDeletePasskey() {}, saveChallenge() {}, pruneExpiredChallenges() {},
  cborEncode() { throw new Error('Unexpected CBOR use') },
  setInterval() { return 0 }, console: silent,
}
const PasskeyStore = new Function(...Object.keys(mocks), `${transpiler.transformSync(stripped)}; return PasskeyStore`)(...Object.values(mocks))
const store = new PasskeyStore()
const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
const encrypted = await store.encryptKey(pkcs8)
const credentialId = 'SYNTHETIC-CREDENTIAL'
credentials.set(credentialId, {
  rpId: 'example.invalid', userId: 'SYNTHETIC-USER', counter: 0,
  encryptedPrivateKey: Buffer.from(encrypted.ciphertext).toString('base64url'),
  iv: Buffer.from(encrypted.iv).toString('base64url'),
})
challenges.set('SYNTHETIC-CHALLENGE', { type: 'authenticate', rpId: 'example.invalid', challenge: 'SYNTHETIC' })
const authentication = await store.completeAuthentication('SYNTHETIC-CHALLENGE', credentialId)
const authData = Buffer.from(authentication.authenticatorData, 'base64url')
const signature = Buffer.from(authentication.signature, 'base64url')
assert.ok(authData[32] & 0x04)
assert.equal(signature.length, 64)
const leakedKek = await crypto.subtle.importKey('raw', Buffer.from(db.get('passkey_kek')!, 'base64'), 'AES-GCM', false, ['decrypt'])
const recovered = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: encrypted.iv }, leakedKek, encrypted.ciphertext)
assert.deepEqual(new Uint8Array(recovered), new Uint8Array(pkcs8))
results.desktopPrototype = {
  dbKekDecryptsCredential: true,
  uvFlagSetWithoutPinOrBiometricsInEngine: true,
  signatureBytes: signature.length,
  signatureEncoding: 'raw P-256 r||s rather than WebAuthn ES256 DER',
  syntheticClientOrigin: JSON.parse(Buffer.from(authentication.clientDataJSON, 'base64url').toString()).origin,
  note: 'UI approval is outside the engine. This does not claim a callback bypass in the running app.',
}

// Run the actual BEX snapshot function against a synthetic visible password
// input. DOM discovery/visibility are mocked; snapshot's value handling is not.
const agentDom = read(sibling('keepkey-client', 'pages/content/src/agentDom.ts'))
const snapshotSource = agentDom.slice(agentDom.indexOf('function snapshot()'), agentDom.indexOf('function resolve('))
assert.ok(snapshotSource.startsWith('function snapshot()'))
const fixtureInput = { value: 'SYNTHETIC-PASSWORD', type: 'password', matches: () => false, getAttribute: () => null }
const deps = {
  deepQuery: () => [fixtureInput], isVisible: () => true,
  roleOf: () => 'textbox', nameOf: () => 'Password', clip: (s: string) => s,
  isDisabled: () => false, refs: new Map(), document: {},
  location: { href: 'https://example.invalid/login' },
}
const snapshot = new Function(...Object.keys(deps), transpiler.transformSync(`let refSeq = 0; const INTERACTIVE = ''; const CONTEXT = ''; ${snapshotSource}; return snapshot`))(...Object.values(deps))
assert.equal(snapshot().nodes[0].value, 'SYNTHETIC-PASSWORD')
assert.ok(agentDom.includes("await showThen('typing', el, String(msg.text ?? '').slice(0, 40))"))
results.bex = {
  passwordValueReturnedInSnapshot: true,
  typedTextPassedToOverlayAndPanelLog: true,
  note: 'Original snapshot logic with mocked element discovery. No actual browser or real password used.',
}

// Published BIP85 Base64 password vector, entirely software and public input.
// This verifies the proposed derivation format, not firmware support.
const { HDKey } = await import(Bun.resolveSync('@scure/bip32', resolve(root, 'projects/keepkey-vault')))
const publicTestXprv = 'xprv9s21ZrQH143K2LBWUUQRFXhucrQqBpKdRRxNVq2zBqsx8HVqFk2uYo8kmbaLLHRdqtQpUm98uKfu3vca1LqdGhUtyoFnCNkfmXRyPXLjbKb'
const child = HDKey.fromExtendedKey(publicTestXprv).derive("m/83696968'/707764'/21'/0'")
const entropy = createHmac('sha512', 'bip-entropy-from-k').update(child.privateKey).digest()
assert.equal(entropy.toString('base64').slice(0, 21), 'dKLoepugzdVJvdL56ogNV')
results.passwordBank = { publishedBip85PasswordVectorMatches: true, firmwarePasswordCommandImplemented: false }

results.sourceSha256 = Object.fromEntries([
  ['relay', storageSource], ['scanner', scanner], ['webview', webview],
  ['desktopPrototype', prototype], ['bexAgentDom', agentDom],
].map(([name, source]) => [name, createHash('sha256').update(source).digest('hex')]))

process.stdout.write(JSON.stringify(results, null, 2) + '\n')
