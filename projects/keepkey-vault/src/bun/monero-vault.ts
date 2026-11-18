/** Monero receiving bridge. Only an explicitly approved device view key reaches the local sidecar. */
import type { MoneroCachedBalance, MoneroConnectionInfo } from '../shared/types'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { MoneroCoreVerifier } from './monero-device-signing'
import { preloadNativeContactProof } from './native-contact-proof'
import { checkStreamSigningBounds, signMoneroStream, streamNeedsMonitoringKey, validateStreamMonitoringKey, supportsMoneroSigning, STREAM_ERRORS, type MoneroSigningPhase, type MoneroText } from './monero-stream-signer'
import { MONERO_DEVICE_CANDIDATE_SHA256, MONERO_DEVICE_SUBADDRESS_CANDIDATE_SHA256 } from './monero-device-signing'
import type { MoneroWatchStore } from './monero-watch-store'
import * as managedSidecar from './monero-sidecar'
import type { MoneroOutputRecord, MoneroTransferDraft } from './monero-sidecar'
import { MAX_KEY_IMAGE_OUTPUTS, MAX_WALLET_OUTPUTS, PUBLIC_ERRORS, WATCH_NODE_UNREACHABLE, WATCH_SCANNING } from '../../monero-cli/src/protocol'
import type { MoneroDiscardGuard, MoneroPendingBroadcast, MoneroPendingStore } from './monero-pending'
import type { MoneroTxLookup } from '../../monero-cli/src/protocol'
import { formatXmrAtomic, moneroAddressKind } from '../shared/monero-address'
import { assertMoneroStandardWallet, moneroHiddenWallet, MoneroWalletPolicyError, MONERO_STANDARD_WALLET_REQUIRED } from '../shared/monero-wallet-policy'
import { MAX_FEE_ATOMIC, MAX_SIGNED_RESPONSE, MAX_UINT64, MONERO_PATH as PATH, MoneroError, bytesField, checkSignedTransaction, concat, keyImageInitRequest,
  lengthField, numberField, openKeyImage, parseFields, parseSignedTransaction, reviewPlan, signRequest, transferDetails,
  type MoneroSendReview } from './monero-wire'

export type { MoneroSendReview } from './monero-wire'
// Public IDs from device-protocol at alpha 66df3e24c. Pinned research artifacts
// predate that allocation; never probe/fallback after a rejected device request.
const FIRMWARE_WATCH = { getAddress: 1800, address: 1801, getWatchKey: 1802, watchKey: 1803,
  imageInit: 1804, imageInitAck: 1805, imageStep: 1806, imageStepAck: 1807, imageFinal: 1808, imageFinalAck: 1809 }
const RESEARCH_WATCH = { getAddress: 540, address: 541, getWatchKey: 542, watchKey: 543,
  imageInit: 530, imageInitAck: 531, imageStep: 532, imageStepAck: 533, imageFinal: 534, imageFinalAck: 535 }
const RESEARCH_FIRMWARE = new Set([MONERO_DEVICE_CANDIDATE_SHA256, MONERO_DEVICE_SUBADDRESS_CANDIDATE_SHA256])
const MAX_RESPONSE = 4096
const PRIMARY_ADDRESS = /^4[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/
const PREPARED_LIFETIME_MS = 10 * 60 * 1000
/** The watch wallet scans subaddresses 0/0..0/199 (wallet-rpc's default minor lookahead). */
export const MAX_RECEIVE_SUBADDRESS = 199
export type MoneroSendBlocker = 'unrelayed' | 'emulator' | 'firmware' | 'adapter' | 'syncing' | 'key-images'
const BLOCKER_MESSAGES: Record<MoneroSendBlocker, string> = {
  unrelayed: 'A signed transaction may already be broadcast: retry broadcasting that same transaction first',
  firmware: 'Monero hardware signing is not available for this firmware in this build',
  emulator: 'Sending needs the Monero signing (research) emulator build',
  adapter: 'This Vault build is missing required Monero wallet tools',
  syncing: 'Wait for the watch wallet to finish syncing',
  'key-images': 'Sync key images on KeepKey before sending',
}
export const KEY_IMAGES_STALE = 'New XMR arrived since the last key-image sync, so the wallet cannot yet tell which outputs are spent. Sync key images on KeepKey again before sending'
export const SELF_SEND = "This is this wallet's own main address, which also receives the change, so it cannot be the recipient too. To move XMR within this wallet, send it to one of its subaddresses"
const NOT_ENOUGH = 'Not enough unlocked XMR for this amount and fee'
export const SUPERSEDED = 'The inputs of the pending transaction were spent by a different transaction, so it can never be sent. It was not sent, and nothing more will be sent from it'

export interface MoneroVaultConfig {
  enabled: boolean
  offline: boolean
  daemonUrl: string
  /** Earliest block the watch wallet scans; 0 (also when unset) scans everything. */
  restoreHeight: number
}
export interface MoneroVaultStatus {
  cachedBalance?: MoneroCachedBalance
  connection?: MoneroConnectionInfo
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
  /** What the balance means now: not connected (unknown), still scanning, current, or the last update (node down). */
  syncState: 'not-connected' | 'scanning' | 'ready' | 'unreachable'
  signingPhase?: MoneroSigningPhase
  connectionPhase?: 'device' | 'wallet'
  /** Scan start and target, for progress. */
  restoreHeight?: number
  daemonHeight?: number
  emulatorReady: boolean
  updatedAt?: string
  error?: string
  signingReady?: boolean
  canSend: boolean
  /** The first unmet send gate, when sending is unavailable. */
  sendBlocked?: MoneroSendBlocker
  unrelayedTxid?: string
  /** This session imported device key images for every wallet output. */
  keyImagesSynced: boolean
  /** Key images were synced, but outputs arrived since. */
  keyImagesStale?: boolean
  /** The node's last answer about the pending tx: it does not have it; discardable only if its inputs are unspent.
   *  relayNode is where it was sent (when recorded); checkedNode is the node that answered. */
  unrelayedCheck?: { state: 'unknown'; discardable: boolean; checkedAt: string; relayNode?: string; checkedNode: string }
  /** A discarded tx that could still be mined: the next send must reuse one of its inputs. */
  discardedTxid?: string
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
  readonly isPassphraseWallet?: boolean
  wallet: { transport?: unknown } | null
  emuDelegate?: unknown
  currentSeedEthAddress?: string | null
  getDeviceState(): { state: string; deviceId?: string; firmwareVersion?: string; activeTransport?: unknown; isHiddenWallet?: boolean; firmwareHash?: string; capabilities?: readonly number[] }
}
type Confirm = (operation: () => Promise<any>, details: { operation: string; chain?: string; to?: string; value?: string; fee?: string }) => Promise<any>
export interface MoneroWatchSidecar {
  startMoneroSidecar(): Promise<void>
  stopMoneroSidecar(): void
  configureMoneroWatch(options: { walletId: string; network: 'mainnet'; address: string; viewKey: Uint8Array; restoreHeight: number; daemonUrl: string }): Promise<unknown>
  getMoneroWalletStatus(): Promise<unknown>
  // Research send path; absent in a watch-only sidecar.
  hasMoneroSigningTools?(): boolean
  isMoneroSignerWorkerReady?(): boolean
  isMoneroSendReady?(): boolean
  exportMoneroOutputs?(): Promise<MoneroOutputRecord[]>
  importMoneroKeyImages?(input: { offset: number; signedKeyImages: Array<{ keyImage: string; signature: string }> }): Promise<unknown>
  createMoneroTransfer?(input: { address: string; amountAtomic: string; priority: number }): Promise<MoneroTransferDraft>
  relayMoneroTransaction?(input: { txHex: string }): Promise<unknown>
  lookupMoneroTransaction?(input: { txid: string; keyImages: string[] }): Promise<MoneroTxLookup>
  refreshMoneroWatch?(): Promise<unknown>
}
type Owned = Map<string, { amountAtomic: string; keyImage: string }>
type Prepared = { id: string; key: string; generation: number; expires: number; draft: MoneroTransferDraft; review: MoneroSendReview }
type Snapshot = { messages: typeof FIRMWARE_WATCH; key: string; deviceId: string; wallet: NonNullable<Engine['wallet']>; transport: Transport; config: MoneroVaultConfig; emulator: boolean; streamed: boolean; watchScope: string | null }
type Synced = { key: string; generation: number; owned: Owned; txids: Set<string>; balanceAtomic: bigint }
type PendingCheck = { state: 'unknown'; discardable: boolean; checkedAt: string; relayNode?: string; checkedNode: string }
type Message = { type: number; body: Uint8Array }

function empty(enabled: boolean, deviceReady: boolean, error?: string): MoneroVaultStatus {
  return { available: false, enabled, deviceReady, connected: false, sidecarReady: false,
    network: 'mainnet', address: '', balanceAtomic: '0', unlockedBalanceAtomic: '0', walletHeight: 0,
    transactions: [], monitorReady: false, syncState: 'not-connected', emulatorReady: false, error, canSend: false, keyImagesSynced: false, spendStateKnown: false }
}
/** Safe polling result: never retain another wallet's address/balance while hidden. */
export const moneroHiddenWalletStatus = (enabled: boolean): MoneroVaultStatus => empty(enabled, false, MONERO_STANDARD_WALLET_REQUIRED)
function checkedAddress(value: unknown, minor = 0): string {
  const valid = typeof value === 'string' && (minor === 0 ? PRIMARY_ADDRESS.test(value) : moneroAddressKind(value) === 'subaddress')
  if (!valid) throw new MoneroError('The device returned an invalid Monero mainnet address')
  return value as string
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
  if (error instanceof MoneroWalletPolicyError) return new MoneroError(error.message)
  return new MoneroError(error instanceof Error && (PUBLIC_ERRORS as readonly string[]).includes(error.message) ? error.message : fallback)
}
/** Interpret only the numeric Failure code. Firmware text may contain private request details. */
function deviceFailure(body: Uint8Array, request: number): MoneroError {
  let code: bigint | undefined
  try {
    const values = parseFields(body).get(1)
    if (values?.length === 1 && typeof values[0] === 'bigint') code = values[0]
  } catch { /* Malformed Failure remains a fixed, scrubbed diagnostic. */ }
  const messages: Record<string, string> = {
    '1': `The KeepKey firmware does not recognize Monero request ${request}; update Vault and firmware together`,
    '2': 'The KeepKey expected a button acknowledgement for the Monero request',
    '3': 'The KeepKey received an invalid Monero request; update Vault and firmware together',
    '4': 'The KeepKey cancelled the Monero request',
    '5': 'Unlock the KeepKey wallet first, then connect Monero again',
    '6': 'KeepKey PIN entry was cancelled; unlock the wallet and try Monero again',
    '7': 'The KeepKey PIN was invalid; unlock the wallet and try Monero again',
    '11': 'The KeepKey wallet is not initialized',
    '99': 'The KeepKey reported a firmware error during the Monero request',
  }
  return new MoneroError(messages[String(code)] ?? (code === undefined
    ? 'The KeepKey rejected the Monero request without a valid failure code'
    : `The KeepKey rejected the Monero request (firmware failure code ${code})`))
}
function decodeAddress(bytes: Uint8Array, minor = 0): string { return checkedAddress(new TextDecoder('utf-8', { fatal: true }).decode(bytes), minor) }
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
  onTransportFailure, coreVerifier, text = s => s, watchStore, replyMs = { device: MONERO_DEVICE_REPLY_MS, human: MONERO_HUMAN_REPLY_MS }, pendingStore = { load: () => [], save() {} } }: {
  /** Invalidate/re-pair only the transport that failed; never replay the device operation. */
  onTransportFailure?: (transport: unknown) => Promise<unknown> | void
  coreVerifier?: MoneroCoreVerifier
  text?: MoneroText
  watchStore?: MoneroWatchStore
  engine: Engine; confirm?: Confirm; getConfig: () => MoneroVaultConfig; sidecar?: MoneroWatchSidecar
  /** The running emulator is a verified signing-enabled research build. */
  signingEmulator?: () => boolean
  /** Raw read bounds (tests shorten them). */
  replyMs?: { device: number; human: number }
  /** Where unknown-outcome broadcasts survive an app restart (src/bun/monero-pending.ts). */
  pendingStore?: MoneroPendingStore
}) {
  let epoch = 0, busy = false
  let signingPhase: MoneroSigningPhase | undefined
  let signingViewKey: Uint8Array | null = null
  let connectionPhase: 'device' | 'wallet' | undefined
  let activeDelegate: Delegate | null = null
  let bound: { snapshot: Snapshot; address: string } | null = null
  let lastGood: MoneroVaultStatus | null = null
  let cachedBalance: { scope: string; value: MoneroCachedBalance } | null = null
  let loadedBalanceScope: string | null = null
  let balanceWrite: Promise<unknown> = Promise.resolve()
  let loadingBalance: { scope: string; promise: Promise<MoneroCachedBalance | null> } | null = null
  let synced: Synced | null = null
  let prepared: Prepared | null = null
  // Signed txs whose broadcast outcome is unknown, per wallet, persisted. Kept across reconnects and
  // restarts so a retry re-sends these exact bytes instead of building a second, different payment.
  const pending = new Map<string, MoneroPendingBroadcast>()
  const sent = new Map<string, MoneroPendingBroadcast>()
  const persistPending = () => { assertMoneroStandardWallet(engine); pendingStore.save([...pending.values()]) }
  /** The node's answer for each wallet's pending tx (this run only). */
  const checks = new Map<string, PendingCheck>()
  // Discarded txs whose inputs are still unspent, per wallet, persisted (see MoneroDiscardGuard).
  const guards = new Map<string, MoneroDiscardGuard>()
  let persistenceLoaded = false
  const loadPersistence = () => {
    assertMoneroStandardWallet(engine)
    if (persistenceLoaded) return
    for (const record of pendingStore.loadSent?.() ?? []) sent.set(`${record.wallet}:${record.txid}`, record)
    persistenceLoaded = true
    try { for (const record of pendingStore.load()) pending.set(record.wallet, record) }
    catch { console.warn('[monero] Could not read pending broadcasts') }
    try { for (const guard of pendingStore.loadGuards?.() ?? []) guards.set(guard.wallet, guard) }
    catch { console.warn('[monero] Could not read discarded broadcasts') }
  }
  const persistGuards = () => { assertMoneroStandardWallet(engine); pendingStore.saveGuards?.([...guards.values()]) }
  const clearGuard = (wallet: string) => { assertMoneroStandardWallet(engine); guards.delete(wallet); try { persistGuards() } catch { console.warn('[monero] Could not clear a discard guard') } }
  const walletKey = (current: Snapshot, address: string) => `${current.deviceId}:${address}`
  /** A cached amount belongs to the current standard seed and device, independent of node/scan settings. */
  const balanceScope = (): string | null => {
    if (moneroHiddenWallet(engine) || !getConfig().enabled || !engine.wallet) return null
    const state = engine.getDeviceState(), seed = engine.currentSeedEthAddress?.toLowerCase()
    if (!state.deviceId || !['ready', 'needs_pin'].includes(state.state) || !seed || !/^0x[0-9a-f]{40}$/.test(seed)) return null
    return JSON.stringify(['mainnet', PATH, state.deviceId, seed, false])
  }
  const withCachedBalance = async (status: MoneroVaultStatus): Promise<MoneroVaultStatus> => {
    const scope = balanceScope(), generation = epoch
    if (!scope) return status
    if (loadedBalanceScope !== scope && watchStore?.loadBalance) {
      try {
        if (loadingBalance?.scope !== scope) loadingBalance = {scope, promise: watchStore.loadBalance(scope)}
        const value = await loadingBalance.promise
        if (epoch !== generation || balanceScope() !== scope) return empty(!!getConfig().enabled, false)
        loadedBalanceScope = scope
        // A concurrently observed live balance takes precedence over an older disk read.
        if (value && (cachedBalance?.scope !== scope || Date.parse(value.updatedAt) > Date.parse(cachedBalance.value.updatedAt))) cachedBalance = {scope,value}
      } catch { /* Secure storage unavailable: keep any current amount; never substitute plaintext. */ }
      finally { if (loadingBalance?.scope === scope) loadingBalance = null }
    }
    if (epoch !== generation || balanceScope() !== scope) return empty(!!getConfig().enabled, false)
    return cachedBalance?.scope === scope ? {...status, cachedBalance: {...cachedBalance.value}} : status
  }
  const rememberBalance = (current: Snapshot, status: MoneroVaultStatus) => {
    if (!status.monitorReady || !status.updatedAt || status.walletHeight <= 0 || !current.watchScope || balanceScope() !== current.watchScope) return
    // A failed/locked read cannot authorize replacing a stronger snapshot that
    // may already be on disk. Retry loading it on the next status observation.
    if (watchStore?.loadBalance && loadedBalanceScope !== current.watchScope) return
    const value: MoneroCachedBalance = {balanceAtomic:status.balanceAtomic,unlockedBalanceAtomic:status.unlockedBalanceAtomic,
      walletHeight:status.walletHeight,updatedAt:status.updatedAt,spendStateKnown:status.spendStateKnown}
    if (cachedBalance?.scope === current.watchScope && cachedBalance.value.spendStateKnown && !status.spendStateKnown && status.balanceAtomic !== '0') return
    if (cachedBalance?.scope === current.watchScope && Date.parse(value.updatedAt) < Date.parse(cachedBalance.value.updatedAt)) return
    if (cachedBalance?.scope === current.watchScope && JSON.stringify(cachedBalance.value) === JSON.stringify(value)) return
    cachedBalance = {scope:current.watchScope,value}; loadedBalanceScope = current.watchScope
    // Display snapshots are independent of transaction authorization. OS storage failure must not block a live wallet.
    const scope = current.watchScope, address = status.address
    balanceWrite = balanceWrite.then(() => watchStore?.saveBalance?.(scope, address, value)).catch(() => {console.warn('[monero] Last known balance could not be saved securely')})
  }
  const snapshot = (): Snapshot | null => {
    assertMoneroStandardWallet(engine)
    const config = getConfig(), state = engine.getDeviceState(), wallet = engine.wallet
    if (!config.enabled || config.offline || state.state !== 'ready' || !wallet || !state.deviceId) return null
    const streamed = supportsMoneroSigning(state.capabilities)
    if (!Number.isSafeInteger(config.restoreHeight) || config.restoreHeight < 0) throw new MoneroError('Invalid Monero restore height')
    let url: URL
    try { url = new URL(config.daemonUrl) } catch { throw new MoneroError('Configure a Monero daemon URL first') }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.hash || url.search) throw new MoneroError('Use HTTPS for a remote Monero daemon or HTTP for an explicit loopback daemon')
    const transport = wallet.transport as Transport | undefined
    if (!transport?.delegate || typeof transport.lockDuring !== 'function' ||
        typeof transport.delegate.readChunk !== 'function' || typeof transport.delegate.writeChunk !== 'function') throw new MoneroError('The Monero device transport is unavailable')
    if (engine.isEmulator && (!confirm || transport.delegate !== engine.emuDelegate)) throw new MoneroError('The emulator confirmation window is unavailable')
    const key = JSON.stringify([state.deviceId, state.activeTransport, state.isHiddenWallet, state.firmwareHash, streamed,
      engine.currentSeedEthAddress, config.daemonUrl, config.restoreHeight])
    const seed = engine.currentSeedEthAddress?.toLowerCase()
    const watchScope = seed && /^0x[0-9a-f]{40}$/.test(seed) ? JSON.stringify(['mainnet', PATH, state.deviceId, seed, !!state.isHiddenWallet]) : null
    const messages = engine.isEmulator || RESEARCH_FIRMWARE.has(state.firmwareHash ?? '') ? RESEARCH_WATCH : FIRMWARE_WATCH
    return { messages, key, deviceId: state.deviceId, wallet, transport, config: { ...config }, emulator: engine.isEmulator, streamed, watchScope }
  }
  const matches = (expected: Snapshot): boolean => {
    try { const current = snapshot(); return !!current && current.key === expected.key && current.wallet === expected.wallet && current.transport === expected.transport } catch { return false }
  }
  const stop = () => {
    epoch++; bound = null; lastGood = null; synced = null; prepared = null
    connectionPhase = undefined; signingPhase = undefined
    signingViewKey?.fill(0); signingViewKey = null
    try { sidecar.stopMoneroSidecar() } catch { /* stop must still invalidate local authorization */ }
    if (activeDelegate) void writeMessage(activeDelegate, 20).catch(() => {})
  }
  const check = (expected: Snapshot, generation: number) => {
    assertMoneroStandardWallet(engine)
    if (epoch !== generation || !matches(expected)) throw new MoneroError('The Monero wallet or configuration changed; connect again')
  }
  const requireReady = (): Snapshot => {
    const current = snapshot()
    if (!current) throw new MoneroError(getConfig().offline ? 'Monero is unavailable in offline mode' : !getConfig().enabled ? 'Monero is disabled in settings' : 'Unlock and connect a KeepKey before connecting Monero')
    loadPersistence()
    return current
  }
  const receive = async (current: Snapshot, generation: number, request: number, responseType: number, body: Uint8Array, review: boolean, max = MAX_RESPONSE): Promise<Uint8Array> => {
    const delegate = current.transport.delegate
    try {
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
        if (response.type === 3) throw deviceFailure(response.body, request)
        if (response.type !== responseType) throw new MoneroError('The KeepKey firmware does not support this Monero operation')
        transferred = true
        return response.body
      } finally { if (!transferred) response.body.fill(0) }
    }
    throw new MoneroError('Monero review exceeded its bound')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const transportLost = /did not answer the Monero request|LIBUSB_(?:ERROR_(?:NOT_FOUND|NO_DEVICE|PIPE|IO)|TRANSFER_(?:ERROR|NO_DEVICE))|device (?:was disconnected|is not opened)/i.test(message)
      if (transportLost && engine.wallet?.transport === current.transport) {
        stop()
        try { void Promise.resolve(onTransportFailure?.(current.transport)).catch(() => {}) }
        catch { /* The failed transport remains unauthorized even if re-pairing fails. */ }
      }
      throw error
    }
  }
  const actualAddress = async (current: Snapshot, generation: number, display: boolean, minor = 0) => {
    const request = concat([...PATH.map(part => numberField(1, part)), numberField(2, Number(display)), numberField(3, 0), numberField(4, 0), numberField(5, minor)])
    const body = await receive(current, generation, current.messages.getAddress, current.messages.address, request, display)
    try { const fields = parseFields(body); if (fields.size !== 1) throw new MoneroError('Invalid Monero address response'); return decodeAddress(bytesField(fields, 1), minor) } finally { body.fill(0) }
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
    const restoreHeight = current.config.restoreHeight
    const ready = data.monitorReady && fresh && walletHeight >= restoreHeight
    const daemonHeight = data.daemonHeight === undefined ? undefined : integer(data.daemonHeight)
    // A refresh that failed (node down, local RPC stopped) keeps the last balance, labelled; a long scan is not an error.
    const unreachable = !ready && typeof data.error === 'string' && data.error !== WATCH_SCANNING
    return { available: true, enabled: true, deviceReady: true, connected: true, sidecarReady: true,
      network: 'mainnet', address: expectedAddress, balanceAtomic, unlockedBalanceAtomic, walletHeight, transactions,
      monitorReady: ready, syncState: ready ? 'ready' : unreachable ? 'unreachable' : 'scanning', restoreHeight,
      ...(daemonHeight === undefined ? {} : { daemonHeight }), emulatorReady: !current.emulator || matches(current),
      ...(Number.isFinite(updated) ? { updatedAt: new Date(updated).toISOString() } : {}),
      error: unreachable ? WATCH_NODE_UNREACHABLE : undefined, canSend: false, keyImagesSynced: false, spendStateKnown: false }
  }
  const bindingFor = (current: Snapshot) => {
    if (!bound || bound.snapshot.key !== current.key || bound.snapshot.wallet !== current.wallet || bound.snapshot.transport !== current.transport) throw new MoneroError('Connect the Monero watch wallet first')
    return bound
  }
  const keyImagesFor = (current: Snapshot) => synced && synced.key === current.key && synced.generation === epoch ? synced : null
  /** Synced key images cover the outputs known at sync time; a new incoming tx or a higher balance means new, unsynced outputs. */
  const keyImagesStale = (images: Synced, status: MoneroVaultStatus) =>
    status.transactions.some(tx => !images.txids.has(tx.txid)) || BigInt(status.balanceAtomic) > images.balanceAtomic
  const pendingFor = (current: Snapshot) => bound ? pending.get(walletKey(current, bound.address)) : undefined
  /** Signing is a prerequisite for onboarding or exposing a deposit address. */
  const signingBlocker = (current: Snapshot): 'emulator' | 'firmware' | 'adapter' | undefined => {
    if (!current.streamed && !(current.emulator && signingEmulator())) return current.emulator ? 'emulator' : 'firmware'
    if (current.streamed && !coreVerifier?.available()) return 'adapter'
    if (!(sidecar.hasMoneroSigningTools?.() ?? sidecar.isMoneroSendReady?.()) || !sidecar.createMoneroTransfer || !sidecar.relayMoneroTransaction) return 'adapter'
  }
  const requireSigning = (current: Snapshot) => {
    const blocker = signingBlocker(current)
    if (blocker) throw new MoneroError(BLOCKER_MESSAGES[blocker])
  }
  /** Every gate, in the order a user can fix them. Undefined means sending is possible. */
  const sendBlocker = (current: Snapshot, status: MoneroVaultStatus): MoneroSendBlocker | undefined => {
    if (pendingFor(current)) return 'unrelayed'
    const unavailable = signingBlocker(current)
    if (unavailable) return unavailable
    if (!sidecar.isMoneroSendReady?.() || !sidecar.createMoneroTransfer || !sidecar.relayMoneroTransaction) return 'adapter'
    if (!status.monitorReady) return 'syncing'
    const images = keyImagesFor(current)
    if (!images || keyImagesStale(images, status)) return 'key-images'
  }
  const settlePending = (wallet: string) => {
    assertMoneroStandardWallet(engine)
    const record = pending.get(wallet)
    if (record?.transactionKeys) {
      const id = `${wallet}:${record.txid}`, previous = sent.get(id)
      sent.set(id, record)
      try { pendingStore.saveSent?.([...sent.values()]) }
      catch {
        if (previous) sent.set(id, previous); else sent.delete(id)
        throw new MoneroError('The Monero payment-proof record could not be saved; the transaction remains pending')
      }
    }
    pending.delete(wallet); checks.delete(wallet)
    try { persistPending() } catch { console.warn('[monero] Could not clear a pending broadcast record') }
  }
  /** Ask the node where the pending tx is. In its pool or a block: it was sent (settled). Not there but its
   *  inputs spent on chain: another tx spent them, so this one can never land (settled). Otherwise it stays
   *  pending, discardable only if every input is still unspent. */
  const resolvePending = async (wallet: string): Promise<'sent' | 'superseded' | 'unknown' | 'unchecked'> => {
    const record = pending.get(wallet)
    if (!record || !sidecar.lookupMoneroTransaction) return 'unchecked'
    let found: MoneroTxLookup
    try {
      const keyImages = parseSignedTransaction(Uint8Array.from(Buffer.from(record.txHex, 'hex'))).inputs.map(input => input.keyImage)
      found = await sidecar.lookupMoneroTransaction({ txid: record.txid, keyImages })
    } catch { assertMoneroStandardWallet(engine); checks.delete(wallet); return 'unchecked' }
    assertMoneroStandardWallet(engine)
    if (pending.get(wallet) !== record) return 'unchecked'
    if (found.state !== 'unknown') { settlePending(wallet); void sidecar.refreshMoneroWatch?.().catch(() => {}); return 'sent' }
    if (found.keyImages.includes('spent')) { settlePending(wallet); return 'superseded' }
    checks.set(wallet, { state: 'unknown', discardable: found.keyImages.every(state => state === 'unspent'), checkedAt: new Date().toISOString(),
      ...(record.node ? { relayNode: record.node } : {}), checkedNode: getConfig().daemonUrl })
    return 'unknown'
  }
  const unknownOutcome = (record: MoneroPendingBroadcast) => new MoneroError(`The broadcast result is unknown for transaction ${record.txid}: the node does not have it yet. Check it on a block explorer; Retry broadcast resends this same transaction`)
  /** Broadcast the pending bytes once. Only a first-attempt explicit rejection means nothing was sent; any other failure,
   *  including the "Not relayed" a node answers for a tx it already has, is settled by looking the txid up. */
  const relayPending = async (wallet: string, retry: boolean) => {
    assertMoneroStandardWallet(engine)
    const record = pending.get(wallet)!
    const outcome = async () => {
      const result = await resolvePending(wallet)
      if (result === 'sent') return
      if (result === 'superseded') throw new MoneroError(SUPERSEDED)
      throw unknownOutcome(record)
    }
    if (retry) { const first = await resolvePending(wallet); if (first === 'sent') return; if (first === 'superseded') throw new MoneroError(SUPERSEDED) }
    try { await sidecar.relayMoneroTransaction!({ txHex: record.txHex }) }
    catch (error) {
      assertMoneroStandardWallet(engine)
      const message = error instanceof Error ? error.message : ''
      // "double spend": these inputs are spent, by this tx (then it was sent) or by another one; ask the node which.
      if (message === 'The daemon rejected the transaction: double spend') return outcome()
      // A retry refusal says nothing about an earlier attempt on another node.
      if (message.startsWith('The daemon rejected the transaction')) {
        if (!retry) settlePending(wallet)
        throw error
      }
      return outcome()
    }
    assertMoneroStandardWallet(engine)
    settlePending(wallet)
    void sidecar.refreshMoneroWatch?.().catch(() => {})
  }
  const withSendState = async (status: MoneroVaultStatus, current: Snapshot, generation: number): Promise<MoneroVaultStatus> => {
    // Load before considering this observation for persistence: connect may
    // finish before the first startup poll or while that poll is still reading.
    await withCachedBalance(status)
    check(current, generation)
    const blocker = sendBlocker(current, status), images = keyImagesFor(current)
    const stale = !!images && keyImagesStale(images, status), keyImagesSynced = !!images && !stale, record = pendingFor(current)
    const result: MoneroVaultStatus = { ...status, signingReady: !signingBlocker(current), transactions: status.transactions.map(tx => ({ ...tx })), canSend: !blocker && !signingPhase, ...(signingPhase ? { signingPhase } : {}), keyImagesSynced, spendStateKnown: keyImagesSynced,
      ...(stale ? { keyImagesStale: true } : {}), ...(blocker ? { sendBlocked: blocker } : {}), ...(record ? { unrelayedTxid: record.txid } : {}),
      ...(record && checks.get(record.wallet) ? { unrelayedCheck: { ...checks.get(record.wallet)! } } : {}),
      ...(bound && guards.get(walletKey(current, bound.address)) ? { discardedTxid: guards.get(walletKey(current, bound.address))!.txid } : {}) }
    rememberBalance(current,result)
    return cachedBalance?.scope === current.watchScope ? {...result,cachedBalance:{...cachedBalance.value}} : result
  }
  /** Before connecting (e.g. after a restart) a pending broadcast from this device is still named. */
  const withPendingHint = (status: MoneroVaultStatus): MoneroVaultStatus => {
    const deviceId = engine.getDeviceState().deviceId
    const record = deviceId ? [...pending.values()].find(item => item.wallet.startsWith(`${deviceId}:`)) : undefined
    return record ? { ...status, unrelayedTxid: record.txid } : status
  }
  const deviceOperation = async <T,>(current: Snapshot, operation: () => Promise<T>, details: Parameters<Confirm>[1]): Promise<T> =>
    current.transport.lockDuring(async () => {
      activeDelegate = current.transport.delegate
      try { return current.emulator ? await confirm!(operation, details) : await operation() }
      finally { activeDelegate = null }
    })
  const getStatus = async (): Promise<MoneroVaultStatus> => {
    if (moneroHiddenWallet(engine)) { stop(); return moneroHiddenWalletStatus(!!getConfig().enabled) }
    let current: Snapshot | null
    try { current = snapshot() } catch { stop(); return withCachedBalance(empty(!!getConfig().enabled, false, 'The Monero configuration or device transport is unavailable')) }
    if (!current) { stop(); const config = getConfig(); return withCachedBalance(empty(config.enabled, false, config.offline ? 'Monero is unavailable in offline mode' : undefined)) }
    loadPersistence()
    if (!bound) return withCachedBalance(withPendingHint({ ...empty(true, true), signingReady: !signingBlocker(current), ...(signingBlocker(current) ? { sendBlocked: signingBlocker(current) } : {}), restoreHeight: current.config.restoreHeight, ...(connectionPhase ? { connectionPhase } : {}) }))
    if (bound.snapshot.key !== current.key || bound.snapshot.wallet !== current.wallet || bound.snapshot.transport !== current.transport) { stop(); return withCachedBalance(withPendingHint(empty(true, true))) }
    const authorized = bound, generation = epoch
    try {
      const value = await sidecar.getMoneroWalletStatus(); check(current, generation)
      if (!value || typeof value !== 'object' || (value as any).network !== 'mainnet' || (value as any).address !== authorized.address) {
        stop()
        return empty(true, true, 'The Monero monitor wallet changed; connect again')
      }
      lastGood = statusFrom(value, current, authorized.address)
      return await withSendState(lastGood, current, generation)
    } catch {
      if (moneroHiddenWallet(engine)) { stop(); return moneroHiddenWalletStatus(!!getConfig().enabled) }
      if (!matches(current) || epoch !== generation) { stop(); return empty(!!getConfig().enabled, false) }
      if (lastGood) return withSendState({ ...lastGood, monitorReady: false, syncState: 'unreachable', error: 'The Monero monitor is temporarily unavailable; showing the last wallet update' }, current, generation)
      throw new MoneroError('The Monero watch wallet status is unavailable')
    }
  }
  return {
    stop,
    invalidate: stop,
    getStatus,
    flushBalanceCache: () => balanceWrite,
    async connect({ showDisplay = false }: { showDisplay?: boolean } = {}): Promise<MoneroVaultStatus> {
      assertMoneroStandardWallet(engine)
      if (typeof showDisplay !== 'boolean') throw new MoneroError('Invalid Monero address display option')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady()
      requireSigning(current)
      busy = true; stop(); const generation = epoch
      connectionPhase = 'wallet'
      let viewKey: Uint8Array | null = null
      try {
        await sidecar.startMoneroSidecar(); check(current, generation)
        if (!(sidecar.isMoneroSignerWorkerReady?.() ?? sidecar.isMoneroSendReady?.())) throw new MoneroError(BLOCKER_MESSAGES.adapter)
        requireSigning(current)
        connectionPhase = 'device'
        const approved = await current.transport.lockDuring(async () => {
          activeDelegate = current.transport.delegate
          const operation = async () => {
            // Always bind cached monitoring access to the address read from this device now.
            const address = await actualAddress(current, generation, showDisplay)
            if (watchStore && current.watchScope) {
              try {
                const saved = await watchStore.loadWatch(current.watchScope, address)
                if (saved) {
                  try { check(current, generation); return { address, viewKey: saved } }
                  catch (error) { saved.fill(0); throw error }
                }
              } catch { check(current, generation) } // Locked/missing OS storage falls back to device consent.
            }
            const request = concat([...PATH.map(part => numberField(1, part)), numberField(2, 0)])
            const body = await receive(current, generation, current.messages.getWatchKey, current.messages.watchKey, request, true)
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
        // Device-approved monitoring access belongs to this wallet, independently of node availability.
        if (watchStore && current.watchScope) {
          try { await watchStore.saveWatch(current.watchScope, address, viewKey); check(current, generation); await watchStore.saveAddress(current.watchScope,address,0,address) }
          catch { console.warn('[monero] Monitoring access could not be saved securely') }
          check(current,generation)
        }
        connectionPhase = 'wallet'
        const value = await sidecar.configureMoneroWatch({ walletId: `${engine.getDeviceState().deviceId}:${address}`, network: 'mainnet', address,
          viewKey, restoreHeight: current.config.restoreHeight, daemonUrl: current.config.daemonUrl })
        check(current, generation); requireSigning(current)
        if (!(sidecar.isMoneroSignerWorkerReady?.() ?? sidecar.isMoneroSendReady?.())) throw new MoneroError(BLOCKER_MESSAGES.adapter)
        const status = statusFrom(value, current, address)
        signingViewKey?.fill(0); signingViewKey = viewKey.slice()
        bound = { snapshot: current, address }; lastGood = status
        // A pending broadcast (e.g. from before a restart) is looked up once: settled if the node has it.
        if (pending.has(walletKey(current, address))) await resolvePending(walletKey(current, address))
        return await withSendState(status, current, generation)
      } catch (error) {
        stop()
        // Never forward arbitrary subprocess/transport diagnostics that might contain credentials;
        // the worker's fixed messages (node unavailable / not synchronized) do pass.
        throw publicError(error, 'Unable to connect the Monero watch wallet; review the device and try again')
      } finally { viewKey?.fill(0); busy = false; connectionPhase = undefined }
    },
    /** The primary address (minor 0) or receive subaddress 0/minor, read from the device. */
    async getAddress({ showDisplay = false, minor = 0 }: { showDisplay?: boolean; minor?: number } = {}): Promise<{ address: string; network: 'mainnet'; displayed: boolean; minor: number }> {
      assertMoneroStandardWallet(engine)
      if (typeof showDisplay !== 'boolean') throw new MoneroError('Invalid Monero address display option')
      if (!Number.isSafeInteger(minor) || minor < 0 || minor > MAX_RECEIVE_SUBADDRESS) throw new MoneroError(`Choose a subaddress from 0 to ${MAX_RECEIVE_SUBADDRESS}`)
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady(), generation = epoch; requireSigning(current); bindingFor(current)
      if (!(sidecar.isMoneroSignerWorkerReady?.() ?? sidecar.isMoneroSendReady?.())) throw new MoneroError(BLOCKER_MESSAGES.adapter)
      busy = true
      try {
        const primary = bound?.snapshot.key === current.key && bound.snapshot.wallet === current.wallet && bound.snapshot.transport === current.transport ? bound.address : undefined
        if (!showDisplay && primary && current.watchScope && watchStore) {
          try {
            const cached = await watchStore.loadAddress(current.watchScope, primary, minor)
            check(current, generation)
            if (cached) return { address: checkedAddress(cached, minor), network: 'mainnet' as const, displayed: false, minor }
          } catch { check(current, generation) }
        }
        return await current.transport.lockDuring(async () => {
          activeDelegate = current.transport.delegate
          const operation = () => actualAddress(current, generation, showDisplay, minor)
          try {
            const address = current.emulator && showDisplay ? await confirm!(operation, { operation: 'moneroGetAddress', chain: 'Monero', to: minor ? undefined : bound?.address }) : await operation()
            check(current, generation)
            if (minor === 0 && bound && bound.address !== address) { stop(); throw new MoneroError('The Monero wallet changed; connect again') }
            if (primary && watchStore && current.watchScope) {
              try { await watchStore.saveAddress(current.watchScope, primary, minor, address) }
              catch { console.warn('[monero] Receive address could not be saved') }
              check(current, generation)
            }
            return { address, network: 'mainnet' as const, displayed: showDisplay, minor }
          } finally { activeDelegate = null }
        })
      } finally { busy = false }
    },
    /** Device key images (1804..1809 on public firmware; 530..535 on research artifacts) for every wallet output, imported so the watch wallet knows which outputs are spent. */
    async syncKeyImages(): Promise<MoneroVaultStatus> {
      assertMoneroStandardWallet(engine)
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady(); bindingFor(current)
      if (!sidecar.exportMoneroOutputs || !sidecar.importMoneroKeyImages) throw new MoneroError('Monero key-image sync is unavailable in this build')
      busy = true; synced = null; prepared = null
      const generation = epoch
      try {
        // What the wallet knew before export: anything newer marks these key images stale.
        const before = await getStatus(); check(current, generation)
        const outputs = await sidecar.exportMoneroOutputs(); check(current, generation)
        if (!outputs.length) throw new MoneroError('The watch wallet has no received outputs to sync yet')
        if (outputs.length > MAX_WALLET_OUTPUTS) throw new MoneroError(`This wallet has more than ${MAX_WALLET_OUTPUTS} outputs, more than this preview can sync`)
        // The device syncs at most 64 outputs per session: one session per 64, each imported at its offset.
        const sessions: MoneroOutputRecord[][] = []
        for (let start = 0; start < outputs.length; start += MAX_KEY_IMAGE_OUTPUTS) sessions.push(outputs.slice(start, start + MAX_KEY_IMAGE_OUTPUTS))
        const outputHash = createHash('sha256').update(JSON.stringify(outputs)).digest('hex')
        let savedProofs = null
        if (watchStore && current.watchScope) {
          try { savedProofs = await watchStore.loadImages(current.watchScope, bindingFor(current).address, outputHash) }
          catch { /* No reusable proof: request the device's approval. */ }
          check(current, generation)
        }
        const proofs = savedProofs?.length === outputs.length ? savedProofs : await deviceOperation(current, async () => {
          const opened: Array<{ keyImage: string; signature: string }> = []
          for (const session of sessions) {
            (await receive(current, generation, current.messages.imageInit, current.messages.imageInitAck, keyImageInitRequest(session), true)).fill(0)
            const sealed: Array<{ iv: Uint8Array; blob: Uint8Array }> = []
            for (let start = 0; start < session.length; start += 4) {
              const batch = session.slice(start, start + 4)
              const body = await receive(current, generation, current.messages.imageStep, current.messages.imageStepAck, concat(batch.map(output => lengthField(1, transferDetails(output)))), false)
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
            const final = await receive(current, generation, current.messages.imageFinal, current.messages.imageFinalAck, new Uint8Array(), false)
            try {
              const fields = parseFields(final)
              if (fields.size !== 1) throw new MoneroError('Invalid Monero key-image response')
              const key = bytesField(fields, 1)
              opened.push(...sealed.map(record => openKeyImage(key, record.iv, record.blob)))
            } finally { final.fill(0) }
          }
          return opened
        }, { operation: 'moneroSyncKeyImages', chain: 'Monero' })
        check(current, generation)
        // The post-import unspent total is the baseline: importing can only lower the balance (spends found),
        // so comparing against the pre-import balance would hide a later deposit up to that amount. wallet2's
        // reply is cumulative (it counts every transfer before the offset too), so the last session's is the total.
        let unspent: bigint | null = null
        for (let index = 0; index < sessions.length; index++) {
          const offset = index * MAX_KEY_IMAGE_OUTPUTS
          const result = await sidecar.importMoneroKeyImages({ offset, signedKeyImages: proofs.slice(offset, offset + sessions[index].length) }) as { unspentAtomic?: unknown }
          check(current, generation)
          unspent = typeof result?.unspentAtomic === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(result.unspentAtomic) ? BigInt(result.unspentAtomic) : null
        }
        if (watchStore && current.watchScope) {
          try { await watchStore.saveImages(current.watchScope, bindingFor(current).address, outputHash, proofs) }
          catch { console.warn('[monero] Balance verification proofs could not be saved') }
          check(current, generation)
        }
        synced = { key: current.key, generation, owned: new Map(outputs.map((output, i) => [output.outKey, { amountAtomic: output.amountAtomic, keyImage: proofs[i].keyImage }])),
          txids: new Set(before.transactions.map(tx => tx.txid)), balanceAtomic: unspent ?? BigInt(before.balanceAtomic) }
      } catch (error) { synced = null; throw publicError(error, 'Unable to sync Monero key images; review the device and try again') }
      finally { busy = false }
      return getStatus()
    },
    /** Build with the watch wallet, decode with the adapter, and refuse anything but the user's payment plus own change.
     *  Capability firmware supports zero-change Max; the research signer retains one atomic unit. */
    async prepareSend(params: { address?: unknown; amountAtomic?: unknown; max?: unknown } = {}): Promise<MoneroSendReview & { prepareId: string; max: boolean }> {
      assertMoneroStandardWallet(engine)
      const { address, amountAtomic, max = false } = params ?? {}
      const kind = moneroAddressKind(address)
      if (kind === 'integrated') throw new MoneroError('Integrated addresses are not supported by this preview')
      if (typeof address !== 'string' || (kind !== 'standard' && kind !== 'subaddress')) throw new MoneroError('Enter a valid Monero mainnet address')
      if (typeof max !== 'boolean') throw new MoneroError('Invalid Monero max option')
      if (!max && (typeof amountAtomic !== 'string' || !/^[1-9][0-9]{0,19}$/.test(amountAtomic) || BigInt(amountAtomic) > MAX_UINT64)) throw new MoneroError('Enter a positive XMR amount')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      const current = requireReady(); requireSigning(current)
      const binding = bindingFor(current)
      if (address === binding.address) throw new MoneroError(SELF_SEND)
      if (pendingFor(current)) throw new MoneroError(BLOCKER_MESSAGES.unrelayed)
      busy = true; prepared = null
      const generation = epoch
      try {
        const status = await getStatus(), keyImages = keyImagesFor(current)
        if (!status.canSend || !keyImages || !sidecar.createMoneroTransfer) {
          throw new MoneroError(status.keyImagesStale ? KEY_IMAGES_STALE : status.sendBlocked ? BLOCKER_MESSAGES[status.sendBlocked] : 'Monero sending is unavailable')
        }
        // A discarded tx whose inputs are unspent could still be mined from another node: settle it or bind to it.
        const wallet = walletKey(current, binding.address), guard = guards.get(wallet)
        let guardActive = false
        if (guard) {
          let found: MoneroTxLookup
          try { found = await sidecar.lookupMoneroTransaction!({ txid: guard.txid, keyImages: guard.keyImages }) }
          catch { throw new MoneroError(`The transaction you discarded (${guard.txid}) could not be checked with the node, so nothing new is built yet. Try again when the node answers`) }
          check(current, generation)
          if (found.state !== 'unknown') {
            clearGuard(wallet)
            throw new MoneroError(`The transaction you discarded (${guard.txid}) was sent after all: the node has it ${found.state === 'mined' ? 'in a block' : 'in its pool'}. Check your balance before sending again`)
          }
          if (found.keyImages.includes('spent')) clearGuard(wallet)
          else guardActive = true
        }
        const unlocked = BigInt(status.unlockedBalanceAtomic), locked = BigInt(status.balanceAtomic) - unlocked
        const build = async (amount: bigint) => {
          const draft = await sidecar.createMoneroTransfer!({ address, amountAtomic: amount.toString(), priority: 0 }); check(current, generation); return draft
        }
        const notEnough = (error: unknown) => error instanceof Error && error.message === NOT_ENOUGH
        /** The fee for (about) the whole balance, learned from a draft that leaves the fee cap aside. */
        const wholeBalanceFee = async () => {
          const probe = unlocked > MAX_FEE_ATOMIC * 2n ? unlocked - MAX_FEE_ATOMIC : unlocked / 2n
          if (probe < 1n) throw new MoneroError('There is no unlocked XMR to send yet')
          return BigInt((await build(probe)).feeAtomic)
        }
        let amount: bigint, draft: MoneroTransferDraft
        if (max) {
          const fee = await wholeBalanceFee()
          // More inputs than the probe used cost more: widen the reserve, then tighten to the fee actually charged.
          let found: { amount: bigint; draft: MoneroTransferDraft } | null = null
          const keepChange = current.streamed ? 0n : 1n
          for (const reserve of [fee + keepChange, fee * 2n + keepChange, fee * 4n + keepChange]) {
            if (unlocked <= reserve) break
            try { found = { amount: unlocked - reserve, draft: await build(unlocked - reserve) }; break }
            catch (error) { if (!notEnough(error)) throw error }
          }
          if (!found) throw new MoneroError('KeepKey could not build a send of the whole balance; enter a slightly smaller amount')
          const exact = unlocked - BigInt(found.draft.feeAtomic) - keepChange
          if (exact > found.amount) { try { found = { amount: exact, draft: await build(exact) } } catch (error) { if (!notEnough(error)) throw error } }
          ;({ amount, draft } = found)
        } else {
          amount = BigInt(amountAtomic as string)
          if (amount > unlocked) {
            throw new MoneroError(`This is more than your unlocked balance (${formatXmrAtomic(unlocked)})${locked > 0n ? `; ${formatXmrAtomic(locked)} is still locked until it has 10 confirmations` : ''}`)
          }
          // Check the fee budget for amounts near the whole balance.
          if (amount > unlocked - MAX_FEE_ATOMIC) {
            const fee = await wholeBalanceFee()
            if (amount + fee > unlocked) throw new MoneroError(`Not enough unlocked XMR for this amount plus the ${formatXmrAtomic(fee)} network fee. Use Max to send the most you can`)
          }
          draft = await build(amount)
        }
        // Every input must be an output whose key image KeepKey synced; a newer one means the sync is out of date.
        if (draft.plan.inputs.some(input => !keyImages.owned.has(input.ring[input.realMember]?.publicKey ?? ""))) { synced = null; throw new MoneroError(KEY_IMAGES_STALE) }
        if (guardActive && guard && !draft.plan.inputs.some(input => guard.keyImages.includes(keyImages.owned.get(input.ring[input.realMember].publicKey)!.keyImage))) {
          throw new MoneroError(`The transaction you discarded (${guard.txid}) could still be mined from another node's pool. Until its inputs are spent, a new send must spend at least one of them, so both cannot be mined; this send would use other funds, so it was not built. Send an amount that needs those funds (Max does), or wait until it settles`)
        }
        if (draft.plan.unlockTime !== undefined && draft.plan.unlockTime !== '0') throw new MoneroError(text(STREAM_ERRORS.unlock))
        if (current.streamed) {checkStreamSigningBounds(draft.plan, text); validateStreamMonitoringKey(draft.plan, signingViewKey, text)}
        // Choose the review order once; the stored plan drives every signing step.
        for (let i = draft.plan.outputs.length - 1; i > 0; i--) {
          const j = randomInt(i + 1)
          ;[draft.plan.outputs[i], draft.plan.outputs[j]] = [draft.plan.outputs[j], draft.plan.outputs[i]]
        }
        const review = reviewPlan(draft.plan, { address, amountAtomic: amount.toString(), walletAddress: binding.address,
          walletFeeAtomic: draft.feeAtomic, walletAmountAtomic: draft.amountAtomic, owned: keyImages.owned })
        prepared = { id: randomBytes(16).toString('hex'), key: current.key, generation, expires: Date.now() + PREPARED_LIFETIME_MS, draft, review }
        return { prepareId: prepared.id, max, ...review, outputs: review.outputs.map(output => ({ ...output })) }
      } catch (error) { throw publicError(error, 'Unable to prepare the Monero transaction') }
      finally { busy = false }
    },
    /** Sign the reviewed plan once using the selected firmware protocol, verify it, then relay. */
    async send(params: { prepareId?: unknown } = {}): Promise<{ txid: string }> {
      assertMoneroStandardWallet(engine)
      const id = params?.prepareId, reviewed = prepared
      if (typeof id !== 'string' || !reviewed || reviewed.id !== id || Date.now() > reviewed.expires) throw new MoneroError('This Monero send review expired; prepare it again')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      prepared = null
      const current = requireReady()
      const keyImages = bound && bound.snapshot.key === current.key && bound.snapshot.wallet === current.wallet &&
        bound.snapshot.transport === current.transport ? keyImagesFor(current) : null
      if (current.key !== reviewed.key || epoch !== reviewed.generation || !keyImages || !bound) { stop(); throw new MoneroError('The Monero wallet or configuration changed; connect again') }
      if ((!current.streamed && !(current.emulator && signingEmulator())) || !sidecar.relayMoneroTransaction) throw new MoneroError(BLOCKER_MESSAGES[current.emulator ? 'emulator' : 'firmware'])
      if (current.streamed) checkStreamSigningBounds(reviewed.draft.plan, text)
      busy = true
      const { draft, review, generation } = reviewed, wallet = walletKey(current, bound.address)
      let verifier: ReturnType<MoneroCoreVerifier['prepare']> | null = null
      const senderViewKey = current.streamed && streamNeedsMonitoringKey(draft.plan) ? signingViewKey?.slice() ?? null : null
      try {
        if (current.streamed) {
          validateStreamMonitoringKey(draft.plan, senderViewKey, text)
          if (!coreVerifier?.available()) throw new MoneroError(text(STREAM_ERRORS.verifier))
          verifier = coreVerifier.prepare(draft.plan)
          check(current, generation)
        }
        const signed = await deviceOperation(current, async () => {
          if (current.streamed) {
            try {
              await preloadNativeContactProof(current.wallet, draft.plan.outputs.map(o => o.address), 'monero')
              return await signMoneroStream(draft.plan,
                (request, response, payload, review) => receive(current, generation, request, response, payload, review),
                { text, senderViewKey, onProgress: phase => { check(current, generation); signingPhase = phase } })
            } catch (error) {
              // End a still-open session on host validation failure, without replaying any step.
              if (matches(current) && epoch === generation) {
                try { await writeMessage(current.transport.delegate, 20); (await readBounded(current.transport.delegate, replyMs.device)).body.fill(0) } catch { /* original error wins */ }
              }
              throw error
            }
          }
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
        if ('prefixHash' in signed && parsed.prefixHash !== signed.prefixHash) throw new MoneroError(text(STREAM_ERRORS.prefix))
        if (verifier && !verifier.verify(signed.blob)) throw new MoneroError(text(STREAM_ERRORS.verification))
        // These inputs are now spent: another send needs a fresh key-image sync.
        synced = null
        // Saved before the broadcast, so an outcome lost to a crash or restart still blocks a second payment.
        pending.set(wallet, { wallet, txid: parsed.hash, txHex: Buffer.from(signed.blob).toString('hex'), createdAt: new Date().toISOString(), node: current.config.daemonUrl,
          ...('transactionKeys' in signed ? {transactionKeys:signed.transactionKeys} : {}) })
        try { persistPending() }
        catch { pending.delete(wallet); throw new MoneroError('The signed transaction could not be saved for recovery, so it was not broadcast. Nothing was sent') }
        await relayPending(wallet, false)
        return { txid: parsed.hash }
      } catch (error) { throw publicError(error, 'Unable to send the Monero transaction') }
      finally { senderViewKey?.fill(0); verifier?.dispose(); signingPhase = undefined; busy = false }
    },
    /** Re-broadcast the same signed bytes after an unknown relay outcome; never builds a new transaction. */
    async retryRelay(): Promise<{ txid: string }> {
      assertMoneroStandardWallet(engine)
      const current = requireReady(), binding = bindingFor(current), wallet = walletKey(current, binding.address), record = pending.get(wallet)
      if (!record) throw new MoneroError('No Monero transaction is waiting to be broadcast')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      busy = true
      try { await relayPending(wallet, true); return { txid: record.txid } }
      catch (error) { throw publicError(error, 'Unable to broadcast the Monero transaction') }
      finally { busy = false }
    },
    /** Backend-only payment-proof lookup, scoped to the connected wallet. No frontend RPC. */
    getTransactionKey(txid: string) {
      assertMoneroStandardWallet(engine)
      const current = requireReady(), binding = bindingFor(current), wallet = walletKey(current, binding.address)
      loadPersistence()
      const record = pending.get(wallet)?.txid === txid ? pending.get(wallet) : sent.get(`${wallet}:${txid}`)
      return record?.transactionKeys ? {txKey:record.transactionKeys.txKey, additionalTxKeys:[...record.transactionKeys.additionalTxKeys]} : null
    },
    /** Unresolved unknown-outcome sends on record, for every wallet. */
    pendingCount: () => { assertMoneroStandardWallet(engine); if (getConfig().enabled) loadPersistence(); return pending.size },
    /** Forget a pending tx the user chose to give up on. Allowed only when, asked right now, the node does
     *  not have it and every input is still unspent; a tx the node has is settled as sent instead. */
    async discardPending(params: { confirm?: unknown } = {}): Promise<{ outcome: 'discarded' | 'sent' | 'superseded'; txid: string }> {
      assertMoneroStandardWallet(engine)
      if (params?.confirm !== true) throw new MoneroError('Confirm discarding the pending transaction')
      const current = requireReady(), binding = bindingFor(current), wallet = walletKey(current, binding.address), record = pending.get(wallet)
      if (!record) throw new MoneroError('No Monero transaction is waiting to be broadcast')
      if (busy) throw new MoneroError('A Monero device request is already in progress')
      busy = true
      try {
        const result = await resolvePending(wallet)
        if (result === 'sent' || result === 'superseded') return { outcome: result, txid: record.txid }
        if (result === 'unchecked') throw new MoneroError('The node could not be asked about this transaction, so it was not discarded')
        if (!checks.get(wallet)?.discardable) throw new MoneroError("This transaction's inputs are spent in the node's pool by another transaction. Wait until that settles; it was not discarded")
        // Another node may still hold it: remember its inputs so the next send reuses one (both cannot land).
        const keyImages = parseSignedTransaction(Uint8Array.from(Buffer.from(record.txHex, 'hex'))).inputs.map(input => input.keyImage)
        guards.set(wallet, { wallet, txid: record.txid, keyImages, ...(record.node ? { node: record.node } : {}), discardedAt: new Date().toISOString() })
        try { persistGuards() }
        catch { guards.delete(wallet); throw new MoneroError('The discard could not be saved, so the transaction was not discarded') }
        settlePending(wallet)
        return { outcome: 'discarded', txid: record.txid }
      } finally { busy = false }
    },
  }
}
