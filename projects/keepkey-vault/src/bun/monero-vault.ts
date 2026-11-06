/** Monero receiving bridge. Only an explicitly approved device view key reaches the local sidecar. */
import { randomBytes } from 'node:crypto'
import * as managedSidecar from './monero-sidecar'
import type { MoneroOutputRecord, MoneroTransferDraft } from './monero-sidecar'
import { PUBLIC_ERRORS } from '../../monero-cli/src/protocol'
import { firmwareSupportsMonero, MONERO_MIN_FIRMWARE } from '../shared/firmware-versions'
import { formatXmrAtomic, moneroAddressKind } from '../shared/monero-address'
import { MAX_SIGNED_RESPONSE, MAX_UINT64, MONERO_PATH as PATH, MoneroError, bytesField, checkSignedTransaction, concat, keyImageInitRequest,
  lengthField, numberField, openKeyImage, parseFields, parseSignedTransaction, reviewPlan, signRequest, transferDetails,
  type MoneroSendReview } from './monero-wire'

export type { MoneroSendReview } from './monero-wire'
const MAX_RESPONSE = 4096
const PRIMARY_ADDRESS = /^4[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/
const PREPARED_LIFETIME_MS = 10 * 60 * 1000
export type MoneroSendBlocker = 'unrelayed' | 'emulator' | 'adapter' | 'syncing' | 'key-images'
const BLOCKER_MESSAGES: Record<MoneroSendBlocker, string> = {
  unrelayed: 'A signed transaction may already be broadcast: retry broadcasting that same transaction first',
  emulator: 'Sending needs the Monero signing (research) emulator build',
  adapter: 'The Monero signing adapter is not installed in this build',
  syncing: 'Wait for the watch wallet to finish syncing',
  'key-images': 'Sync key images on KeepKey before sending',
}

export interface MoneroVaultConfig {
  enabled: boolean
  offline: boolean
  daemonUrl: string
  restoreHeight: number
}
export interface MoneroVaultStatus {
  available: boolean
  enabled: boolean
  deviceReady: boolean
  connected: boolean
  sidecarReady: boolean
  network: 'mainnet'
  address: string
  balanceAtomic: string
  unlockedBalanceAtomic: string
  walletHeight: number
  transactions: Array<{ txid: string; amountAtomic: string; confirmations: number; locked: boolean; height?: number; type?: 'in' | 'pool' }>
  monitorReady: boolean
  emulatorReady: boolean
  updatedAt?: string
  error?: string
  canSend: boolean
  /** The first unmet send gate, when sending is unavailable. */
  sendBlocked?: MoneroSendBlocker
  unrelayedTxid?: string
  /** This session imported device key images for every wallet output. */
  keyImagesSynced: boolean
  /** View-only scanning alone cannot prove whether received outputs were spent. */
  spendStateKnown: boolean
}
type Delegate = {
  writeChunk(data: Uint8Array, debugLink?: boolean): Promise<void>
  readChunk(debugLink?: boolean): Promise<Uint8Array>
  onButtonRequest?: (() => void) | null
  disconnect?: () => unknown
}
type Transport = { delegate: Delegate; lockDuring<T>(operation: () => Promise<T>): Promise<T> }
type Engine = {
  isEmulator: boolean
  wallet: { transport?: unknown } | null
  emuDelegate?: unknown
  currentSeedEthAddress?: string | null
  getDeviceState(): { state: string; deviceId?: string; firmwareVersion?: string; activeTransport?: unknown; isHiddenWallet?: boolean; firmwareHash?: string }
}
type Confirm = (operation: () => Promise<any>, details: { operation: string; chain?: string; to?: string; value?: string; fee?: string }) => Promise<any>
export interface MoneroWatchSidecar {
  startMoneroSidecar(): Promise<void>
  stopMoneroSidecar(): void
  configureMoneroWatch(options: { walletId: string; network: 'mainnet'; address: string; viewKey: Uint8Array; restoreHeight: number; daemonUrl: string }): Promise<unknown>
  getMoneroWalletStatus(): Promise<unknown>
  // Research send path; absent in a watch-only sidecar.
  isMoneroSendReady?(): boolean
  exportMoneroOutputs?(): Promise<MoneroOutputRecord[]>
  importMoneroKeyImages?(input: { offset: 0; signedKeyImages: Array<{ keyImage: string; signature: string }> }): Promise<unknown>
  createMoneroTransfer?(input: { address: string; amountAtomic: string; priority: number }): Promise<MoneroTransferDraft>
  relayMoneroTransaction?(input: { txHex: string }): Promise<unknown>
  refreshMoneroWatch?(): Promise<unknown>
}
type Owned = Map<string, { amountAtomic: string; keyImage: string }>
type Prepared = { id: string; key: string; generation: number; expires: number; draft: MoneroTransferDraft; review: MoneroSendReview }
type Snapshot = { key: string; wallet: NonNullable<Engine['wallet']>; transport: Transport; config: MoneroVaultConfig; emulator: boolean }
type Message = { type: number; body: Uint8Array }

function empty(enabled: boolean, deviceReady: boolean, error?: string): MoneroVaultStatus {
  return { available: false, enabled, deviceReady, connected: false, sidecarReady: false,
    network: 'mainnet', address: '', balanceAtomic: '0', unlockedBalanceAtomic: '0', walletHeight: 0,
    transactions: [], monitorReady: false, emulatorReady: false, error, canSend: false, keyImagesSynced: false, spendStateKnown: false }
}
function checkedAddress(value: unknown): string {
  if (typeof value !== 'string' || !PRIMARY_ADDRESS.test(value)) throw new MoneroError('The device returned an invalid Monero mainnet address')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MoneroError('Invalid Monero monitor data')
  return value
}
function atomic(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX_UINT64) throw new MoneroError('Invalid Monero monitor amount')
  return value
}
/** Sidecar errors pass through only as the worker's fixed public diagnostics. */
function publicError(error: unknown, fallback: string): MoneroError {
  if (error instanceof MoneroError) return error
  return new MoneroError(error instanceof Error && (PUBLIC_ERRORS as readonly string[]).includes(error.message) ? error.message : fallback)
}
function decodeAddress(bytes: Uint8Array): string { return checkedAddress(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
async function writeMessage(delegate: Delegate, type: number, payload: Uint8Array = new Uint8Array()): Promise<void> {
  const header = new Uint8Array(8); header.set([35, 35])
  const view = new DataView(header.buffer); view.setUint16(2, type); view.setUint32(4, payload.length)
  const data = concat([header, payload])
  for (let offset = 0; offset < data.length; offset += 63) {
    const report = new Uint8Array(64); report[0] = 63; report.set(data.subarray(offset, offset + 63), 1)
    await delegate.writeChunk(report, false)
  }
}
/** A device answer not waiting on a person (computation included) vs one after ButtonAck. */
export const MONERO_DEVICE_REPLY_MS = 120_000
export const MONERO_HUMAN_REPLY_MS = 15 * 60_000
/** The emulator delegate has no read deadline of its own, so every raw read here is bounded:
 *  on expiry the delegate is disconnected (ending the pending read) and the lock is released. */
async function readBounded(delegate: Delegate, ms: number, max = MAX_RESPONSE): Promise<Message> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = readMessage(delegate, max)
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MoneroError('The KeepKey did not answer the Monero request in time; reconnect it and try again')), ms) })
  try { return await Promise.race([read, expired]) }
  catch (error) {
    if (error instanceof MoneroError && /did not answer/.test(error.message)) {
      read.then(message => message.body.fill(0), () => {})
      try { await delegate.disconnect?.() } catch { /* the read is abandoned either way */ }
    }
    throw error
  } finally { clearTimeout(timer) }
}
async function readMessage(delegate: Delegate, max = MAX_RESPONSE): Promise<Message> {
  const first = await delegate.readChunk(false)
  let body: Uint8Array | null = null
  try {
    if (first.length !== 64 || first[0] !== 63 || first[1] !== 35 || first[2] !== 35) throw new MoneroError('Invalid Monero device report')
    const header = new DataView(first.buffer, first.byteOffset, first.byteLength)
    const type = header.getUint16(3), length = header.getUint32(5)
    if (length > max) throw new MoneroError('Monero device response exceeds its bound')
    body = new Uint8Array(length)
    body.set(first.subarray(9, 9 + Math.min(length, 55)))
    first.fill(0)
    let offset = Math.min(length, 55)
    while (offset < length) {
      const report = await delegate.readChunk(false)
      try {
        if (report.length !== 64 || report[0] !== 63 || (report[1] === 35 && report[2] === 35)) throw new MoneroError('Invalid Monero device continuation')
        const count = Math.min(length - offset, 63); body.set(report.subarray(1, 1 + count), offset); offset += count
      } finally { report.fill(0) }
    }
    return { type, body }
  } catch (error) { body?.fill(0); throw error }
  finally { first.fill(0) }
}

/** Injected engine/config keep device state authoritative; no private keys enter frontend RPC. */
export function createMoneroVault({ engine, confirm, getConfig, sidecar = managedSidecar, signingEmulator = () => false,
  replyMs = { device: MONERO_DEVICE_REPLY_MS, human: MONERO_HUMAN_REPLY_MS } }: {
  engine: Engine; confirm?: Confirm; getConfig: () => MoneroVaultConfig; sidecar?: MoneroWatchSidecar
  /** The running emulator is a verified signing-enabled research build. */
  signingEmulator?: () => boolean
  /** Raw read bounds (tests shorten them). */
  replyMs?: { device: number; human: number }
}) {
  let epoch = 0, busy = false
  let activeDelegate: Delegate | null = null
  let bound: { snapshot: Snapshot; address: string } | null = null
  let lastGood: MoneroVaultStatus | null = null
  let synced: { key: string; generation: number; owned: Owned } | null = null
  let prepared: Prepared | null = null
  // A signed tx whose broadcast outcome is unknown. Kept (even across reconnects) so a retry
  // re-sends these exact bytes instead of building a second, different payment.
  let unrelayed: { txid: string; txHex: string } | null = null
  const snapshot = (): Snapshot | null => {
    const config = getConfig(), state = engine.getDeviceState(), wallet = engine.wallet
    if (!config.enabled || config.offline || state.state !== 'ready' || !wallet || !state.deviceId) return null
    if (!firmwareSupportsMonero(state.firmwareVersion)) throw new MoneroError(`Monero needs KeepKey firmware ${MONERO_MIN_FIRMWARE} or newer`)
    if (!Number.isSafeInteger(config.restoreHeight) || config.restoreHeight < 0) throw new MoneroError('Invalid Monero restore height')
    let url: URL
    try { url = new URL(config.daemonUrl) } catch { throw new MoneroError('Configure a Monero daemon URL first') }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.hash || url.search) throw new MoneroError('Use HTTPS for a remote Monero daemon or HTTP for an explicit loopback daemon')
    const transport = wallet.transport as Transport | undefined
    if (!transport?.delegate || typeof transport.lockDuring !== 'function' ||
        typeof transport.delegate.readChunk !== 'function' || typeof transport.delegate.writeChunk !== 'function') throw new MoneroError('The Monero device transport is unavailable')
    if (engine.isEmulator && (!confirm || transport.delegate !== engine.emuDelegate)) throw new MoneroError('The emulator confirmation window is unavailable')
    const key = JSON.stringify([state.deviceId, state.activeTransport, state.isHiddenWallet, state.firmwareHash,
      engine.currentSeedEthAddress, config.daemonUrl, config.restoreHeight])
    return { key, wallet, transport, config: { ...config }, emulator: engine.isEmulator }
  }
  const matches = (expected: Snapshot): boolean => {
    try { const current = snapshot(); return !!current && current.key === expected.key && current.wallet === expected.wallet && current.transport === expected.transport } catch { return false }
  }
  const stop = () => {
    epoch++; bound = null; lastGood = null; synced = null; prepared = null
    try { sidecar.stopMoneroSidecar() } catch { /* stop must still invalidate local authorization */ }
    if (activeDelegate) void writeMessage(activeDelegate, 20).catch(() => {})
  }
  const check = (expected: Snapshot, generation: number) => {
    if (epoch !== generation || !matches(expected)) throw new MoneroError('The Monero wallet or configuration changed; connect again')
  }
  const requireReady = (): Snapshot => {
    const current = snapshot()
    if (!current) throw new MoneroError(getConfig().offline ? 'Monero is unavailable in offline mode' : !getConfig().enabled ? 'Monero is disabled in settings' : 'Unlock and connect a KeepKey before connecting Monero')
    return current
  }
  const receive = async (current: Snapshot, generation: number, request: number, responseType: number, body: Uint8Array, review: boolean, max = MAX_RESPONSE): Promise<Uint8Array> => {
    const delegate = current.transport.delegate
    check(current, generation); await writeMessage(delegate, request, body)
    let waitingOnPerson = false
    for (let screens = 0; screens < 64; screens++) {
      const response = await readBounded(delegate, waitingOnPerson ? replyMs.human : replyMs.device, max)
      waitingOnPerson = false
      let transferred = false
      try {
        check(current, generation)
        if (response.type === 26) {
          if (!review || (current.emulator && typeof delegate.onButtonRequest !== 'function')) {
            await writeMessage(delegate, 20)
            const cancelled = await readBounded(delegate, replyMs.device); cancelled.body.fill(0)
            throw new MoneroError('Monero approval requires the emulator confirmation window')
          }
          await writeMessage(delegate, 27)
          waitingOnPerson = true
          continue
        }
        if (response.type === 18 || response.type === 41) {
          await writeMessage(delegate, 20)
          const cancelled = await readBounded(delegate, replyMs.device); cancelled.body.fill(0)
          throw new MoneroError('Unlock the KeepKey wallet first, then connect Monero again')
        }
        if (response.type === 3) throw new MoneroError('The KeepKey rejected or cancelled the Monero request')
        if (response.type !== responseType) throw new MoneroError('The KeepKey firmware does not support this Monero operation')
        transferred = true
        return response.body
      } finally { if (!transferred) response.body.fill(0) }
    }
    throw new MoneroError('Monero review exceeded its bound')
  }
  const actualAddress = async (current: Snapshot, generation: number, display: boolean) => {
    const request = concat([...PATH.map(part => numberField(1, part)), numberField(2, Number(display)), numberField(3, 0), numberField(4, 0), numberField(5, 0)])
    const body = await receive(current, generation, 540, 541, request, display)
    try { const fields = parseFields(body); if (fields.size !== 1) throw new MoneroError('Invalid Monero address response'); return decodeAddress(bytesField(fields, 1)) } finally { body.fill(0) }
  }
  const statusFrom = (value: unknown, current: Snapshot, expectedAddress: string): MoneroVaultStatus => {
    const data = value as Record<string, any>
    if (!data || data.network !== 'mainnet' || data.address !== expectedAddress || data.canSend !== false ||
        typeof data.monitorReady !== 'boolean' || !Array.isArray(data.transactions) || data.transactions.length > 10000) throw new MoneroError('Invalid Monero watch status')
    const balanceAtomic = atomic(data.balanceAtomic), unlockedBalanceAtomic = atomic(data.unlockedBalanceAtomic)
    if (BigInt(unlockedBalanceAtomic) > BigInt(balanceAtomic)) throw new MoneroError('Inconsistent Monero watch balance')
    const walletHeight = integer(data.walletHeight)
    const transactions = data.transactions.map((item: Record<string, unknown>) => {
      if (!item || typeof item.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(item.txid) || typeof item.locked !== 'boolean' ||
          (item.type !== undefined && item.type !== 'in' && item.type !== 'pool')) throw new MoneroError('Invalid Monero watch transaction')
      return { txid: item.txid.toLowerCase(), amountAtomic: atomic(item.amountAtomic), confirmations: integer(item.confirmations), locked: item.locked,
        ...(item.height === undefined ? {} : { height: integer(item.height) }), ...(item.type === undefined ? {} : { type: item.type as 'in' | 'pool' }) }
    })
    const updated = typeof data.updatedAt === 'string' ? Date.parse(data.updatedAt) : NaN
    const fresh = Number.isFinite(updated) && updated <= Date.now() + 30000 && Date.now() - updated <= 120000
    const ready = data.monitorReady && fresh && walletHeight >= current.config.restoreHeight
    return { available: true, enabled: true, deviceReady: true, connected: true, sidecarReady: true,
      network: 'mainnet', address: expectedAddress, balanceAtomic, unlockedBalanceAtomic, walletHeight, transactions,
      monitorReady: ready, emulatorReady: !current.emulator || matches(current),
      ...(Number.isFinite(updated) ? { updatedAt: new Date(updated).toISOString() } : {}),
      error: ready ? undefined : 'The Monero watch wallet is syncing or reconnecting', canSend: false, keyImagesSynced: false, spendStateKnown: false }
  }
  const bindingFor = (current: Snapshot) => {
    if (!bound || bound.snapshot.key !== current.key || bound.snapshot.wallet !== current.wallet || bound.snapshot.transport !== current.transport) throw new MoneroError('Connect the Monero watch wallet first')
    return bound
  }
  const keyImagesFor = (current: Snapshot) => synced && synced.key === current.key && synced.generation === epoch ? synced : null
  /** Every gate, in the order a user can fix them. Undefined means sending is possible. */
  const sendBlocker = (current: Snapshot, status: MoneroVaultStatus): MoneroSendBlocker | undefined => {
    if (unrelayed) return 'unrelayed'
    if (!current.emulator || !signingEmulator()) return 'emulator'
    if (!sidecar.isMoneroSendReady?.() || !sidecar.createMoneroTransfer || !sidecar.relayMoneroTransaction) return 'adapter'
    if (!status.monitorReady) return 'syncing'
    if (!keyImagesFor(current)) return 'key-images'
  }
  const relayUnrelayed = async (retry: boolean) => {
    const pending = unrelayed!
    try { await sidecar.relayMoneroTransaction!({ txHex: pending.txHex }) }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      // A definite rejection sent nothing. On a retry, "double spend" means these inputs are already
      // spent (normally by this same tx in the pool/chain), so it cannot pay twice either way.
      if (message.startsWith('The daemon rejected the transaction')) {
        unrelayed = null
        if (retry && /double spend/.test(message)) { void sidecar.refreshMoneroWatch?.().catch(() => {}); return }
        throw error
      }
      // Timeout, network or worker failure, or accepted-but-not-relayed: the outcome is unknown.
      throw new MoneroError(`The broadcast result is unknown for transaction ${pending.txid}. Check it on a block explorer; Retry broadcast resends this same transaction`)
    }
    unrelayed = null
    void sidecar.refreshMoneroWatch?.().catch(() => {})
  }
  const withSendState = (status: MoneroVaultStatus, current: Snapshot): MoneroVaultStatus => {
    const blocker = sendBlocker(current, status), keyImagesSynced = !!keyImagesFor(current)
    return { ...status, transactions: status.transactions.map(tx => ({ ...tx })), canSend: !blocker, keyImagesSynced, spendStateKnown: keyImagesSynced,
      ...(blocker ? { sendBlocked: blocker } : {}), ...(unrelayed ? { unrelayedTxid: unrelayed.txid } : {}) }
  }
  const deviceOperation = async <T,>(current: Snapshot, operation: () => Promise<T>, details: Parameters<Confirm>[1]): Promise<T> =>
    current.transport.lockDuring(async () => {
      activeDelegate = current.transport.delegate
      try { return current.emulator ? await confirm!(operation, details) : await operation() }
      finally { activeDelegate = null }
    })
  const getStatus = async (): Promise<MoneroVaultStatus> => {
    let current: Snapshot | null
    try { current = snapshot() } catch { stop(); return empty(!!getConfig().enabled, false, 'The Monero configuration or device transport is unavailable') }
    if (!current) { stop(); const config = getConfig(); return empty(config.enabled, false, config.offline ? 'Monero is unavailable in offline mode' : undefined) }
    if (!bound) return empty(true, true)
    if (bound.snapshot.key !== current.key || bound.snapshot.wallet !== current.wallet || bound.snapshot.transport !== current.transport) { stop(); return empty(true, true) }
    const authorized = bound, generation = epoch
    try {
      const value = await sidecar.getMoneroWalletStatus(); check(current, generation)
      if (!value || typeof value !== 'object' || (value as any).network !== 'mainnet' || (value as any).address !== authorized.address) {
        stop()
        return empty(true, true, 'The Monero monitor wallet changed; connect again')
      }
      lastGood = statusFrom(value, current, authorized.address)
      return withSendState(lastGood, current)
    } catch {
      if (!matches(current) || epoch !== generation) { stop(); return empty(!!getConfig().enabled, false) }
      if (lastGood) return withSendState({ ...lastGood, monitorReady: false, error: 'The Monero monitor is temporarily unavailable; showing the last wallet update' }, current)
      throw new MoneroError('The Monero watch wallet status is unavailable')
    }
  }
  return {
    stop,
    invalidate: stop,
    getStatus,
    async connect({ showDisplay = false }: { showDisplay?: boolean } = {}): Promise<MoneroVaultStatus> {
      if (typeof showDisplay !== 'boolean') throw new MoneroError('Invalid Monero address display option')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady(); busy = true; stop(); const generation = epoch
      let viewKey: Uint8Array | null = null
      try {
        const approved = await current.transport.lockDuring(async () => {
          activeDelegate = current.transport.delegate
          const operation = async () => {
            const address = await actualAddress(current, generation, showDisplay)
            const request = concat([...PATH.map(part => numberField(1, part)), numberField(2, 0)])
            const body = await receive(current, generation, 542, 543, request, true)
            try {
              const fields = parseFields(body)
              if (fields.size !== 2 || decodeAddress(bytesField(fields, 2)) !== address) throw new MoneroError('The approved Monero view key belongs to a different wallet')
              const key = bytesField(fields, 1)
              if (key.length !== 32 || !key.some(byte => byte !== 0)) throw new MoneroError('The KeepKey returned an invalid private view key')
              check(current, generation); return { address, viewKey: key.slice() }
            } finally { body.fill(0) }
          }
          try { return current.emulator ? await confirm!(operation, { operation: 'moneroConnect', chain: 'Monero' }) : await operation() }
          finally { activeDelegate = null }
        })
        viewKey = approved.viewKey
        const address = approved.address
        check(current, generation)
        if (!viewKey) throw new MoneroError('The KeepKey did not authorize Monero monitoring')
        await sidecar.startMoneroSidecar(); check(current, generation)
        const value = await sidecar.configureMoneroWatch({ walletId: `${engine.getDeviceState().deviceId}:${address}`, network: 'mainnet', address,
          viewKey, restoreHeight: current.config.restoreHeight, daemonUrl: current.config.daemonUrl })
        check(current, generation)
        const status = statusFrom(value, current, address)
        bound = { snapshot: current, address }; lastGood = status
        return { ...status, transactions: status.transactions.map(tx => ({ ...tx })) }
      } catch (error) {
        stop()
        // Never forward arbitrary subprocess/transport diagnostics that might contain credentials.
        if (error instanceof MoneroError) throw error
        throw new MoneroError('Unable to connect the Monero watch wallet; review the device and try again')
      } finally { viewKey?.fill(0); busy = false }
    },
    async getAddress({ showDisplay = false }: { showDisplay?: boolean } = {}): Promise<{ address: string; network: 'mainnet'; displayed: boolean }> {
      if (typeof showDisplay !== 'boolean') throw new MoneroError('Invalid Monero address display option')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady(), generation = epoch; busy = true
      try {
        return await current.transport.lockDuring(async () => {
          activeDelegate = current.transport.delegate
          const operation = () => actualAddress(current, generation, showDisplay)
          try {
            const address = current.emulator && showDisplay ? await confirm!(operation, { operation: 'moneroGetAddress', chain: 'Monero', to: bound?.address }) : await operation()
            check(current, generation)
            if (bound && bound.address !== address) { stop(); throw new MoneroError('The Monero wallet changed; connect again') }
            return { address, network: 'mainnet' as const, displayed: showDisplay }
          } finally { activeDelegate = null }
        })
      } finally { busy = false }
    },
    /** Device key images (530..535) for every wallet output, imported so the watch wallet knows which outputs are spent. */
    async syncKeyImages(): Promise<MoneroVaultStatus> {
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady(); bindingFor(current)
      if (!sidecar.exportMoneroOutputs || !sidecar.importMoneroKeyImages) throw new MoneroError('Monero key-image sync is unavailable in this build')
      busy = true; synced = null; prepared = null
      const generation = epoch
      try {
        const outputs = await sidecar.exportMoneroOutputs(); check(current, generation)
        if (!outputs.length) throw new MoneroError('The watch wallet has no received outputs to sync yet')
        if (outputs.length > 64) throw new MoneroError('This preview syncs at most 64 wallet outputs')
        const proofs = await deviceOperation(current, async () => {
          (await receive(current, generation, 530, 531, keyImageInitRequest(outputs), true)).fill(0)
          const sealed: Array<{ iv: Uint8Array; blob: Uint8Array }> = []
          for (let start = 0; start < outputs.length; start += 4) {
            const batch = outputs.slice(start, start + 4)
            const body = await receive(current, generation, 532, 533, concat(batch.map(output => lengthField(1, transferDetails(output)))), false)
            try {
              const fields = parseFields(body), records = fields.get(1) ?? []
              if (fields.size !== 1 || records.length !== batch.length) throw new MoneroError('Invalid Monero key-image response')
              for (const record of records) {
                const parts = record instanceof Uint8Array ? parseFields(record) : null
                if (!parts || parts.size !== 2) throw new MoneroError('Invalid Monero key-image response')
                sealed.push({ iv: bytesField(parts, 1).slice(), blob: bytesField(parts, 3).slice() })
              }
            } finally { body.fill(0) }
          }
          const final = await receive(current, generation, 534, 535, new Uint8Array(), false)
          try {
            const fields = parseFields(final)
            if (fields.size !== 1) throw new MoneroError('Invalid Monero key-image response')
            const key = bytesField(fields, 1)
            return sealed.map(record => openKeyImage(key, record.iv, record.blob))
          } finally { final.fill(0) }
        }, { operation: 'moneroSyncKeyImages', chain: 'Monero' })
        check(current, generation)
        await sidecar.importMoneroKeyImages({ offset: 0, signedKeyImages: proofs }); check(current, generation)
        synced = { key: current.key, generation, owned: new Map(outputs.map((output, i) => [output.outKey, { amountAtomic: output.amountAtomic, keyImage: proofs[i].keyImage }])) }
      } catch (error) { synced = null; throw publicError(error, 'Unable to sync Monero key images; review the device and try again') }
      finally { busy = false }
      return getStatus()
    },
    /** Build with the watch wallet, decode with the adapter, and refuse anything but the user's payment plus own change. */
    async prepareSend(params: { address?: unknown; amountAtomic?: unknown } = {}): Promise<MoneroSendReview & { prepareId: string }> {
      const { address, amountAtomic } = params ?? {}
      const kind = moneroAddressKind(address)
      if (kind === 'integrated') throw new MoneroError('Integrated addresses are not supported by this preview')
      if (typeof address !== 'string' || (kind !== 'standard' && kind !== 'subaddress')) throw new MoneroError('Enter a valid Monero mainnet address')
      if (typeof amountAtomic !== 'string' || !/^[1-9][0-9]{0,19}$/.test(amountAtomic) || BigInt(amountAtomic) > MAX_UINT64) throw new MoneroError('Enter a positive XMR amount')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady(), binding = bindingFor(current)
      if (address === binding.address) throw new MoneroError('Sending to this same wallet is not supported by this preview')
      if (unrelayed) throw new MoneroError(BLOCKER_MESSAGES.unrelayed)
      busy = true; prepared = null
      const generation = epoch
      try {
        const status = await getStatus(), keyImages = keyImagesFor(current)
        if (!status.canSend || !keyImages || !sidecar.createMoneroTransfer) throw new MoneroError(status.sendBlocked ? BLOCKER_MESSAGES[status.sendBlocked] : 'Monero sending is unavailable')
        const draft = await sidecar.createMoneroTransfer({ address, amountAtomic, priority: 0 }); check(current, generation)
        const review = reviewPlan(draft.plan, { address, amountAtomic, walletAddress: binding.address,
          walletFeeAtomic: draft.feeAtomic, walletAmountAtomic: draft.amountAtomic, owned: keyImages.owned })
        prepared = { id: randomBytes(16).toString('hex'), key: current.key, generation, expires: Date.now() + PREPARED_LIFETIME_MS, draft, review }
        return { prepareId: prepared.id, ...review, outputs: review.outputs.map(output => ({ ...output })) }
      } catch (error) { throw publicError(error, 'Unable to prepare the Monero transaction') }
      finally { busy = false }
    },
    /** Sign the reviewed plan once (65000/65001), check the signed bytes against it, then relay. */
    async send(params: { prepareId?: unknown } = {}): Promise<{ txid: string }> {
      const id = params?.prepareId, pending = prepared
      if (typeof id !== 'string' || !pending || pending.id !== id || Date.now() > pending.expires) throw new MoneroError('This Monero send review expired; prepare it again')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      prepared = null
      const current = requireReady()
      const keyImages = bound && bound.snapshot.key === current.key && bound.snapshot.wallet === current.wallet &&
        bound.snapshot.transport === current.transport ? keyImagesFor(current) : null
      if (current.key !== pending.key || epoch !== pending.generation || !keyImages) { stop(); throw new MoneroError('The Monero wallet or configuration changed; connect again') }
      if (!current.emulator || !signingEmulator() || !sidecar.relayMoneroTransaction) throw new MoneroError(BLOCKER_MESSAGES.emulator)
      busy = true
      const { draft, review, generation } = pending
      try {
        const signed = await deviceOperation(current, async () => {
          const body = await receive(current, generation, 65000, 65001, signRequest(draft.plan), true, MAX_SIGNED_RESPONSE)
          try {
            const fields = parseFields(body), blob = bytesField(fields, 1), hash = bytesField(fields, 2)
            if (fields.size !== 2 || hash.length !== 32 || !blob.length || blob.length > 16384) throw new MoneroError('The KeepKey returned an invalid Monero transaction')
            return { blob: blob.slice(), hash: Buffer.from(hash).toString('hex') }
          } finally { body.fill(0) }
        }, { operation: 'moneroSend', chain: 'Monero', to: review.recipient, value: formatXmrAtomic(review.amountAtomic), fee: formatXmrAtomic(review.feeAtomic) })
        check(current, generation)
        const parsed = parseSignedTransaction(signed.blob)
        checkSignedTransaction(parsed, signed.hash, draft.plan, keyImages.owned)
        // These inputs are now spent: another send needs a fresh key-image sync.
        synced = null
        unrelayed = { txid: parsed.hash, txHex: Buffer.from(signed.blob).toString('hex') }
        await relayUnrelayed(false)
        return { txid: parsed.hash }
      } catch (error) { throw publicError(error, 'Unable to send the Monero transaction') }
      finally { busy = false }
    },
    /** Re-broadcast the same signed bytes after an unknown relay outcome; never builds a new transaction. */
    async retryRelay(): Promise<{ txid: string }> {
      if (!unrelayed) throw new MoneroError('No Monero transaction is waiting to be broadcast')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const txid = unrelayed.txid
      busy = true
      try { await relayUnrelayed(true); return { txid } }
      catch (error) { throw publicError(error, 'Unable to broadcast the Monero transaction') }
      finally { busy = false }
    },
  }
}
