/**
 * Cosmos/THORChain/Maya/Osmosis tx builder
 * Simplified from pioneer-sdk/txbuilder/createUnsignedTendermintTx.ts
 *
 * Fetches account_number + sequence from Pioneer API.
 * Returns object ready for hdwallet's cosmosSignTx / thorchainSignTx / etc.
 */
import type { ChainDef } from '../../shared/chains'

const TAG = '[txbuilder:cosmos]'

// Chain-specific fees (in display units)
const FEES: Record<string, number> = {
  thorchain: 0.02,
  mayachain: 0,
  cosmos: 0.005,
  osmosis: 0.035,
}

// Chain-specific msg types
const MSG_TYPES: Record<string, string> = {
  thorchain: 'thorchain/MsgSend',
  mayachain: 'mayachain/MsgSend',
  cosmos: 'cosmos-sdk/MsgSend',
  osmosis: 'cosmos-sdk/MsgSend',
}

// Fee templates
const FEE_TEMPLATES: Record<string, { gas: string; amount: { denom: string; amount: string }[] }> = {
  thorchain: { gas: '500000000', amount: [{ denom: 'rune', amount: '0' }] },
  mayachain: { gas: '500000000', amount: [{ denom: 'cacao', amount: '0' }] },
  cosmos: { gas: '1000000', amount: [{ denom: 'uatom', amount: '5000' }] },
  osmosis: { gas: '1000000', amount: [{ denom: 'uosmo', amount: '30000' }] },
}

export interface BuildCosmosParams {
  to: string
  amount: string    // human-readable (e.g. "1.5")
  memo?: string
  isMax?: boolean
  fromAddress: string
}

export interface BuildCosmosStakingParams {
  validatorAddress: string
  amount: string    // human-readable (e.g. "1.5")
  memo?: string
  fromAddress: string
  type: 'delegate' | 'undelegate'
}

export async function buildCosmosTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildCosmosParams,
) {
  const { to, memo = '', isMax = false, fromAddress } = params
  let amountNum = parseFloat(params.amount)

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

  // 2. Compute amount in base units
  let baseAmount: number

  if (isMax) {
    const balResp = await pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey: fromAddress }] })
    const balanceDisplay = Number((balResp?.data?.balances || [])[0]?.balance ?? 0)
    const feeDisplay = FEES[chain.id] || 0
    baseAmount = Math.floor(Math.max(0, balanceDisplay * 10 ** chain.decimals - feeDisplay * 10 ** chain.decimals))
  } else {
    baseAmount = Math.floor(amountNum * 10 ** chain.decimals)
  }

  if (baseAmount <= 0) throw new Error('Amount must be greater than zero')

  // 3. Build unsigned tx
  const fee = FEE_TEMPLATES[chain.id] || FEE_TEMPLATES.cosmos
  const msgType = MSG_TYPES[chain.id] || 'cosmos-sdk/MsgSend'
  if (!chain.chainId) throw new Error(`Missing chainId for Cosmos chain: ${chain.id}`)
  const chain_id = chain.chainId

  const feeInDisplay = String(Number(fee.amount[0]?.amount || 0) / 10 ** chain.decimals)

  return {
    signerAddress: fromAddress,
    addressNList: chain.defaultPath,
    tx: {
      fee,
      memo: memo || '',
      msg: [
        {
          type: msgType,
          value: {
            amount: [{ denom, amount: String(baseAmount) }],
            from_address: fromAddress,
            to_address: to,
          },
        },
      ],
      signatures: [],
    },
    chain_id,
    account_number,
    sequence,
    fee: feeInDisplay,
  }
}

export async function buildCosmosStakingTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildCosmosStakingParams,
) {
  const { validatorAddress, memo = '', fromAddress, type } = params
  let amountNum = parseFloat(params.amount)

  if (!validatorAddress) throw new Error('Validator address is required')
  if (!amountNum || amountNum <= 0) throw new Error('Amount must be greater than zero')

  const denom = chain.denom || chain.symbol.toLowerCase()

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

  const baseAmount = Math.floor(amountNum * 10 ** chain.decimals)
  if (baseAmount <= 0) throw new Error('Amount must be greater than zero')

  const fee = FEE_TEMPLATES[chain.id] || FEE_TEMPLATES.cosmos
  const feeInDisplay = String(Number(fee.amount[0]?.amount || 0) / 10 ** chain.decimals)
  if (!chain.chainId) throw new Error(`Missing chainId for Cosmos chain: ${chain.id}`)
  const chain_id = chain.chainId

  const msgType = type === 'undelegate' ? 'cosmos-sdk/MsgUndelegate' : 'cosmos-sdk/MsgDelegate'
  const msgValue = {
    amount: { denom, amount: String(baseAmount) },
    delegator_address: fromAddress,
    validator_address: validatorAddress,
  }

  return {
    signerAddress: fromAddress,
    addressNList: chain.defaultPath,
    tx: {
      fee,
      memo: memo || '',
      msg: [{ type: msgType, value: msgValue }],
      signatures: [],
    },
    chain_id,
    account_number,
    sequence,
    fee: feeInDisplay,
  }
}
