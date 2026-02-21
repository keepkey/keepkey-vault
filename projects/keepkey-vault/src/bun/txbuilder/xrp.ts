/**
 * XRP tx builder — simplified from pioneer-sdk/txbuilder/createUnsignedRippleTx.ts
 *
 * Fetches sequence + ledger index from Pioneer API.
 * Returns object ready for hdwallet's rippleSignTx().
 */
import type { ChainDef } from '../../shared/chains'

const TAG = '[txbuilder:xrp]'

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
  let amountNum = parseFloat(params.amount)

  // 1. Get account info (use CAIP networkId)
  console.log(`${TAG} Fetching account info for XRP...`)
  let accountInfo = (await pioneer.GetAccountInfo({ address: fromAddress, network: chain.networkId }))?.data
  if (!accountInfo) throw new Error('Failed to get XRP account info')

  const sequence = String(accountInfo.Sequence || '0')
  const ledgerIndexCurrent = parseInt(accountInfo.ledger_index_current || '0')

  // 2. Handle memo vs destination tag
  let destinationTag: string | undefined
  let memoData: string | undefined

  if (memo && memo.trim()) {
    if (/^\d+$/.test(memo.trim())) {
      const tagNum = parseInt(memo.trim(), 10)
      if (tagNum >= 0 && tagNum <= 4294967295) {
        destinationTag = String(tagNum)
      } else {
        throw new Error(`XRP destination tag must be 0-4294967295, got: ${memo}`)
      }
    } else {
      memoData = memo.trim()
    }
  }

  // 3. Compute amount in drops
  let drops: number
  if (isMax) {
    drops = Number(accountInfo.Balance) - 1000000 - 1 // reserve 1 XRP + 1 drop
  } else {
    drops = Math.round(amountNum * 1e6)
  }

  if (drops <= 0) throw new Error('Amount must be greater than zero')

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
        amount: [{ amount: '1000', denom: 'drop' }],
        gas: '28000',
      },
      memo: memoData || ' ',
      msg: [msg],
      signatures: null,
    },
  }

  const payment = {
    amount: String(drops),
    destination: to,
    destinationTag: destinationTag || '0',
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
