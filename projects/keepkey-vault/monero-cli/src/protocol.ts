export const SIDECAR_VERSION = '0.1.0'
export const MONERO_VERSION = '0.18.5.4'
export const MAX_IPC_LINE = 65536

export interface MoneroWatchConfiguration {
  walletId: string
  network: 'mainnet'
  address: string
  viewKey: string
  restoreHeight: number
  daemonUrl: string
}

export interface MoneroWalletStatus {
  network: 'mainnet'
  address: string
  balanceAtomic: string
  unlockedBalanceAtomic: string
  walletHeight: number
  transactions: Array<{
    txid: string; amountAtomic: string; confirmations: number; locked: boolean
    height: number; type: 'in' | 'pool'
  }>
  transactionsTruncated?: boolean
  monitorReady: boolean
  updatedAt: string
  error?: string
  canSend: false
}

export interface MoneroSidecarStatus {
  state: 'stopped' | 'starting' | 'ready' | 'error'
  configured: boolean
  version: string
  binaryVersion: string
  error?: string
}

const BASE58 = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/
export function validateConfiguration(value: unknown): MoneroWatchConfiguration {
  const v = value as MoneroWatchConfiguration
  const allowed = ['walletId', 'network', 'address', 'viewKey', 'restoreHeight', 'daemonUrl']
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).some(k => !allowed.includes(k)) ||
      typeof v.walletId !== 'string' || !/^[a-zA-Z0-9_:.-]{1,256}$/.test(v.walletId) ||
      v.network !== 'mainnet' || typeof v.address !== 'string' || !v.address.startsWith('4') || !BASE58.test(v.address) ||
      typeof v.viewKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(v.viewKey) || /^0+$/.test(v.viewKey) ||
      !Number.isSafeInteger(v.restoreHeight) || v.restoreHeight < 0 || typeof v.daemonUrl !== 'string') {
    throw new Error('Invalid watch-only Monero configuration')
  }
  const url = new URL(v.daemonUrl)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('Monero daemon requires an HTTPS origin')
  return { walletId: v.walletId, network: 'mainnet', address: v.address,
    viewKey: v.viewKey.toLowerCase(), restoreHeight: v.restoreHeight, daemonUrl: url.origin }
}

export function unsigned(value: unknown): number {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Monero numeric field')
  return value
}

export function atomic(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) {
    throw new Error('Invalid Monero atomic amount')
  }
  return value
}

export function validateWalletStatus(value: unknown): MoneroWalletStatus {
  const v = value as MoneroWalletStatus
  const allowed = ['network', 'address', 'balanceAtomic', 'unlockedBalanceAtomic', 'walletHeight', 'transactions',
    'transactionsTruncated', 'monitorReady', 'updatedAt', 'error', 'canSend']
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k)) ||
      v.network !== 'mainnet' || typeof v.address !== 'string' || !v.address.startsWith('4') || !BASE58.test(v.address) ||
      typeof v.monitorReady !== 'boolean' || v.canSend !== false || typeof v.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(v.updatedAt)) || !Array.isArray(v.transactions) || v.transactions.length > 100 ||
      (v.error !== undefined && (typeof v.error !== 'string' || v.error.length > 256)) ||
      (v.transactionsTruncated !== undefined && typeof v.transactionsTruncated !== 'boolean')) throw new Error('Invalid Monero wallet status')
  const balance = atomic(v.balanceAtomic), unlocked = atomic(v.unlockedBalanceAtomic)
  if (BigInt(unlocked) > BigInt(balance)) throw new Error('Invalid Monero wallet balances')
  const transactions = v.transactions.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !['txid', 'amountAtomic', 'confirmations', 'locked', 'height', 'type'].includes(k)) ||
        typeof item.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(item.txid) || typeof item.locked !== 'boolean' || !['in', 'pool'].includes(item.type)) {
      throw new Error('Invalid Monero wallet transaction')
    }
    return { txid: item.txid.toLowerCase(), amountAtomic: atomic(item.amountAtomic), confirmations: unsigned(item.confirmations),
      locked: item.locked, height: unsigned(item.height), type: item.type }
  })
  return { network: 'mainnet', address: v.address, balanceAtomic: balance, unlockedBalanceAtomic: unlocked,
    walletHeight: unsigned(v.walletHeight), transactions, monitorReady: v.monitorReady, updatedAt: v.updatedAt,
    transactionsTruncated: v.transactionsTruncated, error: v.error, canSend: false }
}

/** Preserve integer JSON tokens before JavaScript can round monetary uint64s. */
export function parseExactJson(text: string): any {
  let result = '', i = 0
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue }
        if (text[i++] === '"') break
      }
      result += text.slice(start, i)
    } else if (text[i] === '-' || /[0-9]/.test(text[i])) {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i))
      if (!match) throw new Error('Invalid Monero JSON')
      // Even a fractional/exponent token that rounds to an integer must not
      // become an accepted atomic amount (e.g. 1.00000000000000001 or 1e-999).
      result += JSON.stringify(match[0])
      i += match[0].length
    } else result += text[i++]
  }
  return JSON.parse(result)
}
