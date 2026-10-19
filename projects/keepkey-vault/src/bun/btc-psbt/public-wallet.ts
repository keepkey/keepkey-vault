/** Portable public account metadata. No seed, private key, node URL or credentials. */
import { HDKey } from '@scure/bip32'
import { hex } from '@scure/base'
import { formatPath, parsePath, toStandardXpub } from './codec'
import type { BtcPsbtAccount, BtcPsbtScriptType } from './psbt'

const FORMAT = 'keepkey-public-wallet'
const PURPOSE: Record<BtcPsbtScriptType, number> = { p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84, p2tr: 86 }
const H = 0x80000000

function fields(value: unknown, allowed: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) {
    throw new Error('Invalid public wallet fields; import public metadata only')
  }
}

export function readPublicWallet(value: unknown): BtcPsbtAccount & { xpub: string; masterFingerprint: Uint8Array } {
  fields(value, ['format', 'version', 'network', 'masterFingerprint', 'account'])
  if (value.format !== FORMAT || value.version !== 1) throw new Error('Unsupported Desktop public wallet format')
  if (value.network !== 'bitcoin-mainnet') throw new Error('Only Bitcoin mainnet public wallets are supported')
  if (typeof value.masterFingerprint !== 'string' || !/^[0-9a-fA-F]{8}$/.test(value.masterFingerprint)) throw new Error('Master fingerprint must be 8 hex characters')
  const a = value.account
  fields(a, ['xpub', 'path', 'scriptType', 'receiveBranch', 'changeBranch'])
  if (a.receiveBranch !== 0 || a.changeBranch !== 1) throw new Error('Expected receive branch 0 and change branch 1')
  if (typeof a.scriptType !== 'string' || !Object.prototype.hasOwnProperty.call(PURPOSE, a.scriptType)) throw new Error('Unsupported public wallet script type')
  if (typeof a.xpub !== 'string' || typeof a.path !== 'string') throw new Error('Public wallet requires an account xpub and derivation path')
  const { xpub, scriptType: prefix } = toStandardXpub(a.xpub)
  if (prefix !== 'p2pkh') throw new Error('Public wallet must contain a standard xpub with an explicit script type')
  const scriptType = a.scriptType as BtcPsbtScriptType
  const hd = HDKey.fromExtendedKey(xpub)
  const path = parsePath(a.path)
  if (hd.depth !== 3 || hd.index < H || path.length !== 3 || path[0] !== PURPOSE[scriptType] + H || path[1] !== H || path[2] !== hd.index) {
    throw new Error('Public wallet path, account key and script type do not agree')
  }
  return { xpub, scriptType, path, masterFingerprint: hex.decode(value.masterFingerprint) }
}

export function writePublicWallet(account: BtcPsbtAccount & { masterFingerprint: Uint8Array }): string {
  if (typeof account.xpub !== 'string') throw new Error('Expected an account xpub string')
  const value = {
    format: FORMAT, version: 1, network: 'bitcoin-mainnet', masterFingerprint: hex.encode(account.masterFingerprint),
    account: { xpub: account.xpub, path: formatPath(account.path), scriptType: account.scriptType, receiveBranch: 0, changeBranch: 1 },
  }
  readPublicWallet(value)
  return JSON.stringify(value, null, 2) + '\n'
}
