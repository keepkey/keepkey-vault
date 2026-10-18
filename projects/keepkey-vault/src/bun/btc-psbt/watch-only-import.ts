/**
 * Watch-only import for a machine that never saw the KeepKey: an Electrum wallet
 * file or a bare x/y/zpub. Pure: no device, no network, no database.
 *
 * Nothing here proves the key belongs to a KeepKey. The wallet stays "not
 * verified" until a connected KeepKey returns the same account xpub at the path.
 */
import { createHash } from 'crypto'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { b58check, formatPath, parsePath, readElectrumWallet, toSlip132, toStandardXpub } from './codec'
import type { BtcPsbtScriptType } from './psbt'

const H = 0x80000000
const PURPOSE: Record<BtcPsbtScriptType, number> = { p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84, p2tr: 86 }

export interface WatchOnlyImport {
  /** 'wo:' + sha256 of the standard xpubs; the synthetic device_snapshot id */
  id: string
  source: 'electrum' | 'key'
  scriptType: BtcPsbtScriptType
  /** Standard xpub */
  xpub: string
  /** SLIP-132 key, as the device cache stores Bitcoin keys */
  key: string
  path: number[]
  /** Path inferred from the key, not stated by the file: the user must confirm it */
  pathAssumed: boolean
  /** Real master fingerprint (8 hex), null = unknown */
  fingerprint: string | null
}

export function watchOnlyImportId(xpubs: string[]): string {
  return 'wo:' + createHash('sha256').update([...xpubs].sort().join('\n')).digest('hex')
}

function readBareKey(text: string): { xpub: string; scriptType: BtcPsbtScriptType } {
  if (!/^[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(text)) throw new Error('Not an Electrum wallet file or an extended public key (xpub, ypub or zpub)')
  const std = toStandardXpub(text) // refuses private, testnet, multisig and corrupted keys
  const depth = b58check.decode(text)[4]
  if (depth < 3) throw new Error(`This is a depth-${depth} key, not an account key. Electrum seed wallets (m/0h) are not KeepKey wallets; export the account key (m/84'/0'/0' or similar)`)
  if (depth !== 3) throw new Error(`This is a depth-${depth} key; expected an account key (depth 3, m/purpose'/0'/account')`)
  return std
}

/**
 * text: Electrum wallet JSON or a bare key. fingerprint: optional user-entered
 * master fingerprint. path: the path the user confirmed; required (and must be
 * the standard one) when the import does not state it. A bare xpub needs an
 * explicit BIP86 path to select Taproot; its version bytes alone mean legacy.
 */
export function parseWatchOnlyImport(text: string, opts: { fingerprint?: string; path?: string } = {}): WatchOnlyImport {
  const t = text.trim()
  const isFile = /^(\{|BIE[12]|QklFM[Qg])/.test(t)
  const electrum = isFile ? readElectrumWallet(t) : null
  const decoded = electrum ?? readBareKey(t)
  const { xpub } = decoded
  let { scriptType } = decoded
  const hd = HDKey.fromExtendedKey(xpub)
  if (hd.index < H) throw new Error('The account level of this key is not hardened; not a BIP44/49/84 account key')
  if (!electrum && scriptType === 'p2pkh' && opts.path && parsePath(opts.path.trim())[0] === 86 + H) scriptType = 'p2tr'
  const standard = [PURPOSE[scriptType] + H, H, hd.index]
  let path = electrum?.path ?? standard

  if (opts.path) {
    const confirmed = parsePath(opts.path.trim())
    if (formatPath(confirmed) !== formatPath(path)) {
      throw new Error(`A ${scriptType} key at this account can only be ${formatPath(path)}, not ${formatPath(confirmed)}`)
    }
    path = confirmed
  }

  let fingerprint = electrum?.masterFingerprint ? hex.encode(electrum.masterFingerprint) : null
  // Electrum records the account key's own fingerprint when it knows no origin: not the master.
  if (fingerprint !== null && parseInt(fingerprint, 16) === hd.fingerprint) fingerprint = null
  if (opts.fingerprint) {
    const fp = opts.fingerprint.trim().toLowerCase()
    if (!/^[0-9a-f]{8}$/.test(fp)) throw new Error('Master fingerprint must be 8 hex characters')
    if (fingerprint !== null && fp !== fingerprint) throw new Error(`The fingerprint entered (${fp}) differs from the file's (${fingerprint})`)
    if (fp !== '00000000') fingerprint = fp // zero = unknown, as Electrum writes it
  }

  return {
    id: watchOnlyImportId([xpub]),
    source: electrum ? 'electrum' : 'key',
    scriptType,
    xpub,
    key: toSlip132(xpub, scriptType),
    path,
    pathAssumed: !electrum?.path,
    fingerprint,
  }
}
