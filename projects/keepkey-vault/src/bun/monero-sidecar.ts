/** Managed, watch-only Monero CLI worker. Private IPC payloads are never logged. */
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { MAX_IPC_LINE, MONERO_VERSION, SIDECAR_VERSION, validateConfiguration, validateWalletStatus,
  type MoneroSidecarStatus, type MoneroWalletStatus, type MoneroWatchConfiguration } from '../../monero-cli/src/protocol'

export type { MoneroSidecarStatus, MoneroWalletStatus } from '../../monero-cli/src/protocol'
export type ConfigureMoneroWatch = Omit<MoneroWatchConfiguration, 'viewKey'> & { viewKey: string | Uint8Array }

interface WorkerProcess {
  stdin: { write(value: string): unknown; flush?(): unknown }
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: any): unknown
}
interface Pending {
  resolve(value: any): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
interface Runtime {
  proc: WorkerProcess
  pending: Map<number, Pending>
  readyResolve(): void
  readyReject(error: Error): void
  startupTimer: ReturnType<typeof setTimeout>
  stopped: boolean
  receivedReady: boolean
}

function workerCommand(): string[] {
  const safe = (path: string) => {
    try {
      const info = lstatSync(path)
      return info.isFile() && !info.isSymbolicLink() && (process.platform === 'win32' || !(info.mode & 0o022))
    } catch { return false }
  }
  const name = process.platform === 'win32' ? 'monero-cli.exe' : 'monero-cli'
  if (process.env.MONERO_CLI_BIN) {
    const path = resolve(process.env.MONERO_CLI_BIN)
    if (!safe(path)) throw new Error('The configured Monero sidecar is unavailable')
    return [path]
  }
  for (const path of [join(resolve(import.meta.dir, '..'), name), join(dirname(process.execPath), name),
    resolve(import.meta.dir, '../../monero-cli/dist', name), resolve(process.cwd(), 'monero-cli/dist', name)]) {
    if (safe(path)) return [path]
  }
  for (const path of [resolve(import.meta.dir, '../../monero-cli/src/main.ts'), resolve(process.cwd(), 'monero-cli/src/main.ts')]) {
    if (safe(path)) return [process.execPath, path]
  }
  throw new Error('The Monero sidecar is unavailable; build monero-cli first')
}

export function createMoneroSidecarManager(options: {
  spawn?: () => WorkerProcess
  startupTimeoutMs?: number
  requestTimeoutMs?: number
} = {}) {
  let runtime: Runtime | null = null
  let initializing: Promise<void> | null = null
  let nextId = 1
  let walletAddress: string | null = null
  let status: MoneroSidecarStatus = { state: 'stopped', configured: false, version: SIDECAR_VERSION, binaryVersion: MONERO_VERSION }

  const fail = (current: Runtime, message: string) => {
    clearTimeout(current.startupTimer)
    current.readyReject(new Error(message))
    for (const pending of current.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    current.pending.clear()
    if (runtime === current) {
      runtime = null
      walletAddress = null
      status = { ...status, state: 'error', configured: false, error: message }
    }
    if (!current.stopped) {
      current.stopped = true
      try { current.proc.stdin.write('{"cmd":"quit"}\n'); current.proc.stdin.flush?.() } catch {}
      const force = setTimeout(() => { try { current.proc.kill('SIGKILL') } catch {} }, 5000)
      void current.proc.exited.finally(() => clearTimeout(force))
    }
  }

  const consume = async (current: Runtime) => {
    const reader = current.proc.stdout.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
          if (Buffer.byteLength(line) > MAX_IPC_LINE) throw new Error('bound')
          if (!line.trim()) continue
          const response = JSON.parse(line)
          if (response?.ready === true && response._req_id === undefined && response.ok === true) {
            if (current.receivedReady || response.version !== SIDECAR_VERSION || response.binaryVersion !== MONERO_VERSION || runtime !== current || current.stopped) throw new Error('version')
            current.receivedReady = true
            clearTimeout(current.startupTimer)
            status = { state: 'ready', configured: false, version: response.version, binaryVersion: response.binaryVersion }
            current.readyResolve()
          } else if (Number.isSafeInteger(response?._req_id) && current.pending.has(response._req_id)) {
            const pending = current.pending.get(response._req_id)!
            current.pending.delete(response._req_id); clearTimeout(pending.timer)
            if (response.ok === true) pending.resolve(response.result)
            else pending.reject(new Error('The watch-only Monero operation could not complete'))
          } else throw new Error('unexpected')
        }
        if (Buffer.byteLength(buffer) > MAX_IPC_LINE) throw new Error('bound')
      }
      if (!current.stopped) fail(current, 'The Monero sidecar stopped')
    } catch { if (!current.stopped) fail(current, 'The Monero sidecar returned invalid data') }
    finally { reader.releaseLock() }
  }

  async function start(): Promise<void> {
    if (runtime && status.state === 'ready') return
    if (initializing) return initializing
    const operation = (async () => {
      status = { ...status, state: 'starting', configured: false, error: undefined }
      let proc: WorkerProcess
      try {
        proc = options.spawn ? options.spawn() : Bun.spawn(workerCommand(), { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }) as unknown as WorkerProcess
      } catch { status = { ...status, state: 'error', error: 'The Monero sidecar is unavailable' }; throw new Error(status.error) }
      let resolveReady!: () => void, rejectReady!: (error: Error) => void
      const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      const current: Runtime = { proc, pending: new Map(), readyResolve: resolveReady, readyReject: rejectReady,
        startupTimer: undefined as any, stopped: false, receivedReady: false }
      runtime = current
      current.startupTimer = setTimeout(() => fail(current, 'The Monero sidecar did not become ready'), options.startupTimeoutMs ?? 20000)
      void consume(current)
      // Drain diagnostics without retaining or forwarding private child output.
      void (async () => {
        const reader = proc.stderr.getReader()
        try { while (!(await reader.read()).done) { /* intentionally discarded */ } } catch {}
        finally { reader.releaseLock() }
      })()
      void proc.exited.then(() => { if (!current.stopped) fail(current, 'The Monero sidecar exited') })
      await ready
    })()
    initializing = operation
    try { await operation } finally { if (initializing === operation) initializing = null }
  }

  function stop(): void {
    const current = runtime; runtime = null; initializing = null; walletAddress = null
    status = { state: 'stopped', configured: false, version: SIDECAR_VERSION, binaryVersion: MONERO_VERSION }
    if (!current) return
    current.stopped = true; clearTimeout(current.startupTimer)
    current.readyReject(new Error('The Monero sidecar was stopped'))
    for (const pending of current.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The Monero sidecar was stopped')) }
    current.pending.clear()
    try { current.proc.stdin.write('{"cmd":"quit"}\n'); current.proc.stdin.flush?.() } catch {}
    const force = setTimeout(() => { try { current.proc.kill('SIGKILL') } catch {} }, 5000)
    void current.proc.exited.finally(() => clearTimeout(force))
  }

  async function request(cmd: string, params?: unknown, timeoutMs = options.requestTimeoutMs ?? 45000): Promise<any> {
    const current = runtime
    if (!current || current.stopped || status.state !== 'ready') throw new Error('The Monero sidecar is not ready')
    if (current.pending.size >= 32) throw new Error('Too many pending Monero operations')
    const id = nextId++, message = JSON.stringify({ cmd, _req_id: id, ...(params === undefined ? {} : { params }) }) + '\n'
    if (Buffer.byteLength(message) > MAX_IPC_LINE) throw new Error('Monero request exceeds its bound')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(current, 'The Monero operation timed out') }, timeoutMs)
      current.pending.set(id, { resolve, reject, timer })
      try { current.proc.stdin.write(message); current.proc.stdin.flush?.() }
      catch { clearTimeout(timer); current.pending.delete(id); reject(new Error('Cannot communicate with the Monero sidecar')) }
    })
  }

  return {
    start, stop,
    status: (): MoneroSidecarStatus => ({ ...status }),
    async configureWatch(input: ConfigureMoneroWatch): Promise<MoneroWalletStatus> {
      const config = validateConfiguration({ ...input, viewKey: typeof input.viewKey === 'string' ? input.viewKey : Buffer.from(input.viewKey).toString('hex') })
      await start()
      const current = runtime
      try {
        const result = validateWalletStatus(await request('configure_watch', config, 180000))
        if (!current || runtime !== current || current.stopped || result.address !== config.address || result.network !== config.network || result.canSend !== false) {
          throw new Error('The Monero sidecar changed during wallet configuration')
        }
        status = { ...status, configured: true }
        walletAddress = result.address
        return result
      } finally { config.viewKey = '' }
    },
    async getWalletStatus(): Promise<MoneroWalletStatus> {
      if (!walletAddress || !status.configured) throw new Error('Connect a Monero watch wallet first')
      const result = validateWalletStatus(await request('get_status'))
      if (result.address !== walletAddress) throw new Error('The Monero watch wallet identity changed')
      return result
    },
    async refresh(): Promise<MoneroWalletStatus> {
      if (!walletAddress || !status.configured) throw new Error('Connect a Monero watch wallet first')
      const result = validateWalletStatus(await request('refresh'))
      if (result.address !== walletAddress) throw new Error('The Monero watch wallet identity changed')
      return result
    },
  }
}

const manager = createMoneroSidecarManager()
export const startMoneroSidecar = manager.start
export const stopMoneroSidecar = manager.stop
export const getMoneroSidecarStatus = manager.status
export const configureMoneroWatch = manager.configureWatch
export const getMoneroWalletStatus = manager.getWalletStatus
export const refreshMoneroWatch = manager.refresh
