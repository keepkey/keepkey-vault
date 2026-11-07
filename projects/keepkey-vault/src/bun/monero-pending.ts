/** Signed Monero transactions whose broadcast outcome is unknown, kept across app restarts.
 *  While one is pending for a wallet, that wallet may only re-broadcast these exact bytes:
 *  building a second, different payment could pay twice if the first one did reach the network. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSignedTransaction } from './monero-wire'

export interface MoneroPendingBroadcast {
  /** `${deviceId}:${primaryAddress}`: the wallet whose inputs these bytes spend. */
  wallet: string
  txid: string
  txHex: string
  createdAt: string
}
export interface MoneroPendingStore {
  load(): MoneroPendingBroadcast[]
  save(records: MoneroPendingBroadcast[]): void
}

const MAX_RECORDS = 16
const WALLET = /^\S{1,128}:4[1-9A-HJ-NP-Za-km-z]{94}$/

/** A record is restored only if its bytes still hash to its txid (a damaged or edited file is not re-sent). */
export function validPendingBroadcast(value: unknown): MoneroPendingBroadcast | null {
  const v = value as MoneroPendingBroadcast
  if (!v || typeof v !== 'object' || typeof v.wallet !== 'string' || !WALLET.test(v.wallet) || typeof v.txid !== 'string' ||
      !/^[0-9a-f]{64}$/.test(v.txid) || typeof v.txHex !== 'string' || !/^(?:[0-9a-f]{2}){1,16384}$/.test(v.txHex) ||
      typeof v.createdAt !== 'string' || !Number.isFinite(Date.parse(v.createdAt))) return null
  try {
    if (parseSignedTransaction(Uint8Array.from(Buffer.from(v.txHex, 'hex'))).hash !== v.txid) return null
  } catch { return null }
  return { wallet: v.wallet, txid: v.txid, txHex: v.txHex, createdAt: v.createdAt }
}

/** One owner-only JSON file (directory 0700, file 0600), replaced atomically so a crash never leaves half a record. */
export function createFilePendingStore(directory: string): MoneroPendingStore {
  const file = join(directory, 'monero-pending-broadcast.json')
  return {
    load() {
      if (!existsSync(file)) return []
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        const records = Array.isArray(parsed?.records) ? parsed.records.slice(0, MAX_RECORDS) : []
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
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, records: records.slice(0, MAX_RECORDS) }), { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, file)
    },
  }
}
