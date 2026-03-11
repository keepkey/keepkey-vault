/**
 * Swap service — Pioneer API integration for cross-chain swaps.
 *
 * ALL swap data flows through Pioneer (api.keepkey.info):
 *   - Available assets: Pioneer GetAvailableAssets
 *   - Quotes: Pioneer Quote (aggregates THORChain, ShapeShift, ChainFlip, etc.)
 *   - Execution: builds, signs (on device), and broadcasts swap txs
 *
 * NO direct THORNode or other third-party calls — fail fast if Pioneer is down.
 */
import { CHAINS } from '../shared/chains'
import type { ChainDef } from '../shared/chains'
import type { SwapAsset, SwapQuote, SwapQuoteParams, ExecuteSwapParams, SwapResult } from '../shared/types'
import { getPioneer } from './pioneer'
import { encodeDepositWithExpiry, encodeApprove, parseUnits, toHex } from './txbuilder/evm'
import { getEvmGasPrice, getEvmNonce, getEvmBalance, getErc20Allowance, getErc20Decimals, broadcastEvmTx, waitForTxReceipt, estimateGas } from './evm-rpc'
import * as txb from './txbuilder'
// Re-export pure parsing functions (used by tests + this module)
export { parseQuoteResponse, parseAssetsResponse, parseThorAsset, assetToCaip, THOR_TO_CHAIN } from './swap-parsing'
import { parseQuoteResponse, parseAssetsResponse, assetToCaip } from './swap-parsing'

const TAG = '[swap]'

/** Known THORChain router contracts per EVM chain — verified against THORNode */
const THORCHAIN_ROUTERS: Record<string, string[]> = {
  ethereum: ['0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146', '0x42a5ed456650a09dc10ebc6361a7480fdd61f27b'],
  avalanche: ['0x8f66c4ae756bebc49ec8b81966dd8bba9f127549'],
  bsc: ['0xb30ec53f98ff5947ede720d32ac2da7e52a5f56b'],
  base: ['0x1b3e6daa08e7a2e29e2ff23b6c40abe79a15a17a'],
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Format a bigint wei value as a human-readable string (avoids Number() precision loss for large values) */
function formatWei(wei: bigint, decimals = 18): string {
  const whole = wei / 10n ** BigInt(decimals)
  const frac = wei % 10n ** BigInt(decimals)
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

/** Chain-aware minimum gas price fallbacks (gwei) — used when RPC/Pioneer both fail */
const MIN_GAS_GWEI: Record<string, number> = {
  ethereum: 10,
  polygon: 30,
  avalanche: 25,
  bsc: 3,
  base: 0.01,
  arbitrum: 0.01,
  optimism: 0.01,
}

/** Chain-aware gas limits for depositWithExpiry — L2s need more for L1 data posting */
const DEPOSIT_GAS_LIMITS: Record<string, bigint> = {
  ethereum: 120000n,
  polygon: 120000n,
  avalanche: 120000n,
  bsc: 120000n,
  base: 200000n,
  arbitrum: 300000n,  // Arbitrum gas units != mainnet gas units
  optimism: 200000n,
}

/** Memo length limits — THORChain global limit is 250 bytes.
 *  THORNode constructs memos optimized for source chain constraints (e.g. short
 *  asset names like AVAX.USDT instead of AVAX.USDT-0x...) so we trust the memo
 *  from Pioneer/THORNode and only enforce the THORChain protocol limit. */
const MEMO_LIMIT = 250

// ── Pool/Asset fetching via Pioneer ─────────────────────────────────

let assetCache: SwapAsset[] = []
let assetCacheTime = 0
const ASSET_CACHE_TTL = 5 * 60_000 // 5 minutes

/** Invalidate the asset cache (e.g., after Pioneer reconnects) */
export function clearSwapCache(): void {
  assetCache = []
  assetCacheTime = 0
}

/** Fetch available swap assets from Pioneer GetAvailableAssets */
export async function getSwapAssets(): Promise<SwapAsset[]> {
  if (assetCache.length > 0 && Date.now() - assetCacheTime < ASSET_CACHE_TTL) {
    return assetCache
  }

  const pioneer = await getPioneer()
  console.log(`${TAG} Fetching available swap assets from Pioneer...`)

  const resp = await pioneer.GetAvailableAssets()
  const assets = parseAssetsResponse(resp)

  // Ensure RUNE is always included (may not be in pools list)
  if (!assets.find(a => a.asset === 'THOR.RUNE')) {
    const thorDef = CHAINS.find(c => c.id === 'thorchain')
    if (thorDef) {
      assets.unshift({
        asset: 'THOR.RUNE',
        chainId: 'thorchain',
        symbol: 'RUNE',
        name: 'THORChain',
        chainFamily: 'cosmos',
        decimals: 8,
        caip: thorDef.caip,
      })
    }
  }

  console.log(`${TAG} Loaded ${assets.length} swap assets from Pioneer`)
  assetCache = assets
  assetCacheTime = Date.now()
  return assets
}

// ── Quote fetching via Pioneer ──────────────────────────────────────

/** Fetch a swap quote from Pioneer (aggregated across DEXes) */
export async function getSwapQuote(params: SwapQuoteParams): Promise<SwapQuote> {
  if (!params.amount || parseFloat(params.amount) <= 0) {
    throw new Error('Amount must be greater than 0')
  }

  const pioneer = await getPioneer()

  // Convert THORChain asset notation to CAIP for Pioneer Quote
  const sellCaip = assetToCaip(params.fromAsset)
  const buyCaip = assetToCaip(params.toAsset)
  const slippage = params.slippageBps ? params.slippageBps / 100 : 3 // Pioneer uses % not bps

  // Normalize BCH CashAddr: strip "bitcoincash:" prefix — THORChain uses short form
  const normalizeBchAddr = (addr: string) =>
    addr.startsWith('bitcoincash:') ? addr.slice('bitcoincash:'.length) : addr
  const senderAddress = normalizeBchAddr(params.fromAddress)
  const recipientAddress = normalizeBchAddr(params.toAddress)

  console.log(`${TAG} Fetching quote: ${params.fromAsset} → ${params.toAsset} (${params.amount})`)
  console.log(`${TAG} CAIP: ${sellCaip} → ${buyCaip}`)
  console.log(`${TAG} sender=${senderAddress}, recipient=${recipientAddress}`)

  const quoteResp = await pioneer.Quote({
    sellAsset: sellCaip,
    sellAmount: params.amount, // Pioneer expects DECIMAL format (human-readable)
    buyAsset: buyCaip,
    recipientAddress,
    senderAddress,
    slippage,
  })

  // Log raw response structure for debugging quote parsing issues
  const qDebug = quoteResp?.data?.data || quoteResp?.data || quoteResp
  const firstQuote = Array.isArray(qDebug) ? qDebug[0] : qDebug
  console.log(`${TAG} Raw quote response keys: ${firstQuote ? Object.keys(firstQuote).join(', ') : 'EMPTY'}`)

  const result = parseQuoteResponse(quoteResp, params)
  console.log(`${TAG} Quote: ${result.expectedOutput} (via ${result.integration}), memo=${result.memo || 'NONE'}, router=${result.router || 'NONE'}, expiry=${result.expiry}`)
  return result
}

// ── Swap execution ──────────────────────────────────────────────────

/** Wallet methods used during swap execution (subset of hdwallet interface) */
export interface SwapWallet {
  getPublicKeys(params: any[]): Promise<Array<{ xpub: string }> | null>
  ethSignTx(params: any): Promise<any>
  [method: string]: (...args: any[]) => Promise<any>  // dynamic address/sign methods
}

/** Dependencies injected by the caller (index.ts) to avoid circular imports */
export interface SwapContext {
  wallet: SwapWallet
  getAllChains: () => ChainDef[]
  getRpcUrl: (chain: ChainDef) => string | undefined
  getBtcXpub: () => string | undefined  // selected BTC xpub if available
}

/** Execute a swap: build tx, sign on device, broadcast */
export async function executeSwap(params: ExecuteSwapParams, ctx: SwapContext): Promise<SwapResult> {
  const { wallet, getAllChains, getRpcUrl, getBtcXpub } = ctx

  // Resolve source chain
  const allChains = getAllChains()
  const fromChain = allChains.find(c => c.id === params.fromChainId)
  if (!fromChain) throw new Error(`Unknown source chain: ${params.fromChainId}`)

  // Detect ERC-20 source (THORChain format: "ETH.USDT-0xDAC17F..." — has hyphen + contract)
  const isErc20Source = params.fromAsset.includes('-') && fromChain.chainFamily === 'evm'

  // 1. Get sender address
  const addrParams: any = {
    addressNList: fromChain.defaultPath,
    showDisplay: false,
    coin: fromChain.chainFamily === 'evm' ? 'Ethereum' : fromChain.coin,
  }
  if (fromChain.scriptType) addrParams.scriptType = fromChain.scriptType
  const addrMethod = fromChain.id === 'ripple' ? 'rippleGetAddress' : fromChain.rpcMethod
  const addrResult = await wallet[addrMethod](addrParams)
  const fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
  if (!fromAddress) throw new Error('Could not derive sender address')

  // 1b. Derive destination address for validation
  const toChain = allChains.find(c => c.id === params.toChainId)
  if (!toChain) throw new Error(`Unknown destination chain: ${params.toChainId}`)

  const toAddrParams: any = {
    addressNList: toChain.defaultPath,
    showDisplay: false,
    coin: toChain.chainFamily === 'evm' ? 'Ethereum' : toChain.coin,
  }
  if (toChain.scriptType) toAddrParams.scriptType = toChain.scriptType
  const toAddrMethod = toChain.id === 'ripple' ? 'rippleGetAddress' : toChain.rpcMethod
  const toAddrResult = await wallet[toAddrMethod](toAddrParams)
  const toAddress = typeof toAddrResult === 'string' ? toAddrResult : toAddrResult?.address
  if (!toAddress) throw new Error('Could not derive destination address')

  // SAFETY: Reject memos containing extended pubkeys — these are never valid destinations
  // and indicate the quote was fetched with an unresolved xpub address.
  // Covers: xpub/ypub/zpub (BTC), dgub (DOGE), Ltub/Mtub (LTC), drkp/drks (DASH), tpub (testnet)
  if (params.memo && /(xpub|ypub|zpub|dgub|Ltub|Mtub|drkp|drks|tpub|upub|vpub)[a-zA-Z0-9]{20,}/.test(params.memo)) {
    throw new Error('Swap memo contains an extended pubkey instead of a destination address — aborting to protect funds')
  }

  // Validate the memo contains our destination address (only for UTXO/Cosmos — EVM memos use shorthand/aggregator formats)
  // Normalize BCH CashAddr: strip "bitcoincash:" prefix for comparison — THORChain memos use short form
  const toAddrNorm = toAddress.startsWith('bitcoincash:') ? toAddress.slice('bitcoincash:'.length) : toAddress
  if (params.memo && fromChain.chainFamily !== 'evm' && !params.memo.toLowerCase().includes(toAddrNorm.toLowerCase())) {
    console.warn(`${TAG} WARNING: Swap memo does not contain derived destination address. Memo may use a different format.`)
  }

  // 2. Validate required fields
  if (!params.inboundAddress) throw new Error('Missing inbound vault address from quote')
  if (!params.memo) throw new Error('Missing swap memo from quote')
  const memoByteLength = Buffer.byteLength(params.memo, 'utf8')
  if (memoByteLength > MEMO_LIMIT) {
    throw new Error(`Swap memo too long (${memoByteLength} bytes, THORChain max ${MEMO_LIMIT})`)
  }

  console.log(`${TAG} Executing: ${params.fromAsset} → ${params.toAsset}, amount=${params.amount}`)
  console.log(`${TAG} Chain family: ${fromChain.chainFamily}, vault: ${params.inboundAddress}, router: ${params.router || 'none'}`)
  if (isErc20Source) console.log(`${TAG} ERC-20 source detected: ${params.fromAsset}`)

  // 3. Get Pioneer for tx building
  const pioneer = await getPioneer()

  let unsignedTx: any
  let approvalTxid: string | undefined

  // ── EVM chains: MUST use router contract depositWithExpiry() ──
  if (fromChain.chainFamily === 'evm') {
    const result = await buildEvmSwapTx(params, fromChain, fromAddress, pioneer, getRpcUrl, isErc20Source, wallet)
    unsignedTx = result.unsignedTx
    approvalTxid = result.approvalTxid

  // ── UTXO chains: send to vault, memo in OP_RETURN ──
  } else if (fromChain.chainFamily === 'utxo') {
    // Only use BTC multi-account xpub for Bitcoin — other UTXO chains (DOGE, LTC, etc.)
    // have their own xpub formats and must derive their own
    let xpub: string | undefined
    if (fromChain.id === 'bitcoin') {
      try { xpub = getBtcXpub() } catch { /* BTC account manager not ready */ }
      if (!xpub) {
        console.warn(`${TAG} BTC multi-account xpub unavailable — falling back to default account 0`)
      }
    }
    if (!xpub) {
      try {
        const result = await wallet.getPublicKeys([{
          addressNList: fromChain.defaultPath.slice(0, 3),
          coin: fromChain.coin,
          scriptType: fromChain.scriptType,
          curve: 'secp256k1',
        }])
        xpub = result?.[0]?.xpub
      } catch (e: any) {
        throw new Error(`Failed to get xpub for ${fromChain.coin}: ${e.message}`)
      }
    }

    const buildResult = await txb.buildTx(pioneer, fromChain, {
      chainId: fromChain.id,
      to: params.inboundAddress,
      amount: params.amount,
      memo: params.memo,
      feeLevel: params.feeLevel,
      isMax: params.isMax,
      fromAddress,
      xpub,
    })
    unsignedTx = buildResult.unsignedTx

  // ── Cosmos/THORChain: send to vault with memo in tx metadata ──
  } else {
    const buildResult = await txb.buildTx(pioneer, fromChain, {
      chainId: fromChain.id,
      to: params.inboundAddress,
      amount: params.amount,
      memo: params.memo,
      feeLevel: params.feeLevel,
      isMax: params.isMax,
      isSwapDeposit: true, // C1 fix: explicit flag for MsgDeposit (not inferred from memo)
      fromAddress,
    })
    unsignedTx = buildResult.unsignedTx
  }

  // 4. Sign on device (user confirms tx details on hardware wallet)
  const signedTx = await txb.signTx(wallet, fromChain, unsignedTx)

  // 5. Broadcast
  const { txid } = await txb.broadcastTx(pioneer, fromChain, signedTx)

  console.log(`${TAG} Broadcast success: ${txid}`)

  return {
    txid,
    fromAsset: params.fromAsset,
    toAsset: params.toAsset,
    fromAmount: params.amount,
    expectedOutput: params.expectedOutput,
    ...(approvalTxid ? { approvalTxid } : {}),
  }
}

// ── EVM swap tx building (extracted for readability) ────────────────

async function buildEvmSwapTx(
  params: ExecuteSwapParams,
  fromChain: ChainDef,
  fromAddress: string,
  pioneer: any,
  getRpcUrl: (chain: ChainDef) => string | undefined,
  isErc20Source: boolean,
  wallet: any,
): Promise<{ unsignedTx: any; approvalTxid?: string }> {
  if (!params.router) throw new Error('EVM swaps require a router address from the quote')

  // Validate router against known THORChain routers (warn-only, routers rotate during churn)
  const knownRouters = THORCHAIN_ROUTERS[fromChain.id]
  if (knownRouters && knownRouters.length > 0) {
    const routerLower = params.router.toLowerCase()
    if (!knownRouters.some(r => r.toLowerCase() === routerLower)) {
      console.warn(`${TAG} Router ${params.router} not in known list for ${fromChain.id}. Proceeding — routers rotate during vault churn.`)
    }
  }

  // Use expiry from quote if available, otherwise 1 hour from now
  const expiry = params.expiry && params.expiry > Math.floor(Date.now() / 1000)
    ? params.expiry
    : Math.floor(Date.now() / 1000) + 3600
  const chainId = parseInt(fromChain.chainId || '1', 10)
  const rpcUrl = getRpcUrl(fromChain)

  // Fetch gas price, nonce, native balance
  const fallbackGwei = MIN_GAS_GWEI[fromChain.id] ?? 10
  const fallbackGasPrice = BigInt(Math.round(fallbackGwei * 1e9))
  let gasPrice: bigint
  if (rpcUrl) {
    try { gasPrice = await getEvmGasPrice(rpcUrl) } catch (e: any) {
      console.warn(`${TAG} Failed to fetch gas price via RPC, using ${fallbackGwei} gwei fallback for ${fromChain.id}: ${e.message}`)
      gasPrice = fallbackGasPrice
    }
  } else {
    try {
      const gp = await pioneer.GetGasPriceByNetwork({ networkId: fromChain.networkId })
      const gpData = gp?.data
      const gpGwei = typeof gpData === 'object' ? parseFloat(gpData.average || gpData.fast || String(fallbackGwei)) : parseFloat(gpData || String(fallbackGwei))
      gasPrice = BigInt(Math.round((isNaN(gpGwei) ? fallbackGwei : gpGwei) * 1e9))
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch gas price via Pioneer, using ${fallbackGwei} gwei fallback for ${fromChain.id}: ${e.message}`)
      gasPrice = fallbackGasPrice
    }
  }
  if (params.feeLevel != null && params.feeLevel <= 2) gasPrice = gasPrice * 80n / 100n
  else if (params.feeLevel != null && params.feeLevel >= 8) gasPrice = gasPrice * 150n / 100n

  let nonce: number | undefined
  if (rpcUrl) {
    try { nonce = await getEvmNonce(rpcUrl, fromAddress) } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via RPC: ${e.message}`)
    }
  }
  if (nonce === undefined) {
    try {
      const nd = await pioneer.GetNonceByNetwork({ networkId: fromChain.networkId, address: fromAddress })
      nonce = nd?.data?.nonce
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via Pioneer: ${e.message}`)
    }
  }
  if (nonce === undefined || nonce === null) {
    throw new Error(`Failed to fetch nonce for ${fromAddress} on ${fromChain.id} — cannot safely build swap transaction`)
  }

  let nativeBalance = 0n
  if (rpcUrl) {
    try { nativeBalance = await getEvmBalance(rpcUrl, fromAddress) } catch (e: any) {
      console.warn(`${TAG} Failed to fetch native balance via RPC: ${e.message}`)
    }
  } else {
    try {
      const bd = await pioneer.GetBalanceAddressByNetwork({ networkId: fromChain.networkId, address: fromAddress })
      const balEth = parseFloat(bd?.data?.nativeBalance || bd?.data?.balance || '0')
      nativeBalance = BigInt(Math.round(balEth * 1e18))
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch balance via Pioneer: ${e.message}`)
    }
  }

  let approvalTxid: string | undefined

  if (isErc20Source) {
    // ── ERC-20 source swap: approve + depositWithExpiry ──

    // a) Extract token contract from THORChain asset string "ETH.USDT-0xDAC17F..."
    const assetParts = params.fromAsset.split('-')
    const tokenContract = assetParts.slice(1).join('-') // rejoin in case of multiple hyphens
    if (!tokenContract || !tokenContract.startsWith('0x')) {
      throw new Error(`Cannot extract token contract from asset: ${params.fromAsset}`)
    }

    // b) Get token decimals (direct RPC first, then Pioneer fallback)
    let tokenDecimals = 18
    if (rpcUrl) {
      try {
        tokenDecimals = await getErc20Decimals(rpcUrl, tokenContract)
        console.log(`${TAG} Token decimals (direct RPC): ${tokenDecimals}`)
      } catch (e: any) {
        console.warn(`${TAG} Direct RPC decimals failed: ${e.message}, trying Pioneer...`)
        try {
          const decimalsResp = await pioneer.GetTokenDecimals({ networkId: fromChain.networkId, contractAddress: tokenContract })
          tokenDecimals = Number(decimalsResp?.data?.decimals)
          if (isNaN(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) tokenDecimals = 18
        } catch { console.warn(`${TAG} Pioneer decimals also failed, using default 18`) }
      }
    } else {
      try {
        const decimalsResp = await pioneer.GetTokenDecimals({ networkId: fromChain.networkId, contractAddress: tokenContract })
        tokenDecimals = Number(decimalsResp?.data?.decimals)
        if (isNaN(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) tokenDecimals = 18
      } catch { console.warn(`${TAG} Pioneer decimals failed, using default 18`) }
    }

    // c) Parse amount using TOKEN decimals (not chain's native 18)
    const amountBaseUnits = parseUnits(params.amount, tokenDecimals)
    console.log(`${TAG} ERC-20 amount: ${amountBaseUnits} base units (${tokenDecimals} decimals)`)

    // Validate native balance covers gas for approve + deposit
    const approveGasLimit = 80000n
    const depositGasLimit = 200000n
    const totalGas = gasPrice * (approveGasLimit + depositGasLimit)
    if (nativeBalance < totalGas) {
      throw new Error(
        `Insufficient ${fromChain.symbol} for gas: need ~${formatWei(totalGas)}, ` +
        `have ${formatWei(nativeBalance)}`
      )
    }

    // d) Check allowance
    let needsApproval = true
    if (rpcUrl) {
      try {
        const currentAllowance = await getErc20Allowance(rpcUrl, tokenContract, fromAddress, params.router)
        needsApproval = currentAllowance < amountBaseUnits
        console.log(`${TAG} Current allowance: ${currentAllowance}, needed: ${amountBaseUnits}, needsApproval: ${needsApproval}`)
      } catch (e: any) {
        console.warn(`${TAG} Allowance check failed, assuming approval needed: ${e.message}`)
      }
    }

    // e) If allowance insufficient, sign + broadcast approve tx
    //    H2 fix: approve exact amount (not MaxUint256) — safer for hardware wallet users
    if (needsApproval) {
      const approveData = encodeApprove(params.router, amountBaseUnits)

      const approveTx = {
        chainId,
        addressNList: fromChain.defaultPath,
        nonce: toHex(nonce),
        gasLimit: toHex(approveGasLimit),
        gasPrice: toHex(gasPrice),
        to: tokenContract,  // approve is called on the token contract
        value: '0x0',       // no ETH value
        data: approveData,
      }

      console.log(`${TAG} Signing ERC-20 approve tx: token=${tokenContract}, spender=${params.router}, amount=${amountBaseUnits}`)
      const signedApprove = await wallet.ethSignTx(approveTx)

      // Extract serialized tx
      let approveHex: string
      if (typeof signedApprove === 'string') {
        approveHex = signedApprove
      } else if (signedApprove?.serializedTx) {
        approveHex = signedApprove.serializedTx
      } else if (signedApprove?.serialized) {
        approveHex = signedApprove.serialized
      } else {
        throw new Error('Failed to extract serialized approve tx')
      }
      if (!approveHex.startsWith('0x')) approveHex = '0x' + approveHex

      // Broadcast approve tx
      if (rpcUrl) {
        approvalTxid = await broadcastEvmTx(rpcUrl, approveHex)
        console.log(`${TAG} Approve tx broadcast (direct RPC): ${approvalTxid}`)

        // Wait for approval receipt before building deposit — prevents nonce gap if approval reverts
        console.log(`${TAG} Waiting for approval receipt (up to 90s)...`)
        const receipt = await waitForTxReceipt(rpcUrl, approvalTxid, 90_000)
        if (receipt && !receipt.status) {
          throw new Error(`ERC-20 approve tx reverted on-chain (txid: ${approvalTxid}). Swap aborted — no deposit was sent.`)
        }
        if (!receipt) {
          console.warn(`${TAG} Approval receipt not confirmed within 90s — proceeding with deposit (nonce gap risk)`)
        } else {
          console.log(`${TAG} Approval confirmed on-chain (gas used: ${receipt.gasUsed})`)
        }
      } else {
        const approveResult = await pioneer.Broadcast({ networkId: fromChain.networkId, serialized: approveHex })
        approvalTxid = approveResult?.data?.txid || approveResult?.data?.tx_hash || approveResult?.data?.hash
        console.log(`${TAG} Approve tx broadcast (Pioneer): ${approvalTxid}`)
        // No receipt check available without RPC — warn user
        console.warn(`${TAG} No direct RPC — cannot verify approval receipt. Proceeding with deposit.`)
      }

      nonce += 1
    }

    // f) Build depositWithExpiry with token contract as asset, value = 0x0
    const depositData = encodeDepositWithExpiry(
      params.inboundAddress, // vault address
      tokenContract,         // ERC-20 token contract (NOT zero address)
      amountBaseUnits,
      params.memo,
      expiry,
    )

    // Dynamic gas estimation with static fallback
    let erc20DepositGas = depositGasLimit
    if (rpcUrl) {
      erc20DepositGas = await estimateGas(rpcUrl, {
        to: params.router, from: fromAddress, data: depositData, value: '0x0',
      }, depositGasLimit)
      console.log(`${TAG} Estimated deposit gas: ${erc20DepositGas} (fallback: ${depositGasLimit})`)
    }

    const unsignedTx = {
      chainId,
      addressNList: fromChain.defaultPath,
      nonce: toHex(nonce),
      gasLimit: toHex(erc20DepositGas),
      gasPrice: toHex(gasPrice),
      to: params.router,     // ROUTER contract, NOT vault
      value: '0x0',          // no ETH value for ERC-20 swaps
      data: depositData,
    }

    console.log(`${TAG} ERC-20 router call: to=${params.router}, vault=${params.inboundAddress}, token=${tokenContract}, amount=${amountBaseUnits}`)
    return { unsignedTx, approvalTxid }

  } else {
    // ── Native asset swap: asset = 0x0, value = amountWei ──
    const amountWei = parseUnits(params.amount, fromChain.decimals)
    const staticGasLimit = DEPOSIT_GAS_LIMITS[fromChain.id] || 120000n

    const data = encodeDepositWithExpiry(
      params.inboundAddress, // vault address
      ZERO_ADDRESS,          // native asset (not ERC-20)
      amountWei,
      params.memo,
      expiry,
    )

    // Dynamic gas estimation with static fallback
    let gasLimit = staticGasLimit
    if (rpcUrl) {
      gasLimit = await estimateGas(rpcUrl, {
        to: params.router, from: fromAddress, data, value: toHex(amountWei),
      }, staticGasLimit)
      console.log(`${TAG} Estimated native deposit gas: ${gasLimit} (fallback: ${staticGasLimit})`)
    }

    const gasFee = gasPrice * gasLimit

    if (nativeBalance < amountWei + gasFee) {
      throw new Error(
        `Insufficient ${fromChain.symbol}: need ${formatWei(amountWei + gasFee)}, ` +
        `have ${formatWei(nativeBalance)}`
      )
    }

    const unsignedTx = {
      chainId,
      addressNList: fromChain.defaultPath,
      nonce: toHex(nonce),
      gasLimit: toHex(gasLimit),
      gasPrice: toHex(gasPrice),
      to: params.router,         // ROUTER contract, NOT vault
      value: toHex(amountWei),   // ETH value sent with the call
      data,                       // depositWithExpiry encoded call
    }

    console.log(`${TAG} EVM native router call: to=${params.router}, vault=${params.inboundAddress}, value=${params.amount} ${fromChain.symbol}`)
    return { unsignedTx }
  }
}
