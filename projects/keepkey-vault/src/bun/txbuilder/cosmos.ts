/**
 * Cosmos/THORChain/Maya/Osmosis tx builder
 * Simplified from pioneer-sdk/txbuilder/createUnsignedTendermintTx.ts
 *
 * Fetches account_number + sequence from Pioneer API.
 * Returns object ready for hdwallet's cosmosSignTx / thorchainSignTx / etc.
 */
import type { ChainDef } from '../../shared/chains'

const TAG = '[txbuilder:cosmos]'

/** Convert a decimal string (e.g. "1.5") to base units using integer math only. */
function toBaseUnits(displayAmount: string, decimals: number): bigint {
  const parts = displayAmount.split('.')
  const whole = parts[0] || '0'
  const frac = (parts[1] || '').slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac)
}

// Chain-specific fees (in display units)
const FEES: Record<string, number> = {
  thorchain: 0.02,
  mayachain: 0,
  cosmos: 0.005,
  osmosis: 0.035,
}

// Chain-specific msg types (MsgSend)
const MSG_SEND_TYPES: Record<string, string> = {
  thorchain: 'thorchain/MsgSend',
  mayachain: 'mayachain/MsgSend',
  cosmos: 'cosmos-sdk/MsgSend',
  osmosis: 'cosmos-sdk/MsgSend',
}

// Chain-specific msg types (MsgDeposit — used for swaps/LP on THORChain/Maya)
const MSG_DEPOSIT_TYPES: Record<string, string> = {
  thorchain: 'thorchain/MsgDeposit',
  mayachain: 'mayachain/MsgDeposit',
}

// MsgDeposit asset identifiers (CHAIN.SYMBOL format)
const DEPOSIT_ASSETS: Record<string, string> = {
  thorchain: 'THOR.RUNE',
  mayachain: 'MAYA.CACAO',
}

// Fee templates
const FEE_TEMPLATES: Record<string, { gas: string; amount: { denom: string; amount: string }[] }> = {
  thorchain: { gas: '500000000', amount: [{ denom: 'rune', amount: '0' }] },
  mayachain: { gas: '500000000', amount: [{ denom: 'cacao', amount: '0' }] },
  cosmos: { gas: '1000000', amount: [{ denom: 'uatom', amount: '5000' }] },
  osmosis: { gas: '1000000', amount: [{ denom: 'uosmo', amount: '10000' }] },
}

export interface BuildCosmosParams {
  to: string
  amount: string    // human-readable (e.g. "1.5")
  memo?: string
  isMax?: boolean
  isSwapDeposit?: boolean // use MsgDeposit instead of MsgSend (for THORChain/Maya swaps)
  fromAddress: string
}

export async function buildCosmosTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildCosmosParams,
) {
  const { to, memo = '', isMax = false, isSwapDeposit = false, fromAddress } = params

  const denom = chain.denom || chain.symbol.toLowerCase()

  // 1. Get account info (API expects short network name, not CAIP networkId)
  console.log(`${TAG} Fetching account info for ${chain.coin}...`)
  const accountResp = await pioneer.GetAccountInfo({ network: chain.id, address: fromAddress })
  const accountInfo = accountResp?.data

  let account_number: string
  let sequence: string

  if (accountInfo?.account) {
    account_number = String(accountInfo.account.account_number || '0')
    sequence = String(accountInfo.account.sequence || '0')
  } else if (accountInfo?.result?.value) {
    account_number = String(accountInfo.result.value.account_number || '0')
    sequence = String(accountInfo.result.value.sequence || '0')
  } else {
    throw new Error(`Unexpected account info format for ${chain.id}: ${JSON.stringify(accountInfo)}`)
  }

  console.log(`${TAG} account_number=${account_number}, sequence=${sequence}`)

  // 2. Compute amount in base units (integer math to avoid float precision loss)
  let baseAmount: bigint

  if (isMax) {
    const balResp = await pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey: fromAddress }] })
    const balStr = String((balResp?.data?.balances || [])[0]?.balance ?? '0')
    const feeDisplay = FEES[chain.id] || 0
    const balBase = toBaseUnits(balStr, chain.decimals)
    const feeBase = toBaseUnits(String(feeDisplay), chain.decimals)
    baseAmount = balBase - feeBase
    if (baseAmount < 0n) baseAmount = 0n
  } else {
    baseAmount = toBaseUnits(params.amount, chain.decimals)
  }

  if (baseAmount <= 0n) throw new Error('Amount must be greater than zero')

  // 3. Build unsigned tx
  const fee = FEE_TEMPLATES[chain.id] || FEE_TEMPLATES.cosmos
  if (!chain.chainId) throw new Error(`Missing chainId for Cosmos chain: ${chain.id}`)
  const chain_id = chain.chainId

  const feeInDisplay = String(Number(fee.amount[0]?.amount || 0) / 10 ** chain.decimals)

  // Determine message type: MsgDeposit for THORChain/Maya swaps (explicit flag), MsgSend otherwise
  // NOTE: Do NOT infer from !!memo — normal sends with memos (e.g. exchange deposits) must use MsgSend
  const isDeposit = isSwapDeposit && (chain.id === 'thorchain' || chain.id === 'mayachain')
  let msg: { type: string; value: Record<string, unknown> }

  if (isDeposit) {
    const depositType = MSG_DEPOSIT_TYPES[chain.id]!
    const depositAsset = DEPOSIT_ASSETS[chain.id]!
    console.log(`${TAG} Building MsgDeposit: asset=${depositAsset}, amount=${baseAmount}, memo=${memo}`)
    msg = {
      type: depositType,
      value: {
        coins: [{ asset: depositAsset, amount: String(baseAmount) }],
        memo,
        signer: fromAddress,
      },
    }
  } else {
    const sendType = MSG_SEND_TYPES[chain.id] || 'cosmos-sdk/MsgSend'
    msg = {
      type: sendType,
      value: {
        amount: [{ denom, amount: String(baseAmount) }],
        from_address: fromAddress,
        to_address: to,
      },
    }
  }

  return {
    signerAddress: fromAddress,
    addressNList: chain.defaultPath,
    tx: {
      fee,
      memo: memo || '',
      msg: [msg],
      signatures: [],
    },
    chain_id,
    account_number,
    sequence,
    fee: feeInDisplay,
  }
}
