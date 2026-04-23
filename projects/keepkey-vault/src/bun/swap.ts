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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Format a bigint wei value as a human-readable string (avoids Number() precision loss for large values) */
function formatWei(wei: bigint, decimals = 18): string {
  const whole = wei / 10n ** BigInt(decimals)
  const frac = wei % 10n ** BigInt(decimals)
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : `${whole}`
}

/** Chain-aware minimum gas price floors (gwei) — enforced even when RPC/Pioneer report lower.
 *  L2s and less-used chains frequently report unrealistically low fees that cause mempool drops. */
const MIN_GAS_GWEI: Record<string, number> = {
  ethereum: 1,
  polygon: 30,
  avalanche: 25,
  bsc: 3,
  base: 1,
  arbitrum: 1,
  optimism: 1,
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

// ── Router validation via Pioneer ───────────────────────────────────
// Pioneer proxies THORNode inbound_addresses — validate router from quote
// matches what Pioneer reports, to guard against stale/tampered quotes.

let routerCache: { routers: Map<string, string>; ts: number } = { routers: new Map(), ts: 0 }
const ROUTER_CACHE_TTL = 5 * 60_000 // 5 minutes

const CHAIN_TO_THORNODE: Record<string, string> = {
  ethereum: 'ETH', avalanche: 'AVAX', bsc: 'BSC', polygon: 'MATIC',
  base: 'BASE', arbitrum: 'ARB', optimism: 'OP',
}

async function validateRouterAddress(router: string, chain: ChainDef, pioneer: any): Promise<void> {
  const thorChain = CHAIN_TO_THORNODE[chain.id]
  if (!thorChain) return // non-EVM or unmapped chains

  // Check cache first
  if (routerCache.routers.size > 0 && Date.now() - routerCache.ts < ROUTER_CACHE_TTL) {
    const expected = routerCache.routers.get(thorChain)
    if (expected && router.toLowerCase() !== expected) {
      throw new Error(`Router mismatch: quote=${router}, Pioneer inbound=${expected} for ${thorChain}. Swap aborted.`)
    }
    return
  }

  // Fetch inbound addresses from Pioneer
  try {
    const resp = await pioneer.GetInboundAddresses()
    const data: Array<{ chain: string; router?: string }> = resp?.data || resp || []
    const routers = new Map<string, string>()
    for (const entry of data) {
      if (entry.router) routers.set(entry.chain, entry.router.toLowerCase())
    }
    routerCache = { routers, ts: Date.now() }

    const expected = routers.get(thorChain)
    if (expected && router.toLowerCase() !== expected) {
      throw new Error(`Router mismatch: quote=${router}, Pioneer inbound=${expected} for ${thorChain}. Swap aborted.`)
    }
  } catch (e: any) {
    if (e.message?.includes('Router mismatch')) throw e
    // Pioneer unavailable — log warning but don't block the swap
    console.warn(`${TAG} Could not validate router via Pioneer: ${e.message}`)
  }
}

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

  // Pioneer's /swap/available-assets historically omitted TRON entirely
  // even though /quote happily quotes TRON.TRX and TRON.USDT-TR7N... via
  // THORChain (both pools verified Available against thornode). Pioneer PR
  // #37 fixed this for both, but if a future deploy re-includes only one
  // (different whitelist policy, drift, etc.) the all-or-nothing shim
  // below would silently drop the other. Check each asset independently
  // so partial pioneer coverage doesn't regress us. Same posture as the
  // THOR.RUNE entry above.
  const tronDef = CHAINS.find(c => c.id === 'tron')
  if (tronDef) {
    if (!assets.find(a => a.asset === 'TRON.TRX')) {
      assets.push({
        asset: 'TRON.TRX',
        chainId: 'tron',
        symbol: 'TRX',
        name: 'Tron',
        chainFamily: 'tron',
        decimals: 6,
        caip: tronDef.caip,
      })
    }
    if (!assets.find(a => a.asset === 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T')) {
      assets.push({
        asset: 'TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T',
        chainId: 'tron',
        symbol: 'USDT',
        name: 'Tether (TRON)',
        chainFamily: 'tron',
        decimals: 6,
        contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        caip: 'tron:0x2b6653dc/token:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
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

  // Convert THORChain asset notation to CAIP for Pioneer Quote.
  // Pass in the cached asset list so assetToCaip can use pioneer's canonical
  // CAIP (correct namespace + correct case) instead of reconstructing — the
  // reconstruct path can't recover TRON's case-sensitive base58 address from
  // THORChain's uppercased contract field.
  const knownAssets = await getSwapAssets()
  const sellCaip = assetToCaip(params.fromAsset, knownAssets)
  const buyCaip = assetToCaip(params.toAsset, knownAssets)
  const slippage = params.slippageBps ? params.slippageBps / 100 : 3 // Pioneer uses % not bps

  // Normalize BCH CashAddr: strip "bitcoincash:" prefix — THORChain uses short form
  const normalizeBchAddr = (addr: string) =>
    addr.startsWith('bitcoincash:') ? addr.slice('bitcoincash:'.length) : addr
  const senderAddress = normalizeBchAddr(params.fromAddress)
  const recipientAddress = normalizeBchAddr(params.toAddress)

  console.log(`${TAG} Fetching quote: ${params.fromAsset} → ${params.toAsset} (${params.amount})`)
  console.log(`${TAG} CAIP: ${sellCaip} → ${buyCaip}`)
  console.log(`${TAG} sender=${senderAddress}, recipient=${recipientAddress}`)

  let quoteResp: any
  try {
    quoteResp = await pioneer.Quote({
      sellAsset: sellCaip,
      sellAmount: params.amount, // Pioneer expects DECIMAL format (human-readable)
      buyAsset: buyCaip,
      recipientAddress,
      senderAddress,
      slippage,
    })
  } catch (e: any) {
    // Pioneer-client (swagger-client) throws Error with message="Internal
    // Server Error" but the real diagnostic from THORNode (e.g. "amount less
    // than min swap amount (recommended_min_amount_in: …)") is in
    // e.response.body.message. Surface the inner message so the RPC layer +
    // frontend can render something useful instead of "Internal Server Error".
    const inner = e?.response?.body?.message || e?.responseError?.message || e?.response?.text
    if (inner && typeof inner === 'string') {
      // The text body comes through as a JSON string on some swagger versions;
      // try to unwrap once if it looks like JSON.
      let unwrapped = inner
      try {
        const parsed = JSON.parse(inner)
        if (parsed?.message) unwrapped = parsed.message
      } catch { /* not JSON, use as-is */ }
      const err = new Error(unwrapped)
      ;(err as any).cause = e
      throw err
    }
    throw e
  }

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
  getBtcXpub: () => { xpub: string; accountPath?: number[] } | undefined  // selected BTC xpub + account path
  getAllBtcXpubs: () => Array<{ xpub: string; scriptType: string; accountPath: number[] }>  // all funded BTC xpubs
  /** Wrap signing ops for emulator (shows confirm UI). Pass-through on real device. */
  wrapSign: (fn: () => Promise<any>, details: { operation: string; chain?: string; to?: string; value?: string; memo?: string }) => Promise<any>
}

/** Execute a swap: build tx, sign on device, broadcast */
export async function executeSwap(params: ExecuteSwapParams, ctx: SwapContext): Promise<SwapResult> {
  const { wallet, getAllChains, getRpcUrl, getBtcXpub, getAllBtcXpubs, wrapSign } = ctx

  // Resolve source chain
  const allChains = getAllChains()
  const fromChain = allChains.find(c => c.id === params.fromChainId)
  if (!fromChain) throw new Error(`Unknown source chain: ${params.fromChainId}`)

  // Detect ERC-20 source (THORChain format: "ETH.USDT-0xDAC17F..." — has hyphen + contract)
  const isErc20Source = params.fromAsset.includes('-') && fromChain.chainFamily === 'evm'

  // 1. Get sender address (use override if provided, otherwise derive from defaultPath)
  let fromAddress = params.fromAddressOverride
  if (!fromAddress) {
    const addrParams: any = {
      addressNList: fromChain.defaultPath,
      showDisplay: false,
      coin: fromChain.chainFamily === 'evm' ? 'Ethereum' : fromChain.coin,
    }
    if (fromChain.scriptType) addrParams.scriptType = fromChain.scriptType
    const addrMethod = fromChain.id === 'ripple' ? 'rippleGetAddress' : fromChain.rpcMethod
    const addrResult = await wallet[addrMethod](addrParams)
    fromAddress = typeof addrResult === 'string' ? addrResult : addrResult?.address
  }
  if (!fromAddress) throw new Error('Could not derive sender address')

  // 1b. Derive destination address for validation
  const toChain = allChains.find(c => c.id === params.toChainId)
  if (!toChain) throw new Error(`Unknown destination chain: ${params.toChainId}`)

  let toAddress = params.toAddressOverride
  if (!toAddress) {
    const toAddrParams: any = {
      addressNList: toChain.defaultPath,
      showDisplay: false,
      coin: toChain.chainFamily === 'evm' ? 'Ethereum' : toChain.coin,
    }
    if (toChain.scriptType) toAddrParams.scriptType = toChain.scriptType
    const toAddrMethod = toChain.id === 'ripple' ? 'rippleGetAddress' : toChain.rpcMethod
    const toAddrResult = await wallet[toAddrMethod](toAddrParams)
    toAddress = typeof toAddrResult === 'string' ? toAddrResult : toAddrResult?.address
  }
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
  // Relay integration provides pre-built tx with calldata — no memo or inbound address needed
  const isRelay = params.integration === 'relay' && !!params.relayTx
  // Native THORChain/Maya deposits (RUNE, CACAO) use MsgDeposit — no inbound vault needed
  const isNativeDeposit = params.fromAsset === 'THOR.RUNE' || params.fromAsset === 'MAYA.CACAO'
  if (!params.inboundAddress && !isNativeDeposit && !isRelay) throw new Error('Missing inbound vault address from quote')
  if (!params.memo && !isRelay) throw new Error('Missing swap memo from quote')
  if (params.memo) {
    const memoByteLength = Buffer.byteLength(params.memo, 'utf8')
    if (memoByteLength > MEMO_LIMIT) {
      throw new Error(`Swap memo too long (${memoByteLength} bytes, THORChain max ${MEMO_LIMIT})`)
    }
  }

  console.log(`${TAG} Executing: ${params.fromAsset} → ${params.toAsset}, amount=${params.amount}`)
  if (isRelay) {
    console.log(`${TAG} Relay integration — using pre-built tx (to=${params.relayTx!.to}, chainId=${params.relayTx!.chainId})`)
  } else {
    console.log(`${TAG} Chain family: ${fromChain.chainFamily}, vault: ${params.inboundAddress || 'MsgDeposit'}, router: ${params.router || 'none'}`)
  }
  if (isErc20Source) console.log(`${TAG} ERC-20 source detected: ${params.fromAsset}`)

  // 3. Get Pioneer for tx building
  const pioneer = await getPioneer()

  let unsignedTx: any
  let approvalTxid: string | undefined

  // ── Relay integration: sign pre-built tx directly ──
  if (isRelay) {
    const result = await buildRelaySwapTx(params, fromChain, fromAddress, getRpcUrl)
    unsignedTx = result.unsignedTx

  // ── EVM chains: MUST use router contract depositWithExpiry() ──
  } else if (fromChain.chainFamily === 'evm') {
    const result = await buildEvmSwapTx(params, fromChain, fromAddress, pioneer, getRpcUrl, isErc20Source, wallet)
    unsignedTx = result.unsignedTx
    approvalTxid = result.approvalTxid

  // ── UTXO chains: send to vault, memo in OP_RETURN ──
  } else if (fromChain.chainFamily === 'utxo') {
    let xpub: string | undefined
    let accountPath: number[] | undefined
    let allXpubs: Array<{ xpub: string; scriptType: string; accountPath: number[] }> | undefined

    if (fromChain.id === 'bitcoin') {
      // BTC: aggregate UTXOs from ALL funded xpubs (p2pkh + p2sh-p2wpkh + p2wpkh)
      try {
        allXpubs = getAllBtcXpubs()
        if (allXpubs.length > 0) {
          console.log(`${TAG} BTC multi-xpub: ${allXpubs.length} funded xpubs`)
          // Primary xpub for change address = selected, or first funded
          const btcInfo = getBtcXpub()
          xpub = btcInfo?.xpub || allXpubs[0].xpub
          accountPath = btcInfo?.accountPath || allXpubs[0].accountPath
        }
      } catch { /* BTC account manager not ready */ }
      if (!xpub) {
        // Fallback: single selected xpub
        try {
          const btcInfo = getBtcXpub()
          if (btcInfo) { xpub = btcInfo.xpub; accountPath = btcInfo.accountPath }
        } catch {}
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
      allXpubs,
      accountPath,
    })
    unsignedTx = buildResult.unsignedTx

  // ── All other chains (Cosmos, XRP, Solana, Tron, TON): send to vault with memo ──
  } else {
    // Resolve the canonical CAIP for the source asset and pull token decimals
    // from the cached SwapAsset list. Without this, buildTx's TRC-20 detection
    // (which keys off `params.caip` matching `tron:.../token:T...`) never
    // triggers for a USDT-on-TRON source — buildTx falls through to the native
    // TRX `createtransaction` path and would send `params.amount` as TRX to the
    // THORChain inbound address instead of as a USDT.transfer() call. Same
    // pattern would matter for any future SPL/non-EVM token sends.
    const knownAssets = await getSwapAssets()
    const fromAssetMeta = knownAssets.find(a => a.asset === params.fromAsset)
    const sourceCaip = fromAssetMeta?.caip
    const tokenDecimals = fromAssetMeta?.decimals

    const buildResult = await txb.buildTx(pioneer, fromChain, {
      chainId: fromChain.id,
      // MsgDeposit (RUNE/CACAO native swaps) ignores `to` — use sender as fallback
      to: params.inboundAddress || fromAddress,
      amount: params.amount,
      memo: params.memo,
      feeLevel: params.feeLevel,
      isMax: params.isMax,
      isSwapDeposit: true, // C1 fix: explicit flag for MsgDeposit (not inferred from memo)
      fromAddress,
      caip: sourceCaip,
      tokenDecimals,
    })
    unsignedTx = buildResult.unsignedTx
  }

  // 4. Sign on device (user confirms tx details on hardware wallet)
  console.log(`${TAG} Signing ${fromChain.chainFamily} tx via ${fromChain.signMethod}...`)
  let signedTx: any
  try {
    signedTx = await wrapSign(
      () => txb.signTx(wallet, fromChain, unsignedTx),
      { operation: 'swap', chain: fromChain.coin, to: params.inboundAddress, value: params.amount, memo: params.memo },
    )
  } catch (e: any) {
    console.error(`${TAG} SIGN FAILED: ${e.message}`)
    console.error(`${TAG}   chain=${fromChain.id}, method=${fromChain.signMethod}`)
    console.error(`${TAG}   stack: ${e.stack?.split('\n').slice(0, 5).join('\n')}`)
    throw e
  }
  console.log(`${TAG} Sign complete, serialized=${!!signedTx?.serialized || !!signedTx?.serializedTx}`)

  // 5. Broadcast — prefer direct RPC for EVM chains (Pioneer relay can silently drop txs)
  let txid: string
  const swapRpcUrl = fromChain.chainFamily === 'evm' ? getRpcUrl(fromChain) : undefined
  if (swapRpcUrl && fromChain.chainFamily === 'evm') {
    // Extract serialized tx hex from signed result
    const serializedHex: string | undefined = typeof signedTx === 'string' ? signedTx
      : signedTx?.serializedTx || signedTx?.serialized
    if (!serializedHex) {
      throw new Error(`Cannot extract serialized tx from signed result: ${JSON.stringify(signedTx).slice(0, 200)}`)
    }
    try {
      txid = await broadcastEvmTx(swapRpcUrl, serializedHex)
      console.log(`${TAG} Broadcast via direct RPC: ${txid}`)
    } catch (directErr: any) {
      console.warn(`${TAG} Direct RPC broadcast failed (${directErr.message}), falling back to Pioneer...`)
      try {
        const result = await txb.broadcastTx(pioneer, fromChain, signedTx)
        txid = result.txid
      } catch (pioneerErr: any) {
        console.error(`${TAG} BROADCAST FAILED (both direct RPC and Pioneer):`)
        console.error(`${TAG}   Direct: ${directErr.message}`)
        console.error(`${TAG}   Pioneer: ${pioneerErr.message}`)
        throw pioneerErr
      }
    }
  } else {
    try {
      const result = await txb.broadcastTx(pioneer, fromChain, signedTx)
      txid = result.txid
    } catch (e: any) {
      console.error(`${TAG} BROADCAST FAILED: ${e.message}`)
      console.error(`${TAG}   signedTx keys: ${signedTx ? Object.keys(signedTx).join(', ') : 'null'}`)
      throw e
    }
  }

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

// ── Relay swap tx building (pre-built calldata from bridge protocol) ──

async function buildRelaySwapTx(
  params: ExecuteSwapParams,
  fromChain: ChainDef,
  fromAddress: string,
  getRpcUrl: (chain: ChainDef) => string | undefined,
): Promise<{ unsignedTx: any }> {
  const relay = params.relayTx!

  // Guard: relay chainId MUST match the locally-resolved source chain to prevent
  // signing a tx for chain A with a nonce fetched from chain B.
  const expectedChainId = parseInt(fromChain.chainId || '0', 10)
  if (relay.chainId !== expectedChainId) {
    throw new Error(
      `Relay chainId mismatch: quote says ${relay.chainId} but source chain ${fromChain.id} is ${expectedChainId}. ` +
      `Aborting — stale or mismatched quote.`
    )
  }

  const chainId = expectedChainId
  const rpcUrl = getRpcUrl(fromChain)

  // Fetch nonce (relay tx doesn't include it)
  let nonce: number | undefined
  if (rpcUrl) {
    try { nonce = await getEvmNonce(rpcUrl, fromAddress) } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via RPC for relay tx: ${e.message}`)
    }
  }
  if (nonce === undefined) {
    const pioneer = await getPioneer()
    try {
      const nd = await pioneer.GetNonceByNetwork({ networkId: fromChain.networkId, address: fromAddress })
      nonce = nd?.data?.nonce
    } catch (e: any) {
      console.warn(`${TAG} Failed to fetch nonce via Pioneer for relay tx: ${e.message}`)
    }
  }
  if (nonce === undefined || nonce === null) {
    throw new Error(`Failed to fetch nonce for ${fromAddress} on ${fromChain.id} — cannot build relay tx`)
  }

  // Use gas params from relay quote, with sane fallbacks.
  // Mirror the normal EVM path: try quote fields → RPC → Pioneer → chain-specific floor.
  const gasLimit = relay.gasLimit || '300000'
  const fallbackGwei = MIN_GAS_GWEI[fromChain.id] ?? 10
  const fallbackGasPrice = BigInt(Math.round(fallbackGwei * 1e9))
  let gasPrice: string | undefined
  let maxFeePerGas: string | undefined
  let maxPriorityFeePerGas: string | undefined

  if (relay.maxFeePerGas) {
    // EIP-1559 tx — use quote values
    maxFeePerGas = relay.maxFeePerGas
    maxPriorityFeePerGas = relay.maxPriorityFeePerGas || '1000000' // 0.001 gwei fallback
  } else {
    // Legacy gas price — try RPC, then Pioneer, then chain-specific floor
    if (rpcUrl) {
      try {
        const gp = await getEvmGasPrice(rpcUrl)
        gasPrice = toHex(gp < fallbackGasPrice ? fallbackGasPrice : gp)
      } catch {
        console.warn(`${TAG} RPC gas price failed for relay tx, trying Pioneer...`)
      }
    }
    if (!gasPrice) {
      try {
        const pioneer = await getPioneer()
        const gp = await pioneer.GetGasPriceByNetwork({ networkId: fromChain.networkId })
        const gpData = gp?.data
        const gpGwei = typeof gpData === 'object'
          ? parseFloat(gpData.average || gpData.fast || String(fallbackGwei))
          : parseFloat(gpData || String(fallbackGwei))
        const gpWei = BigInt(Math.round((isNaN(gpGwei) ? fallbackGwei : gpGwei) * 1e9))
        gasPrice = toHex(gpWei < fallbackGasPrice ? fallbackGasPrice : gpWei)
      } catch (e: any) {
        console.warn(`${TAG} Pioneer gas price failed for relay tx, using ${fallbackGwei} gwei floor: ${e.message}`)
        gasPrice = toHex(fallbackGasPrice)
      }
    }
  }

  // Build ethSignTx params for hdwallet
  const unsignedTx: any = {
    addressNList: fromChain.defaultPath,
    chainId,
    nonce: toHex(BigInt(nonce)),
    gasLimit: toHex(BigInt(gasLimit)),
    to: relay.to,
    value: toHex(BigInt(relay.value)),
    data: relay.data,
  }

  // EIP-1559 fields
  if (maxFeePerGas) {
    unsignedTx.maxFeePerGas = toHex(BigInt(maxFeePerGas))
    unsignedTx.maxPriorityFeePerGas = toHex(BigInt(maxPriorityFeePerGas || '1000000'))
  } else if (gasPrice) {
    unsignedTx.gasPrice = gasPrice
  }

  console.log(`${TAG} Relay tx built: nonce=${nonce}, gasLimit=${gasLimit}, chainId=${chainId}, to=${relay.to}, value=${relay.value}`)
  return { unsignedTx }
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

  // Validate router against Pioneer inbound_addresses to catch stale/tampered quotes
  await validateRouterAddress(params.router, fromChain, pioneer)

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
  // Enforce minimum gas price floor — RPC/Pioneer frequently report unrealistically low fees
  if (gasPrice < fallbackGasPrice) {
    console.log(`${TAG} Gas price ${gasPrice} below floor ${fallbackGasPrice} (${fallbackGwei} gwei) — using floor`)
    gasPrice = fallbackGasPrice
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
      const balStr = String(bd?.data?.nativeBalance || bd?.data?.balance || '0')
      nativeBalance = parseUnits(balStr, 18)
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
    //    CRITICAL: Never silently default to 18 — wrong decimals cause catastrophic fund loss
    //    (e.g. USDC has 6 decimals; using 18 would send 10^12x the intended amount)
    let tokenDecimals: number | undefined
    if (rpcUrl) {
      try {
        tokenDecimals = await getErc20Decimals(rpcUrl, tokenContract)
        console.log(`${TAG} Token decimals (direct RPC): ${tokenDecimals}`)
      } catch (e: any) {
        console.warn(`${TAG} Direct RPC decimals failed: ${e.message}, trying Pioneer...`)
        try {
          const decimalsResp = await pioneer.GetTokenDecimals({ networkId: fromChain.networkId, contractAddress: tokenContract })
          const d = Number(decimalsResp?.data?.decimals)
          if (!isNaN(d) && d >= 0 && d <= 36) tokenDecimals = d
        } catch { console.warn(`${TAG} Pioneer decimals also failed`) }
      }
    } else {
      try {
        const decimalsResp = await pioneer.GetTokenDecimals({ networkId: fromChain.networkId, contractAddress: tokenContract })
        const d = Number(decimalsResp?.data?.decimals)
        if (!isNaN(d) && d >= 0 && d <= 36) tokenDecimals = d
      } catch { console.warn(`${TAG} Pioneer decimals failed`) }
    }
    if (tokenDecimals === undefined) {
      throw new Error(
        `Cannot determine token decimals for ${tokenContract} on ${fromChain.id}. ` +
        `Refusing to proceed — wrong decimals cause catastrophic fund loss.`
      )
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
    let amountWei = parseUnits(params.amount, fromChain.decimals)
    const staticGasLimit = DEPOSIT_GAS_LIMITS[fromChain.id] || 120000n

    // Dynamic gas estimation with static fallback (use static for initial estimate)
    let gasLimit = staticGasLimit

    const gasFee = gasPrice * gasLimit

    // sendMax: deduct gas from send amount so the entire balance is used
    if (params.isMax && nativeBalance > gasFee) {
      amountWei = nativeBalance - gasFee
      console.log(`${TAG} sendMax: adjusted amount to ${formatWei(amountWei)} ${fromChain.symbol} (balance ${formatWei(nativeBalance)} - gas ${formatWei(gasFee)})`)
    }

    const data = encodeDepositWithExpiry(
      params.inboundAddress, // vault address
      ZERO_ADDRESS,          // native asset (not ERC-20)
      amountWei,
      params.memo,
      expiry,
    )

    // Refine gas estimate now that we have the calldata
    if (rpcUrl) {
      try {
        gasLimit = await estimateGas(rpcUrl, {
          to: params.router, from: fromAddress, data, value: toHex(amountWei),
        }, staticGasLimit)
        console.log(`${TAG} Estimated native deposit gas: ${gasLimit} (fallback: ${staticGasLimit})`)
      } catch (e: any) {
        console.warn(`${TAG} Gas estimation failed, using static fallback ${staticGasLimit}: ${e.message}`)
        gasLimit = staticGasLimit
      }
    }

    const finalGasFee = gasPrice * gasLimit

    // L2 chains (OP Stack): reserve extra for L1 data posting fee, which is separate from
    // gasPrice * gasLimit. Without this, sendMax overspends by the L1 fee and gets rejected.
    const L2_DATA_FEE_CHAINS = ['base', 'optimism', 'arbitrum']
    const l1DataFeeBuffer = L2_DATA_FEE_CHAINS.includes(fromChain.id) ? BigInt(5e13) : 0n // 0.00005 ETH
    const totalGasReserve = finalGasFee + l1DataFeeBuffer

    // Re-adjust for sendMax with refined gas estimate + L1 data fee buffer
    if (params.isMax && nativeBalance > totalGasReserve) {
      amountWei = nativeBalance - totalGasReserve
      if (l1DataFeeBuffer > 0n) console.log(`${TAG} sendMax includes L1 data fee buffer: ${formatWei(l1DataFeeBuffer)}`)
    }

    if (nativeBalance < amountWei + totalGasReserve) {
      throw new Error(
        `Insufficient ${fromChain.symbol}: need ${formatWei(amountWei + totalGasReserve)}, ` +
        `have ${formatWei(nativeBalance)}`
      )
    }

    // Rebuild calldata with final amount
    const finalData = encodeDepositWithExpiry(
      params.inboundAddress,
      ZERO_ADDRESS,
      amountWei,
      params.memo,
      expiry,
    )

    const unsignedTx = {
      chainId,
      addressNList: fromChain.defaultPath,
      nonce: toHex(nonce),
      gasLimit: toHex(gasLimit),
      gasPrice: toHex(gasPrice),
      to: params.router,         // ROUTER contract, NOT vault
      value: toHex(amountWei),   // ETH value sent with the call
      data: finalData,           // depositWithExpiry encoded call
    }

    console.log(`${TAG} EVM native router call: to=${params.router}, vault=${params.inboundAddress}, value=${formatWei(amountWei)} ${fromChain.symbol}${params.isMax ? ' (sendMax)' : ''}`)
    return { unsignedTx }
  }
}
