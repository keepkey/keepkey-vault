/**
 * POST /api/v2/tx/build — the browser extension builds through Desktop.
 *
 * Owner rule (2026-11-13): thin clients never build transactions on a server.
 * Desktop decides the sender (keys, UTXOs, change, fee) with the same
 * buildTxForCurrentWallet the in-app send uses, and answers with the exact body
 * for an EXISTING sign route plus a summary of what it built. Servers only
 * supply data. Pure: no device, no network.
 */
import { HttpError } from './auth'
import { utxoAccountScriptPaths } from './chain-scan'
import { isBurnAddress, validateAddress } from '../shared/address-validation'
import { baseUnitsToDecimalString } from '../shared/max-send'
import type { ChainDef } from '../shared/chains'
import type { BtcAccountSet, BtcXpub, BuildTxParams, BuildTxResult } from '../shared/types'

/** Native assets the extension may send; value = Desktop chain.id. */
export const TX_BUILD_CAIPS = {
  'bip122:000000000019d6689c085ae165831e93/slip44:0': 'bitcoin',
  'bip122:000000000000000000651ef99cb9fcbe/slip44:145': 'bitcoincash',
  'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2': 'litecoin',
  'bip122:00000000001a91e3dace36e2be3bf030/slip44:3': 'dogecoin',
  'bip122:000007d91d1254d60e2dd1ae58038307/slip44:5': 'dash',
  'cosmos:cosmoshub-4/slip44:118': 'cosmos',
  'cosmos:osmosis-1/slip44:118': 'osmosis',
  'cosmos:thorchain-mainnet-v1/slip44:931': 'thorchain',
  'cosmos:mayachain-mainnet-v1/slip44:931': 'mayachain',
  'ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144': 'ripple',
} as const

export type TxBuildSignRoute =
  | '/utxo/sign-transaction'
  | '/cosmos/sign-amino' | '/osmosis/sign-amino'
  | '/thorchain/sign-amino-transfer' | '/mayachain/sign-amino-transfer'
  | '/xrp/sign-transaction'

export type TxBuildScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr'
const PURPOSE: Record<TxBuildScriptType, number> = { p2pkh: 44, 'p2sh-p2wpkh': 49, p2wpkh: 84, p2tr: 86 }

/** Exactly what reaches buildTxHeadless. Nothing else from the client does.
 *  scriptType (UTXO only) names which of the user's own accounts to spend;
 *  Desktop derives that account itself. Absent = Desktop's own choice. */
export interface TxBuildHeadlessRequest {
  chainId: string
  to: string
  amount: string | undefined
  isMax: boolean
  memo: string | undefined
  accountIndex: number
  scriptType?: TxBuildScriptType
}

export interface TxBuildResponse {
  signRoute: TxBuildSignRoute
  signBody: Record<string, unknown>
  summary: {
    to: string; amount: string; fee: string; symbol: string; memo?: string; destinationTag?: string
    /** UTXO: the one account every input and the change belong to, as built. */
    scriptType?: string; accountIndex?: number
  }
}

/** Account path [purpose', coin', account'] Desktop derives for this script
 *  type on this chain, or undefined when Desktop does not spend that type there.
 *  Purpose-matched entries of the scan Desktop runs for its own balances. */
export function txBuildAccountPath(chain: ChainDef, scriptType: string, accountIndex: number): number[] | undefined {
  if (chain.chainFamily !== 'utxo' || !(scriptType in PURPOSE)) return undefined
  const purpose = PURPOSE[scriptType as TxBuildScriptType] + 0x80000000
  return utxoAccountScriptPaths(chain, accountIndex, true)
    .find(e => e.scriptType === scriptType && e.path[0] === purpose)?.path
}

const COSMOS_SIGN_ROUTES: Record<string, TxBuildSignRoute> = {
  cosmos: '/cosmos/sign-amino',
  osmosis: '/osmosis/sign-amino',
  thorchain: '/thorchain/sign-amino-transfer',
  mayachain: '/mayachain/sign-amino-transfer',
}

const refuse = (code: string, message: string) => new HttpError(400, message, { code })

export function validateTxBuildRequest(
  body: { caip: string; to: string; amount?: string; isMax?: boolean; memo?: string; accountIndex?: number; scriptType?: string },
  chains: ChainDef[],
): { chain: ChainDef; request: TxBuildHeadlessRequest } {
  const chainId = (TX_BUILD_CAIPS as Record<string, string>)[body.caip]
  const chain = chainId ? chains.find(c => c.id === chainId && c.caip === body.caip) : undefined
  if (!chain) throw refuse('UNSUPPORTED_ASSET', `${body.caip} cannot be sent from the extension yet`)

  const to = body.to.trim()
  if (!validateAddress(to, chain).valid) throw refuse('INVALID_ADDRESS', `Invalid ${chain.symbol} address`)
  if (isBurnAddress(to)) throw refuse('INVALID_ADDRESS', `${to} is a burn address: ${chain.symbol} sent there can never be spent`)

  const isMax = body.isMax === true
  let amount: string | undefined
  if (!isMax) {
    if (body.amount === undefined) throw refuse('INVALID_AMOUNT', 'Enter an amount, or send the maximum')
    const m = /^(\d+)(?:\.(\d+))?$/.exec(body.amount)
    if (!m || (m[2]?.length ?? 0) > chain.decimals) {
      throw refuse('INVALID_AMOUNT', `Invalid ${chain.symbol} amount: use a plain number with at most ${chain.decimals} decimals`)
    }
    if (/^0*$/.test(m[1] + (m[2] ?? ''))) throw refuse('INVALID_AMOUNT', 'Amount must be greater than zero')
    amount = body.amount
  }

  const memo = body.memo?.trim() ? body.memo : undefined
  if (memo && chain.chainFamily === 'utxo') {
    throw refuse('MEMO_UNSUPPORTED', `Memos are not supported for ${chain.symbol} sends from the extension`)
  }

  const scriptType = body.scriptType
  if (scriptType !== undefined && !txBuildAccountPath(chain, scriptType, 0)) {
    throw refuse('SCRIPT_TYPE_UNSUPPORTED', `${chain.symbol} cannot be sent from a ${scriptType || 'blank'} account`)
  }

  // Without a script type, non-BTC UTXO sends spend all account-0 types at once,
  // so only a named account can be account N.
  const accountIndex = body.accountIndex ?? 0
  if (accountIndex > 0 && chain.id !== 'bitcoin' && scriptType === undefined) {
    throw refuse('ACCOUNT_UNSUPPORTED', `Only account 0 can send ${chain.symbol} from the extension`)
  }

  const request: TxBuildHeadlessRequest = { chainId: chain.id, to, amount, isMax, memo, accountIndex }
  if (scriptType !== undefined) request.scriptType = scriptType as TxBuildScriptType
  return { chain, request }
}

/** The single account (script type + account path) that every input and every
 *  change output of a UTXO build belongs to; undefined when they differ. */
function builtUtxoAccount(u: any): { scriptType: string; path: number[] } | undefined {
  const legs = [...u.inputs, ...u.outputs.filter((o: any) => o.addressType === 'change')]
  const first = legs[0]
  if (!Array.isArray(first?.addressNList) || first.addressNList.length < 3) return undefined
  const path: number[] = first.addressNList.slice(0, 3)
  const same = legs.every((l: any) => l.scriptType === first.scriptType && Array.isArray(l.addressNList)
    && l.addressNList.length >= 3 && path.every((n, i) => l.addressNList[i] === n))
  return same ? { scriptType: first.scriptType, path } : undefined
}

/** Map a built unsignedTx to the sign route that accepts it unchanged. When the
 *  request named a UTXO account, a build that spends anything else (or sends
 *  change elsewhere) is refused rather than returned. */
export function toTxBuildResponse(
  chain: ChainDef,
  built: BuildTxResult,
  requested?: Pick<TxBuildHeadlessRequest, 'scriptType' | 'accountIndex'>,
): TxBuildResponse {
  const u = built.unsignedTx
  const display = (base: string) => baseUnitsToDecimalString(BigInt(base), chain.decimals)
  const base = { fee: built.fee, symbol: chain.symbol }

  if (chain.chainFamily === 'utxo') {
    const spends = u.outputs.filter((o: any) => o.addressType === 'spend')
    if (spends.length !== 1) throw new HttpError(422, `Unexpected ${chain.symbol} build: ${spends.length} recipient outputs`, { code: 'BUILD_FAILED' })
    const account = builtUtxoAccount(u)
    if (requested?.scriptType) {
      const want = txBuildAccountPath(chain, requested.scriptType, requested.accountIndex)
      if (!want || account?.scriptType !== requested.scriptType || !want.every((n, i) => account.path[i] === n)) {
        throw new HttpError(422, `KeepKey Desktop did not build this ${chain.symbol} send from the selected account. Nothing was signed.`, { code: 'BUILD_FAILED' })
      }
    }
    return {
      signRoute: '/utxo/sign-transaction',
      signBody: { coin: u.coin, inputs: u.inputs, outputs: u.outputs, version: u.version, locktime: u.locktime },
      summary: {
        to: spends[0].address, amount: display(spends[0].amount), ...base,
        ...(account ? { scriptType: account.scriptType, accountIndex: account.path[2] - 0x80000000 } : {}),
      },
    }
  }

  if (chain.chainFamily === 'cosmos') {
    const send = u.tx.msg[0].value
    return {
      signRoute: COSMOS_SIGN_ROUTES[chain.id],
      signBody: {
        signerAddress: u.signerAddress,
        signDoc: { account_number: u.account_number, chain_id: u.chain_id, fee: u.tx.fee, memo: u.tx.memo, msgs: u.tx.msg, sequence: u.sequence },
      },
      summary: { to: send.to_address, amount: display(send.amount[0].amount), ...base, ...(u.tx.memo ? { memo: u.tx.memo } : {}) },
    }
  }

  // XRP: the builder output already is the /xrp/sign-transaction body.
  const { flags: _flags, ...signBody } = u
  const routingMemo = u.tx.value.memo?.trim()
  return {
    signRoute: '/xrp/sign-transaction',
    signBody,
    summary: {
      to: u.payment.destination, amount: display(u.payment.amount), ...base,
      ...(routingMemo ? { memo: routingMemo } : {}),
      ...(u.payment.destinationTag !== undefined ? { destinationTag: u.payment.destinationTag } : {}),
    },
  }
}

/** The buildTxForCurrentWallet params for a validated request. A named script
 *  type on any UTXO chain (Bitcoin included) is account N derived on the device
 *  from its account path, so it need not be one Desktop already tracks. Without
 *  one, Bitcoin spends the xpub Desktop holds for that account. */
export function txBuildParams(r: TxBuildHeadlessRequest, chain: ChainDef, btcAccounts: BtcAccountSet): BuildTxParams {
  const p: BuildTxParams = { chainId: r.chainId, to: r.to, amount: r.isMax ? '0' : r.amount!, isMax: r.isMax, memo: r.memo, feeLevel: 3 }
  if (r.scriptType) {
    const accountPath = txBuildAccountPath(chain, r.scriptType, r.accountIndex)
    if (!accountPath) throw refuse('SCRIPT_TYPE_UNSUPPORTED', `${r.chainId} cannot be sent from a ${r.scriptType} account`)
    p.scriptTypeOverride = r.scriptType
    p.accountPath = accountPath
  } else if (r.chainId === 'bitcoin') {
    p.xpubOverride = btcXpubForAccount(btcAccounts, r.accountIndex).xpub
  }
  return p
}

/** Desktop's BTC account N in the named script type, or (none named) the one
 *  Desktop has selected. Only xpubs Desktop derived from the device qualify. */
export function btcXpubForAccount(set: BtcAccountSet, accountIndex: number, scriptType?: TxBuildScriptType): BtcXpub {
  const account = set.accounts.find(a => a.accountIndex === accountIndex)
  if (!account) throw refuse('ACCOUNT_NOT_FOUND', `KeepKey Desktop has no Bitcoin account ${accountIndex}`)
  const type = scriptType ?? set.selectedXpub?.scriptType ?? 'p2wpkh'
  const xpub = account.xpubs.find(x => x.scriptType === type)
  if (!xpub) throw refuse('SCRIPT_TYPE_UNSUPPORTED', `This KeepKey has no ${type} Bitcoin account ${accountIndex}`)
  return xpub
}
