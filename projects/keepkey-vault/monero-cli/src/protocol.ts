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
  /** The worker found a pinned research signing adapter. */
  sendReady?: boolean
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

// ── Send path (research emulator only). Amounts stay exact decimal strings. ──
export const MAX_KEY_IMAGE_OUTPUTS = 64
export const MAX_SIGNED_TX_BYTES = 16384
const HEX32 = /^[0-9a-f]{64}$/
const SEND_ADDRESS = /^[48][123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/

/** Fixed, credential-free diagnostics the worker may forward verbatim. */
export const PUBLIC_ERRORS = [
  'The Monero signing adapter is not installed',
  'This preview syncs at most 64 wallet outputs',
  'Not enough unlocked XMR for this amount and fee',
  'The watch wallet cannot build this transaction',
  'The daemon rejected the transaction: double spend',
  'The daemon rejected the transaction: fee too low',
  'The daemon rejected the transaction',
  'The daemon accepted the transaction but did not relay it',
  'The Monero daemon is unavailable',
] as const
export class PublicError extends Error {
  constructor(message: typeof PUBLIC_ERRORS[number]) { super(message) }
}

export interface MoneroOutputRecord {
  transferIndex: number; amountAtomic: string; globalIndex: string; outKey: string; txPublicKey: string
  additionalTxPublicKeys: string[]; outputIndex: number; subaddressMajor: number; subaddressMinor: number
}
export interface MoneroPlanInput {
  amountAtomic: string; realMember: number; outputIndex: number; subaddressMajor: number; subaddressMinor: number
  txPublicKey: string; mask: string; additionalTxPublicKeys: string[]
  ring: Array<{ globalIndex: string; publicKey: string; commitment: string }>
}
export interface MoneroPlanOutput { amountAtomic: string; address: string; isChange: boolean; changeMajor: number; changeMinor: number }
export interface MoneroPlan { network: 0; feeAtomic: string; inputs: MoneroPlanInput[]; outputs: MoneroPlanOutput[] }
export interface MoneroTransferDraft { feeAtomic: string; amountAtomic: string; plan: MoneroPlan }

function exactKeys(value: any, keys: string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => key in value)
}
function u32(value: unknown): number {
  const result = unsigned(value)
  if (result > 0xffffffff) throw new Error('Invalid Monero index')
  return result
}
function hex32(value: unknown): string {
  if (typeof value !== 'string' || !HEX32.test(value)) throw new Error('Invalid Monero key field')
  return value
}
function keys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid Monero additional keys')
  return value.map(hex32)
}

/** Adapter `outputs` reply (after parseExactJson): the complete wallet export in transfer order. */
export function validateOutputs(value: unknown): MoneroOutputRecord[] {
  const v = value as any
  if (!exactKeys(v, ['status', 'offset', 'total', 'outputs']) || v.status !== 'pass' || unsigned(v.offset) !== 0 ||
      !Array.isArray(v.outputs) || unsigned(v.total) !== v.outputs.length || v.outputs.length > 4096) throw new Error('Invalid Monero output export')
  const seen = new Set<string>()
  return v.outputs.map((item: any, index: number) => {
    if (!exactKeys(item, ['transfer_index', 'amount', 'global_index', 'out_key', 'tx_public_key', 'additional_tx_public_keys',
        'output_index', 'subaddress_major', 'subaddress_minor']) || unsigned(item.transfer_index) !== index) throw new Error('Invalid Monero output record')
    const outKey = hex32(item.out_key)
    if (seen.has(outKey)) throw new Error('Duplicate Monero output'); seen.add(outKey)
    return { transferIndex: index, amountAtomic: atomic(item.amount), globalIndex: atomic(item.global_index), outKey,
      txPublicKey: hex32(item.tx_public_key), additionalTxPublicKeys: keys(item.additional_tx_public_keys),
      outputIndex: u32(item.output_index), subaddressMajor: u32(item.subaddress_major), subaddressMinor: u32(item.subaddress_minor) }
  })
}

/** Adapter `plan` reply (after parseExactJson), within the research signer's bounds. */
export function validatePlan(value: unknown): MoneroPlan {
  const v = value as any
  if (!exactKeys(v, ['status', 'network', 'fee', 'inputs', 'outputs']) || v.status !== 'pass' || unsigned(v.network) !== 0 ||
      !Array.isArray(v.inputs) || v.inputs.length < 1 || v.inputs.length > 4 ||
      !Array.isArray(v.outputs) || v.outputs.length < 2 || v.outputs.length > 4) throw new Error('Invalid Monero transaction plan')
  const inputs = v.inputs.map((item: any): MoneroPlanInput => {
    if (!exactKeys(item, ['amount', 'real_member', 'output_index', 'subaddress_major', 'subaddress_minor', 'tx_public_key', 'mask',
        'additional_tx_public_keys', 'ring']) || !Array.isArray(item.ring) || item.ring.length !== 16 || u32(item.real_member) >= 16) throw new Error('Invalid Monero plan input')
    let previous = -1n
    const ring = item.ring.map((member: any) => {
      if (!exactKeys(member, ['global_index', 'public_key', 'commitment'])) throw new Error('Invalid Monero ring member')
      const globalIndex = atomic(member.global_index)
      if (BigInt(globalIndex) <= previous) throw new Error('Monero ring indices must increase'); previous = BigInt(globalIndex)
      return { globalIndex, publicKey: hex32(member.public_key), commitment: hex32(member.commitment) }
    })
    const amountAtomic = atomic(item.amount)
    if (amountAtomic === '0') throw new Error('Invalid Monero plan input')
    return { amountAtomic, realMember: u32(item.real_member), outputIndex: u32(item.output_index),
      subaddressMajor: u32(item.subaddress_major), subaddressMinor: u32(item.subaddress_minor), txPublicKey: hex32(item.tx_public_key),
      mask: hex32(item.mask), additionalTxPublicKeys: keys(item.additional_tx_public_keys), ring }
  })
  const outputs = v.outputs.map((item: any): MoneroPlanOutput => {
    if (!exactKeys(item, ['amount', 'address', 'is_change', 'change_major', 'change_minor']) || typeof item.is_change !== 'boolean' ||
        typeof item.address !== 'string' || !SEND_ADDRESS.test(item.address)) throw new Error('Invalid Monero plan output')
    const amountAtomic = atomic(item.amount)
    if (amountAtomic === '0') throw new Error('Invalid Monero plan output')
    return { amountAtomic, address: item.address, isChange: item.is_change, changeMajor: u32(item.change_major), changeMinor: u32(item.change_minor) }
  })
  return { network: 0, feeAtomic: atomic(v.fee), inputs, outputs }
}

export function validateTransferRequest(value: unknown): { address: string; amountAtomic: string; priority: number } {
  const v = value as any
  if (!exactKeys(v, ['address', 'amountAtomic', 'priority']) || typeof v.address !== 'string' || !SEND_ADDRESS.test(v.address) ||
      atomic(v.amountAtomic) === '0' || !Number.isSafeInteger(v.priority) || v.priority < 0 || v.priority > 4) throw new Error('Invalid Monero transfer request')
  return { address: v.address, amountAtomic: v.amountAtomic, priority: v.priority }
}

/** Worker reply: wallet-rpc fee/amount plus the adapter plan in adapter shape (exact strings). */
export function validateTransferDraft(value: unknown): MoneroTransferDraft {
  const v = value as any
  if (!exactKeys(v, ['feeAtomic', 'amountAtomic', 'plan'])) throw new Error('Invalid Monero transfer draft')
  return { feeAtomic: atomic(v.feeAtomic), amountAtomic: atomic(v.amountAtomic), plan: validatePlan(v.plan) }
}

export function validateKeyImageImport(value: unknown): { offset: 0; signedKeyImages: Array<{ keyImage: string; signature: string }> } {
  const v = value as any
  if (!exactKeys(v, ['offset', 'signedKeyImages']) || v.offset !== 0 || !Array.isArray(v.signedKeyImages) ||
      !v.signedKeyImages.length || v.signedKeyImages.length > MAX_KEY_IMAGE_OUTPUTS) throw new Error('Invalid Monero key-image import')
  return { offset: 0, signedKeyImages: v.signedKeyImages.map((item: any) => {
    if (!exactKeys(item, ['keyImage', 'signature']) || !HEX32.test(item.keyImage) || typeof item.signature !== 'string' ||
        !/^[0-9a-f]{128}$/.test(item.signature)) throw new Error('Invalid Monero key image')
    return { keyImage: item.keyImage, signature: item.signature }
  }) }
}

export function validateKeyImageResult(value: unknown): { height: number; spentAtomic: string; unspentAtomic: string } {
  const v = value as any
  if (!exactKeys(v, ['height', 'spentAtomic', 'unspentAtomic'])) throw new Error('Invalid Monero key-image result')
  return { height: unsigned(v.height), spentAtomic: atomic(v.spentAtomic), unspentAtomic: atomic(v.unspentAtomic) }
}

export function validateRelayRequest(value: unknown): { txHex: string } {
  const v = value as any
  if (!exactKeys(v, ['txHex']) || typeof v.txHex !== 'string' || !v.txHex.length || v.txHex.length > MAX_SIGNED_TX_BYTES * 2 ||
      !/^(?:[0-9a-f]{2})+$/.test(v.txHex)) throw new Error('Invalid Monero transaction')
  return { txHex: v.txHex }
}

/** Daemon /send_raw_transaction reply. Every failure flag is checked, not only status. */
export function checkRelayResponse(value: unknown): void {
  const v = value as any
  if (!v || typeof v !== 'object') throw new PublicError('The daemon rejected the transaction')
  if (v.double_spend === true) throw new PublicError('The daemon rejected the transaction: double spend')
  if (v.fee_too_low === true) throw new PublicError('The daemon rejected the transaction: fee too low')
  if (v.status !== 'OK' || ['low_mixin', 'invalid_input', 'invalid_output', 'too_big', 'overspend', 'too_few_outputs',
      'sanity_check_failed', 'tx_extra_too_big', 'nonzero_unlock_time'].some(flag => v[flag] === true)) throw new PublicError('The daemon rejected the transaction')
  if (v.not_relayed !== false) throw new PublicError('The daemon accepted the transaction but did not relay it')
}
