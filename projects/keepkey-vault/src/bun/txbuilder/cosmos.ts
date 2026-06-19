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

// Native transaction fee reserved on a MAX send/deposit (in display units).
// THORChain/Maya charge this fee on top of the deposited/sent amount at the
// bank layer (the tx `fee.amount` is '0' — the network deducts it from the
// account), so a MAX must leave headroom: account needs amount + fee. Maya's
// NativeTransactionFee is 0.2 CACAO (2000000000 base @ 10 decimals); reserving
// 0 swept 100% of the balance and every MAX CACAO swap reverted with
// "insufficient funds". THORChain's native_tx_fee is 0.02 RUNE.
const FEES: Record<string, number> = {
  thorchain: 0.02,
  mayachain: 0.2,
  cosmos: 0.005,
  osmosis: 0.035,
}

// A MAX reserves FEE × this multiplier — never the bare fee. Reserving exactly
// the fee leaves zero headroom, and a MAX CACAO swap STILL reverted on-chain
// with "insufficient funds" (no refund) even after FEES.mayachain was set to
// the exact 0.2 CACAO: Pioneer reports the balance rounded/slightly stale
// (778.25133011 for an on-chain 778.2513), so amount = reportedBalance − fee
// overdrew the *real* balance by a few hundred base units. The frontend
// EVM/Solana MAX reserves deliberately leave a real buffer (the Solana one is
// ~2000× the fee) for exactly this drift; mirror that here. 2× the fee is
// ~$0.025 on Maya / ~$0.04 on THOR — dust against any swap. The unused
// remainder simply stays in the wallet.
const MAX_FEE_RESERVE_MULTIPLIER = 2n

/** Base-unit amount to hold back on a MAX send/deposit so the account keeps
 *  `amount` + everything the network charges, with headroom for a slightly-stale
 *  reported balance (Pioneer rounds balances). There are two distinct cost
 *  sources and only one applies per chain:
 *    - cosmos/osmosis pay the tx fee via `fee.amount` (deducted by the ante
 *      handler). Pass the *actual feeLevel-adjusted* fee — reserving the static
 *      FEES value under-reserves once the gas multiplier kicks in (feeLevel 5
 *      doubles it), leaving zero headroom.
 *    - thor/maya set `fee.amount` to '0' and charge the native fee at the bank
 *      layer (the FEES table), which `fee.amount` can't see.
 *  Reserve the larger of the two, then × the multiplier so a full extra fee of
 *  headroom sits above the real cost. */
function maxFeeReserveBase(chain: ChainDef, adjustedTxFeeBase: bigint): bigint {
  const nativeBankFeeBase = toBaseUnits(String(FEES[chain.id] || 0), chain.decimals)
  const cost = adjustedTxFeeBase > nativeBankFeeBase ? adjustedTxFeeBase : nativeBankFeeBase
  return cost * MAX_FEE_RESERVE_MULTIPLIER
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
  feeLevel?: number // 1-2=slow, 3-4=avg, 5+=fast (default 5)
  isMax?: boolean
  isSwapDeposit?: boolean // use MsgDeposit instead of MsgSend (for THORChain/Maya swaps)
  fromAddress: string
}

export async function buildCosmosTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildCosmosParams,
) {
  const { to, memo = '', feeLevel = 5, isMax = false, isSwapDeposit = false, fromAddress } = params

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

  // 2. Build the fee FIRST (it's independent of amount) so a MAX can reserve
  //    against the actual feeLevel-adjusted fee, not a stale guess.
  const baseFee = FEE_TEMPLATES[chain.id] || FEE_TEMPLATES.cosmos
  const gasMultiplier = feeLevel <= 2 ? 1 : feeLevel <= 4 ? 1.5 : 2
  const adjustedGas = String(Math.ceil(Number(baseFee.gas) * gasMultiplier))
  const adjustedFeeAmount = baseFee.amount.map(a => ({
    ...a,
    amount: String(Math.ceil(Number(a.amount) * gasMultiplier)),
  }))
  const fee = { gas: adjustedGas, amount: adjustedFeeAmount }
  if (!chain.chainId) throw new Error(`Missing chainId for Cosmos chain: ${chain.id}`)
  const chain_id = chain.chainId

  const feeInDisplay = String(Number(fee.amount[0]?.amount || 0) / 10 ** chain.decimals)

  // 3. Compute amount in base units (integer math to avoid float precision loss)
  let baseAmount: bigint

  if (isMax) {
    const balResp = await pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey: fromAddress }] }, { forceRefresh: true })
    const balStr = String((balResp?.data?.balances || [])[0]?.balance ?? '0')
    const balBase = toBaseUnits(balStr, chain.decimals)
    const feeBase = maxFeeReserveBase(chain, BigInt(fee.amount[0]?.amount || '0'))
    baseAmount = balBase - feeBase
    if (baseAmount < 0n) baseAmount = 0n
  } else {
    baseAmount = toBaseUnits(params.amount, chain.decimals)
  }

  if (baseAmount <= 0n) throw new Error('Amount must be greater than zero')

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

// ── Staking / delegation tx builder ─────────────────────────────────────

export interface BuildCosmosStakingParams {
  validatorAddress: string
  amount: string    // human-readable (e.g. "1.5")
  memo?: string
  fromAddress: string
  type: 'delegate' | 'undelegate'
  isMax?: boolean   // delegate all available balance minus fee
}

export async function buildCosmosStakingTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildCosmosStakingParams,
) {
  const { validatorAddress, memo = '', fromAddress, type, isMax = false } = params

  if (!validatorAddress) throw new Error('Validator address is required')
  if (!isMax) {
    const amountNum = parseFloat(params.amount)
    if (!amountNum || amountNum <= 0) throw new Error('Amount must be greater than zero')
  }

  const denom = chain.denom || chain.symbol.toLowerCase()

  console.log(`${TAG} Fetching account info for ${chain.coin} (staking)...`)
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

  const fee = FEE_TEMPLATES[chain.id] || FEE_TEMPLATES.cosmos
  const feeInDisplay = String(Number(fee.amount[0]?.amount || 0) / 10 ** chain.decimals)

  let baseAmount: bigint
  if (isMax) {
    // Delegate all available balance minus the network fee (matches buildCosmosTx send-max)
    const balResp = await pioneer.GetPortfolioBalances({ pubkeys: [{ caip: chain.caip, pubkey: fromAddress }] }, { forceRefresh: true })
    const balStr = String((balResp?.data?.balances || [])[0]?.balance ?? '0')
    const balBase = toBaseUnits(balStr, chain.decimals)
    // Same headroom rationale as buildCosmosTx (see maxFeeReserveBase). This
    // builder doesn't apply a feeLevel multiplier, so fee.amount is the actual
    // fee paid.
    const feeBase = maxFeeReserveBase(chain, BigInt(fee.amount[0]?.amount || '0'))
    baseAmount = balBase - feeBase
    if (baseAmount < 0n) baseAmount = 0n
  } else {
    baseAmount = toBaseUnits(params.amount, chain.decimals)
  }
  if (baseAmount <= 0n) throw new Error('Amount must be greater than zero')
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

// ── THORName / MAYAName registration tx builder ─────────────────────────
// Registration is a MsgDeposit (native RUNE/CACAO) with a `~:` memo that routes
// it to the ManageTHORName handler. The deposited amount must cover the one-time
// register fee plus per-block rent for the requested number of years:
//   amount = registerFee + feePerBlock * blocksPerYear * years   (base units)
// Owner defaults to the signer; the alias is the signer's own L1 address on the
// chain. See docs/handoff-thorname-mayaname-pioneer.md for the memo spec.

// `chain` field of the memo (the alias's chain). v1 registers the chain's own L1.
const NAME_MEMO_CHAIN: Record<string, string> = {
  thorchain: 'THOR',
  mayachain: 'MAYA',
}

const NAME_RE = /^[a-zA-Z0-9+_-]{1,30}$/

export interface BuildCosmosNameRegParams {
  name: string
  years: number
  fromAddress: string
}

export async function buildCosmosNameRegTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildCosmosNameRegParams,
) {
  const { name, years, fromAddress } = params

  if (chain.id !== 'thorchain' && chain.id !== 'mayachain') {
    throw new Error(`Name registration not supported for chain: ${chain.id}`)
  }
  if (!NAME_RE.test(name)) {
    throw new Error('Invalid name: use 1-30 chars of a-z, A-Z, 0-9, +, _, -')
  }
  if (!Number.isInteger(years) || years < 1) throw new Error('years must be a positive integer')

  // 1. Live registration cost constants (base units) from Pioneer.
  console.log(`${TAG} Fetching name registration quote for ${chain.coin}...`)
  const quoteResp = await pioneer.GetNameRegistrationQuote({ network: chain.id })
  // Pioneer wraps the payload in a `data` envelope (like GetStakingPositions).
  const quote = quoteResp?.data?.data ?? quoteResp?.data
  if (!quote?.registerFeeBase || !quote?.feePerBlockBase || !quote?.blocksPerYear) {
    throw new Error(`Unexpected name quote format for ${chain.id}: ${JSON.stringify(quote)}`)
  }
  const registerFee = BigInt(String(quote.registerFeeBase))
  const feePerBlock = BigInt(String(quote.feePerBlockBase))
  const blocksPerYear = BigInt(String(quote.blocksPerYear))
  const baseAmount = registerFee + feePerBlock * blocksPerYear * BigInt(years)
  if (baseAmount <= 0n) throw new Error('Computed registration amount is zero')

  // 2. Account info (account_number + sequence).
  console.log(`${TAG} Fetching account info for ${chain.coin} (name reg)...`)
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

  if (!chain.chainId) throw new Error(`Missing chainId for Cosmos chain: ${chain.id}`)
  const chain_id = chain.chainId

  const fee = FEE_TEMPLATES[chain.id] || FEE_TEMPLATES.cosmos
  // THOR/Maya set tx.fee.amount to '0' and charge the native tx fee at the bank
  // layer (the FEES table). Report that as the display fee — the deposit amount
  // is the full registration cost, so the account also needs this fee on top.
  const feeInDisplay = String(FEES[chain.id] ?? Number(fee.amount[0]?.amount || 0) / 10 ** chain.decimals)

  // 3. Build the `~:` memo: ~:name:chain:address  (owner defaults to signer).
  const memoChain = NAME_MEMO_CHAIN[chain.id]!
  const memo = `~:${name}:${memoChain}:${fromAddress}`

  const depositType = MSG_DEPOSIT_TYPES[chain.id]!
  const depositAsset = DEPOSIT_ASSETS[chain.id]!
  console.log(`${TAG} Building name-reg MsgDeposit: asset=${depositAsset}, amount=${baseAmount}, memo=${memo}`)

  const msg = {
    type: depositType,
    value: {
      coins: [{ asset: depositAsset, amount: String(baseAmount) }],
      memo,
      signer: fromAddress,
    },
  }

  return {
    signerAddress: fromAddress,
    addressNList: chain.defaultPath,
    tx: {
      fee,
      memo,
      msg: [msg],
      signatures: [],
    },
    chain_id,
    account_number,
    sequence,
    fee: feeInDisplay,
  }
}
