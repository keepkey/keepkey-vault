/**
 * XRP tx builder — simplified from pioneer-sdk/txbuilder/createUnsignedRippleTx.ts
 *
 * Fetches sequence + ledger index from Pioneer API.
 * Returns object ready for hdwallet's rippleSignTx().
 */
import type { ChainDef } from '../../shared/chains'

const TAG = '[txbuilder:xrp]'
export const XRP_FEE_DROPS = 1000n
/** Cross-chain routing memos (THORChain / Maya): short and long forms, e.g. "=:ETH.ETH:0x…", "SWAP:…", "s:…". */
const XRP_SWAP_MEMO = /^(?:[=+\-~]|swap|s|add|a|withdraw|wd)?:/i
const uint = (value: unknown, label: string): bigint => {
  if (!/^\d+$/.test(String(value))) throw new Error(`Invalid XRP ${label}`)
  return BigInt(String(value))
}

async function maxDrops(account: any): Promise<bigint> {
  const balance = uint(account.Balance, 'balance'), owners = uint(account.OwnerCount, 'owner count')
  for (const endpoint of ['https://s1.ripple.com:51234', 'https://s2.ripple.com:51234']) {
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'server_state', params: [{}] }), signal: AbortSignal.timeout(8000) })
      if (!response.ok) continue
      const body = await response.json() as any
      const ledger = body?.result?.state?.validated_ledger
      const base = uint(ledger?.reserve_base, 'base reserve'), increment = uint(ledger?.reserve_inc, 'owner reserve')
      if (base <= 0n || increment <= 0n) continue
      const available = balance - base - owners * increment - XRP_FEE_DROPS
      if (available <= 0n) throw new Error('Insufficient XRP after account reserve and transaction fee')
      return available
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Insufficient XRP')) throw error
    }
  }
  throw new Error('Cannot verify XRP account reserves for MAX. No transaction was built.')
}

export async function getXrpMaxAmount(pioneer: any, address: string): Promise<string> {
  const account = (await pioneer.GetAccountInfo({ address, network: 'ripple' }))?.data
  if (!account) throw new Error('Failed to get XRP account info')
  const drops = await maxDrops(account)
  return `${drops / 1000000n}.${(drops % 1000000n).toString().padStart(6, '0')}`
}

export interface BuildXrpParams {
  to: string
  amount: string    // human-readable (e.g. "10")
  memo?: string
  isMax?: boolean
  fromAddress: string
}

export async function buildXrpTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildXrpParams,
) {
  const { to, memo = '', isMax = false, fromAddress } = params

  // 1. Get account info (API expects short network name, not CAIP networkId)
  console.log(`${TAG} Fetching account info for XRP...`)
  let accountInfo = (await pioneer.GetAccountInfo({ address: fromAddress, network: chain.id }))?.data
  if (!accountInfo) throw new Error('Failed to get XRP account info')

  const sequence = String(accountInfo.Sequence || '0')
  const ledgerIndexCurrent = parseInt(accountInfo.ledger_index_current || '0')

  // 2. Destination tag vs routing memo.
  //   - empty            → no tag at all (never a silent tag 0: exchanges credit by tag)
  //   - whole number     → destination tag (0–4294967295)
  //   - swap routing memo (THORChain/Maya "=:…", "SWAP:…", …) → memo data, no tag
  //   - anything else    → rejected: "Tag: 104857" used to become a memo AND send tag 0
  let destinationTag: string | undefined
  let memoData: string | undefined

  const trimmed = memo.trim()
  if (trimmed) {
    if (XRP_SWAP_MEMO.test(trimmed)) {
      memoData = trimmed
    } else if (/^\d+$/.test(trimmed) && BigInt(trimmed) <= 4294967295n) {
      destinationTag = BigInt(trimmed).toString()
    } else if (/^\d+$/.test(trimmed)) {
      throw new Error(`XRP destination tag must be 0-4294967295, got: ${trimmed}`)
    } else {
      throw new Error('XRP destination tag must be a whole number (0-4294967295). Remove any text, then try again.')
    }
  }

  // 3. Compute amount in drops
  let drops: bigint
  if (isMax) {
    drops = await maxDrops(accountInfo)
  } else {
    if (!/^\d+(?:\.\d{1,6})?$/.test(params.amount)) throw new Error('Invalid XRP amount: use at most six decimals')
    const [whole, fraction = ''] = params.amount.split('.')
    drops = BigInt(whole + fraction.padEnd(6, '0'))
  }

  if (drops <= 0n) throw new Error('Amount must be greater than zero')
  if (accountInfo.Balance != null && drops + XRP_FEE_DROPS > uint(accountInfo.Balance, 'balance')) throw new Error('Insufficient XRP for amount and transaction fee')

  // 4. Build unsigned tx
  const msg = {
    type: 'ripple-sdk/MsgSend',
    value: {
      amount: [{ amount: String(drops), denom: 'drop' }],
      from_address: fromAddress,
      to_address: to,
    },
  }

  const tx = {
    type: 'auth/StdTx',
    value: {
      fee: {
        amount: [{ amount: XRP_FEE_DROPS.toString(), denom: 'drop' }],
        gas: '28000',
      },
      memo: memoData || ' ',
      msg: [msg],
      signatures: null,
    },
  }

  // Omit destinationTag when there is none: the signer only sets a tag when it is defined.
  const payment: { amount: string; destination: string; destinationTag?: string } = {
    amount: String(drops),
    destination: to,
    ...(destinationTag !== undefined ? { destinationTag } : {}),
  }

  return {
    addressNList: chain.defaultPath,
    tx,
    flags: undefined,
    lastLedgerSequence: String(ledgerIndexCurrent + 1000),
    sequence,
    payment,
    fee: '0.001', // 1000 drops = 0.001 XRP
  }
}
