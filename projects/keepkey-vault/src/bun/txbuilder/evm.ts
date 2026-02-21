/**
 * EVM tx builder — simplified from pioneer-sdk/txbuilder/createUnsignedEvmTx.ts
 *
 * Fetches gas price + nonce from Pioneer API.
 * Returns object ready for hdwallet's ethSignTx().
 * Supports native ETH transfers and ERC-20 token transfers.
 */
import type { ChainDef } from '../../shared/chains'
import { getEvmGasPrice, getEvmNonce, getEvmBalance } from '../evm-rpc'

const TAG = '[txbuilder:evm]'

const toHex = (value: bigint | number): string => {
  let hex = BigInt(value).toString(16)
  if (hex.length % 2) hex = '0' + hex
  return '0x' + hex
}

/** Encode ERC-20 transfer(address,uint256) call data */
function encodeTransferData(toAddress: string, amountBaseUnits: bigint): string {
  const selector = 'a9059cbb' // transfer(address,uint256)
  const addrPadded = toAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const amtPadded = amountBaseUnits.toString(16).padStart(64, '0')
  return '0x' + selector + addrPadded + amtPadded
}

/** Extract contract address from CAIP-19 like "eip155:1/erc20:0xdac17f..." */
function extractContractFromCaip(caip: string): string {
  const match = caip.match(/\/erc20:(0x[a-fA-F0-9]{40})/)
  if (!match) throw new Error(`Cannot extract contract address from CAIP: ${caip}`)
  return match[1]
}

export interface BuildEvmParams {
  to: string
  amount: string    // human-readable (e.g. "0.1")
  memo?: string
  feeLevel?: number // 1=slow, 5=avg, 10=fast
  isMax?: boolean
  fromAddress: string
  caip?: string     // Token CAIP-19 — triggers ERC-20 mode when contains 'erc20'
  tokenBalance?: string  // human-readable token balance from frontend
  tokenDecimals?: number // token decimals from frontend
  rpcUrl?: string   // Direct RPC URL — bypasses Pioneer for custom chains
}

export async function buildEvmTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildEvmParams,
) {
  const { to, memo, feeLevel = 5, isMax = false, fromAddress, caip, tokenBalance, tokenDecimals: frontendDecimals, rpcUrl } = params
  const amountNum = parseFloat(params.amount)
  const chainId = parseInt(chain.chainId || '1', 10)
  const isErc20 = !!(caip && caip.includes('erc20'))

  if (isErc20) console.log(`${TAG} ERC-20 token transfer: ${caip}`)

  // 1. Gas price (shared for native + ERC-20)
  console.log(`${TAG} Fetching gas price for ${chain.coin}...`)
  let gasPrice: bigint
  if (rpcUrl) {
    // Direct RPC path — custom chains bypass Pioneer
    try {
      gasPrice = await getEvmGasPrice(rpcUrl)
    } catch {
      gasPrice = BigInt(2e9)
      console.warn(`${TAG} Direct RPC gas price failed, using 2 gwei default`)
    }
  } else {
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
  }

  if (feeLevel <= 2) gasPrice = gasPrice * 80n / 100n
  else if (feeLevel >= 8) gasPrice = gasPrice * 150n / 100n
  if (chainId === 1 && gasPrice < BigInt(1e9)) gasPrice = BigInt(1e9)

  // 2. Nonce
  let nonce = 0
  if (rpcUrl) {
    try { nonce = await getEvmNonce(rpcUrl, fromAddress) } catch { console.warn(`${TAG} Direct RPC nonce failed, using 0`) }
  } else {
    try {
      const nonceData = await pioneer.GetNonceByNetwork({ networkId: chain.networkId, address: fromAddress })
      nonce = nonceData?.data?.nonce ?? 0
    } catch {
      console.warn(`${TAG} Nonce API failed, using 0`)
    }
  }

  // 3. Native balance (needed for gas in both native and ERC-20 paths)
  let nativeBalance = 0n
  if (rpcUrl) {
    try { nativeBalance = await getEvmBalance(rpcUrl, fromAddress) } catch { console.warn(`${TAG} Direct RPC balance failed`) }
  } else {
    try {
      const balData = await pioneer.GetBalanceAddressByNetwork({ networkId: chain.networkId, address: fromAddress })
      const balEth = parseFloat(balData?.data?.nativeBalance || balData?.data?.balance || '0')
      nativeBalance = BigInt(Math.round(balEth * 1e18))
    } catch {
      console.warn(`${TAG} Balance API failed`)
    }
  }

  // ── ERC-20 token transfer ───────────────────────────────────────────
  if (isErc20) {
    const contractAddress = extractContractFromCaip(caip!)
    const gasLimit = 100000n // ERC-20 transfers need ~65k, 100k is safe margin

    // Use frontend-provided decimals when available, otherwise fetch from API
    let tokenDecimals: number
    if (frontendDecimals != null && frontendDecimals >= 0 && frontendDecimals <= 36) {
      tokenDecimals = frontendDecimals
      console.log(`${TAG} Token decimals (from frontend): ${tokenDecimals}`)
    } else {
      try {
        const decimalsResp = await pioneer.GetTokenDecimals({
          networkId: chain.networkId,
          contractAddress,
        })
        tokenDecimals = Number(decimalsResp?.data?.decimals)
        if (isNaN(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
          throw new Error(`Invalid decimals value: ${decimalsResp?.data?.decimals}`)
        }
        console.log(`${TAG} Token decimals (from API): ${tokenDecimals}`)
      } catch (e: any) {
        throw new Error(`Cannot build ERC-20 tx: failed to fetch decimals for ${contractAddress} — ${e.message}`)
      }
    }

    const gasFee = gasPrice * gasLimit

    // Validate native balance covers gas
    if (nativeBalance < gasFee) {
      throw new Error(
        `Insufficient ${chain.symbol} for gas: have ${Number(nativeBalance) / 1e18}, ` +
        `need ~${Number(gasFee) / 1e18} ${chain.symbol}`,
      )
    }

    // Compute token amount in base units
    let amountBaseUnits: bigint
    const tokenMultiplier = 10n ** BigInt(tokenDecimals)

    if (isMax) {
      // Prefer frontend-provided balance (already displayed to user) over re-fetching
      let tokBal: number
      if (tokenBalance && parseFloat(tokenBalance) > 0) {
        tokBal = parseFloat(tokenBalance)
        console.log(`${TAG} Using frontend token balance for max: ${tokBal}`)
      } else {
        try {
          const tokBalResp = await pioneer.GetTokenBalance({
            networkId: chain.networkId,
            address: fromAddress,
            contractAddress,
          })
          tokBal = parseFloat(tokBalResp?.data?.balance || '0')
          console.log(`${TAG} Fetched token balance from API for max: ${tokBal}`)
        } catch (e: any) {
          throw new Error(`Cannot fetch token balance for max send: ${e.message}`)
        }
      }
      amountBaseUnits = BigInt(Math.round(tokBal * Number(tokenMultiplier)))
      if (amountBaseUnits <= 0n) throw new Error('Token balance is zero')
    } else {
      if (isNaN(amountNum) || amountNum <= 0) throw new Error('Invalid token amount')
      amountBaseUnits = BigInt(Math.round(amountNum * Number(tokenMultiplier)))
    }

    console.log(`${TAG} ERC-20 transfer: ${amountBaseUnits} base units → ${contractAddress}`)

    const txData = encodeTransferData(to, amountBaseUnits)

    return {
      chainId,
      addressNList: chain.defaultPath,
      nonce: toHex(nonce),
      gasLimit: toHex(gasLimit),
      gasPrice: toHex(gasPrice),
      to: contractAddress,  // send to contract, NOT recipient
      value: '0x0',         // no ETH value for token transfers
      data: txData,
      fee: String(Number(gasFee) / 1e18),
    }
  }

  // ── Native ETH transfer ─────────────────────────────────────────────
  const gasLimit = memo ? 21000n + BigInt(Buffer.from(memo, 'utf8').length) * 68n : 21000n
  const gasFee = gasPrice * gasLimit

  let amountWei: bigint
  if (isMax) {
    if (nativeBalance <= gasFee) throw new Error('Insufficient funds to cover gas fees')
    amountWei = nativeBalance - gasFee * 110n / 100n // 10% gas buffer for safety
  } else {
    amountWei = BigInt(Math.round(amountNum * 1e18))
    if (amountWei + gasFee > nativeBalance && nativeBalance > 0n) {
      throw new Error(
        `Insufficient funds: balance ${Number(nativeBalance) / 1e18} ${chain.symbol}, ` +
        `need ${Number(amountWei + gasFee) / 1e18} ${chain.symbol} (incl gas)`,
      )
    }
  }

  const data = memo ? '0x' + Buffer.from(memo, 'utf8').toString('hex') : '0x'

  return {
    chainId,
    addressNList: chain.defaultPath,
    nonce: toHex(nonce),
    gasLimit: toHex(gasLimit),
    gasPrice: toHex(gasPrice),
    to,
    value: toHex(amountWei),
    data,
    fee: String(Number(gasFee) / 1e18),
  }
}
