/** Standalone synthetic UI smoke fixture. Run with Bun; never loads app DB. */
import { createHmac } from 'node:crypto'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { PasswordBank } from '../../../src/bun/password-bank'
const db = new Map<string, string>()
const bank = new PasswordBank({ read: k => db.get(k) || null, write: (k, v) => { db.set(k, v) }, device: () => ({ session: 'synthetic-device', cipher: async (p, l) => new Uint8Array(createHmac('sha256', 'PUBLIC UI TEST FIXTURE ONLY').update(JSON.stringify(p)).update(l).digest()) }) })
const settings = () => ({ passwordManagerEnabled: bank.enabled, restApiEnabled: false, btcMultisigEnabled: false, walletConnectEnabled: false, zcashPrivacyEnabled: false, hiveEnabled: false, emulatorEnabled: false, offlineMode: false, pioneerApiBase: '', pioneerServers: [], activePioneerServer: '', fiatCurrency: 'USD', numberLocale: 'en-US', disabledNetworks: [], evmSimulationRpcUrls: {}, appLanguage: 'en' })
const rpc = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const { method, params: p } = await req.json()
  try {
    let payload: unknown = {}
    switch (method) {
      case 'testReset': bank.lock(); db.clear(); payload = settings(); break
      case 'getAppSettings': payload = settings(); break
      case 'setPasswordManagerEnabled': bank.setEnabled(p.enabled); payload = settings(); break
      case 'passwordBankStatus': payload = bank.view(); break
      case 'passwordBankUnlock': payload = await bank.unlock(p?.create); break
      case 'passwordBankLock': bank.lock(); payload = bank.view(); break
      case 'passwordBankGenerate': payload = await bank.generate(p.count, p.ttlMinutes); break
      case 'passwordBankAssign': payload = bank.assign(p.origin, p.account, p.reviewDays); break
      case 'passwordBankReveal': payload = bank.reveal(p.id, p.pending); break
      case 'passwordBankRehydrate': payload = await bank.rehydrate(p.id, p.pending, p.ttlMinutes); break
      case 'passwordBankRotate': payload = bank.rotate(p.id, p.action, p.confirmed); break
      case 'passwordBankExport': payload = bank.exportBackup(); break
      case 'passwordBankBackupSaved': payload = bank.acknowledgeBackup(p.revision); break
      case 'passwordBankImport': payload = await bank.unlock(false, p.json); break
      case 'passwordBankBrowserTargets': payload = []; break
      case 'getFeatures': payload = { label: 'Synthetic test KeepKey', policiesList: [] }; break
      case 'listRegisteredDevices': case 'listEmulatorWallets': case 'getPairedApps': case 'getPioneerServers': payload = []; break
    }
    return Response.json({ success: true, payload })
  } catch (e: any) { return Response.json({ success: false, error: e.message }) }
} })
const vite = await createServer({ configFile: false, plugins: [react()], root: import.meta.dir, server: { host: '127.0.0.1', port: 5198, strictPort: true, fs: { allow: [new URL('../../../..', import.meta.url).pathname] }, proxy: { '/__test_rpc': `http://127.0.0.1:${rpc.port}` } } })
await vite.listen()
console.log('Password MVP synthetic UI fixture: http://127.0.0.1:5198')
