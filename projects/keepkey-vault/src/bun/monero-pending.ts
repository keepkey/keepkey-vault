/** Signed Monero transactions whose broadcast outcome is unknown, kept across app restarts.
 *  While one is pending for a wallet, that wallet may only re-broadcast these exact bytes:
 *  building a second, different payment could pay twice if the first one did reach the network. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { validTransactionKeys, type MoneroTransactionKeys } from './monero-transaction-keys'
import { parseSignedTransaction } from './monero-wire'

export interface MoneroPendingBroadcast {
  /** `${deviceId}:${primaryAddress}`: the wallet whose inputs these bytes spend. */
  wallet: string
  txid: string
  txHex: string
  createdAt: string
  transactionKeys?: MoneroTransactionKeys
  /** The node the bytes were relayed to (a later check against another node is said to be one). */
  node?: string
}
/** A pending tx the user discarded. Until its inputs are spent, the wallet's next send must reuse one of
 *  them, so the discarded tx (which another node may still mine) and the new one cannot both land. */
export interface MoneroDiscardGuard {
  wallet: string
  txid: string
  keyImages: string[]
  node?: string
  discardedAt: string
}
export interface MoneroPendingStore {
  load(): MoneroPendingBroadcast[]
  save(records: MoneroPendingBroadcast[]): void
  loadSent?(): MoneroPendingBroadcast[]
  saveSent?(records: MoneroPendingBroadcast[]): void
  loadGuards?(): MoneroDiscardGuard[]
  saveGuards?(guards: MoneroDiscardGuard[]): void
}

const MAX_RECORDS = 16
const WALLET = /^\S{1,128}:4[1-9A-HJ-NP-Za-km-z]{94}$/

/** A record is restored only if its bytes still hash to its txid (a damaged or edited file is not re-sent). */
export function validPendingBroadcast(value: unknown): MoneroPendingBroadcast | null {
  const v = value as MoneroPendingBroadcast
  if (!v || typeof v !== 'object' || typeof v.wallet !== 'string' || !WALLET.test(v.wallet) || typeof v.txid !== 'string' ||
      !/^[0-9a-f]{64}$/.test(v.txid) || typeof v.txHex !== 'string' || !/^(?:[0-9a-f]{2}){1,16384}$/.test(v.txHex) ||
      typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt)) || (v.node !== undefined && !validNode(v.node)) ||
      (v.transactionKeys !== undefined && !validTransactionKeys(v.transactionKeys))) return null
  try {
    if (parseSignedTransaction(Uint8Array.from(Buffer.from(v.txHex, 'hex'))).hash !== v.txid) return null
  } catch { return null }
  return { wallet: v.wallet, txid: v.txid, txHex: v.txHex, createdAt: v.createdAt,
    ...(v.transactionKeys ? {transactionKeys: {txKey:v.transactionKeys.txKey,additionalTxKeys:[...v.transactionKeys.additionalTxKeys]}} : {}), ...(v.node === undefined ? {} : { node: v.node }) }
}
const validNode = (node: unknown) => typeof node === 'string' && node.length <= 2048 && /^https?:\/\//.test(node)
export function validDiscardGuard(value: unknown): MoneroDiscardGuard | null {
  const v = value as MoneroDiscardGuard
  if (!v || typeof v !== 'object' || typeof v.wallet !== 'string' || !WALLET.test(v.wallet) || typeof v.txid !== 'string' || !/^[0-9a-f]{64}$/.test(v.txid) ||
      !Array.isArray(v.keyImages) || !v.keyImages.length || v.keyImages.length > 4 || v.keyImages.some(k => typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)) ||
      typeof v.discardedAt !== 'string' || !Number.isFinite(Date.parse(v.discardedAt)) || (v.node !== undefined && !validNode(v.node))) return null
  return { wallet: v.wallet, txid: v.txid, keyImages: [...v.keyImages], discardedAt: v.discardedAt, ...(v.node === undefined ? {} : { node: v.node }) }
}

/** One owner-only JSON file (directory 0700, file 0600), replaced atomically so a crash never leaves half a record. */
export function createFilePendingStore(directory: string): MoneroPendingStore {
  const file = join(directory, 'monero-pending-broadcast.json'), guardFile = join(directory, 'monero-discarded-broadcast.json'), sentFile = join(directory, 'monero-sent-transactions.json')
  const write = (target: string, value: unknown) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, target)
  }
  return {
    loadSent() {
      if (!existsSync(sentFile)) return []
      let raw: string
      try { raw = readFileSync(sentFile, 'utf8') } catch { throw new Error('The Monero payment-proof records could not be read') }
      let records: unknown[] | null = null
      try { const parsed = JSON.parse(raw); if (Array.isArray(parsed?.records)) records = parsed.records } catch {}
      const valid = (records ?? []).map(validPendingBroadcast).filter((r: MoneroPendingBroadcast | null): r is MoneroPendingBroadcast => !!r)
      if (records && valid.length === records.length) return valid
      // Unparseable, an unknown shape, or records that fail validation: the next save would drop those
      // keys for good. Keep the original file aside first (audit v6 N2), then continue with what is valid.
      // Order matters: write the clean file first, then move the original aside, then put the clean one in
      // place, so a failed step never leaves the valid keys only in the aside copy.
      const unreadable = () => new Error('The Monero payment-proof records could not be read')
      const aside = join(directory, `monero-sent-transactions.unreadable-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}.json`)
      const clean = `${sentFile}.${process.pid}.clean`
      try { write(clean, { version: 1, records: valid }) } catch { throw unreadable() }
      try { renameSync(sentFile, aside) } catch { try { unlinkSync(clean) } catch {} throw unreadable() }
      try { renameSync(clean, sentFile) } catch { try { renameSync(aside, sentFile) } catch {} throw unreadable() }
      console.warn(`[monero] Unreadable payment-proof records were kept aside as ${basename(aside)}`)
      return valid
    },
    saveSent(records) { write(sentFile, {version:1, records}) },
    loadGuards() {
      if (!existsSync(guardFile)) return []
      try {
        const parsed = JSON.parse(readFileSync(guardFile, 'utf8'))
        return (Array.isArray(parsed?.guards) ? parsed.guards.slice(-MAX_RECORDS) : []).map(validDiscardGuard).filter((g: MoneroDiscardGuard | null): g is MoneroDiscardGuard => !!g)
      } catch { console.warn('[monero] The discarded-broadcast file is unreadable'); return [] }
    },
    saveGuards(guards) {
      if (!guards.length) { if (existsSync(guardFile)) unlinkSync(guardFile); return }
      write(guardFile, { version: 1, guards: guards.slice(-MAX_RECORDS) })
    },
    load() {
      if (!existsSync(file)) return []
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        const records = Array.isArray(parsed?.records) ? parsed.records.slice(-MAX_RECORDS) : []
        const valid = records.map(validPendingBroadcast).filter((record: MoneroPendingBroadcast | null): record is MoneroPendingBroadcast => !!record)
        if (valid.length !== records.length) console.warn('[monero] Ignored a pending-broadcast record that does not verify')
        return valid
      } catch {
        console.warn('[monero] The pending-broadcast file is unreadable')
        return []
      }
    },
    save(records) {
      if (!records.length) { if (existsSync(file)) unlinkSync(file); return }
      write(file, { version: 1, records: records.slice(-MAX_RECORDS) })
    },
  }
}
