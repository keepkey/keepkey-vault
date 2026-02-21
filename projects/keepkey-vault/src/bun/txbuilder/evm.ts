/**
 * EVM tx builder — simplified from pioneer-sdk/txbuilder/createUnsignedEvmTx.ts
 *
 * Fetches gas price + nonce from Pioneer API.
 * Returns object ready for hdwallet's ethSignTx().
 * Supports native ETH transfers only (no ERC20, no THORChain depositWithExpiry).
 */
import type { ChainDef } from '../../shared/chains'

const TAG = '[txbuilder:evm]'

const toHex = (value: bigint | number): string => {
  let hex = BigInt(value).toString(16)
  if (hex.length % 2) hex = '0' + hex
  return '0x' + hex
}

export interface BuildEvmParams {
  to: string
  amount: string    // human-readable (e.g. "0.1")
  memo?: string
  feeLevel?: number // 1=slow, 5=avg, 10=fast
  isMax?: boolean
  fromAddress: string
}

export async function buildEvmTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildEvmParams,
) {
  const { to, memo, feeLevel = 5, isMax = false, fromAddress } = params
  const amountNum = parseFloat(params.amount)
  const chainId = parseInt(chain.chainId || '1', 10)

  // 1. Gas price
  console.log(`${TAG} Fetching gas price for ${chain.coin}...`)
  let gasPrice: bigint
  try {
    const gasPriceData = await pioneer.GetGasPriceByNetwork({ networkId: chain.networkId })
    const data = gasPriceData?.data

    let gasPriceGwei: number
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      gasPriceGwei = feeLevel <= 2
        ? parseFloat(data.slow || data.average || '2')
        : feeLevel >= 8
          ? parseFloat(data.fastest || data.fast || data.average || '2')
          : parseFloat(data.average || data.fast || '2')
    } else {
      gasPriceGwei = parseFloat(data || '2')
    }
    if (isNaN(gasPriceGwei) || gasPriceGwei <= 0) gasPriceGwei = 2
    gasPrice = BigInt(Math.round(gasPriceGwei * 1e9))
  } catch {
    gasPrice = BigInt(2e9) // fallback 2 gwei
    console.warn(`${TAG} Gas price API failed, using 2 gwei default`)
  }

  // Apply fee level multiplier if API returned single value
  if (feeLevel <= 2) gasPrice = gasPrice * 80n / 100n
  else if (feeLevel >= 8) gasPrice = gasPrice * 150n / 100n

  // ETH mainnet min 1 gwei
  if (chainId === 1 && gasPrice < BigInt(1e9)) gasPrice = BigInt(1e9)

  // 2. Nonce
  let nonce = 0
  try {
    const nonceData = await pioneer.GetNonceByNetwork({ networkId: chain.networkId, address: fromAddress })
    nonce = nonceData?.data?.nonce ?? 0
  } catch {
    console.warn(`${TAG} Nonce API failed, using 0`)
  }

  // 3. Balance check
  let balance = 0n
  try {
    const balData = await pioneer.GetBalanceAddressByNetwork({ networkId: chain.networkId, address: fromAddress })
    const balEth = parseFloat(balData?.data?.nativeBalance || balData?.data?.balance || '0')
    balance = BigInt(Math.round(balEth * 1e18))
  } catch {
    console.warn(`${TAG} Balance API failed`)
  }

  // 4. Build tx
  const gasLimit = memo ? 21000n + BigInt(Buffer.from(memo, 'utf8').length) * 68n : 21000n
  const gasFee = gasPrice * gasLimit

  let amountWei: bigint
  if (isMax) {
    if (balance <= gasFee) throw new Error('Insufficient funds to cover gas fees')
    amountWei = balance - gasFee - gasFee / 2n // 50% buffer
  } else {
    amountWei = BigInt(Math.round(amountNum * 1e18))
    if (amountWei + gasFee > balance && balance > 0n) {
      throw new Error(
        `Insufficient funds: balance ${Number(balance) / 1e18} ${chain.symbol}, ` +
        `need ${Number(amountWei + gasFee) / 1e18} ${chain.symbol} (incl gas)`,
      )
    }
  }

  const data = memo ? '0x' + Buffer.from(memo, 'utf8').toString('hex') : '0x'

  const gasFeeUsd = 0 // populated later by caller if market data available

  return {
    chainId,
    addressNList: chain.defaultPath,
    nonce: toHex(nonce),
    gas: toHex(gasLimit),
    gasPrice: toHex(gasPrice),
    to,
    value: toHex(amountWei),
    data,
    fee: String(Number(gasFee) / 1e18),
    gasFeeUsd,
  }
}
