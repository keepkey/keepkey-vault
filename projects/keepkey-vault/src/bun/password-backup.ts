import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Acknowledge only after an exclusive, owner-only export and its directory are durable. */
export function savePasswordBackup(bank: {
  exportBackup(): { json: string; revision: number }
  acknowledgeBackup(revision: number): unknown
}, directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Password backup folder must be private to your user')
  }
  const { json, revision } = bank.exportBackup()
  const filePath = join(directory, `keepkey-passwords-r${revision}-${randomUUID()}.json`)
  const file = openSync(filePath, 'wx', 0o600)
  try { writeFileSync(file, json, 'utf8'); fsyncSync(file) } finally { closeSync(file) }
  const dir = openSync(directory, 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
  bank.acknowledgeBackup(revision)
  return { filePath, revision }
}
