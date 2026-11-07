import { randomBytes, createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { DigestWalletRpc, RpcFailure } from './digest'
import { PublicError, WATCH_NODE_UNREACHABLE, WATCH_SCANNING, atomic, checkRelayResponse, parseTxLookup, unsigned, validateTxLookupRequest, type MoneroTxLookup, validateConfiguration, validateKeyImageImport, validateOutputs,
  validatePlan, validateRelayRequest, validateTransferRequest, type MoneroWalletStatus } from './protocol'
import { runHostAdapter } from './tools'

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

/** How recently the node itself must have answered for a slow wallet refresh to count as scanning. */
export const NODE_ANSWER_WINDOW_MS = 45_000
/** A refresh that ran out of time while the node itself still answers is a scan in progress (wallet-rpc keeps
 *  going); a timeout with a silent node, or any other failure, is the node being unreachable. */
export function refreshFailure(error: unknown, nodeAnsweredRecently: boolean): string {
  return error instanceof Error && error.message === 'Monero wallet RPC timed out' && nodeAnsweredRecently ? WATCH_SCANNING : WATCH_NODE_UNREACHABLE
}

// Dev/E2E only: an offline loopback regtest daemon ("fakechain"). Mainnet rules are unchanged otherwise.
const LOCAL_REGTEST = process.env.KEEPKEY_MONERO_LOCAL_REGTEST === '1'

export async function verifyDaemon(origin: string, minimumHeight: number): Promise<{ height: number; fingerprint?: string; synchronized: boolean; regtest: boolean; offline: boolean }> {
  const url = new URL(origin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('Invalid Monero daemon origin')
  const fingerprint = url.protocol === 'http:' ? undefined : await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: true })
    socket.setTimeout(15000, () => socket.destroy(new Error('timeout')))
    socket.once('error', () => reject(new PublicError('The Monero daemon is unavailable')))
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate().raw
      if (!socket.authorized || !certificate) { socket.destroy(); reject(new Error('Cannot verify the Monero daemon TLS identity')); return }
      const pin = createHash('sha256').update(certificate).digest('hex')
      socket.end(); resolve(pin)
    })
  })
  let response: Response
  try {
    response = await fetch(`${url.origin}/json_rpc`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', method: 'get_info' }),
      signal: AbortSignal.timeout(20000), redirect: 'error' })
  } catch { throw new PublicError('The Monero daemon is unavailable') }
  if (!response.ok) throw new PublicError('The Monero daemon is unavailable')
  const reader = response.body?.getReader(); if (!reader) throw new PublicError('The Monero daemon is unavailable')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.length
    if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Monero daemon response exceeds its bound') }
    chunks.push(value)
  }
  const info = JSON.parse(Buffer.concat(chunks).toString('utf8')).result
  const regtest = LOCAL_REGTEST && loopback && url.protocol === 'http:' && info?.nettype === 'fakechain' && info.offline === true
  if (!info || (!regtest && info.nettype !== 'mainnet') || info.testnet || info.stagenet ||
      (!info.synchronized && !(loopback && info.offline === true)) || unsigned(info.height) < minimumHeight) {
    throw new PublicError('The selected Monero node is not synchronized on mainnet')
  }
  return { height: unsigned(info.height), fingerprint, synchronized: info.synchronized === true, regtest, offline: info.offline === true }
}

/** wallet-rpc refuses import_key_images without a trusted daemon. As in Monero's own default, only a loopback daemon is trusted. */
export function walletDaemonArgs(daemonUrl: string, daemon: { fingerprint?: string; regtest: boolean }): string[] {
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(daemonUrl).hostname)
  return [loopback ? '--trusted-daemon' : '--untrusted-daemon', '--daemon-address', daemonUrl,
    ...(daemon.fingerprint ? ['--daemon-ssl', 'enabled', '--daemon-ssl-allowed-fingerprints', daemon.fingerprint] : ['--daemon-ssl', 'disabled']),
    ...(daemon.regtest ? ['--allow-mismatched-daemon-version'] : [])]
}

/**
 * wallet-rpc imports key images only from a trusted daemon. A remote daemon is trusted just for this call
 * (owner decision 2026-11-06: that node sees these key images, a privacy cost; it cannot move funds), keeping
 * its TLS pin, then untrusted again. If untrusting fails the caller must end the session (fail closed).
 */
export async function withDaemonTrusted<T>(rpc: { call(method: string, params: unknown, timeout?: number): Promise<any> },
  daemonUrl: string, fingerprint: string | undefined, work: () => Promise<T>): Promise<T> {
  if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(daemonUrl).hostname)) return work()
  const trust = (trusted: boolean) => rpc.call('set_daemon', { address: daemonUrl, trusted,
    ssl_support: fingerprint ? 'enabled' : 'disabled', ssl_allowed_fingerprints: fingerprint ? [fingerprint] : [] }, 30000)
  await trust(true)
  try { return await work() } finally { await trust(false) }
}

interface Session {
  directory: string
  address: string
  restoreHeight: number
  daemonUrl: string
  daemonSynchronized: boolean
  /** An offline daemon cannot broadcast; sending needs a live one (local regtest excepted). */
  sendable: boolean
  daemonFingerprint?: string
  /** The node's own height (/get_height, pinned), polled independently of the wallet refresh: the scan target. */
  daemonHeight: number
  /** When the node last answered that poll. */
  nodeAnsweredAt: number
  proc: ReturnType<typeof Bun.spawn>
  rpc: DigestWalletRpc
  status: MoneroWalletStatus
}

/** Establish a watch-only wallet before scheduling any scan. Core's automatic idle
 * refresh must be disabled before creation, otherwise it can block identity checks. */
export async function initializeWatchRpc(rpc: Pick<DigestWalletRpc, 'call'>,
  config: { address: string; viewKey: string; restoreHeight: number }, password: string): Promise<void> {
  try {
    // Core's idle auto-refresh can start as soon as generate_from_keys returns and
    // monopolize its RPC thread before get_address/query_key. Disable it while
    // there is no wallet yet; this service explicitly schedules refresh below.
    await rpc.call('auto_refresh', { enable: false })
    await rpc.call('generate_from_keys', { filename: 'watch', address: config.address,
      viewkey: config.viewKey, spendkey: '', password, restore_height: config.restoreHeight, language: 'English' }, 30000)
  } finally { config.viewKey = '' }
  const actual = await rpc.call('get_address', { account_index: 0 })
  if (actual.address !== config.address) throw new Error('The Monero watch wallet does not match the device')
  try { await rpc.call('query_key', { key_type: 'spend_key' }); throw new Error('The Monero sidecar unexpectedly has a spend key') }
  catch (error) { if (!(error instanceof RpcFailure) || error.code !== -29) throw error }
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
        '--rpc-ssl', 'disabled', ...walletDaemonArgs(config.daemonUrl, daemon),
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
      await initializeWatchRpc(rpc, config, randomBytes(32).toString('hex'))
      if (this.generation !== generation) throw new Error('Monero configuration was cancelled')
      const status: MoneroWalletStatus = { network: 'mainnet', address: config.address, balanceAtomic: '0', unlockedBalanceAtomic: '0',
        walletHeight: 0, transactions: [], monitorReady: false, updatedAt: new Date().toISOString(), canSend: false, daemonHeight: daemon.height }
      const session: Session = { directory, address: config.address, restoreHeight: config.restoreHeight, daemonUrl: config.daemonUrl,
        daemonSynchronized: daemon.synchronized, sendable: daemon.regtest || (daemon.synchronized && !daemon.offline), daemonFingerprint: daemon.fingerprint,
        daemonHeight: daemon.height, nodeAnsweredAt: Date.now(), proc, rpc, status }
      this.session = session
      this.pending = null
      void proc.exited.then(() => {
        if (this.session === session) {
          session.status = { ...session.status, monitorReady: false, error: 'The local Monero wallet RPC stopped' }
          session.rpc.close()
        }
      })
      this.timer = setInterval(() => { void this.probeNode(session); void this.refresh().catch(() => {}) }, 15000)
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
          monitorReady: session.daemonSynchronized && height >= session.restoreHeight, updatedAt: new Date().toISOString(), canSend: false,
          daemonHeight: session.daemonHeight }
        if (this.session !== session) throw new Error('The Monero wallet changed during refresh')
        session.status = status
        return structuredClone(status)
      } catch (error) {
        // wallet-rpc keeps scanning after our call times out; only a failed refresh means the node is unreachable.
        if (this.session === session) session.status = { ...session.status, monitorReady: false,
          error: refreshFailure(error, Date.now() - session.nodeAnsweredAt <= NODE_ANSWER_WINDOW_MS) }
        throw new Error('The Monero watch wallet could not refresh')
      }
    })()
    this.refreshPromise = operation
    void operation.finally(() => { if (this.refreshPromise === operation) this.refreshPromise = null }).catch(() => {})
    return operation
  }

  /** The node's height straight from the node (its pinned TLS identity), on the same 15 s beat as the wallet
   *  refresh but outside the wallet-RPC queue, so a node that stops answering shows even during a long scan. */
  async probeNode(session: Session): Promise<void> {
    try {
      const height = await nodeHeight(session.daemonUrl, session.daemonFingerprint)
      if (this.session !== session) return
      session.daemonHeight = height; session.nodeAnsweredAt = Date.now()
      session.status = { ...session.status, daemonHeight: height,
        ...(session.status.error === WATCH_NODE_UNREACHABLE ? { error: undefined } : {}) }
    } catch {
      if (this.session === session) session.status = { ...session.status, monitorReady: false, error: WATCH_NODE_UNREACHABLE }
    }
  }

  /** Is this transaction in the node's pool or a block, and are its inputs spent? (No wallet state is changed.) */
  async lookup(input: unknown): Promise<MoneroTxLookup> {
    const { txid, keyImages } = validateTxLookupRequest(input), session = this.current()
    return lookupTransaction(session.daemonUrl, session.daemonFingerprint, txid, keyImages)
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
    validateOutputs(reply)
    return reply
  }

  /** One device session's key images (at most 64), imported at their transfer offset. */
  async importKeyImages(input: unknown): Promise<{ height: number; spentAtomic: string; unspentAtomic: string }> {
    const { offset, signedKeyImages } = validateKeyImageImport(input), session = this.current()
    let result: any
    try {
      result = await withDaemonTrusted(session.rpc, session.daemonUrl, session.daemonFingerprint, () => session.rpc.call('import_key_images', { offset,
        signed_key_images: signedKeyImages.map(item => ({ key_image: item.keyImage, signature: item.signature })) }, 120000))
    } catch (error) {
      // Unknown trust state after a failed call: end the wallet rather than leave a remote daemon trusted.
      await this.stop().catch(() => {})
      throw error
    }
    const value = { height: unsigned(result.height), spentAtomic: atomic(result.spent), unspentAtomic: atomic(result.unspent) }
    // The import can discover spends. Publish its new balance before the host
    // checks whether verification is stale; the pre-import cache can be higher.
    // An existing refresh may still contain pre-import reads, so let it settle
    // and then start a fresh one. Never refresh a replacement wallet for this call.
    if (this.session !== session) throw new Error('The Monero wallet changed during key-image import')
    await this.refreshPromise?.catch(() => {})
    if (this.session !== session) throw new Error('The Monero wallet changed during key-image import')
    await this.refresh().catch(() => {})
    if (this.session !== session) throw new Error('The Monero wallet changed during key-image import')
    return value
  }

  /** Watch-only `transfer` yields an unsigned set; the adapter decodes it against a fresh export. Nothing is relayed. */
  async createTransfer(input: unknown): Promise<{ feeAtomic: string; amountAtomic: string; plan: unknown }> {
    const request = validateTransferRequest(input), session = this.current()
    if (!this.adapter) throw new PublicError('The Monero signing adapter is not installed')
    if (!session.sendable) throw new PublicError('The Monero daemon is unavailable')
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

type Fetcher = (url: string, init: any) => Promise<Response>

/** A bounded JSON POST to the configured daemon; HTTPS must present the certificate pinned at configuration.
 *  No answer: "unavailable". An answer that is not bounded JSON: "could not be read" (never a rejection). */
export async function daemonRequest(origin: string, fingerprint: string | undefined, path: string, body: unknown,
  fetcher: Fetcher = fetch as any, timeoutMs = 60000): Promise<unknown> {
  const url = new URL(origin)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol === 'https:' ? !fingerprint : !(url.protocol === 'http:' && loopback)) throw new Error('Invalid Monero daemon origin')
  const tls = url.protocol === 'https:' ? { checkServerIdentity: (_host: string, certificate: { raw?: Uint8Array }) =>
    certificate?.raw && createHash('sha256').update(certificate.raw).digest('hex') === fingerprint ? undefined : new Error('pin') } : undefined
  let response: Response
  try {
    response = await fetcher(`${url.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error', ...(tls ? { tls } : {}) })
  } catch { throw new PublicError('The Monero daemon is unavailable') }
  if (!response.ok) throw new PublicError('The Monero daemon is unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    const reader = response.body?.getReader()
    while (reader) {
      const { done, value } = await reader.read(); if (done) break
      if ((size += value.length) > 65536) { await reader.cancel(); throw new PublicError('The daemon reply could not be read') }
      chunks.push(value)
    }
  } catch (error) { throw error instanceof PublicError ? error : new PublicError('The daemon reply could not be read') }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new PublicError('The daemon reply could not be read') }
}

/** POST /send_raw_transaction once. Only explicit rejection flags reject; anything else unexpected is unknown. */
export async function relayRawTransaction(origin: string, fingerprint: string | undefined, txHex: string, fetcher: Fetcher = fetch as any): Promise<void> {
  checkRelayResponse(await daemonRequest(origin, fingerprint, '/send_raw_transaction', { tx_as_hex: txHex, do_not_relay: false }, fetcher))
}

/** Where the node has a transaction (pool, block, or not at all) and whether its inputs are spent.
 *  Key images first, then the tx: a block landing between the two calls then shows the tx as mined, never
 *  as "missed but spent" (which reads as another tx spending them). If they are spent on chain and the tx is
 *  still missed, the tx is asked once more before that conclusion stands. */
export async function lookupTransaction(origin: string, fingerprint: string | undefined, txid: string, keyImages: string[],
  fetcher: Fetcher = fetch as any): Promise<MoneroTxLookup> {
  const spent = await daemonRequest(origin, fingerprint, '/is_key_image_spent', { key_images: keyImages }, fetcher, 30000)
  const ask = () => daemonRequest(origin, fingerprint, '/get_transactions', { txs_hashes: [txid] }, fetcher, 30000)
  const first = parseTxLookup(txid, await ask(), spent, keyImages.length)
  if (first.state !== 'unknown' || !first.keyImages.includes('spent')) return first
  return parseTxLookup(txid, await ask(), spent, keyImages.length)
}

/** The node's own chain height (/get_height), not the wallet's: the scan target and the node-alive signal. */
export async function nodeHeight(origin: string, fingerprint: string | undefined, fetcher: Fetcher = fetch as any): Promise<number> {
  const value = await daemonRequest(origin, fingerprint, '/get_height', {}, fetcher, 15000) as any
  if (value?.status !== 'OK' || !Number.isSafeInteger(value.height) || value.height < 1) throw new PublicError('The daemon reply could not be read')
  return value.height
}
