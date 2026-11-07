/** Local migration operator. It never requests or prints a password value. */
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const [command, first, second] = process.argv.slice(2)
const base = new URL(process.env.KEEPKEY_PASSWORD_AGENT_URL || 'http://127.0.0.1:1646')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/') throw new Error('Use a loopback-only Vault URL')
const tokenFile = process.env.KEEPKEY_PASSWORD_AGENT_TOKEN_FILE || resolve(import.meta.dir, '../../../artifacts/password-migration-agent/token.json')
const output = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
function saveExclusive(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'wx', 0o600)
  try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  chmodSync(file, 0o600)
}
async function request(path: string, body?: unknown, paired = true) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (paired) {
    const token = process.env.KEEPKEY_API_KEY || JSON.parse(readFileSync(tokenFile, 'utf8')).apiKey
    if (typeof token !== 'string' || !token) throw new Error('Pair this operator with Vault first')
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(600000) })
  const result = await response.json() as any
  if (!response.ok || result.error) throw new Error(result.error || `Vault returned HTTP ${response.status}`)
  return result
}
const call = (tool: string, args: unknown = {}) => request('/api/v1/passwords/call', { tool, arguments: args })

try {
  if (command === 'pair') {
    const result = await request('/auth/pair', { name: 'KeepKey Password Migration Assistant', url: 'http://localhost', imageUrl: '', clientId: 'keepkey-password-migration-assistant-v1' }, false)
    if (typeof result.apiKey !== 'string' || !result.apiKey) throw new Error('Pairing returned no token')
    saveExclusive(tokenFile, JSON.stringify({ apiKey: result.apiKey }) + '\n')
    output({ paired: true, tokenFile, tokenPrinted: false })
  } else if (command === 'profiles') {
    output(await call('password_profiles', first ? { service: first, ...(second ? { account: second } : {}) } : {}))
  } else if (command === 'helper') {
    output(await call('password_service_help', first ? { service: first } : {}))
  } else if (command === 'call') {
    if (!first?.startsWith('password_') || first === 'password_backup_export') throw new Error('Use a public password tool; use save-backup for exports')
    output(await call(first, second ? JSON.parse(second) : {}))
  } else if (command === 'save-backup') {
    if (!first) throw new Error('Provide a new encrypted backup filename')
    const backup = await call('password_backup_export')
    if (typeof backup.json !== 'string' || !Number.isSafeInteger(backup.revision)) throw new Error('Invalid backup response')
    const file = resolve(first)
    saveExclusive(file, backup.json + '\n')
    // Do not claim a backup was saved until its write and fsync succeeded.
    const state = await call('password_backup_saved', { revision: backup.revision })
    output({ file, revision: backup.revision, backupRequired: state.backupRequired, passwordValuesPrinted: false, reminder: 'Keep an independent copy of this encrypted recovery manifest.' })
  } else if (command === 'browser-call') {
    if (!first?.startsWith('bex_')) throw new Error('Use a BEX browser tool')
    const result = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: first, arguments: second ? JSON.parse(second) : {} } })
    if (result.result?.isError) throw new Error(result.result.content?.[0]?.text || 'Browser tool failed')
    output(result.result)
  } else {
    output({ commands: ['pair', 'profiles [service] [exact account]', 'helper [google|github|microsoft]', 'call password_TOOL JSON', 'save-backup NEW_FILE', 'browser-call bex_TOOL JSON'], tokenFile, secretsReturned: false })
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : 'Migration command failed', passwordValuesPrinted: false }) + '\n')
  process.exitCode = 1
}
