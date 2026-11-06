/** Monero receiving bridge. Only an explicitly approved device view key reaches the local sidecar. */
import * as managedSidecar from './monero-sidecar'
import { firmwareSupportsMonero, MONERO_MIN_FIRMWARE } from '../shared/firmware-versions'

const MAX_RESPONSE = 4096
const MAX_UINT64 = 18446744073709551615n
const PRIMARY_ADDRESS = /^4[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/
const PATH = [0x8000002c, 0x80000080, 0x80000000]
class MoneroError extends Error {}

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
  canSend: false
  /** View-only scanning cannot prove whether received outputs were spent. */
  spendStateKnown: false
}
type Delegate = {
  writeChunk(data: Uint8Array, debugLink?: boolean): Promise<void>
  readChunk(debugLink?: boolean): Promise<Uint8Array>
  onButtonRequest?: (() => void) | null
}
type Transport = { delegate: Delegate; lockDuring<T>(operation: () => Promise<T>): Promise<T> }
type Engine = {
  isEmulator: boolean
  wallet: { transport?: unknown } | null
  emuDelegate?: unknown
  currentSeedEthAddress?: string | null
  getDeviceState(): { state: string; deviceId?: string; firmwareVersion?: string; activeTransport?: unknown; isHiddenWallet?: boolean; firmwareHash?: string }
}
type Confirm = (operation: () => Promise<any>, details: { operation: string; chain?: string; to?: string }) => Promise<any>
export interface MoneroWatchSidecar {
  startMoneroSidecar(): Promise<void>
  stopMoneroSidecar(): void
  configureMoneroWatch(options: { walletId: string; network: 'mainnet'; address: string; viewKey: Uint8Array; restoreHeight: number; daemonUrl: string }): Promise<unknown>
  getMoneroWalletStatus(): Promise<unknown>
}
type Snapshot = { key: string; wallet: NonNullable<Engine['wallet']>; transport: Transport; config: MoneroVaultConfig; emulator: boolean }
type Message = { type: number; body: Uint8Array }

function empty(enabled: boolean, deviceReady: boolean, error?: string): MoneroVaultStatus {
  return { available: false, enabled, deviceReady, connected: false, sidecarReady: false,
    network: 'mainnet', address: '', balanceAtomic: '0', unlockedBalanceAtomic: '0', walletHeight: 0,
    transactions: [], monitorReady: false, emulatorReady: false, error, canSend: false, spendStateKnown: false }
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
function varint(value: bigint): Uint8Array {
  const bytes: number[] = []
  do { const next = Number(value & 127n); value >>= 7n; bytes.push(next | (value ? 128 : 0)) } while (value)
  return new Uint8Array(bytes)
}
function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
function numberField(field: number, value: number): Uint8Array { return concat([varint(BigInt(field << 3)), varint(BigInt(value))]) }
function parseFields(body: Uint8Array): Map<number, Array<bigint | Uint8Array>> {
  let offset = 0
  const result = new Map<number, Array<bigint | Uint8Array>>()
  const nextNumber = (): bigint => {
    let value = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= body.length) throw new MoneroError('Invalid Monero device response')
      const byte = body[offset++]; value |= BigInt(byte & 127) << shift
      if (!(byte & 128)) {
        if (value > MAX_UINT64) throw new MoneroError('Invalid Monero device response')
        return value
      }
    }
    throw new MoneroError('Invalid Monero device response')
  }
  while (offset < body.length) {
    const tag = nextNumber(), field = Number(tag >> 3n), encoding = Number(tag & 7n)
    if (!Number.isSafeInteger(field) || field < 1) throw new MoneroError('Invalid Monero device response')
    let value: bigint | Uint8Array
    if (encoding === 0) value = nextNumber()
    else if (encoding === 2) {
      const length = nextNumber()
      if (length > BigInt(body.length - offset)) throw new MoneroError('Invalid Monero device response')
      value = body.subarray(offset, offset + Number(length)); offset += Number(length)
    } else throw new MoneroError('Invalid Monero device response')
    const values = result.get(field) ?? []; values.push(value); result.set(field, values)
  }
  return result
}
function bytesField(fields: Map<number, Array<bigint | Uint8Array>>, field: number): Uint8Array {
  const values = fields.get(field)
  if (values?.length !== 1 || !(values[0] instanceof Uint8Array)) throw new MoneroError('Invalid Monero device response')
  return values[0]
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
async function readMessage(delegate: Delegate): Promise<Message> {
  const first = await delegate.readChunk(false)
  let body: Uint8Array | null = null
  try {
    if (first.length !== 64 || first[0] !== 63 || first[1] !== 35 || first[2] !== 35) throw new MoneroError('Invalid Monero device report')
    const header = new DataView(first.buffer, first.byteOffset, first.byteLength)
    const type = header.getUint16(3), length = header.getUint32(5)
    if (length > MAX_RESPONSE) throw new MoneroError('Monero device response exceeds its bound')
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
export function createMoneroVault({ engine, confirm, getConfig, sidecar = managedSidecar }: {
  engine: Engine; confirm?: Confirm; getConfig: () => MoneroVaultConfig; sidecar?: MoneroWatchSidecar
}) {
  let epoch = 0, busy = false
  let activeDelegate: Delegate | null = null
  let bound: { snapshot: Snapshot; address: string } | null = null
  let lastGood: MoneroVaultStatus | null = null
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
    epoch++; bound = null; lastGood = null
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
  const receive = async (current: Snapshot, generation: number, request: number, responseType: number, body: Uint8Array, review: boolean): Promise<Uint8Array> => {
    const delegate = current.transport.delegate
    check(current, generation); await writeMessage(delegate, request, body)
    for (let screens = 0; screens < 64; screens++) {
      const response = await readMessage(delegate)
      let transferred = false
      try {
        check(current, generation)
        if (response.type === 26) {
          if (!review || (current.emulator && typeof delegate.onButtonRequest !== 'function')) {
            await writeMessage(delegate, 20)
            const cancelled = await readMessage(delegate); cancelled.body.fill(0)
            throw new MoneroError('Monero approval requires the emulator confirmation window')
          }
          await writeMessage(delegate, 27)
          continue
        }
        if (response.type === 18 || response.type === 41) {
          await writeMessage(delegate, 20)
          const cancelled = await readMessage(delegate); cancelled.body.fill(0)
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
      error: ready ? undefined : 'The Monero watch wallet is syncing or reconnecting', canSend: false, spendStateKnown: false }
  }
  return {
    stop,
    invalidate: stop,
    async getStatus(): Promise<MoneroVaultStatus> {
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
        return { ...lastGood, transactions: lastGood.transactions.map(tx => ({ ...tx })) }
      } catch {
        if (!matches(current) || epoch !== generation) { stop(); return empty(!!getConfig().enabled, false) }
        if (lastGood) return { ...lastGood, transactions: lastGood.transactions.map(tx => ({ ...tx })), monitorReady: false, error: 'The Monero monitor is temporarily unavailable; showing the last wallet update' }
        throw new MoneroError('The Monero watch wallet status is unavailable')
      }
    },
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
  }
}
