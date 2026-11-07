import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { PasswordBank, PASSWORD_BANK_FLAG } from '../src/bun/password-bank'
import { PasswordBex } from '../src/bun/password-bex'
import { PasswordAgent, passwordAgentHttp } from '../src/bun/password-agent'
import { passwordInventory } from '../src/shared/password-inventory'
import { handleMcpRequest } from '../src/bun/mcp'

function fixture() {
  const db = new Map<string, string>([['monero_enabled', '1']])
  let now = 1_000_000, deviceCalls = 0, fills = 0
  const approvals: unknown[] = []
  const bank = new PasswordBank({ read: k => db.get(k) ?? null, write: (k,v) => { db.set(k,v) }, now: () => now,
    device: () => ({ session: 'test', cipher: async (path, label) => {
      deviceCalls++; return new Uint8Array(createHmac('sha256', 'public test seed').update(JSON.stringify(path)).update(label).digest())
    } }) })
  const bex = new PasswordBex(bank, { browsers: () => [{ browser: 'b-test' }], call: async (tool, args: any) => {
    if (tool === 'bex_tabs') return { tabs: [{ tabId: 1, url: 'https://accounts.google.com/', title: 'Sign in' }] }
    if (tool === '__vault_password_targets_v1') return { origin: args.origin, documentToken: 'document', targets: [{ ref: 'p1', label: 'Password' }] }
    fills++; return { filled: true, submitted: false }
  } }, () => now)
  const agent = new PasswordAgent(bank, bex, a => approvals.push(a), () => now)
  return { db, bank, agent, approvals, advance: (ms: number) => { now += ms }, fills: () => fills, deviceCalls: () => deviceCalls }
}
async function ready() {
  const f = fixture(); f.bank.setEnabled(true); await f.bank.unlock(true); await f.bank.generate(3, 5)
  const id = f.bank.assign('accounts.google.com', 'test@example.com', 30).profiles[0].id
  return { ...f, id }
}
function staged(f: Awaited<ReturnType<typeof ready>>) {
  f.bank.rotate(f.id, 'prepare', false)
  f.bank.acknowledgeBackup(f.bank.exportBackup().revision)
  f.bank.rotate(f.id, 'submitted', false)
}
async function requestFill(f: Awaited<ReturnType<typeof ready>>) {
  await f.agent.invoke('password_fill_targets', { id: f.id })
  return f.agent.invoke('password_fill_request', { id: f.id, pending: true, browser: 'b-test', tabId: 1, documentToken: 'document', ref: 'p1', expectedRevision: f.bank.view().revision }) as Promise<{ id: string; state: string }>
}

describe('separate default-off password feature and agent boundary', () => {
  test('Monero enabled never enables passwords; switching passwords never changes Monero', async () => {
    const f = fixture()
    expect(f.db.get('monero_enabled')).toBe('1')
    expect(f.db.has(PASSWORD_BANK_FLAG)).toBe(false)
    expect(f.bank.enabled).toBe(false)
    expect((await f.agent.invoke('password_profiles') as any).visibility).toBe('disabled')
    await expect(f.agent.invoke('password_service_help')).rejects.toThrow('separate feature flag')
    await expect(f.agent.invoke('password_generate', { count: 1, ttlMinutes: 5, expectedRevision: 0 })).rejects.toThrow('disabled')
    expect(f.deviceCalls()).toBe(0)
    f.bank.setEnabled(true); expect(f.bank.enabled).toBe(true)
    f.bank.setEnabled(false); expect(f.bank.enabled).toBe(false)
    expect(f.db.get('monero_enabled')).toBe('1')
  })
  test('disabled and locked inventories disclose no accounts', async () => {
    const f = await ready(); f.bank.lock()
    expect((await f.agent.invoke('password_profiles') as any).profiles).toEqual([])
    f.bank.setEnabled(false)
    expect(JSON.stringify(await f.agent.invoke('password_profiles'))).not.toContain('test@example.com')
  })
  test('metadata is explicitly whitelisted; refill is independent from rotation', async () => {
    const f = await ready(); staged(f); f.bank.rotate(f.id, 'verify', true)
    const secret = f.bank.reveal(f.id).password
    const view = f.bank.view(); Object.assign(view.profiles[0], { password: secret, privateKey: 'never-export' })
    const inv = passwordInventory(view, 1_000_000)
    expect(JSON.stringify(inv)).not.toContain(secret)
    expect(JSON.stringify(inv)).not.toContain('privateKey')
    f.advance(5 * 60000)
    const result: any = await f.agent.invoke('password_profiles')
    expect(result.profiles[0].cache.state).toBe('needs-rehydration')
    expect(result.profiles[0].rotation.required).toBe(false)
    expect(result.profiles[0].risk.status).toBe('not-assessed')
    expect(result.chromeCheckup.automaticallyScanned).toBe(false)
  })
  test('reported compromised accounts take priority and resolve only after verified rotation', async () => {
    const f = await ready()
    f.bank.assign('github.com', 'second', 30)
    f.bank.reportRisk(f.id, 'compromised', 'chrome-password-checkup')
    let result: any = await f.agent.invoke('password_profiles')
    expect(result.profiles[0].id).toBe(f.id)
    expect(result.profiles[0].risk.findings[0].mode).toBe('user-reported')
    staged(f)
    expect((await f.agent.invoke('password_profiles') as any).profiles[0].rotation.state).toBe('verification-needed')
    f.bank.rotate(f.id, 'verify', true)
    result = await f.agent.invoke('password_profiles')
    expect(result.profiles.find((p: any) => p.id === f.id).risk.status).toBe('not-assessed')
    expect(f.bank.view().profiles[0].riskFindings![0].resolvedAt).toBeDefined()
  })
  test('mutations require current revision and reject secret arguments or remote activation', async () => {
    const f = await ready()
    await expect(f.agent.invoke('password_assign', { origin: 'github.com', account: 'a', expectedRevision: 0 })).rejects.toThrow('revision')
    await expect(f.agent.invoke('password_profiles', { password: 'no' })).rejects.toThrow('Unexpected argument')
    await expect(f.agent.invoke('password_rotation', { id: f.id, action: 'verify', expectedRevision: f.bank.view().revision })).rejects.toThrow('Invalid argument')
    await expect(f.agent.invoke('password_reveal', { id: f.id })).rejects.toThrow('Unknown')
  })
  test('agent fill waits for one-use native approval and returns no password', async () => {
    const f = await ready(); staged(f)
    const op = await requestFill(f)
    expect(op.state).toBe('awaiting-approval'); expect(f.fills()).toBe(0)
    expect(f.approvals).toHaveLength(1)
    const result = await f.agent.approve(op.id)
    expect(result.state).toBe('filled'); expect(f.fills()).toBe(1)
    expect(JSON.stringify(result)).not.toContain(f.bank.reveal(f.id, true).password)
    await expect(f.agent.approve(op.id)).rejects.toThrow('expired or changed')
  })
  test('expired, rejected, or disabled requests cannot fill', async () => {
    for (const action of ['expire', 'reject', 'disable']) {
      const f = await ready(); staged(f); const op = await requestFill(f)
      if (action === 'expire') f.advance(30001)
      if (action === 'reject') f.agent.reject(op.id)
      if (action === 'disable') f.bank.setEnabled(false)
      if (action === 'disable') expect((await f.agent.approve(op.id)).state).toBe('failed')
      else await expect(f.agent.approve(op.id)).rejects.toThrow()
      expect(f.fills()).toBe(0)
    }
  })
  test('HTTP endpoint returns only metadata with no-store and no browser CORS', async () => {
    const f = fixture()
    const res = await passwordAgentHttp(new Request('http://localhost/api/v1/passwords/profiles'), f.agent)
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.has('access-control-allow-origin')).toBe(false)
    expect((await res.json() as any).visibility).toBe('disabled')
  })
  test('MCP catalog changes live with password flag and private fill remains inaccessible', async () => {
    const f = fixture()
    const rpc = async (method: string, params = {}) => (await handleMcpRequest(new Request('http://localhost/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), {}, f.agent)).json() as Promise<any>
    expect((await rpc('tools/list')).result.tools.some((t: any) => t.name.startsWith('password_'))).toBe(false)
    f.bank.setEnabled(true)
    expect((await rpc('tools/list')).result.tools.some((t: any) => t.name === 'password_profiles')).toBe(true)
    f.bank.setEnabled(false)
    expect((await rpc('tools/list')).result.tools.some((t: any) => t.name.startsWith('password_'))).toBe(false)
    expect((await rpc('tools/call', { name: '__vault_password_fill_v1', arguments: {} })).error.code).toBe(-32601)
  })
})
