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
import { validateAddress } from '../shared/address-validation'
import { baseUnitsToDecimalString } from '../shared/max-send'
import type { ChainDef } from '../shared/chains'
import type { BtcAccountSet, BtcXpub, BuildTxResult } from '../shared/types'

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

/** Exactly what reaches buildTxHeadless. Nothing else from the client does. */
export interface TxBuildHeadlessRequest {
  chainId: string
  to: string
  amount: string | undefined
  isMax: boolean
  memo: string | undefined
  accountIndex: number
}

export interface TxBuildResponse {
  signRoute: TxBuildSignRoute
  signBody: Record<string, unknown>
  summary: { to: string; amount: string; fee: string; symbol: string; memo?: string; destinationTag?: string }
}

const COSMOS_SIGN_ROUTES: Record<string, TxBuildSignRoute> = {
  cosmos: '/cosmos/sign-amino',
  osmosis: '/osmosis/sign-amino',
  thorchain: '/thorchain/sign-amino-transfer',
  mayachain: '/mayachain/sign-amino-transfer',
}

const refuse = (code: string, message: string) => new HttpError(400, message, { code })

export function validateTxBuildRequest(
  body: { caip: string; to: string; amount?: string; isMax?: boolean; memo?: string; accountIndex?: number },
  chains: ChainDef[],
): { chain: ChainDef; request: TxBuildHeadlessRequest } {
  const chainId = (TX_BUILD_CAIPS as Record<string, string>)[body.caip]
  const chain = chainId ? chains.find(c => c.id === chainId && c.caip === body.caip) : undefined
  if (!chain) throw refuse('UNSUPPORTED_ASSET', `${body.caip} cannot be sent from the extension yet`)

  const to = body.to.trim()
  if (!validateAddress(to, chain).valid) throw refuse('INVALID_ADDRESS', `Invalid ${chain.symbol} address`)

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

  const accountIndex = body.accountIndex ?? 0
  if (accountIndex > 0 && chain.id !== 'bitcoin') {
    throw refuse('ACCOUNT_UNSUPPORTED', `Only account 0 can send ${chain.symbol} from the extension`)
  }

  return { chain, request: { chainId: chain.id, to, amount, isMax, memo, accountIndex } }
}

/** Map a built unsignedTx to the sign route that accepts it unchanged. */
export function toTxBuildResponse(chain: ChainDef, built: BuildTxResult): TxBuildResponse {
  const u = built.unsignedTx
  const display = (base: string) => baseUnitsToDecimalString(BigInt(base), chain.decimals)
  const base = { fee: built.fee, symbol: chain.symbol }

  if (chain.chainFamily === 'utxo') {
    const spends = u.outputs.filter((o: any) => o.addressType === 'spend')
    if (spends.length !== 1) throw new HttpError(422, `Unexpected ${chain.symbol} build: ${spends.length} recipient outputs`, { code: 'BUILD_FAILED' })
    return {
      signRoute: '/utxo/sign-transaction',
      signBody: { coin: u.coin, inputs: u.inputs, outputs: u.outputs, version: u.version, locktime: u.locktime },
      summary: { to: spends[0].address, amount: display(spends[0].amount), ...base },
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

/** Desktop's BTC account N, in the script type Desktop has selected. */
export function btcXpubForAccount(set: BtcAccountSet, accountIndex: number): BtcXpub | undefined {
  const scriptType = set.selectedXpub?.scriptType ?? 'p2wpkh'
  return set.accounts.find(a => a.accountIndex === accountIndex)?.xpubs.find(x => x.scriptType === scriptType)
}
