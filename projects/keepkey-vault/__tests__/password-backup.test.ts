import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { savePasswordBackup } from '../src/bun/password-backup'
const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
function root() { const p = mkdtempSync(join(tmpdir(), 'password-backup-')); roots.push(p); return p }
test('writes an exclusive owner-only backup before acknowledging and keeps earlier revisions', () => {
 const directory = join(root(), 'backups'); let calls = 0
 const bank = { exportBackup: () => ({ json: '{"ciphertext":"encrypted fixture"}', revision: 7 }), acknowledgeBackup: (r: number) => { expect(r).toBe(7); calls++ } }
 const a = savePasswordBackup(bank, directory), b = savePasswordBackup(bank, directory)
 expect(a.filePath).not.toBe(b.filePath); expect(calls).toBe(2)
 expect(statSync(directory).mode & 0o777).toBe(0o700)
 expect(statSync(a.filePath).mode & 0o777).toBe(0o600)
 expect(readFileSync(a.filePath, 'utf8')).toBe(bank.exportBackup().json)
})
test('unsafe folder and failed export never acknowledge', () => {
 const directory = root(); chmodSync(directory, 0o755); let ack = false
 const bank = { exportBackup: () => { throw new Error('locked') }, acknowledgeBackup: () => { ack = true } }
 expect(() => savePasswordBackup(bank, directory)).toThrow('private')
 chmodSync(directory, 0o700)
 expect(() => savePasswordBackup(bank, directory)).toThrow('locked'); expect(ack).toBe(false)
})
test('refuses a symlink destination and preserves a saved export if the revision becomes stale', () => {
 const base = root(); symlinkSync(base, join(base, 'link'))
 const bank = { exportBackup: () => ({ json: 'encrypted', revision: 1 }), acknowledgeBackup: () => { throw new Error('changed') } }
 expect(() => savePasswordBackup(bank, join(base, 'link'))).toThrow('private')
 expect(() => savePasswordBackup(bank, join(base, 'safe'))).toThrow('changed')
})
