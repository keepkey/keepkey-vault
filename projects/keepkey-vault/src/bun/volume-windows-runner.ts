import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import broker from './volume-windows-broker.ps1' with { type: 'text' }
import worker from './volume-windows-worker.ps1' with { type: 'text' }
import actions from './volume-windows-actions.ps1' with { type: 'text' }

type Action = 'create' | 'unlock' | 'lock'
type Options = { name?: string; sizeMiB?: number; recordId?: string }
const exec = promisify(execFile)
const volumeName = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _-]{0,63}$/u
const newline = Buffer.from('\n', 'ascii')
const packedSource = gzipSync(worker.replace('__VOLUME_ACTION_FUNCTIONS__', () => actions)).toString('base64')
const digest = createHash('sha256').update(packedSource, 'ascii').digest('hex')
const encodedBroker = Buffer.from(broker.replaceAll('__WORKER_DIGEST__', digest), 'utf16le').toString('base64')

export function validateWindowsVolumeAction(action: Action, path: string, options: Options, password?: Buffer) {
  if (!['create', 'unlock', 'lock'].includes(action) || typeof path !== 'string' ||
      !/^[a-z]:\\/i.test(path) || /[:/\x00-\x1f]/.test(path.slice(2)) || win32.normalize(path) !== path ||
      win32.basename(path) !== 'payload.vhdx') throw new Error('Invalid Windows volume target.')
  const parent = win32.dirname(path)
  const folder = win32.basename(parent)
  const storage = win32.dirname(parent)
  if (win32.basename(storage) !== 'KeepKey Volumes') throw new Error('Invalid Windows volume folder.')
  const name = folder.slice(0, -'.kkvolume'.length)
  if (action === 'create') {
    if (!/^\.creating-[A-Za-z0-9]{6}$/.test(folder) || !options.name || !volumeName.test(options.name) ||
        options.name.trim() !== options.name || !Number.isInteger(options.sizeMiB) ||
        options.sizeMiB! < 128 || options.sizeMiB! > 65536) throw new Error('Invalid Windows volume creation request.')
  } else if (!folder.endsWith('.kkvolume') || !volumeName.test(name) || name.trim() !== name) {
    throw new Error('Invalid Windows volume package.')
  }
  if (action === 'lock') {
    if (password !== undefined) throw new Error('Unexpected lock credential.')
  } else if (!Buffer.isBuffer(password) || password.length !== 64 ||
      !password.every(b => (b >= 48 && b <= 57) || (b >= 97 && b <= 102)) ||
      typeof options.recordId !== 'string' || options.recordId.length !== 32 || !/^[a-f0-9]+$/.test(options.recordId)) {
    throw new Error('Invalid Windows volume recovery record or credential.')
  }
  return { action, path, name: options.name, sizeMiB: options.sizeMiB, recordId: options.recordId }
}

export async function runWindowsVolumeAction(action: Action, path: string, options: Options, password?: Buffer): Promise<void> {
  const request = validateWindowsVolumeAction(action, path, options, password)
  if (process.platform !== 'win32') throw new Error('Windows volume operations require Windows.')
  const system = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const program = win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = exec(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedBroker],
    { cwd: system, windowsHide: true, timeout: 16 * 60_000, maxBuffer: 32768, encoding: 'utf8' })
  child.child.stdin?.on('error', () => { /* Process exit is checked below. */ })
  child.child.stdin?.write(packedSource + '\n')
  // Transport Unicode metadata as ASCII JSON through the system PowerShell console input encoding.
  const json = JSON.stringify(request).replace(/[^\x00-\x7f]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  child.child.stdin?.write(json + '\n')
  if (password) child.child.stdin?.write(password)
  child.child.stdin?.end(newline)
  let status: string
  try { status = (await child).stdout.trim() } catch { status = 'failed' }
  if (status === 'ok') return
  if (status === 'denied') throw new Error('Windows administrator approval was declined or unavailable.')
  if (status === 'account') throw new Error('Approve the Windows volume operation using the same Windows administrator account that launched Vault.')
  if (status === 'invalid') throw new Error('Windows could not verify the volume location or recovery record.')
  if (status === 'timeout') throw new Error('Windows volume operation timed out. Refresh to check its state.')
  throw new Error('Windows could not complete the volume operation. Refresh to check its state.')
}
