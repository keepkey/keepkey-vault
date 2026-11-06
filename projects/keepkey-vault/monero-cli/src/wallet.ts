import { randomBytes, createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { DigestWalletRpc, RpcFailure } from './digest'
import { MAX_KEY_IMAGE_OUTPUTS, PublicError, atomic, checkRelayResponse, unsigned, validateConfiguration, validateKeyImageImport, validateOutputs,
  validatePlan, validateRelayRequest, validateTransferRequest, type MoneroWalletStatus } from './protocol'
import { runHostAdapter } from './tools'

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export async function verifyDaemon(origin: string, minimumHeight: number): Promise<{ height: number; fingerprint?: string; synchronized: boolean }> {
  const url = new URL(origin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Invalid Monero daemon origin')
  const fingerprint = url.protocol === 'http:' ? undefined : await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: true })
    socket.setTimeout(15000, () => socket.destroy(new Error('timeout')))
    socket.once('error', () => reject(new Error('Cannot verify the Monero daemon TLS identity')))
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate().raw
      if (!socket.authorized || !certificate) { socket.destroy(); reject(new Error('Cannot verify the Monero daemon TLS identity')); return }
      const pin = createHash('sha256').update(certificate).digest('hex')
      socket.end(); resolve(pin)
    })
  })
  const response = await fetch(`${url.origin}/json_rpc`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', method: 'get_info' }),
    signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw new Error('The Monero daemon is unavailable')
  const reader = response.body?.getReader(); if (!reader) throw new Error('The Monero daemon is unavailable')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.length
    if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Monero daemon response exceeds its bound') }
    chunks.push(value)
  }
  const info = JSON.parse(Buffer.concat(chunks).toString('utf8')).result
  if (!info || info.nettype !== 'mainnet' || info.testnet || info.stagenet ||
      (!info.synchronized && !(loopback && info.offline === true)) || unsigned(info.height) < minimumHeight) {
    throw new Error('The selected Monero daemon is not synchronized on mainnet')
  }
  return { height: unsigned(info.height), fingerprint, synchronized: info.synchronized === true }
}

interface Session {
  directory: string
  address: string
  restoreHeight: number
  daemonUrl: string
  daemonSynchronized: boolean
  daemonFingerprint?: string
  proc: ReturnType<typeof Bun.spawn>
  rpc: DigestWalletRpc
  status: MoneroWalletStatus
}

export class MoneroWatchService {
  private session: Session | null = null
  private refreshPromise: Promise<MoneroWalletStatus> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private pending: { directory: string; proc: ReturnType<typeof Bun.spawn> } | null = null
  constructor(private binary: string, private adapter: string | null = null) {}
  get sendReady(): boolean { return !!this.adapter }

  async configure(input: unknown): Promise<MoneroWalletStatus> {
    const config = validateConfiguration(input)
    await this.stop()
    const generation = ++this.generation
    const daemon = await verifyDaemon(config.daemonUrl, config.restoreHeight)
    if (this.generation !== generation) throw new Error('Monero configuration was cancelled')
    const directory = await mkdtemp(join(tmpdir(), 'keepkey-monero-watch-'))
    await chmod(directory, 0o700)
    let proc: ReturnType<typeof Bun.spawn> | null = null, rpc: DigestWalletRpc | null = null
    try {
      const reservation = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
      const port = reservation.port; reservation.stop(true)
      const ringdb = join(directory, 'ringdb'); await mkdir(ringdb, { mode: 0o700 })
      const args = [this.binary, '--wallet-dir', directory, '--rpc-bind-ip', '127.0.0.1', '--rpc-bind-port', String(port),
        '--rpc-ssl', 'disabled', '--untrusted-daemon', '--daemon-address', config.daemonUrl,
        ...(daemon.fingerprint ? ['--daemon-ssl', 'enabled', '--daemon-ssl-allowed-fingerprints', daemon.fingerprint] : ['--daemon-ssl', 'disabled']),
        '--no-initial-sync', '--shared-ringdb-dir', ringdb, '--log-level', '0', '--log-file', join(directory, 'rpc.log')]
      proc = Bun.spawn(args, { cwd: directory, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      this.pending = { directory, proc }
      const deadline = Date.now() + 60000, loginFile = join(directory, `monero-wallet-rpc.${port}.login`)
      while (Date.now() < deadline) {
        if (this.generation !== generation) throw new Error('Monero configuration was cancelled')
        if (proc.exitCode !== null) throw new Error('The Monero wallet RPC stopped during startup')
        try {
          const info = await lstat(loginFile)
          if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('login')
          const login = (await readFile(loginFile, 'utf8')).trim(), separator = login.indexOf(':')
          if (separator < 1 || separator === login.length - 1) throw new Error('login')
          rpc = new DigestWalletRpc(port, login.slice(0, separator), login.slice(separator + 1))
          await rpc.call('get_version', {}, 2000)
          break
        } catch { rpc?.close(); rpc = null; await delay(100) }
      }
      if (!rpc) throw new Error('The private Monero wallet RPC did not become ready')
      const password = randomBytes(32).toString('hex')
      try {
        await rpc.call('generate_from_keys', { filename: 'watch', address: config.address,
          viewkey: config.viewKey, spendkey: '', password, restore_height: config.restoreHeight, language: 'English' }, 30000)
      } finally { config.viewKey = '' }
      const actual = await rpc.call('get_address', { account_index: 0 })
      if (actual.address !== config.address) throw new Error('The Monero watch wallet does not match the device')
      try { await rpc.call('query_key', { key_type: 'spend_key' }); throw new Error('The Monero sidecar unexpectedly has a spend key') }
      catch (error) { if (!(error instanceof RpcFailure) || error.code !== -29) throw error }
      if (this.generation !== generation) throw new Error('Monero configuration was cancelled')
      const status: MoneroWalletStatus = { network: 'mainnet', address: config.address, balanceAtomic: '0', unlockedBalanceAtomic: '0',
        walletHeight: 0, transactions: [], monitorReady: false, updatedAt: new Date().toISOString(), canSend: false }
      const session: Session = { directory, address: config.address, restoreHeight: config.restoreHeight, daemonUrl: config.daemonUrl,
        daemonSynchronized: daemon.synchronized, daemonFingerprint: daemon.fingerprint, proc, rpc, status }
      this.session = session
      this.pending = null
      void proc.exited.then(() => {
        if (this.session === session) {
          session.status = { ...session.status, monitorReady: false, error: 'The local Monero wallet RPC stopped' }
          session.rpc.close()
        }
      })
      this.timer = setInterval(() => { void this.refresh().catch(() => {}) }, 15000)
      void this.refresh().catch(() => {})
      return { ...status, transactions: [] }
    } catch (error) {
      rpc?.close()
      if (proc && proc.exitCode === null) {
        const owned = proc
        owned.kill()
        const force = setTimeout(() => { if (owned.exitCode === null) owned.kill('SIGKILL') }, 3000)
        await owned.exited; clearTimeout(force)
      }
      await rm(directory, { recursive: true, force: true })
      if (this.pending?.proc === proc) this.pending = null
      throw error
    } finally { config.viewKey = '' }
  }

  getStatus(): MoneroWalletStatus {
    if (!this.session) throw new Error('Connect a Monero watch wallet first')
    return structuredClone(this.session.status)
  }

  refresh(): Promise<MoneroWalletStatus> {
    if (this.refreshPromise) return this.refreshPromise
    const session = this.session
    if (!session) return Promise.reject(new Error('Connect a Monero watch wallet first'))
    const operation = (async () => {
      try {
        await session.rpc.call('refresh', {}, 300000)
        const height = unsigned((await session.rpc.call('get_height')).height)
        const balances = await session.rpc.call('get_balance', { account_index: 0 })
        const transfers = await session.rpc.call('get_transfers', { in: true, pool: true, out: false,
          pending: false, failed: false, account_index: 0 })
        const balance = atomic(balances.balance), unlocked = atomic(balances.unlocked_balance)
        if (BigInt(unlocked) > BigInt(balance)) throw new Error('Invalid Monero wallet balances')
        const items = [...(transfers.in ?? []).map((v: any) => ({ ...v, type: 'in' as const })),
          ...(transfers.pool ?? []).map((v: any) => ({ ...v, type: 'pool' as const }))]
        if (items.length > 100000) throw new Error('Monero wallet history exceeds its bound')
        const transactions = items.map((v: any) => {
          if (typeof v.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(v.txid) || typeof v.locked !== 'boolean') throw new Error('Invalid Monero wallet history')
          return { txid: v.txid.toLowerCase(), amountAtomic: atomic(v.amount), confirmations: unsigned(v.confirmations ?? 0),
            locked: v.locked, height: unsigned(v.height ?? 0), type: v.type }
        }).sort((a, b) => b.height - a.height)
        const status: MoneroWalletStatus = { network: 'mainnet', address: session.address, balanceAtomic: balance, unlockedBalanceAtomic: unlocked,
          walletHeight: height, transactions: transactions.slice(0, 100), transactionsTruncated: transactions.length > 100,
          monitorReady: session.daemonSynchronized && height >= session.restoreHeight, updatedAt: new Date().toISOString(), canSend: false }
        if (this.session !== session) throw new Error('The Monero wallet changed during refresh')
        session.status = status
        return structuredClone(status)
      } catch {
        if (this.session === session) session.status = { ...session.status, monitorReady: false,
          error: 'The Monero watch wallet is reconnecting or could not refresh' }
        throw new Error('The Monero watch wallet could not refresh')
      }
    })()
    this.refreshPromise = operation
    void operation.finally(() => { if (this.refreshPromise === operation) this.refreshPromise = null }).catch(() => {})
    return operation
  }

  private current(): Session {
    if (!this.session) throw new Error('Connect a Monero watch wallet first')
    return this.session
  }

  private async exportedOutputs(session: Session): Promise<string> {
    const hex = (await session.rpc.call('export_outputs', { all: true }, 60000)).outputs_data_hex
    if (typeof hex !== 'string' || hex.length > 8 * 1024 * 1024 || !/^(?:[0-9a-f]{2})+$/.test(hex)) throw new Error('Invalid Monero output export')
    return hex
  }

  /** The view key is read back from this worker's own watch wallet and goes to the adapter only over stdin. */
  private async adapterRequest(session: Session, op: 'outputs' | 'plan', outputsHex: string, unsignedTxset?: string): Promise<any> {
    if (!this.adapter) throw new PublicError('The Monero signing adapter is not installed')
    const key = await session.rpc.call('query_key', { key_type: 'view_key' })
    const request: Record<string, string> = { op, address: session.address, view_key: typeof key.key === 'string' ? key.key : '',
      outputs_data_hex: outputsHex, ...(unsignedTxset ? { unsigned_txset: unsignedTxset } : {}) }
    key.key = ''
    const reply = await runHostAdapter(this.adapter, request)
    if (this.session !== session) throw new Error('The Monero wallet changed')
    return reply
  }

  /** Complete wallet export in transfer order (public output metadata only). */
  async exportOutputs(): Promise<unknown> {
    const session = this.current()
    const reply = await this.adapterRequest(session, 'outputs', await this.exportedOutputs(session))
    if (validateOutputs(reply).length > MAX_KEY_IMAGE_OUTPUTS) throw new PublicError('This preview syncs at most 64 wallet outputs')
    return reply
  }

  async importKeyImages(input: unknown): Promise<{ height: number; spentAtomic: string; unspentAtomic: string }> {
    const { offset, signedKeyImages } = validateKeyImageImport(input), session = this.current()
    const result = await session.rpc.call('import_key_images', { offset,
      signed_key_images: signedKeyImages.map(item => ({ key_image: item.keyImage, signature: item.signature })) }, 120000)
    const value = { height: unsigned(result.height), spentAtomic: atomic(result.spent), unspentAtomic: atomic(result.unspent) }
    void this.refresh().catch(() => {})
    return value
  }

  /** Watch-only `transfer` yields an unsigned set; the adapter decodes it against a fresh export. Nothing is relayed. */
  async createTransfer(input: unknown): Promise<{ feeAtomic: string; amountAtomic: string; plan: unknown }> {
    const request = validateTransferRequest(input), session = this.current()
    if (!this.adapter) throw new PublicError('The Monero signing adapter is not installed')
    let created: any
    try {
      created = await session.rpc.call('transfer', { destinations: [{ address: request.address, amount: BigInt(request.amountAtomic) }],
        account_index: 0, priority: request.priority, ring_size: 16, unlock_time: 0, do_not_relay: true }, 120000)
    } catch (error) {
      if (error instanceof RpcFailure) throw new PublicError(error.code === -17 ? 'Not enough unlocked XMR for this amount and fee' : 'The watch wallet cannot build this transaction')
      throw error
    }
    const unsignedTxset = created.unsigned_txset
    if (typeof unsignedTxset !== 'string' || unsignedTxset.length > 8 * 1024 * 1024 || !/^(?:[0-9a-f]{2})+$/.test(unsignedTxset)) throw new Error('Invalid unsigned Monero transaction')
    const plan = await this.adapterRequest(session, 'plan', await this.exportedOutputs(session), unsignedTxset)
    validatePlan(plan)
    return { feeAtomic: atomic(created.fee), amountAtomic: atomic(created.amount), plan }
  }

  /** Relay an already verified raw transaction to this session's daemon, with its TLS pin. */
  async relay(input: unknown): Promise<{ relayed: true }> {
    const { txHex } = validateRelayRequest(input), session = this.current()
    await relayRawTransaction(session.daemonUrl, session.daemonFingerprint, txHex)
    void this.refresh().catch(() => {})
    return { relayed: true }
  }

  async stop(): Promise<void> {
    ++this.generation
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const session = this.session; this.session = null; this.refreshPromise = null
    const pending = this.pending; this.pending = null
    if (pending) {
      if (pending.proc.exitCode === null) pending.proc.kill()
      const force = setTimeout(() => { if (pending.proc.exitCode === null) pending.proc.kill('SIGKILL') }, 3000)
      await pending.proc.exited; clearTimeout(force)
      await rm(pending.directory, { recursive: true, force: true })
    }
    if (!session) return
    session.rpc.close()
    if (session.proc.exitCode === null) {
      session.proc.kill()
      const force = setTimeout(() => { if (session.proc.exitCode === null) session.proc.kill('SIGKILL') }, 3000)
      await session.proc.exited
      clearTimeout(force)
    }
    await rm(session.directory, { recursive: true, force: true })
  }
}

/** POST /send_raw_transaction. HTTPS must present the certificate pinned at configuration. */
export async function relayRawTransaction(origin: string, fingerprint: string | undefined, txHex: string,
  fetcher: (url: string, init: any) => Promise<Response> = fetch as any): Promise<void> {
  const url = new URL(origin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'https:' ? !fingerprint : !(url.protocol === 'http:' && loopback)) throw new Error('Invalid Monero daemon origin')
  const tls = url.protocol === 'https:' ? { checkServerIdentity: (_host: string, certificate: { raw?: Uint8Array }) =>
    certificate?.raw && createHash('sha256').update(certificate.raw).digest('hex') === fingerprint ? undefined : new Error('pin') } : undefined
  let response: Response
  try {
    response = await fetcher(`${url.origin}/send_raw_transaction`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_as_hex: txHex, do_not_relay: false }), signal: AbortSignal.timeout(60000), redirect: 'error', ...(tls ? { tls } : {}) })
  } catch { throw new PublicError('The Monero daemon is unavailable') }
  if (!response.ok) throw new PublicError('The Monero daemon is unavailable')
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  while (reader) {
    const { done, value } = await reader.read(); if (done) break
    if ((size += value.length) > 65536) { await reader.cancel(); throw new PublicError('The daemon rejected the transaction') }
    chunks.push(value)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PublicError('The daemon rejected the transaction') }
  checkRelayResponse(value)
}
