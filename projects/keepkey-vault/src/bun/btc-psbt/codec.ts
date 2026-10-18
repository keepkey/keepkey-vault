/**
 * Extended-key and Electrum wallet-file codecs for watch-only Bitcoin.
 * Mainnet single-sig public keys only: private, testnet and multisig keys are refused.
 */
import { createBase58check, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2'
import type { BtcPsbtAccount, BtcPsbtScriptType } from './psbt'

export const b58check = createBase58check(sha256)

const H = 0x80000000
// SLIP-132 public versions: xpub / ypub / zpub. Script type comes from the prefix, as Electrum does.
const PUB: Record<BtcPsbtScriptType, number> = { p2pkh: 0x0488b21e, 'p2sh-p2wpkh': 0x049d7cb2, p2wpkh: 0x04b24746 }
const PURPOSE: Record<BtcPsbtScriptType, number> = { p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84 }
const REFUSED: Record<number, string> = {
  0x0488ade4: 'This is a private key (xprv). Never import a private key',
  0x049d7878: 'This is a private key (yprv). Never import a private key',
  0x04b2430c: 'This is a private key (zprv). Never import a private key',
  0x0295b005: 'This is a private key (Yprv). Never import a private key',
  0x02aa7a99: 'This is a private key (Zprv). Never import a private key',
  0x04358394: 'This is a private key (tprv). Never import a private key',
  0x044a4e28: 'This is a private key (uprv). Never import a private key',
  0x045f18bc: 'This is a private key (vprv). Never import a private key',
  0x043587cf: 'Testnet keys (tpub) are not supported',
  0x044a5262: 'Testnet keys (upub) are not supported',
  0x045f1cf6: 'Testnet keys (vpub) are not supported',
  0x0295b43f: 'Multisig keys (Ypub) are not supported',
  0x02aa7ed3: 'Multisig keys (Zpub) are not supported',
}

const u32be = (b: Uint8Array, o = 0) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

function decodePublicKey(key: string): { bytes: Uint8Array; scriptType: BtcPsbtScriptType } {
  let bytes: Uint8Array
  try { bytes = b58check.decode(key.trim()) } catch { throw new Error('Not an extended public key (bad base58 checksum)') }
  if (bytes.length !== 78) throw new Error('Not an extended public key')
  const version = u32be(bytes)
  if (REFUSED[version]) throw new Error(REFUSED[version])
  const scriptType = (Object.keys(PUB) as BtcPsbtScriptType[]).find((t) => PUB[t] === version)
  if (!scriptType || (bytes[45] !== 0x02 && bytes[45] !== 0x03)) throw new Error('Not a mainnet xpub, ypub or zpub')
  return { bytes, scriptType }
}

function withVersion(bytes: Uint8Array, version: number): string {
  const out = bytes.slice()
  new DataView(out.buffer).setUint32(0, version)
  return b58check.encode(out)
}

/** x/y/zpub -> standard xpub plus the script type its prefix stands for. */
export function toStandardXpub(key: string): { xpub: string; scriptType: BtcPsbtScriptType } {
  const { bytes, scriptType } = decodePublicKey(key)
  return { xpub: withVersion(bytes, PUB.p2pkh), scriptType }
}

/** Standard xpub -> the SLIP-132 key Electrum needs for this script type. */
export function toSlip132(xpub: string, scriptType: BtcPsbtScriptType): string {
  const { bytes, scriptType: t } = decodePublicKey(xpub)
  if (t !== 'p2pkh') throw new Error('Expected a standard xpub')
  return withVersion(bytes, PUB[scriptType])
}

/** Parent fingerprint of a depth-1 key (e.g. m/84'), which is the master fingerprint. */
export function masterFingerprintFromDepth1Xpub(xpub: string): Uint8Array {
  const { bytes } = decodePublicKey(xpub)
  if (bytes[4] !== 1) throw new Error('Not a depth-1 key: only a depth-1 key carries the master fingerprint')
  return bytes.slice(5, 9)
}

/** Account path of a stored depth-3 account key. Coin type 0' is assumed: Desktop stores mainnet Bitcoin accounts only. */
export function accountPathFromXpub(key: string, scriptType: BtcPsbtScriptType): number[] {
  const { bytes, scriptType: prefixType } = decodePublicKey(key)
  if (prefixType !== scriptType) throw new Error(`The stored ${scriptType} key has the wrong prefix`)
  const child = u32be(bytes, 9)
  if (bytes[4] !== 3 || child < H) throw new Error('Not a BIP44/49/84 account key')
  return [PURPOSE[scriptType] + H, H, child]
}

export function formatPath(path: number[]): string {
  return 'm/' + path.map((p) => (p >= H ? `${p - H}'` : `${p}`)).join('/')
}

function parsePath(s: string): number[] {
  if (!/^m(\/\d+['hH]?)+$/.test(s)) throw new Error(`Unreadable derivation path: ${s}`)
  return s.slice(2).split('/').map((p) => {
    const n = parseInt(p, 10)
    if (n >= H) throw new Error(`Unreadable derivation path: ${s}`)
    return /['hH]$/.test(p) ? n + H : n
  })
}

function checkAccountPath(path: number[], scriptType: BtcPsbtScriptType): void {
  const purpose = PURPOSE[scriptType]
  if (path.length !== 3 || path[0] !== purpose + H || path[1] !== H || path[2] < H) {
    throw new Error(`Derivation ${formatPath(path)} does not fit a ${scriptType} key; expected m/${purpose}'/0'/n'`)
  }
}

export interface ElectrumImport {
  /** Standard xpub */
  xpub: string
  scriptType: BtcPsbtScriptType
  /** Account path, when the file says */
  path?: number[]
  masterFingerprint?: Uint8Array
}

/** Read an unencrypted Electrum standard wallet (bip32 watch-only or hardware keystore). The file's label is ignored. */
export function readElectrumWallet(text: string): ElectrumImport {
  const t = text.trim()
  // Encrypted files start with BIE1/BIE2, stored base64 (QklFMQ / QklFMg).
  if (/^(BIE[12]|QklFM[Qg])/.test(t)) throw new Error('This Electrum wallet file is encrypted. Remove the password in Electrum first')
  let w: any
  try { w = JSON.parse(t) } catch { throw new Error('Not an Electrum wallet file') }
  if (!w || typeof w !== 'object') throw new Error('Not an Electrum wallet file')
  const type = w.wallet_type
  if (type === 'imported') throw new Error('Electrum imported-address wallets are not supported')
  if ((typeof type === 'string' && /^\d+of\d+$/.test(type)) || w.x1) throw new Error('Electrum multisig wallets are not supported')
  if (type !== 'standard') throw new Error(`Unsupported Electrum wallet type: ${type}`)
  const ks = w.keystore
  if (!ks || typeof ks !== 'object') throw new Error('Electrum wallet file has no keystore')
  if (ks.type === 'bip32') {
    if (ks.xprv != null) throw new Error('This Electrum wallet contains a private key. Never import a private key')
  } else if (ks.type !== 'hardware') {
    throw new Error(`Unsupported Electrum keystore: ${ks.type}`)
  }
  if (typeof ks.xpub !== 'string') throw new Error('Electrum keystore has no xpub')
  const { bytes, scriptType } = decodePublicKey(ks.xpub)
  if (bytes[4] !== 3) throw new Error("This Electrum wallet is not a BIP44/49/84 account; a KeepKey can't sign for Electrum-seed wallets")
  const out: ElectrumImport = { xpub: withVersion(bytes, PUB.p2pkh), scriptType }
  if (ks.derivation != null) {
    const path = parsePath(String(ks.derivation))
    checkAccountPath(path, scriptType)
    if (u32be(bytes, 9) !== path[2]) throw new Error('Derivation path does not match the xpub')
    out.path = path
  }
  if (ks.root_fingerprint != null) {
    if (!/^[0-9a-fA-F]{8}$/.test(String(ks.root_fingerprint))) throw new Error('Unreadable root fingerprint')
    out.masterFingerprint = hex.decode(String(ks.root_fingerprint).toLowerCase())
  }
  return out
}

/** Unencrypted Electrum watch-only file. No seed_version: Electrum assumes an old one and upgrades. */
export function writeElectrumWallet(account: BtcPsbtAccount & { masterFingerprint: Uint8Array }, label: string): string {
  const xpub = typeof account.xpub === 'string' ? account.xpub : b58check.encode(account.xpub)
  checkAccountPath(account.path, account.scriptType)
  if (account.masterFingerprint.length !== 4) throw new Error('Master fingerprint must be 4 bytes')
  return JSON.stringify({
    wallet_type: 'standard',
    use_encryption: false,
    keystore: {
      type: 'bip32',
      xpub: toSlip132(xpub, account.scriptType),
      xprv: null,
      derivation: formatPath(account.path),
      root_fingerprint: hex.encode(account.masterFingerprint),
      label,
    },
  }, null, 2)
}
