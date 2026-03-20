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

/** String-based decimal→BigInt to avoid floating-point precision loss */
export function parseUnits(amount: string, decimals: number): bigint {
  const [whole = '0', frac = ''] = amount.split('.')
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals)
  return BigInt(whole + padded)
}

export const toHex = (value: bigint | number): string => {
  let hex = BigInt(value).toString(16)
  if (hex.length % 2) hex = '0' + hex
  return '0x' + hex
}

/** Encode ERC-20 approve(spender, amount) call data */
export function encodeApprove(spender: string, amount: bigint): string {
  const selector = '095ea7b3' // approve(address,uint256)
  const spenderPad = spender.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const amountPad = amount.toString(16).padStart(64, '0')
  return '0x' + selector + spenderPad + amountPad
}

/** Encode ERC-20 transfer(address,uint256) call data */
function encodeTransferData(toAddress: string, amountBaseUnits: bigint): string {
  const selector = 'a9059cbb' // transfer(address,uint256)
  const addrPadded = toAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const amtPadded = amountBaseUnits.toString(16).padStart(64, '0')
  return '0x' + selector + addrPadded + amtPadded
}

/**
 * Encode THORChain router depositWithExpiry(address,address,uint256,string,uint256)
 * Selector: 0x44bc937b
 *
 * For native ETH swaps: asset = 0x0...0, value = amount
 * For ERC-20 swaps: asset = token contract, value = 0 (requires prior approval)
 */
export function encodeDepositWithExpiry(
  vault: string,
  asset: string, // 0x0...0 for native, token address for ERC-20
  amount: bigint,
  memo: string,
  expiry: number,
): string {
  const selector = '44bc937b'
  const vaultPad = vault.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const assetPad = asset.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const amountPad = amount.toString(16).padStart(64, '0')
  // String offset: 5 head words × 32 bytes = 160 = 0xa0
  const stringOffset = (5 * 32).toString(16).padStart(64, '0')
  const expiryPad = BigInt(expiry).toString(16).padStart(64, '0')

  // Encode memo string: length prefix + UTF-8 bytes padded to 32-byte boundary
  // Empty memo is valid ABI — zero length + no data words
  const memoBytes = Buffer.from(memo, 'utf8')
  const memoLen = memoBytes.length.toString(16).padStart(64, '0')
  const memoPadded = memoBytes.length === 0
    ? '' // zero-length string: only the length word (0x00...00) is needed
    : memoBytes.toString('hex').padEnd(Math.ceil(memoBytes.length / 32) * 64, '0')

  return '0x' + selector + vaultPad + assetPad + amountPad + stringOffset + expiryPad + memoLen + memoPadded
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
  addressIndex?: number  // EVM multi-address: derivation index (default 0)
}

export async function buildEvmTx(
  pioneer: any,
  chain: ChainDef,
  params: BuildEvmParams,
) {
  const { to, memo, feeLevel = 5, isMax = false, fromAddress, caip, tokenBalance, tokenDecimals: frontendDecimals, rpcUrl, addressIndex } = params
  const amountNum = parseFloat(params.amount)
  const chainId = parseInt(chain.chainId || '1', 10)
  const isErc20 = !!(caip && caip.includes('erc20'))

  // Derive addressNList from addressIndex (multi-address) or fall back to chain.defaultPath
  const addressNList = addressIndex != null
    ? [0x8000002C, 0x8000003C, 0x80000000, 0, addressIndex]
    : chain.defaultPath

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
  let nonce: number | undefined
  if (rpcUrl) {
    try { nonce = await getEvmNonce(rpcUrl, fromAddress) } catch (e: any) {
      console.warn(`${TAG} Direct RPC nonce failed: ${e.message}`)
    }
  }
  if (nonce === undefined) {
    try {
      const nonceData = await pioneer.GetNonceByNetwork({ networkId: chain.networkId, address: fromAddress })
      const n = nonceData?.data?.nonce
      if (n != null) nonce = n
    } catch (e: any) {
      console.warn(`${TAG} Nonce API failed: ${e.message}`)
    }
  }
  if (nonce === undefined) {
    throw new Error(`Failed to fetch nonce for ${fromAddress} on ${chain.coin} — cannot safely build transaction`)
  }

  // 3. Native balance (needed for gas in both native and ERC-20 paths)
  let nativeBalance = 0n
  if (rpcUrl) {
    try { nativeBalance = await getEvmBalance(rpcUrl, fromAddress) } catch { console.warn(`${TAG} Direct RPC balance failed`) }
  } else {
    try {
      const balData = await pioneer.GetBalanceAddressByNetwork({ networkId: chain.networkId, address: fromAddress })
      const balStr = String(balData?.data?.nativeBalance || balData?.data?.balance || '0')
      nativeBalance = parseUnits(balStr, 18)
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

    if (isMax) {
      // Prefer frontend-provided balance (already displayed to user) over re-fetching
      let tokBalStr: string
      if (tokenBalance && parseFloat(tokenBalance) > 0) {
        tokBalStr = tokenBalance
        console.log(`${TAG} Using frontend token balance for max: ${tokBalStr}`)
      } else {
        try {
          const tokBalResp = await pioneer.GetTokenBalance({
            networkId: chain.networkId,
            address: fromAddress,
            contractAddress,
          })
          tokBalStr = String(tokBalResp?.data?.balance || '0')
          console.log(`${TAG} Fetched token balance from API for max: ${tokBalStr}`)
        } catch (e: any) {
          throw new Error(`Cannot fetch token balance for max send: ${e.message}`)
        }
      }
      amountBaseUnits = parseUnits(tokBalStr, tokenDecimals)
      if (amountBaseUnits <= 0n) throw new Error('Token balance is zero')
    } else {
      if (isNaN(amountNum) || amountNum <= 0) throw new Error('Invalid token amount')
      amountBaseUnits = parseUnits(String(params.amount), tokenDecimals)
    }

    console.log(`${TAG} ERC-20 transfer: ${amountBaseUnits} base units → ${contractAddress}`)

    const txData = encodeTransferData(to, amountBaseUnits)

    return {
      chainId,
      addressNList,
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
  const memoBytes = memo ? Buffer.from(memo, 'utf8') : null
  const memoGas = memoBytes ? memoBytes.reduce((sum: bigint, b: number) => sum + (b === 0 ? 4n : 16n), 0n) : 0n
  const gasLimit = 21000n + memoGas
  const gasFee = gasPrice * gasLimit

  let amountWei: bigint
  if (isMax) {
    if (nativeBalance <= gasFee) throw new Error('Insufficient funds to cover gas fees')
    amountWei = nativeBalance - gasFee * 110n / 100n // 10% gas buffer for safety
  } else {
    amountWei = parseUnits(String(params.amount), 18)
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
    addressNList,
    nonce: toHex(nonce),
    gasLimit: toHex(gasLimit),
    gasPrice: toHex(gasPrice),
    to,
    value: toHex(amountWei),
    data,
    fee: String(Number(gasFee) / 1e18),
  }
}
