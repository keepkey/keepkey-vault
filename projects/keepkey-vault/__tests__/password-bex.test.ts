import { expect, test } from 'bun:test'
import { PasswordBank } from '../src/bun/password-bank'
import { PasswordBex } from '../src/bun/password-bex'
import { createHmac } from 'node:crypto'

async function setup() {
  const db = new Map<string, string>()
  let now = 1000000
  const bank = new PasswordBank({ read: k => db.get(k) || null, write: (k, v) => { db.set(k, v) }, now: () => now, device: () => ({ session: 'wallet1', cipher: async (p, l) => new Uint8Array(createHmac('sha256', 'test').update(JSON.stringify(p)).update(l).digest()) }) })
  bank.setEnabled(true); await bank.unlock(true); await bank.generate(2, 5)
  const id = bank.assign('accounts.google.com', 'test@example.com', 90).profiles[0].id
  const calls: { tool: string; args: any; browser: string }[] = []
  const bridge = { browsers: () => [{ browser: 'browser1' }], call: async (tool: string, args: any, browser: string) => {
    calls.push({ tool, args, browser })
    if (tool === 'bex_tabs') return { tabs: [{ tabId: 3, url: 'https://accounts.google.com/login', title: 'Google' }, { tabId: 4, url: 'https://accounts.google.com.evil.invalid/login', title: 'Fake' }] }
    if (tool === '__vault_password_targets_v1') return { documentToken: 'document1', origin: args.origin, targets: [{ ref: 'field1', label: 'current-password' }] }
    return { filled: true, submitted: false }
  } }
  const bex = new PasswordBex(bank, bridge, () => now)
  const input = { id, browser: 'browser1', tabId: 3, documentToken: 'document1', ref: 'field1' }
  return { bank, id, bex, calls, input, advance: () => { now += 31000 } }
}
test('BEX discovery ignores lookalike origins and returns no password', async () => {
  const f = await setup(), targets = await f.bex.discover(f.id)
  expect(targets).toHaveLength(1)
  expect(targets[0].origin).toBe('https://accounts.google.com')
  expect(JSON.stringify(targets)).not.toContain(f.bank.reveal(f.id).password)
  expect(f.calls.filter(c => c.tool === '__vault_password_targets_v1')).toHaveLength(1)
})
test('fill is UI-approved, browser/document-bound, one-use and never submits', async () => {
  const f = await setup()
  await f.bex.discover(f.id)
  expect(() => f.bex.grant({ ...f.input, browser: 'wrong browser' })).toThrow('Review')
  expect(() => f.bex.grant({ ...f.input, documentToken: 'old document' })).toThrow('Review')
  const { grant } = f.bex.grant(f.input)
  expect(await f.bex.fill(grant)).toEqual({ filled: true, submitted: false })
  const sent = f.calls.find(c => c.tool === '__vault_password_fill_v1')!
  expect(sent.browser).toBe('browser1')
  expect(sent.args.origin).toBe('https://accounts.google.com')
  expect(sent.args.documentToken).toBe('document1')
  expect(sent.args.password).toBe(f.bank.reveal(f.id).password)
  await expect(f.bex.fill(grant)).rejects.toThrow('already used')
})
test('feature disable invalidates an already issued fill grant', async () => {
  const f = await setup(); await f.bex.discover(f.id)
  const { grant } = f.bex.grant(f.input)
  f.bank.setEnabled(false); f.bank.setEnabled(true)
  await expect(f.bex.fill(grant)).rejects.toThrow()
  expect(f.calls.some(c => c.tool === '__vault_password_fill_v1')).toBe(false)
})
test('expired grant cannot send a password', async () => {
  const f = await setup(); await f.bex.discover(f.id)
  const { grant } = f.bex.grant(f.input)
  f.advance()
  await expect(f.bex.fill(grant)).rejects.toThrow('expired')
})
test('staged password fill requires a backed-up, begun website change', async () => {
  const f = await setup(); f.bank.rotate(f.id, 'prepare', false)
  await f.bex.discover(f.id)
  expect(() => f.bex.grant({ ...f.input, pending: true })).toThrow('recovery backup')
  const backup = f.bank.exportBackup(); f.bank.acknowledgeBackup(backup.revision)
  f.bank.rotate(f.id, 'submitted', false)
  const { grant } = f.bex.grant({ ...f.input, pending: true })
  await f.bex.fill(grant)
  expect(f.calls.find(c => c.tool === '__vault_password_fill_v1')!.args.password).toBe(f.bank.reveal(f.id, true).password)
})
test('an active-password grant is invalid after the profile rotates to a different slot', async () => {
  const f = await setup(); await f.bex.discover(f.id)
  const { grant } = f.bex.grant(f.input)
  f.bank.rotate(f.id, 'prepare', false)
  const backup = f.bank.exportBackup(); f.bank.acknowledgeBackup(backup.revision)
  f.bank.rotate(f.id, 'submitted', false); f.bank.rotate(f.id, 'verify', true)
  await expect(f.bex.fill(grant)).rejects.toThrow('profile changed')
  expect(f.calls.some(c => c.tool === '__vault_password_fill_v1')).toBe(false)
})
