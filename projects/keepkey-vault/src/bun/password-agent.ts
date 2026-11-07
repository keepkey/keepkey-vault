import { randomUUID } from 'node:crypto'
import type { PasswordAgentApproval, PasswordRiskKind } from '../shared/password-bank'
import { PASSWORD_SERVICE_HELPERS, passwordServiceHelper } from '../shared/password-services'
import { passwordInventory } from '../shared/password-inventory'
import type { PasswordBank } from './password-bank'
import type { PasswordBex } from './password-bex'

const string = { type: 'string' }, integer = { type: 'integer' }, boolean = { type: 'boolean' }
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } })
export const PASSWORD_AGENT_TOOLS = [
  tool('password_profiles', 'Vault password metadata only: profiles, separate refill/review status, risk provenance and priority. Locked/disabled returns no accounts. Does not scan Chrome or return passwords.', { service: string, account: string, needsRotation: boolean, needsRefill: boolean, limit: integer, offset: integer }),
  tool('password_service_help', 'Fetch one compact, versioned migration helper (google, github, microsoft), or the helper catalog. Password values never appear.', { service: string }),
  tool('password_assign', 'Assign a ready KeepKey-generated slot to an exact login domain/account. This does not set the website password. Native bank must be unlocked.', { origin: string, account: string, reviewDays: integer, expectedRevision: integer }, ['origin', 'account', 'expectedRevision']),
  tool('password_generate', 'Generate a bounded batch on KeepKey; each entry requires physical approval. Uses an existing unlocked bank.', { count: integer, ttlMinutes: integer, expectedRevision: integer }, ['count', 'ttlMinutes', 'expectedRevision']),
  tool('password_rehydrate', 'Reproduce current or staged password into the session cache with device approval, without returning its value.', { id: string, pending: boolean, ttlMinutes: integer, expectedRevision: integer }, ['id', 'ttlMinutes', 'expectedRevision']),
  tool('password_rotation', 'Prepare, mark submitted BEFORE the website change, or cancel an unsubmitted rotation. Activation after fresh sign-in is done in Vault UI.', { id: string, action: { type: 'string', enum: ['prepare', 'submitted', 'cancel'] }, expectedRevision: integer }, ['id', 'action', 'expectedRevision']),
  tool('password_backup_export', 'Export an encrypted manifest, not password values. Prefer the skill CLI save-backup command to write this directly to a file without model output.', {}),
  tool('password_backup_saved', 'Acknowledge a revision only after its encrypted backup was saved. Does not claim the file is independently backed up.', { revision: integer }, ['revision']),
  tool('password_risk_report', 'Record an explicitly user-reported compromised/reused/weak account finding with provenance. Does not scan Chrome or infer that unreported accounts are safe.', { id: string, kind: { type: 'string', enum: ['compromised', 'reused', 'weak'] }, source: { type: 'string', enum: ['user', 'chrome-password-checkup'] }, expectedRevision: integer }, ['id', 'kind', 'source', 'expectedRevision']),
  tool('password_fill_targets', 'Discover exact-origin top-level password fields through BEX; values are not returned. Always name the returned browser/document/ref when requesting a fill.', { id: string }, ['id']),
  tool('password_fill_request', 'Queue a one-use current/staged fill for explicit approval in native Vault. Does not return a password or submit the browser form.', { id: string, pending: boolean, browser: string, tabId: integer, documentToken: string, ref: string, expectedRevision: integer }, ['id', 'browser', 'tabId', 'documentToken', 'ref', 'expectedRevision']),
  tool('password_operation_status', 'Poll a fill approval/result by operation ID. No secret values or approval bypass.', { id: string }, ['id']),
]

type Operation = { id: string; state: 'awaiting-approval' | 'filling' | 'filled' | 'rejected' | 'expired' | 'failed'; expiresAt: number; error?: string }
export class PasswordAgent {
  private operations = new Map<string, Operation>()
  private pending = new Map<string, { approval: PasswordAgentApproval; grant: string; assertCurrent: () => void }>()
  constructor(private bank: PasswordBank, private bex: PasswordBex, private notify: (approval: PasswordAgentApproval | null) => void, private now = Date.now) {}
  get enabled() { return this.bank.enabled }
  private validate(name: string, args: unknown): Record<string, any> {
    const definition = PASSWORD_AGENT_TOOLS.find(t => t.name === name)
    if (!definition) throw new Error('Unknown password operation')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object')
    const a = args as Record<string, any>
    if (Object.keys(a).some(k => !Object.prototype.hasOwnProperty.call(definition.inputSchema.properties, k))) throw new Error('Unexpected argument; do not send password values')
    for (const key of definition.inputSchema.required) if (!(key in a)) throw new Error(`Missing argument: ${key}`)
    for (const [key, value] of Object.entries(a)) {
      const schema = definition.inputSchema.properties[key] as { type: string; enum?: string[] }
      if (schema.type === 'string' && (typeof value !== 'string' || value.length > 500)) throw new Error(`Invalid argument: ${key}`)
      if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`Invalid argument: ${key}`)
      if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid argument: ${key}`)
      if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid argument: ${key}`)
    }
    return a
  }
  private current(revision?: number) {
    const assert = this.bank.capture()
    if (revision !== undefined && revision !== this.bank.view().revision) throw new Error('Password inventory changed. Fetch the latest revision before this operation.')
    return assert
  }
  private inventory() { return passwordInventory(this.bank.view(), this.now()) }
  private prune() {
    let dismissed = false
    for (const [id, op] of this.operations) {
      if (op.expiresAt <= this.now() && op.state === 'awaiting-approval') { op.state = 'expired'; this.pending.delete(id); dismissed = true }
      if (op.expiresAt + 600000 <= this.now()) this.operations.delete(id)
    }
    if (dismissed) this.notify(null)
  }
  cancelPending() {
    for (const id of this.pending.keys()) { const op = this.operations.get(id); if (op) op.state = 'rejected' }
    const hadPending = this.pending.size > 0
    this.pending.clear()
    if (hadPending) this.notify(null)
  }
  async approve(id: string) {
    this.prune()
    const entry = this.pending.get(id), op = this.operations.get(id)
    if (!entry || !op || op.state !== 'awaiting-approval') throw new Error('Password fill request expired or changed')
    this.pending.delete(id)
    this.notify(null)
    op.state = 'filling'
    try { entry.assertCurrent(); await this.bex.fill(entry.grant); op.state = 'filled' }
    catch { op.state = 'failed'; op.error = 'Fill failed or the target changed. Discover fields and review again.' }
    return { ...op }
  }
  reject(id: string) {
    this.prune()
    if (!this.pending.has(id)) throw new Error('No pending password fill')
    this.pending.delete(id)
    const op = this.operations.get(id)!; op.state = 'rejected'
    this.notify(null)
  }
  async invoke(name: string, args: unknown = {}) {
    const a = this.validate(name, args)
    this.prune()
    if (!this.enabled && name !== 'password_profiles') throw new Error('Password manager is disabled. Enable its separate feature flag in Vault settings.')
    if (name === 'password_service_help') {
      if (!a.service) return { helpers: PASSWORD_SERVICE_HELPERS.map(h => ({ id: h.id, name: h.name, version: h.version, loginOrigin: h.loginOrigin })), protocol: '/api/v1/passwords/call', passwordValuesReturned: false }
      const h = passwordServiceHelper(a.service)
      return { ...h, activation: 'Native Vault confirmation after fresh sign-in', chromeCheckup: 'Chrome private APIs are unavailable to ordinary BEX. Report user-visible findings with provenance; never assume unreported means safe.' }
    }
    if (name === 'password_profiles') {
      const inventory = this.inventory()
      const limit = a.limit ?? 25, offset = a.offset ?? 0
      if (limit < 1 || limit > 100 || offset > 4096) throw new Error('Use limit 1–100 and offset 0–4096')
      const matches = inventory.profiles.filter(p => (!a.service || p.service === a.service) && (!a.account || p.account === a.account) && (a.needsRotation === undefined || p.rotation.required === a.needsRotation) && (a.needsRefill === undefined || (p.cache.state === 'needs-rehydration') === a.needsRefill))
      return { ...inventory, profiles: matches.slice(offset, offset + limit).map(({ rank: _rank, ...p }) => p), matched: matches.length, offset, limit }
    }
    const assertCurrent = this.current(a.expectedRevision)
    switch (name) {
      case 'password_assign': this.bank.assign(a.origin, a.account, a.reviewDays ?? 90); break
      case 'password_generate': await this.bank.generate(a.count, a.ttlMinutes); break
      case 'password_rehydrate': await this.bank.rehydrate(a.id, a.pending === true, a.ttlMinutes); break
      case 'password_rotation': this.bank.rotate(a.id, a.action, false); break
      case 'password_risk_report': this.bank.reportRisk(a.id, a.kind as PasswordRiskKind, a.source); break
      case 'password_backup_export': return this.bank.exportBackup()
      case 'password_backup_saved': this.bank.acknowledgeBackup(a.revision); break
      case 'password_fill_targets': return this.bex.discover(a.id)
      case 'password_fill_request': {
        if (this.pending.size || this.operations.size >= 100) throw new Error('Resolve the pending fill request before requesting another')
        const profile = this.bank.view().profiles.find(p => p.id === a.id)
        if (!profile) throw new Error('Password profile not found')
        if (!a.pending && !profile.changedAt) throw new Error('Assigned password is not verified at the website. Use a staged setup flow.')
        const target = this.bex.describe(a as any)
        const { grant } = this.bex.grant(a as any)
        const id = randomUUID(), approval: PasswordAgentApproval = { id, profileId: a.id, account: profile.account, origin: target.origin, browser: a.browser, tabId: a.tabId, fieldLabel: target.fieldLabel, pending: a.pending === true, expiresAt: target.expiresAt }
        const op: Operation = { id, state: 'awaiting-approval', expiresAt: target.expiresAt }
        this.operations.set(id, op); this.pending.set(id, { approval, grant, assertCurrent })
        this.notify(approval)
        return { ...op, nextAction: 'Approve this exact fill in native Vault; then poll password_operation_status.' }
      }
      case 'password_operation_status': {
        const op = this.operations.get(a.id)
        if (!op) throw new Error('Unknown or expired password operation')
        return { ...op }
      }
      default: throw new Error('Unknown password operation')
    }
    return this.inventory()
  }
}

/** No browser CORS, no API audit-body persistence, no remote callers. The REST
 * integration authenticates the bearer token before invoking this function. */
export async function passwordAgentHttp(req: Request, agent: PasswordAgent | undefined): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers })
  if (!agent) return reply({ error: 'This Vault build has no password agent API' }, 503)
  try {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/api/v1/passwords/profiles') {
      const args: Record<string, unknown> = {}
      for (const name of ['service', 'account']) if (url.searchParams.has(name)) args[name] = url.searchParams.get(name)
      return reply(await agent.invoke('password_profiles', args))
    }
    if (req.method !== 'POST' || url.pathname !== '/api/v1/passwords/call') return reply({ error: 'Unknown password API route' }, 404)
    const body = await req.text()
    if (body.length > 16384) return reply({ error: 'Password operation request is too large' }, 413)
    const parsed = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).some(k => !['tool', 'arguments'].includes(k)) || typeof parsed.tool !== 'string') return reply({ error: 'Use {tool, arguments}' }, 400)
    return reply(await agent.invoke(parsed.tool, parsed.arguments ?? {}))
  } catch (error) { return reply({ error: error instanceof Error ? error.message : 'Password operation failed' }, 400) }
}
