/** Vault owns only the daemon identified by its unique config path, binary and data directory.
 * RPC is restricted and bound to loopback. No wallet, seed or spending key is involved. */
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, lstatSync, realpathSync } from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { ARCHIVE_HASHES } from '../../monero-cli/src/tools'
import { MONERO_VERSION } from '../../monero-cli/src/protocol'
import { MONERO_NODE_ESTIMATE_BYTES, MONERO_NODE_RESERVE_BYTES, moneroNodeProgress, type MoneroNodeStatus } from '../shared/monero-node'

interface SavedNode { dataDir: string; device?: number; pid?: number; command?: string[]; configPath?: string; stopping?: boolean; error?: string }
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e: any) { return e.code === 'EPERM' } }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function verifiedMonerod(): Promise<string> {
  const platform = `${process.platform}-${process.arch}`, name = process.platform === 'win32' ? 'monerod.exe' : 'monerod'
  const candidates = process.env.MONERO_TOOLS_DIR ? [resolve(process.env.MONERO_TOOLS_DIR)] : [
    join(resolve(import.meta.dir, '..'), 'monero-tools'), join(dirname(process.execPath), 'monero-tools'),
    resolve(import.meta.dir, '../../monero-cli/vendor', platform), resolve(process.cwd(), 'monero-cli/vendor', platform),
  ]
  for (const directory of candidates) {
    try {
      const meta = JSON.parse(await asyncFs.readFile(join(directory, 'monero-tools.json'), 'utf8'))
      const binary = join(directory, name), file = await asyncFs.lstat(binary)
      if (meta.version !== MONERO_VERSION || meta.platform !== platform || meta.archiveSha256 !== ARCHIVE_HASHES[platform]
          || meta.signerFingerprint !== '81AC591FE9C4B65C5806AFC3F0AF4D462A0BDF92'
          || !/^[a-f0-9]{64}$/.test(meta.daemonSha256 ?? '') || !file.isFile() || file.isSymbolicLink()
          || file.size > 256 * 1024 ** 2 || (process.platform !== 'win32' && (file.mode & 0o022))) continue
      if (createHash('sha256').update(new Uint8Array(await asyncFs.readFile(binary))).digest('hex') === meta.daemonSha256) return binary
    } catch { /* Only signed-release preparation outputs are accepted. */ }
  }
  throw new Error('This build does not include the verified Monero node. Use a build with local node support.')
}

const runFile = promisify(execFile)
async function pathExists(path: string) { try { await asyncFs.stat(path); return true } catch (error: any) { if (error.code === 'ENOENT') return false; throw error } }
async function diskUsage(path: string): Promise<number> {
  if (!await pathExists(path)) return 0
  let bytes = 0, count = 0
  const visit = async (directory: string) => {
    for (const entry of await asyncFs.readdir(directory, { withFileTypes: true })) {
      if (++count > 10000) throw new Error('Choose a dedicated Monero node folder')
      const p = join(directory, entry.name), stat = await asyncFs.lstat(p)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) await visit(p)
      else bytes += stat.blocks === undefined ? stat.size : stat.blocks * 512
    }
  }
  await visit(path); return bytes
}

/** Check the mounted volume before creating directories; never create a fallback on the system disk. */
async function storage(path: string, expectedDevice?: number) {
  if (!isAbsolute(path) || path.includes('\0') || path.length > 2048 || path === parse(path).root) throw new Error('Choose an absolute folder path for the Monero blockchain')
  if (process.platform === 'darwin' && path.startsWith('/Volumes/')) {
    const mount = '/' + path.split('/').slice(1, 3).join('/')
    if (!await pathExists(mount) || (await asyncFs.stat(mount)).dev === (await asyncFs.stat('/')).dev) throw new Error('The selected storage drive is not mounted')
  }
  let existing = path
  while (!await pathExists(existing)) existing = dirname(existing)
  const device = (await asyncFs.stat(existing)).dev
  if (expectedDevice !== undefined && device !== expectedDevice) throw new Error('The storage drive changed. Choose the node folder again.')
  const fs = await asyncFs.statfs(existing)
  return { freeBytes: Number(fs.bavail) * Number(fs.bsize), device }
}

export function createMoneroNodeManager(options: { stateFile: string; binary?: () => Promise<string>; disk?: (path: string, expectedDevice?: number) => ReturnType<typeof storage> | Awaited<ReturnType<typeof storage>>;
  reserveBytes?: number; estimatedBytes?: number; port?: number; pollMs?: number; stopWaitMs?: number;
  processCommand?: (pid: number) => string } ) {
  const port = options.port ?? 18081, rpcUrl = `http://127.0.0.1:${port}`
  const reserveBytes = options.reserveBytes ?? MONERO_NODE_RESERVE_BYTES, estimatedBytes = options.estimatedBytes ?? MONERO_NODE_ESTIMATE_BYTES
  let saved: SavedNode = { dataDir: join(homedir(), '.keepkey', 'monero', 'mainnet') }
  try { saved = JSON.parse(readFileSync(options.stateFile, 'utf8')) } catch { /* New install. */ }
  if (typeof saved.dataDir !== 'string') saved = { dataDir: join(homedir(), '.keepkey', 'monero', 'mainnet') }
  let child: ChildProcess | null = null, monitor: ReturnType<typeof setInterval> | null = null
  let reading: Promise<MoneroNodeStatus> | null = null, queue: Promise<unknown> = Promise.resolve(), available: boolean | undefined
  let metrics = { height: null, targetHeight: null, percent: null, peers: 0 } as Pick<MoneroNodeStatus, 'height' | 'targetHeight' | 'percent' | 'peers'>
  const save = () => {
    mkdirSync(dirname(options.stateFile), { recursive: true, mode: 0o700 })
    const temporary = options.stateFile + '.tmp'
    writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 }); renameSync(temporary, options.stateFile)
  }
  const owned = () => {
    if (!alive(saved.pid) || !saved.command?.length || !saved.configPath) return false
    if (child && child.pid === saved.pid && child.exitCode === null && child.signalCode === null) return true
    // PID reuse cannot give Vault authority over a different process.
    try {
      const actual = options.processCommand ? options.processCommand(saved.pid!) : process.platform === 'linux'
        ? readFileSync(`/proc/${saved.pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
        : execFileSync('/bin/ps', ['-ww', '-p', String(saved.pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim()
      return actual === saved.command.join(' ')
    } catch { return false }
  }
  const ownedForStatus = async () => {
    const pid = saved.pid, command = saved.command?.join(' ')
    if (!alive(pid) || !command || !saved.configPath) return false
    if (child && child.pid === pid && child.exitCode === null && child.signalCode === null) return true
    try {
      const actual = options.processCommand ? options.processCommand(pid!) : process.platform === 'linux'
        ? (await asyncFs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim()
        : (await runFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 })).stdout.trim()
      return saved.pid === pid && saved.command?.join(' ') === command && actual === command
    } catch { return false }
  }
  const checkDisk = () => (options.disk ?? storage)(saved.dataDir, saved.device)
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => { const op = queue.then(fn); queue = op.catch(() => {}); return op }
  const startMonitor = () => {
    if (monitor) return
    monitor = setInterval(() => { void status().catch(() => {}) }, options.pollMs ?? 10000)
    monitor.unref?.()
  }
  const signalStop = (reason?: string, ownerChecked = false) => {
    if (!ownerChecked && !owned()) throw new Error('Vault cannot verify ownership of the running node; it has not stopped another process')
    if (!saved.stopping) { process.kill(saved.pid!, 'SIGTERM'); saved.stopping = true; saved.error = reason; save() }
  }
  async function readStatus(): Promise<MoneroNodeStatus> {
    if (available === undefined) { try { await (options.binary ?? verifiedMonerod)(); available = true } catch { available = false } }
    const checking = JSON.stringify([saved.dataDir, saved.device, saved.pid, saved.stopping])
    let freeBytes: number | null = null, diskBytes = 0, error = saved.error
    try { freeBytes = (await checkDisk()).freeBytes; diskBytes = await diskUsage(saved.dataDir) } catch (e: any) { error = saved.error ?? e.message }
    if (checking !== JSON.stringify([saved.dataDir, saved.device, saved.pid, saved.stopping])) return readStatus()
    let state: MoneroNodeStatus['state'] = 'stopped'
    if (alive(saved.pid)) {
      if (!await ownedForStatus()) { state = 'error'; error = 'The saved node process does not belong to Vault. It has not been changed.' }
      else {
        startMonitor()
        if ((freeBytes === null || freeBytes < reserveBytes) && !saved.stopping) {
          signalStop(freeBytes === null ? 'Node stopped because its storage drive is unavailable.' : 'Node stopped to keep 25 GiB free. Free space or choose another drive before restarting.', true)
          error = saved.error
        }
        state = saved.stopping ? 'stopping' : 'starting'
        if (!saved.stopping) {
          try {
            const response = await fetch(`${rpcUrl}/json_rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 'vault', method: 'get_info' }), signal: AbortSignal.timeout(3000), redirect: 'error' })
            if (!response.ok) throw new Error('Node status unavailable')
            const text = await response.text()
            if (text.length > 65536) throw new Error('Node status invalid')
            const next = moneroNodeProgress(JSON.parse(text).result)
            state = next.state; metrics = { height: next.height, targetHeight: next.targetHeight, percent: next.percent, peers: next.peers }
          } catch { /* Starting or temporarily busy; never claim ready from cached metrics. */ }
        }
      }
    } else if (saved.pid) {
      const unexpected = !saved.stopping
      saved.pid = undefined; saved.command = undefined; saved.stopping = false
      if (unexpected) saved.error = error = 'The Monero node stopped unexpectedly. Check its log before restarting.'
      save()
      if (monitor) { clearInterval(monitor); monitor = null }
    }
    return { available: !!available, state, dataDir: saved.dataDir, logPath: join(saved.dataDir, 'node.log'), rpcUrl,
      pruned: true, diskBytes, freeBytes, reserveBytes, estimatedBytes, ...metrics, ...(error ? { error } : {}) }
  }
  function status(): Promise<MoneroNodeStatus> {
    if (reading) return reading
    const op = readStatus(); reading = op
    void op.finally(() => { if (reading === op) reading = null }).catch(() => {})
    return op
  }
  async function configure(dataDir: string) {
    if (alive(saved.pid)) throw new Error('Stop the node before changing its storage folder')
    const path = resolve(dataDir.startsWith('~/') ? join(homedir(), dataDir.slice(2)) : dataDir)
    if (!isAbsolute(dataDir) && !dataDir.startsWith('~/')) throw new Error('Choose an absolute folder path for the Monero blockchain')
    const disk = await (options.disk ?? storage)(path)
    saved = { dataDir: path, device: disk.device }; save()
    metrics = { height: null, targetHeight: null, percent: null, peers: 0 }
    return status()
  }
  async function start() {
    if (alive(saved.pid)) { if (!owned()) throw new Error('The saved node process does not belong to Vault'); return status() }
    const binary = await (options.binary ?? verifiedMonerod)(); available = true
    const disk = await checkDisk()
    // Only existing chain data reduces the remaining download estimate. Logs
    // or unrelated files in a chosen folder do not make a new chain smaller.
    let used = 0
    try {
      const database = lstatSync(join(saved.dataDir, 'lmdb', 'data.mdb'))
      if (database.isFile() && !database.isSymbolicLink()) used = database.blocks === undefined ? database.size : database.blocks * 512
    } catch { /* No saved blockchain yet. */ }
    if (disk.freeBytes < Math.max(0, estimatedBytes - used) + reserveBytes) throw new Error('Not enough free space for a pruned Monero node and the 25 GiB reserve. Choose another drive or free space first.')
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.once('error', () => reject(new Error(`Port ${port} is already in use. Vault will not stop or replace another node.`)))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()))
    })
    mkdirSync(saved.dataDir, { recursive: true, mode: 0o700 }); saved.dataDir = realpathSync(saved.dataDir); saved.device = disk.device
    mkdirSync(dirname(options.stateFile), { recursive: true, mode: 0o700 })
    const configPath = join(dirname(options.stateFile), `monerod-${randomBytes(16).toString('hex')}.conf`)
    writeFileSync(configPath, '# Managed by KeepKey Vault. Options are supplied explicitly.\n', { mode: 0o600 })
    const command = [binary, '--config-file', configPath, '--data-dir', saved.dataDir, '--non-interactive', '--prune-blockchain', '--sync-pruned-blocks',
      '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port), '--restricted-rpc', '--no-igd', '--hide-my-port',
      '--p2p-bind-ip', '127.0.0.1', '--out-peers', '8', '--in-peers', '0', '--max-concurrency', '2',
      '--check-updates', 'disabled', '--log-file', join(saved.dataDir, 'node.log'), '--log-level', '0', '--max-log-file-size', '10485760', '--max-log-files', '2']
    const fd = openSync(join(saved.dataDir, 'console.log'), 'a', 0o600)
    try {
      const proc = spawn(binary, command.slice(1), { detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
      child = proc
      await new Promise<void>((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject) })
      saved = { dataDir: saved.dataDir, device: saved.device, pid: proc.pid, command, configPath }; save()
      proc.unref(); startMonitor()
    } finally { closeSync(fd) }
    return status()
  }
  async function stop(reason?: string) {
    if (!alive(saved.pid)) return status()
    signalStop(reason)
    const end = Date.now() + (options.stopWaitMs ?? 30000)
    while (alive(saved.pid) && Date.now() < end) await sleep(100)
    return status()
  }
  return { status, configure: (path: string) => serialize(() => configure(path)), start: () => serialize(start),
    stop: (reason?: string) => serialize(() => stop(reason)),
    /** On app shutdown, request a graceful database flush. No SIGKILL is used. */
    shutdown() { if (monitor) clearInterval(monitor); monitor = null; if (owned()) signalStop() },
    dispose() { if (monitor) clearInterval(monitor); monitor = null },
  }
}
