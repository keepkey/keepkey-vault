import { getNumberLocale } from "../lib/number-locale"
import { useUiTranslation } from "../i18n/ui"
import { swapFeeLabel } from "../lib/swap-copy"
/**
 * SwapDialog — Full-screen dialog for the swap flow.
 *
 * Phases: input → review → approving/signing/broadcasting → success
 * Replaces the old inline SwapView with a proper modal experience.
 */
import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, Button, Image, HStack, Spinner } from "@chakra-ui/react"
import CountUp from "react-countup"
import { rpcRequest, rpcFire, onRpcMessage } from "../lib/rpc"
import { formatBalance } from "../lib/formatting"
import { formatEvmFeePaid } from "../lib/evm-fee-display"
import { isTokenCaip } from "../lib/asset-utils"
import { useFiat } from "../lib/fiat-context"
import { normalizeAmountInput, usdToCryptoAmount } from '../../shared/locale'
import { canonicalSwapAmount, quantizeComputedSwapAmount, swapAmountExceedsPrecision, swapAssetDecimals } from '../../shared/swap-amount'
import { AssetIcon } from "./AssetIcon"
import { CHAINS, getExplorerTxUrl, getExplorerBlockUrl } from "../../shared/chains"
import type { ChainDef } from "../../shared/chains"
import { decimalToBaseUnits, nativeMaxSpendableAmount, normalizeDecimals, tokenMaxSpendableAmount } from "../../shared/max-send"
import { getAssetIcon } from "../../shared/assetLookup"
import { isBurnAddress, sameAddress, validateAddress } from "../../shared/address-validation"
import { balanceUnverifiedReason, isBalanceUnverified } from "../../shared/balance-display-state"
import { isDeviceBusyError, isLocalDeviceAccessError } from "../../shared/device-access-error"
import { mergeTrustedBalanceSnapshot } from "../../shared/balance-reconciliation"
import type { SwapAsset, SwapQuote, ChainBalance, CustomToken, SwapStatusUpdate, SwapTrackingStatus, PendingSwap, SwapUiState, SwapUiCommand, SwapHealth } from "../../shared/types"
import { SOLANA_BLIND_SIGNING_REQUIRED } from "../../shared/types"
import { Z } from "../lib/z-index"
import { providerTrackerUrl } from "../lib/trackers"
import { ProviderBadge, ProverChip, resolveProvider } from "./ProviderBadge"
import { assessSwapRisk } from "../../shared/swap-risk"
import { swapHealthSummary, swapProviderPresentation, swapHealthQuoteExplanation } from "../../shared/swap-health"
import { knownSpenderName } from "../../shared/evm-known-spenders"
import { isSwapFullySettled, payoutReachesMinimum } from "../../shared/swap-settlement"
import { useSwapRiskRows } from "./SwapRiskReview"
import { NumberNode, PreflightList, PreflightStyles, TimelineItem, usePreflightScroll, usePreflightShort, type PreflightRow } from "./preflight/PreflightConsole"
import { shouldWarnHighSlippage, computeEffectiveSlippageBps, isSmallSwapQuoteWarning } from "../../shared/swap-warnings"
import { useEvmAddresses } from "../hooks/useEvmAddresses"
import { useDeviceState } from "../hooks/useDeviceState"
import { ClearSignReportCard } from "./ClearSignReportCard"
import { namedProviderLine, swapReportNeedsAttention } from "../../shared/clearsign-report"
import { versionCompare } from "../../shared/firmware-versions"
import { scopeSwapBalances, swapAccountAmount } from "../../shared/swap-account-balances"
import { applyNativeProof, DIRECT_TOKEN_PROOF_MAX_AGE_MS, type DirectNativeProof } from "../../shared/selected-token-balance"
import { sameSwapAsset, swapNetworkIdentity } from "../../shared/swap-network-identity"
import { AssetPickerDialog } from "./AssetPickerDialog"
import { DocsLink } from "./DocsLink"
import { DOCS_LINKS, watch } from "../../shared/docs-links"
import { networkDisplayName, parseCaip } from "../../shared/swap-discovery"
import { isSymbolSquatter } from "../../shared/symbolSquatter"
import { retainSwapProgress, shouldRetryCompletedSwapMetadata } from "../../shared/swap-tracker-guards"
import { advanceSwapStatus } from "../../shared/relay-status"
import { blocksSwapUiCommand } from "../../shared/swap-ui-control"
import {
  DEFAULT_SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS_BPS,
  PERSIST_MAX_SLIPPAGE_BPS,
  CONFIRM_SLIPPAGE_BPS,
  normalizeSlippageBps,
  parseCustomSlippagePercent,
  slippageAfterSwap,
} from "../../shared/slippage"
import { KeepKeyDevice, OledText, RouteMap, SpinningDevice } from "./v3"
import { DeviceMirrorPanel } from "./device/SigningReviewCompanion"
import { ethSignTxMirror, ethTxFromBody } from "../../shared/eth-device-screens"
import { getSwapperAnimation, getSwapperStill } from "../lib/swapper-animations"
import calculatingGif from "../assets/swap/calculating.gif"
import shiftingGif from "../assets/swap/shifting.gif"
import completedGif from "../assets/swap/completed.gif"
import shapeshiftLogo from "../assets/providers/shapeshift.svg"
import { getDateLocale } from '../lib/date-locale'

// ── Phase state machine ─────────────────────────────────────────────
type SwapPhase = 'input' | 'quoting' | 'review' | 'approving' | 'signing' | 'broadcasting' | 'submitted' | 'blind-signing-required'

/** Debug log — gated behind localStorage `swap.debug=1`. Used in place of
 *  console.log for high-volume per-render chatter. console.warn/error stay
 *  ungated. Set in DevTools: localStorage.setItem('swap.debug','1'). */
const SWAP_DEBUG = ((): boolean => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('swap.debug') === '1' } catch { return false }
})()
const swapLog = (...args: any[]): void => { if (SWAP_DEBUG) console.log(...args) }

// Chain CAIP for the network badge — only set for tokens (native assets
// would just duplicate the main logo).
const chainBadgeCaip = (asset: SwapAsset): string | undefined =>
  asset.contractAddress ? CHAINS.find(c => c.id === asset.chainId)?.caip : undefined

// ERC-20 approve(spender,amount) selector
const ERC20_APPROVE_SELECTOR = '0x095ea7b3'
const UINT256_MAX = (1n << 256n) - 1n

/** Conservative fee reserve (in native units) for native MAX swaps.
 *  Token swaps spend the token, not the native asset, and UTXO/Cosmos MAX is
 *  computed precisely server-side from the input set. The numbers here are a
 *  UX cushion: backend still performs exact or defensive fee handling at sign
 *  time, but the user should see and quote the post-fee amount when clicking
 *  MAX so they do not think the whole balance will be swapped. */
const NATIVE_EVM_GAS_RESERVE: Record<string, number> = {
  'eip155:1':     0.005,    // Ethereum L1 — swap router can cost ~$10-50
  'eip155:8453':  0.00015,  // Base — L2 cheap, but L1 data fee adds up
  'eip155:10':    0.00015,  // Optimism
  'eip155:42161': 0.0002,   // Arbitrum
  'eip155:137':   0.5,      // Polygon — gas spikes to 3000+ gwei; 0.5 MATIC covers ~3300 gwei × 150k gas
  'eip155:56':    0.002,    // BNB Smart Chain
  'eip155:43114': 0.005,    // Avalanche C-Chain
}
const NATIVE_EVM_GAS_RESERVE_DEFAULT = 0.001

/** THORChain/Midgard reports an all-zero hash for an outbound leg that hasn't
 *  been scheduled/observed yet. It's a "no tx" sentinel, not a real txid —
 *  reject it so the UI never renders a bogus OUTPUT TX / explorer link. */
const isRealHash = (h?: string | null): h is string => !!h && !/^(0x)?0+$/i.test(h)
type NativeMaxReserveMode = 'safe' | 'closer'
const NATIVE_EVM_CLOSER_RESERVE_FACTOR = 0.35
const NATIVE_EVM_CLOSER_RESERVE_FLOOR: Record<string, number> = {
  'eip155:1':     0.001,
  'eip155:8453':  0.00005,
  'eip155:10':    0.00005,
  'eip155:42161': 0.00005,
  'eip155:137':   0.1,      // floor raised to match safe reserve scale-up
  'eip155:56':    0.0005,
  'eip155:43114': 0.001,
}
const NATIVE_EVM_CLOSER_RESERVE_DEFAULT = 0.00025
const NATIVE_TRON_FEE_RESERVE = 1.1
// Solana sendMax reserve. The base network fee is only 5000 lamports/signature
// (~$0.001), but reserving the bare fee made sendMax swaps fail on-chain with
// "insufficient lamports": the balance MAX is computed from reaches the UI
// rounded to 8 decimals upstream (Pioneer), so e.g. 0.659381899 SOL becomes
// 0.65938190 — 1 lamport HIGH — and with zero headroom the Relay deposit
// overdrew (balance − fee) by a lamport. Like the EVM gas reserves, we leave a
// real, fee-/imprecision-proof buffer rather than draining to the last lamport.
// 0.01 SOL (~$1.50) is dust relative to swap sizes but ~2000× the fee, so it
// absorbs balance rounding and any priority-fee spike. Tradeoff: this much SOL
// is left behind on a max swap.
const NATIVE_SOLANA_FEE_RESERVE = 0.01

function nativeMaxFeeReserve(asset: SwapAsset, mode: NativeMaxReserveMode = 'safe'): number {
  if (asset.contractAddress) return 0
  if (asset.chainFamily === 'tron') return NATIVE_TRON_FEE_RESERVE
  if (asset.chainFamily === 'solana') return NATIVE_SOLANA_FEE_RESERVE
  if (asset.chainId === 'thorchain') return 0.022 // 0.02 RUNE network fee × 1.1, like evm.ts isMax
  if (asset.chainFamily !== 'evm') return 0
  const chainDef = CHAINS.find(c => c.id === asset.chainId)
  const reserveKey = chainDef?.networkId ?? asset.chainId
  const safeReserve = NATIVE_EVM_GAS_RESERVE[reserveKey] ?? NATIVE_EVM_GAS_RESERVE[asset.chainId] ?? NATIVE_EVM_GAS_RESERVE_DEFAULT
  if (mode === 'safe') return safeReserve
  const floor = NATIVE_EVM_CLOSER_RESERVE_FLOOR[reserveKey] ?? NATIVE_EVM_CLOSER_RESERVE_FLOOR[asset.chainId] ?? NATIVE_EVM_CLOSER_RESERVE_DEFAULT
  return Math.min(safeReserve, Math.max(floor, safeReserve * NATIVE_EVM_CLOSER_RESERVE_FACTOR))
}

/** Returns the displayable & spendable max amount for native MAX. For chains
 *  without a frontend reserve, returns the full balance unchanged because the
 *  backend computes their fee-aware MAX amount from chain-specific inputs. */
function maxSpendableAmount(asset: SwapAsset, balance: string, mode: NativeMaxReserveMode = 'safe'): string {
  const reserve = nativeMaxFeeReserve(asset, mode)
  if (reserve <= 0) return balance
  const chainDef = CHAINS.find(c => c.id === asset.chainId)
  return nativeMaxSpendableAmount(balance, chainDef?.decimals ?? asset.decimals, reserve)
}

function nativeUsdValue(balance: ChainBalance): number {
  const tokenUsdTotal = balance.tokens?.reduce((sum, token) => sum + (token.balanceUsd || 0), 0) || 0
  const nativeUsd = Number(balance.nativeBalanceUsd ?? 0)
  if (Number.isFinite(nativeUsd) && nativeUsd > 0) return nativeUsd

  const fallbackUsd = Number(balance.balanceUsd ?? 0) - tokenUsdTotal
  return Number.isFinite(fallbackUsd) && fallbackUsd > 0 ? fallbackUsd : 0
}

function nativePriceUsd(balance: ChainBalance): number {
  const bal = parseFloat(balance.balance || '0')
  if (!Number.isFinite(bal) || bal <= 0) return 0
  const nativeUsd = nativeUsdValue(balance)
  return nativeUsd > 0 ? nativeUsd / bal : 0
}

// nativePriceUsd(cb) is the chain GAS asset's price (nativeBalanceUsd / balance).
// It's only a valid price for `asset` when `asset` IS that native asset. THORChain
// / Cosmos sub-denoms (TCY, RUJI, xRUJI, secured assets) share the chain's single
// ChainBalance but trade at their own price — pricing them as native values them at
// the gas asset (e.g. 102 TCY @ RUNE's $0.42 = $43 instead of the real ~$12).
function balanceIsForAsset(cb: ChainBalance, asset: SwapAsset): boolean {
  return !!cb.symbol && !!asset.symbol && cb.symbol.toUpperCase() === asset.symbol.toUpperCase()
}

// Extended-pubkey prefix regex. Used in two places: (1) the UTXO destination
// resolver, to decide whether the cached balance address is actually an xpub
// that needs re-derivation; (2) canQuote, to refuse to send an xpub to Pioneer
// as a `toAddress` — Pioneer will silently substitute a derived destination,
// and the swap.ts:374 in-memo guard fires too late to protect funds.
const XPUB_RE = /^(?:xpub|ypub|zpub|tpub|upub|vpub|dgub|Ltub|Mtub|drkp|drks)[a-zA-Z0-9]{20,}$/i

function parseApproveCalldata(data?: string | null): { spender: string; amount: bigint } | null {
  if (!data || typeof data !== 'string') return null
  const hex = data.toLowerCase()
  if (!hex.startsWith(ERC20_APPROVE_SELECTOR) || hex.length < 138) return null
  try {
    const spender = '0x' + hex.slice(34, 74)
    const amount = BigInt('0x' + hex.slice(74, 138))
    return { spender, amount }
  } catch { return null }
}

// Friendly name for the underlying swap protocol, e.g. "Relay", "0x",
// "ButterSwap". Returns the raw swapper string for unknown providers so the
// UI can still show *something* truthful instead of swallowing it.
function protocolLabel(swapper: string | undefined | null): string | null {
  if (!swapper) return null
  const s = swapper.toLowerCase()
  if (s === 'relay') return 'Relay'
  if (s === 'thorchain' || s === 'thor') return 'THORChain'
  if (s === 'mayachain' || s === 'maya') return 'Maya'
  if (s === '0x' || s === 'zeroex') return '0x'
  if (s === 'uniswap' || s.startsWith('univ')) return 'Uniswap'
  if (s === 'cowswap' || s === 'cow') return 'CoW Swap'
  if (s === 'lifi' || s === 'li.fi') return 'LI.FI'
  if (s === 'oneinch' || s === '1inch') return '1inch'
  return swapper
}

// Friendly hint for a known spender contract address: Desktop's per-chain
// spender list first (the same names the signing card uses), then a few
// protocol-independent hints — many ShapeShift routes (ButterSwap, Relay, Hop,
// etc.) use the same Relay aggregator router as their executor. Returns null
// for unknowns.
function spenderHint(chainId: unknown, addr: string | undefined): string | null {
  if (!addr) return null
  const known = knownSpenderName(Number(chainId) || undefined, addr)
  if (known) return known
  const a = addr.toLowerCase()
  if (a === '0xee0319cf0bca5d09333f9f6277743e8de31bd69a') return 'Relay aggregator router'
  if (a === '0xdef1c0ded9bec7f1a1670819833240f027b25eff') return '0x ExchangeProxy'
  return null
}

type SwapPreviewBuild = {
  approveTx?: any
  unsignedTx: any
  allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }
  balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string }
  clearSignReports?: { approval?: import('../../shared/clearsign-report').ClearSignReport; transaction?: import('../../shared/clearsign-report').ClearSignReport }
  runtimeProvider?: import('../../shared/types').RuntimeProviderNamed
}

const EVM_METHOD_LABELS: Record<string, string> = {
  '0x095ea7b3': 'ERC-20 approve',
  '0x44bc937b': 'THORChain depositWithExpiry',
}

function toBigIntValue(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return BigInt(Math.trunc(value))
  }
  if (typeof value === 'string') {
    try { return BigInt(value) } catch { return null }
  }
  return null
}

function formatUnitsBigInt(value: bigint, decimals: unknown, maxFraction = 8): string {
  const precision = normalizeDecimals(decimals) ?? 0
  if (precision <= 0) return value.toString()
  const scale = 10n ** BigInt(precision)
  const whole = value / scale
  const fraction = value % scale
  if (fraction === 0n || maxFraction <= 0) return whole.toString()
  const frac = fraction.toString().padStart(precision, '0').slice(0, maxFraction).replace(/0+$/, '')
  return frac ? `${whole.toString()}.${frac}` : whole.toString()
}

function formatNativeUnits(value: bigint | null, decimals: unknown, symbol: string, maxFraction = 8): string {
  if (value === null) return '-'
  return `${formatUnitsBigInt(value, decimals, maxFraction)} ${symbol}`
}

function formatGwei(value: bigint | null): string {
  if (value === null) return '-'
  return `${formatUnitsBigInt(value, 9, 4)} gwei`
}

function evmSelector(data: unknown): string | null {
  if (typeof data !== 'string') return null
  const hex = data.toLowerCase()
  if (!hex.startsWith('0x') || hex.length < 10) return null
  return hex.slice(0, 10)
}

function evmDataBytes(data: unknown): number {
  if (typeof data !== 'string' || !data.startsWith('0x')) return 0
  return Math.max(0, Math.floor((data.length - 2) / 2))
}

function evmMethodLabel(data: unknown): string {
  const selector = evmSelector(data)
  if (!selector) return 'No calldata'
  return EVM_METHOD_LABELS[selector] ? `${EVM_METHOD_LABELS[selector]} (${selector})` : `Unknown method (${selector})`
}

function ellipsizeMiddle(value: unknown, start = 10, end = 8): string {
  if (typeof value !== 'string') return value == null ? '-' : String(value)
  if (value.length <= start + end + 1) return value
  return `${value.slice(0, start)}...${value.slice(-end)}`
}

function ReviewRow({ label, children, accent = false }: { label: ReactNode; children: ReactNode; accent?: boolean }) {
  return (
    <Flex justify="space-between" align="flex-start" gap="3">
      <Text fontSize="11px" color="kk.textMuted" maxW="50%">{label}</Text>
      <Text
        fontSize="11px"
        fontFamily="mono"
        fontWeight={accent ? "700" : "500"}
        color={accent ? "var(--text-0)" : "kk.textSecondary"}
        textAlign="right"
        wordBreak="break-word"
      >
        {children}
      </Text>
    </Flex>
  )
}

function QuoteFeeRows({ fees }: { fees: SwapQuote['fees'] }) {
  const { t } = useTranslation('swap')
  const uiText = useUiTranslation()
  return <>
    <ReviewRow label={t('quotedFeeRate', 'Quoted fee rate')}>
      {fees.reportedTotalBps != null ? `${(fees.reportedTotalBps / 100).toFixed(2)}%` : t('notProvided', 'Not provided')}
    </ReviewRow>
    {(fees.items || []).map((fee, index) => <ReviewRow key={`${fee.kind}:${fee.recipient || fee.assetCaip || ''}:${index}`} label={
      <span title={fee.recipient ? `Fee recipient: ${fee.recipient}` : fee.assetCaip}>
        {fee.label ? swapFeeLabel(fee.label, uiText) : (fee.kind === 'affiliate' ? t('affiliateFee', 'Affiliate fee') : fee.kind === 'network' ? t('networkFee', 'Network fee') : t('providerFee', 'Provider fee'))}
        {fee.recipient ? ` · ${ellipsizeMiddle(fee.recipient, 6, 4)}` : ''}
      </span>
    }>
      {fee.amount != null ? <span title={`${fee.amount} ${fee.symbol || ''}${fee.amountBaseUnits ? ` (${fee.amountBaseUnits} base units)` : ''}`}>
        {fee.estimated ? '~' : ''}{formatBalance(fee.amount)} {fee.symbol}
        {fee.bps != null ? ` (${(fee.bps / 100).toFixed(2)}%)` : ''}
      </span> : fee.bps != null ? `${(fee.bps / 100).toFixed(2)}%` : t('notProvided', 'Not provided')}
    </ReviewRow>)}
  </>
}

function EvmTxSummaryCard({
  title,
  tx,
  chain,
  asset,
  isApproval = false,
}: {
  title: string
  tx: any
  chain?: ChainDef
  asset?: SwapAsset
  isApproval?: boolean
}) {
  const uiText = useUiTranslation()

  const nativeDecimals = chain?.decimals ?? 18
  const nativeSymbol = chain?.symbol || 'ETH'
  const gasLimit = toBigIntValue(tx?.gasLimit)
  const gasPrice = toBigIntValue(tx?.gasPrice)
  const maxFeePerGas = toBigIntValue(tx?.maxFeePerGas)
  const maxPriorityFeePerGas = toBigIntValue(tx?.maxPriorityFeePerGas)
  const feePerGas = maxFeePerGas ?? gasPrice
  const maxNetworkFee = gasLimit !== null && feePerGas !== null ? gasLimit * feePerGas : null
  const nonce = toBigIntValue(tx?.nonce)
  const value = toBigIntValue(tx?.value)
  const selector = evmSelector(tx?.data)
  const approve = isApproval ? parseApproveCalldata(tx?.data) : null
  const spenderName = spenderHint(tx?.chainId, approve?.spender)

  return (
    <Box bg="rgba(0,0,0,0.20)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="3" py="2">
      <Flex align="center" justify="space-between" mb="2" gap="2">
        <Text fontSize="11px" fontWeight="700" color="kk.textPrimary">{title}</Text>
        <Text fontSize="10px" color="var(--teal)" fontFamily="mono">{uiText("payload ready")}</Text>
      </Flex>
      <VStack gap="1" align="stretch">
        <ReviewRow label={uiText("Chain")}>{chain?.id || 'EVM'} ({tx?.chainId ?? '-'})</ReviewRow>
        <ReviewRow label={uiText("Contract")}>{ellipsizeMiddle(tx?.to)}</ReviewRow>
        {isApproval && approve && (
          <>
            <ReviewRow label={uiText("Spender")}>{spenderName ? `${spenderName} - ${ellipsizeMiddle(approve.spender)}` : ellipsizeMiddle(approve.spender)}</ReviewRow>
            <ReviewRow label={uiText("Approval amount")} accent>
              {asset ? `${formatUnitsBigInt(approve.amount, asset.decimals, 8)} ${asset.symbol}` : approve.amount.toString()}
            </ReviewRow>
          </>
        )}
        {!isApproval && (
          <ReviewRow label={uiText("Value")} accent>{formatNativeUnits(value, nativeDecimals, nativeSymbol)}</ReviewRow>
        )}
        <ReviewRow label={uiText("Max network fee")} accent>{formatNativeUnits(maxNetworkFee, nativeDecimals, nativeSymbol, 8)}</ReviewRow>
        {maxFeePerGas !== null ? (
          <ReviewRow label={uiText("Fee data")}>{uiText("max")}{" "}{formatGwei(maxFeePerGas)} / priority {formatGwei(maxPriorityFeePerGas)}
          </ReviewRow>
        ) : (
          <ReviewRow label={uiText("Fee data")}>{formatGwei(gasPrice)}</ReviewRow>
        )}
        <ReviewRow label={uiText("Gas / nonce")}>{gasLimit?.toString() || '-'} / {nonce?.toString() || '-'}</ReviewRow>
        <ReviewRow label={uiText("Method")}>{evmMethodLabel(tx?.data)}</ReviewRow>
        <ReviewRow label={uiText("Calldata")}>{evmDataBytes(tx?.data)}{" "}{uiText("bytes")}{selector ? ` - ${selector}` : ''}</ReviewRow>
      </VStack>
    </Box>
  )
}

const ETHERSCAN_BY_CHAIN: Record<string, string> = {
  ethereum: 'https://etherscan.io',
  arbitrum: 'https://arbiscan.io',
  optimism: 'https://optimistic.etherscan.io',
  polygon: 'https://polygonscan.com',
  base: 'https://basescan.org',
  bsc: 'https://bscscan.com',
  avalanche: 'https://snowtrace.io',
}

// Default "to" asset when swapping from a given chain — BTC-like default to ETH, others to BTC
const DEFAULT_OUTPUT: Record<string, string> = {
  bitcoin: 'ETH.ETH',
  ethereum: 'BTC.BTC',
  litecoin: 'BTC.BTC',
  dogecoin: 'BTC.BTC',
  bitcoincash: 'BTC.BTC',
  dash: 'BTC.BTC',
  zcash: 'ETH.ETH',         // ZEC.ZEC pool is on Mayachain; ETH outbound is the most-used
  cosmos: 'ETH.ETH',
  thorchain: 'ETH.ETH',
  mayachain: 'ETH.ETH',
  avalanche: 'ETH.ETH',
  bsc: 'ETH.ETH',
  base: 'ETH.ETH',
  arbitrum: 'ETH.ETH',
  optimism: 'ETH.ETH',
  polygon: 'ETH.ETH',
  ripple: 'ETH.ETH',
  solana: 'ETH.ETH',
  tron: 'ETH.ETH',
  ton: 'ETH.ETH',
}

// ── Icons ───────────────────────────────────────────────────────────
const SwapArrowIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
  </svg>
)


const ThorchainIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" fill="var(--teal)" fillOpacity="0.15" />
    <path d="M12 4l-6 8 6 8 6-8-6-8z" fill="var(--teal)" fillOpacity="0.6" />
  </svg>
)

const CheckIcon = () => (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
)


const SwapInputIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
)

// ── External link icon ──────────────────────────────────────────────
const ExternalLinkIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

// ── Confetti burst (CSS-only, 30 particles) ─────────────────────────
function ConfettiBurst() {
  const colors = ['var(--teal)', 'var(--teal)', 'var(--gold)', 'var(--rose)', '#A78BFA', '#3B82F6', 'var(--gold)', '#F472B6']
  const particles = Array.from({ length: 30 }, (_, i) => {
    const angle = (i / 30) * 360
    const dist = 80 + Math.random() * 100
    const x = Math.cos(angle * Math.PI / 180) * dist
    const y = Math.sin(angle * Math.PI / 180) * dist - 40
    const color = colors[i % colors.length]
    const size = 4 + Math.random() * 5
    const delay = Math.random() * 0.2
    const rotation = Math.random() * 720
    return { x, y, color, size, delay, rotation, id: i }
  })
  return (
    <Box position="absolute" top="50%" left="50%" pointerEvents="none" zIndex={10}>
      {particles.map(p => (
        <Box
          key={p.id}
          position="absolute"
          w={`${p.size}px`}
          h={`${p.size}px`}
          bg={p.color}
          borderRadius={p.id % 3 === 0 ? 'full' : p.id % 3 === 1 ? '1px' : '0'}
          style={{
            animation: `kkConfetti 1s ease-out ${p.delay}s forwards`,
            '--cx': `${p.x}px`,
            '--cy': `${p.y}px`,
            '--cr': `${p.rotation}deg`,
            opacity: 0,
          } as any}
        />
      ))}
    </Box>
  )
}

// ── Play completion chime via Web Audio API ─────────────────────────
function playCompletionSound() {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime
    // Play a pleasant two-note chime (G5 → C6)
    const notes = [784, 1047]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, now + i * 0.15)
      gain.gain.linearRampToValueAtTime(0.15, now + i * 0.15 + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.5)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.15)
      osc.stop(now + i * 0.15 + 0.6)
    })
    setTimeout(() => ctx.close(), 1500)
  } catch { /* audio not available */ }
}

// ── Green CountUp value ─────────────────────────────────────────────
function GreenCountUp({ value, prefix = '', suffix = '', color = 'var(--teal)', fontSize = 'inherit', duration = 1.2 }: {
  value: string | number; prefix?: string; suffix?: string; color?: string; fontSize?: string; duration?: number
}) {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (isNaN(num) || num <= 0) return <>{prefix}{value}{suffix}</>
  const decimals = num < 1 ? 8 : num < 100 ? 4 : 2
  return (
    <Text as="span" color={color} fontSize={fontSize} display="inline-flex" alignItems="center"
      style={{ animation: 'kkBounceUp 0.5s ease-out' }}>
      {/* whiteSpace:pre — inline-flex collapses the leading space in prefix/suffix
          (e.g. " SOLANA"), which glued the amount to the symbol: "…291.85SOLANA" */}
      {prefix && <Text as="span" whiteSpace="pre">{prefix}</Text>}
      <CountUp key={num} start={0} end={num} decimals={decimals} duration={duration} separator="," preserveValue={false} />
      {suffix && <Text as="span" whiteSpace="pre">{suffix}</Text>}
    </Text>
  )
}

const DIALOG_CSS = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes kkSwapPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(139,227,196,0.5); }
    50% { box-shadow: 0 0 0 8px rgba(35,220,200,0); }
  }
  @keyframes kkSwapCheckPop {
    0% { transform: scale(0); opacity: 0; }
    60% { transform: scale(1.2); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes kkSwapDevicePulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(233,196,106,0.4); transform: scale(1); }
    50% { box-shadow: 0 0 20px 8px rgba(233,196,106,0.15); transform: scale(1.02); }
  }
  @keyframes kkSwapFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes kkBounceUp {
    0% { opacity: 0; transform: translateY(8px); }
    60% { opacity: 1; transform: translateY(-3px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes kkConfetti {
    0% { transform: translate(0, 0) rotate(0deg) scale(1); opacity: 1; }
    100% { transform: translate(var(--cx), var(--cy)) rotate(var(--cr)) scale(0.3); opacity: 0; }
  }
  @keyframes kkLogoFloat {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }
  @keyframes kkLogoGlow {
    0%, 100% { filter: drop-shadow(0 0 8px rgba(139,227,196,0.28)); }
    50% { filter: drop-shadow(0 0 20px rgba(139,227,196,0.5)); }
  }
  @keyframes kkGoldPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(233,196,106,0.4); }
    50% { box-shadow: 0 0 16px 6px rgba(233,196,106,0.15); }
  }
  @keyframes kkGoldSpin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(180deg); }
  }
  @keyframes kkBarStripes {
    0% { background-position: 0 0; }
    100% { background-position: 40px 0; }
  }
  /* Pulsing concentric halo rings behind the completed-swap mascot. */
  @keyframes kkPulseRing {
    0%, 100% { transform: scale(1);    opacity: 0.9; }
    50%      { transform: scale(1.04); opacity: 0.55; }
  }
  /* Sub-dialogs (provider status, route details) on the preflight surface. */
  .kk-sd-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(11,11,14,.72); backdrop-filter: blur(20px) saturate(140%); }
  .kk-sd-panel { display: flex; flex-direction: column; width: min(640px, 100%); max-height: calc(100vh - 32px); border-radius: 18px; overflow: hidden; color: var(--text-0); font-family: var(--font-ui-sans);
    background-color: #0b0b0e; background-image: radial-gradient(120% 80% at 0% 0%, rgba(233,196,106,.10), transparent 55%), radial-gradient(90% 70% at 100% 100%, rgba(98,126,234,.07), transparent 60%);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.06), 0 30px 80px -30px rgba(0,0,0,.8); }
  .kk-sd-panel.kk-sd-narrow { width: min(420px, 100%); }
  .kk-sd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 24px 12px; flex: none; }
  .kk-sd-head h2 { margin: 6px 0 0; font-size: 18px; font-weight: 600; }
  .kk-sd-x { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; font-size: 18px; line-height: 1; }
  .kk-sd-x:hover { color: var(--text-0); background: rgba(255,255,255,.05); }
  .kk-sd-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 24px 18px; }
  .kk-sd-foot { flex: none; padding: 10px 24px 16px; box-shadow: 0 -1px 0 rgba(255,255,255,.06); font-size: 11px; color: var(--text-2); }
  /* Native <details> open/close — fade the body in. */
  .kk-acc[open] > .kk-acc-body { animation: kkSwapFadeIn 0.22s ease-out; }
  .kk-acc summary { list-style: none; cursor: pointer; user-select: none; }
  .kk-acc summary::-webkit-details-marker { display: none; }
  .kk-acc[open] .kk-acc-chev { transform: rotate(180deg); }
  .kk-acc-chev { transition: transform 180ms ease-out; }
`

// ── Asset Selector ──────────────────────────────────────────────────
// Renders the selected-asset display (or a "select asset" prompt). Clicking
// either delegates to the parent SwapDialog, which renders a single shared
// AssetPickerDialog at modal-over-modal z-index. Search/filter logic moved
// out of this component into AssetPickerDialog + swap-discovery.
interface AssetSelectorProps {
  label: string
  selected: SwapAsset | null
  onOpenPicker: () => void
  disabled?: boolean
}

function AssetSelector({ label, selected, onOpenPicker, disabled }: AssetSelectorProps) {
  const uiText = useUiTranslation()

  const { t } = useTranslation("swap")
  // Symbol squatter: an unverified token wearing a major chain's ticker/name
  // (e.g. an ERC-20 that calls itself "SOLANA"). Strip its server icon so it
  // can't wear the native logo, and warn — see shared/symbolSquatter.
  const squatter = !!selected && isSymbolSquatter(selected.caip, selected.symbol, selected.name)
  // Native vs token from the CAIP namespace: a token never reads as the chain coin.
  const isToken = !!selected && (selected.caip ? parseCaip(selected.caip).isToken : !!selected.contractAddress)
  const network = selected?.caip ? networkDisplayName(selected.caip.split("/")[0]) : ''
  return (
    <div style={{ display: 'grid', gap: 12 }} data-swap-asset>
      <div className="kk-pf-top">
        <span className="kk-pf-kicker">{label}</span>
        {!disabled && selected && <button type="button" className="kk-pf-link" onClick={onOpenPicker}>{t("change") || uiText("Change")}</button>}
      </div>
      <button type="button" className="kk-pf-pick" onClick={() => { if (!disabled) onOpenPicker() }} disabled={disabled}>
        {selected ? <>
          <AssetIcon caip={selected.caip} iconUrl={squatter ? undefined : selected.icon} chainCaip={chainBadgeCaip(selected)} size={40} alt={selected.symbol} bare />
          <span style={{ minWidth: 0 }}>
            <b>{selected.symbol}</b>{network && <span className="kk-pf-dim">{' · '}{network}</span>}
            {isToken && selected.name && selected.name !== selected.symbol && <small>{selected.name}</small>}
          </span>
        </> : <>
          <span className="kk-pf-node kk-pf-num" aria-hidden="true">?</span>
          <span><b style={{ fontSize: 16, fontWeight: 500, color: 'var(--text-1)' }}>{t("selectAsset")}</b></span>
        </>}
      </button>
      {squatter && selected && (
        <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--rose)', fontWeight: 600 }}>
          {t("symbolSquatterWarning", {
            defaultValue: "⚠ Unverified token using the “{{symbol}}” name — this is NOT the native coin. Verify the contract above.",
            symbol: selected.symbol,
          })}
        </p>
      )}
    </div>
  )
}

// ── Props ───────────────────────────────────────────────────────────
interface SwapDialogProps {
  open: boolean
  onClose: () => void
  chain?: ChainDef
  balance?: ChainBalance
  address?: string | null
  resumeSwap?: PendingSwap | null
  onOutputAssetChange?: (chainId: string | null) => void
  /** CAIP-19 of the asset to pre-select as the FROM side. Falls back to native chain asset. */
  initialFromCaip?: string
  /** Pre-built SwapAsset to use as the FROM side — bypasses Pioneer's GetAvailableAssets list.
   *  Passed by AssetPage when the token may not appear in the ~19-asset Pioneer list. */
  initialFromAsset?: SwapAsset
}

// ── Main SwapDialog ─────────────────────────────────────────────────
export function SwapDialog({ open, onClose, chain, balance, address, resumeSwap, onOutputAssetChange, initialFromCaip, initialFromAsset }: SwapDialogProps) {
  const uiText = useUiTranslation()

  const { t, i18n } = useTranslation("swap")
  const { fmt, fmtCompact, symbol: fiatSymbol, locale } = useFiat()
  const { firmwareVersion } = useDeviceState()
  // Local EVM address selection — scoped to this dialog so switching here doesn't
  // mutate the global selected index in AssetPage. null = use global selectedIndex.
  const [evmAddressIndexOverride, setEvmAddressIndexOverride] = useState<number | null>(null)

  // ── State ─────────────────────────────────────────────────────────
  // A retained dialog can show another receipt while an older execution is
  // still running. Its completion belongs to that execution, not the new view.
  // Hiding a busy dialog keeps its context so it can finish while hidden.
  const executionUiGeneration = useRef(0)
  const executeAttempt = useRef(0)
  useEffect(() => () => { executionUiGeneration.current++ }, [])
  const [phase, setPhase] = useState<SwapPhase>('input')
  const [assets, setAssets] = useState<SwapAsset[]>([])
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [assetLoadError, setAssetLoadError] = useState<string | null>(null)
  const [balances, setBalances] = useState<ChainBalance[]>([])
  const [loadingBalances, setLoadingBalances] = useState(false)
  const [balanceInitialLoaded, setBalanceInitialLoaded] = useState(false)
  const [balanceReloadEpoch, setBalanceReloadEpoch] = useState(0)
  const [sourceBalanceReads, setSourceBalanceReads] = useState<Record<string, 'pending' | 'settled' | 'blocked'>>({})
  const swapOpenGeneration = useRef(0)
  const balancePushRevision = useRef(0)
  const chainBalancePushRevision = useRef(new Map<string, number>())
  // User-added custom tokens, refetched whenever the asset picker opens so a
  // freshly-added contract shows up on the next open without restarting.
  const [customTokens, setCustomTokens] = useState<CustomToken[]>([])

  const [fromAsset, setFromAsset] = useState<SwapAsset | null>(null)
  const [toAsset, setToAsset] = useState<SwapAsset | null>(null)
  const evmEnabled = open && (fromAsset?.chainFamily === 'evm' || toAsset?.chainFamily === 'evm'
    || (!fromAsset && (initialFromAsset?.chainFamily === 'evm' || chain?.chainFamily === 'evm')))
  const { evmAddresses, initialLoaded: evmInitialLoaded, refresh: refreshEvmAddresses } = useEvmAddresses(evmEnabled)
  const effectiveEvmIndex = evmAddressIndexOverride ?? evmAddresses.selectedIndex
  const signingAccount = evmAddresses.addresses.find(a => a.addressIndex === effectiveEvmIndex)
  useEffect(() => { onOutputAssetChange?.(toAsset?.chainId ?? null) }, [toAsset?.chainId, onOutputAssetChange])
  // Which side opened the asset picker — null when closed. Single shared
  // AssetPickerDialog rendered at modal-over-modal z-index for both sides.
  const [pickerSide, setPickerSide] = useState<'from' | 'to' | null>(null)
  const [amount, setAmount] = useState("")
  const [fiatAmount, setFiatAmount] = useState("")
  const [inputMode, setInputMode] = useState<'crypto' | 'fiat'>('crypto')
  const [isMax, setIsMax] = useState(false)
  const [maxReserveMode, setMaxReserveMode] = useState<NativeMaxReserveMode>('safe')

  const [swapHealth, setSwapHealth] = useState<SwapHealth | null>(null)
  const [healthDialogOpen, setHealthDialogOpen] = useState(false)
  const [healthRefreshing, setHealthRefreshing] = useState(false)
  const [quoteDetailsOpen, setQuoteDetailsOpen] = useState(false)
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  // ts when the current quote was received — used to detect staleness on Confirm
  const [quoteFetchedAt, setQuoteFetchedAt] = useState<number>(0)
  const [refreshingQuote, setRefreshingQuote] = useState(false)
  // Manual fallback quote in flight (the "Get Quote" button in the empty
  // receive slot) — re-derives a missing destination address then requotes.
  const [manualQuoting, setManualQuoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorIsWarning = isSmallSwapQuoteWarning(error)
  // Whether the current `error` came from a retryable cause (a quote timeout) —
  // only then do we offer Retry. Deterministic errors (pool unavailable, amount
  // below minimum) are not retryable: retrying just repeats the same failure.
  const [quoteRetryable, setQuoteRetryable] = useState(false)
  // Solana opaque-signing gate: a Relay route without signed ClearSign metadata
  // flips to a route-specific, one-request consent page.
  const [enablingBlindSign, setEnablingBlindSign] = useState(false)
  const [blindSignError, setBlindSignError] = useState<string | null>(null)
  // 'host'   — our own pre-flight consent gate (relay tx we can't verify here)
  // 'device' — the DEVICE refused: its AdvancedMode policy is off. One-shot
  //            consent does not help there (older firmware ignores the
  //            per-request flag), so the only remedy is enabling the policy.
  const [blindSignCause, setBlindSignCause] = useState<'host' | 'device'>('host')
  const [outflowCheck, setOutflowCheck] = useState<
    {
      solAfter: string
      tokensAfter: { mint: string; amount: string; decimals?: number; symbol?: string }[]
      spending?: string
      spendingSymbol?: string
      unavailable?: string
      reason?: string
      decoded?: string[]
    } | null
  >(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Bump to force the quote useEffect to re-run with the same inputs (used by
  // the 'requote' RPC command — re-quoting on input changes is automatic).
  const [requoteTick, setRequoteTick] = useState(0)

  // Slippage tolerance in bps. Allowed range: 10..5000 (0.1%..50%). Reject 0 —
  // silent zero-slippage ships swaps with no protection and routinely loses
  // funds on volatile pairs. Only tolerances up to 3% persist across sessions:
  // a loose one is for this swap only (audit v4 V1).
  const [slippageBps, setSlippageBpsState] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('swap.slippageBps')
      const n = raw ? parseInt(raw, 10) : NaN
      if (Number.isFinite(n) && n >= MIN_SLIPPAGE_BPS && n <= Math.min(MAX_SLIPPAGE_BPS, PERSIST_MAX_SLIPPAGE_BPS)) return n
    } catch { /* localStorage unavailable */ }
    return DEFAULT_SLIPPAGE_BPS
  })
  const setSlippageBps = useCallback((bps: number) => {
    const clamped = normalizeSlippageBps(bps)
    setSlippageBpsState(clamped)
    try {
      if (clamped <= PERSIST_MAX_SLIPPAGE_BPS) localStorage.setItem('swap.slippageBps', String(clamped))
      else localStorage.removeItem('swap.slippageBps')
    } catch { /* ignore */ }
  }, [])
  const [customSlippageOpen, setCustomSlippageOpen] = useState(false)
  const [customSlippageInput, setCustomSlippageInput] = useState(() => (slippageBps / 100).toString())
  const [customSlippageError, setCustomSlippageError] = useState<string | null>(null)

  const openCustomSlippage = useCallback(() => {
    setCustomSlippageInput((slippageBps / 100).toString())
    setCustomSlippageError(null)
    setCustomSlippageOpen(true)
  }, [slippageBps])

  const updateCustomSlippage = useCallback((raw: string) => {
    setCustomSlippageInput(raw)
    const parsed = parseCustomSlippagePercent(raw)
    if (!parsed.ok) {
      setCustomSlippageError(parsed.error)
      return false
    }
    setCustomSlippageError(null)
    setSlippageBps(parsed.bps)
    return true
  }, [setSlippageBps])

  // ── ExecuteSwap substage (retro #1 fix) ────────────────────────
  // Coarse `phase` is approving/signing/broadcasting. For ERC-20 swaps that
  // resolves to "approving" for the entire flow including the swap step,
  // making the UI lie ("Approving token… 1/2 Waiting on KeepKey" while the
  // device is actually prompting for the SWAP). Bun pushes finer-grained
  // substages via `swap-substage` so the label can reflect the truth.
  type SwapSubStage = 'approve-signing' | 'approve-broadcasting' | 'approve-waiting-receipt' | 'swap-signing' | 'swap-broadcasting'
  const [subStage, setSubStage] = useState<SwapSubStage | null>(null)
  // At approve-signing / swap-signing Bun also sends the EVM transaction the
  // device signs now, so the KeepKey's own screens can be drawn for it.
  type SigningTx = { chainId: number; to?: string; value?: string; data?: string; gasLimit?: string; gasPrice?: string; maxFeePerGas?: string; clearSign: boolean }
  const [signingTx, setSigningTx] = useState<SigningTx | null>(null)
  useEffect(() => {
    return onRpcMessage('swap-substage', (msg: { stage: SwapSubStage; tx?: SigningTx }) => {
      setSubStage(msg.stage)
      if (msg.stage.endsWith('-signing')) setSigningTx(msg.tx ?? null)
    })
  }, [])
  // Reset substage whenever we leave the busy phases
  useEffect(() => {
    if (phase !== 'approving' && phase !== 'signing' && phase !== 'broadcasting') {
      setSubStage(null)
      setSigningTx(null)
    }
  }, [phase])
  // The KeepKey's ButtonRequests for the transaction being signed now: the
  // approval and the swap each start their own count.
  const [devicePrompts, setDevicePrompts] = useState(0)
  useEffect(() => onRpcMessage('device-button-request', () => setDevicePrompts(n => n + 1)), [])
  const signingTxKind = subStage?.startsWith('swap-') ? 'swap' : subStage?.startsWith('approve-') || phase === 'approving' ? 'approve' : phase
  useEffect(() => { setDevicePrompts(0) }, [signingTxKind])

  // ── Live swap tracking state ────────────────────────────────────
  const [liveStatus, setLiveStatus] = useState<SwapTrackingStatus>('pending')
  const [liveConfirmations, setLiveConfirmations] = useState(0)
  const [liveOutboundConfirmations, setLiveOutboundConfirmations] = useState<number | undefined>()
  const [liveOutboundRequired, setLiveOutboundRequired] = useState<number | undefined>()
  const [liveOutboundTxid, setLiveOutboundTxid] = useState<string | undefined>()
  // Outbound chain may differ from toAsset.chainId — for refunds the outbound
  // is on the SOURCE chain. Populated from the Midgard classifier in the
  // tracker; falls back to toAsset.chainId when null.
  const [livePayouts, setLivePayouts] = useState<NonNullable<PendingSwap['payouts']>>([])
  const [liveReceivedOutput, setLiveReceivedOutput] = useState<string | undefined>()
  const [liveOutboundChainId, setLiveOutboundChainId] = useState<string | undefined>()
  const [liveRefundReason, setLiveRefundReason] = useState<string | undefined>()
  const [liveSwapper, setLiveSwapper] = useState<string | undefined>()
  const [liveRelayRequestId, setLiveRelayRequestId] = useState<string | undefined>()
  const [liveNearTxHash, setLiveNearTxHash] = useState<string | undefined>()
  // ── Inbound (input tx) on-chain location + timing + structured failure ──
  // All best-effort from Pioneer; render each only when present. createdAt is
  // the broadcast anchor used to show "input confirmed in Xm".
  const [liveInboundBlockNumber, setLiveInboundBlockNumber] = useState<number | undefined>()
  const [liveInboundBlockHash, setLiveInboundBlockHash] = useState<string | undefined>()
  const [liveInboundGasUsed, setLiveInboundGasUsed] = useState<string | undefined>()
  const [liveInboundEffectiveGasPrice, setLiveInboundEffectiveGasPrice] = useState<string | undefined>()
  const [liveInboundConfirmedAt, setLiveInboundConfirmedAt] = useState<number | undefined>()
  const [liveCreatedAt, setLiveCreatedAt] = useState<number | undefined>()
  const [liveCompletedAt, setLiveCompletedAt] = useState<number | undefined>()
  // Tracker error message + recovery guidance — previously never surfaced in
  // the submitted view (only the title flipped to "Swap failed").
  const [liveError, setLiveError] = useState<string | undefined>()
  const [liveErrorActionable, setLiveErrorActionable] = useState<string | undefined>()
  const [liveErrorElapsedMinutes, setLiveErrorElapsedMinutes] = useState<number | undefined>()
  const [rechecking, setRechecking] = useState(false)
  const [statusCheck, setStatusCheck] = useState<PendingSwap['statusCheck']>()

  const [trackingNow, setTrackingNow] = useState(Date.now)
  const elapsedSeconds = liveCreatedAt ? Math.max(0, Math.floor(((liveCompletedAt ?? trackingNow) - liveCreatedAt) / 1000)) : undefined
  const countdown = elapsedSeconds === undefined ? 0 : Math.max(0, Math.ceil((quote?.estimatedTime ?? 0) - elapsedSeconds))

  // ── Before/after balance tracking ─────────────────────────────────
  const [beforeFromBal, setBeforeFromBal] = useState<string | null>(null)
  const [beforeToBal, setBeforeToBal] = useState<string | null>(null)
  const [afterFromBal, setAfterFromBal] = useState<string | null>(null)
  const [afterToBal, setAfterToBal] = useState<string | null>(null)
  const [showConfetti, setShowConfetti] = useState(false)
  const completionFiredRef = useRef(false)

  // ── Frozen amount sent (captured at execution time so balance changes don't affect display) ──
  const [sentAmount, setSentAmount] = useState<string | null>(null)


  // ── Pre-confirm payload preview ──
  // Built silently when the user enters the Confirm Quote screen so the full
  // hdwallet payload is visible in the Details expand BEFORE signing starts.
  const [previewBuild, setPreviewBuild] = useState<SwapPreviewBuild | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // ── Custom destination address ──────────────────────────────────────
  const [useCustomAddress, setUseCustomAddress] = useState(false)
  const [customToAddress, setCustomToAddress] = useState("")
  const customAddressError = useMemo(() => {
    if (!useCustomAddress || !customToAddress) return ''
    const trimmed = customToAddress.trim()
    if (trimmed.length === 0) return 'Address is required'
    // Use chain-aware format validation when destination chain is known
    // SwapAsset names its chain by chainId (there is no `chain` field).
    const destChain = toAsset ? CHAINS.find(c => c.id === toAsset.chainId) : null
    if (destChain) {
      const result = validateAddress(trimmed, destChain)
      // The validator returns a send-namespace i18n key (e.g. invalidChecksum); show its text, not the key.
      if (!result.valid) return t(result.error || 'invalidAddress', { ns: 'send', defaultValue: 'Invalid address format for this chain' })
    } else {
      if (/\s/.test(trimmed)) return 'Address must not contain spaces'
      if (trimmed.length < 10) return 'Address is too short'
    }
    // Funds paid to a zero/burn address are gone (audit v4 H1).
    if (isBurnAddress(trimmed)) return t('burnAddress', { ns: 'send' })
    return ''
  }, [useCustomAddress, customToAddress, toAsset, t])

  // ── Derived terminal status (must be before effects that depend on them) ──
  const requiresSettlementEvidence = /thor|maya/i.test(`${quote?.integration || ''} ${resumeSwap?.integration || ''} ${liveSwapper || ''}`)
  const isSwapComplete = isSwapFullySettled({ status: liveStatus, integration: quote?.integration || resumeSwap?.integration,
    swapper: liveSwapper, payouts: livePayouts, receivedOutput: liveReceivedOutput,
    minimumOutput: quote?.minimumOutput || resumeSwap?.minimumOutput })
  const isSwapFailed = liveStatus === 'failed' || liveStatus === 'refunded'
  const payoutMeetsMinimum = payoutReachesMinimum(liveReceivedOutput, quote?.minimumOutput || resumeSwap?.minimumOutput)

  // Seed the inbound/timing/error fields from a full refreshSwap snapshot.
  // The swap-update message carries these too, but the snapshot is the backstop
  // for a dialog that mounted after the tracker's last push (resume / late open)
  // and is the only place createdAt (the broadcast anchor) is available.
  const updateStatusCheck = useCallback((check: NonNullable<PendingSwap['statusCheck']>) => {
    setStatusCheck(previous => !previous || check.checkedAt >= previous.checkedAt ? check : previous)
  }, [])

  const applyInboundSnap = useCallback((snap: PendingSwap | null) => {
    if (!snap) return
    if (snap.status) setLiveStatus(previous => advanceSwapStatus(previous, snap.status))
    if (snap.payouts) setLivePayouts(snap.payouts)
    if (snap.receivedOutput) setLiveReceivedOutput(snap.receivedOutput)
    if (Number.isFinite(snap.confirmations)) setLiveConfirmations(snap.confirmations)
    if (snap.outboundConfirmations !== undefined) setLiveOutboundConfirmations(snap.outboundConfirmations)
    if (snap.outboundRequiredConfirmations !== undefined) setLiveOutboundRequired(snap.outboundRequiredConfirmations)
    if (isRealHash(snap.outboundTxid)) setLiveOutboundTxid(snap.outboundTxid)
    if (snap.outboundChainId) setLiveOutboundChainId(snap.outboundChainId)
    if (snap.refundReason) setLiveRefundReason(snap.refundReason)
    if (snap.swapper && snap.integration !== 'thorchain' && snap.integration !== 'mayachain') setLiveSwapper(snap.swapper)
    if (snap.completedAt) setLiveCompletedAt(snap.completedAt)
    if (snap.statusCheck) updateStatusCheck(snap.statusCheck)
    if (snap.inboundBlockNumber != null && snap.inboundBlockNumber > 0) setLiveInboundBlockNumber(snap.inboundBlockNumber)
    if (snap.inboundBlockHash) setLiveInboundBlockHash(snap.inboundBlockHash)
    if (snap.inboundGasUsed) setLiveInboundGasUsed(snap.inboundGasUsed)
    if (snap.inboundEffectiveGasPrice) setLiveInboundEffectiveGasPrice(snap.inboundEffectiveGasPrice)
    if (snap.inboundConfirmedAt !== undefined && snap.inboundConfirmedAt !== null) setLiveInboundConfirmedAt(snap.inboundConfirmedAt)
    if (snap.createdAt) setLiveCreatedAt(snap.createdAt)
    if (snap.error) setLiveError(snap.error)
    if (snap.errorActionable) setLiveErrorActionable(snap.errorActionable)
    if (snap.errorElapsedMinutes !== undefined && snap.errorElapsedMinutes !== null) setLiveErrorElapsedMinutes(snap.errorElapsedMinutes)
  }, [updateStatusCheck])

  // ── Listen for swap-update + swap-complete RPC messages ─────────
  useEffect(() => {
    if (!txid || phase !== 'submitted') return

    const unsub1 = onRpcMessage('swap-update', (update: SwapStatusUpdate) => {
      if (update.txid !== txid) return
      setLiveStatus(previous => advanceSwapStatus(previous, update.status))
      if (update.payouts) setLivePayouts(update.payouts)
      if (update.receivedOutput) setLiveReceivedOutput(update.receivedOutput)
      if (update.confirmations !== undefined) setLiveConfirmations(update.confirmations)
      if (update.outboundConfirmations !== undefined) setLiveOutboundConfirmations(update.outboundConfirmations)
      if (update.outboundRequiredConfirmations !== undefined) setLiveOutboundRequired(update.outboundRequiredConfirmations)
      if (isRealHash(update.outboundTxid)) setLiveOutboundTxid(update.outboundTxid)
      if (update.swapper) setLiveSwapper(update.swapper)
      if (update.relayRequestId) setLiveRelayRequestId(update.relayRequestId)
      if (update.outboundChainId) setLiveOutboundChainId(update.outboundChainId)
      if (update.refundReason) setLiveRefundReason(update.refundReason)
      if (update.nearTxHash) setLiveNearTxHash(update.nearTxHash)
      if (update.inboundBlockNumber !== undefined && update.inboundBlockNumber > 0) setLiveInboundBlockNumber(update.inboundBlockNumber)
      if (update.inboundBlockHash) setLiveInboundBlockHash(update.inboundBlockHash)
      if (update.inboundGasUsed) setLiveInboundGasUsed(update.inboundGasUsed)
      if (update.inboundEffectiveGasPrice) setLiveInboundEffectiveGasPrice(update.inboundEffectiveGasPrice)
      if (update.inboundConfirmedAt !== undefined) setLiveInboundConfirmedAt(update.inboundConfirmedAt)
      if (update.error) setLiveError(update.error)
      if (update.errorActionable) setLiveErrorActionable(update.errorActionable)
      if (update.errorElapsedMinutes !== undefined) setLiveErrorElapsedMinutes(update.errorElapsedMinutes)
    })

    const unsub2 = onRpcMessage('swap-complete', (swap: any) => {
      if (swap.txid !== txid) return
      if (swap.payouts) setLivePayouts(swap.payouts)
      if (swap.receivedOutput) setLiveReceivedOutput(swap.receivedOutput)
      setLiveStatus(previous => advanceSwapStatus(previous, swap.status || 'completed'))
    })

    return () => { unsub1(); unsub2() }
  }, [txid, phase])

  // ── On-demand Pioneer polling — only while the dialog is open on this swap.
  // Pull immediately on mount, then on a 10s tick. Stops when the swap
  // reaches a terminal state, when the user closes the dialog, or when the
  // phase moves away.
  //
  // NOTE: deps are deliberately [open, txid, phase] — NOT liveStatus. Including
  // liveStatus here causes a runaway loop: every status push from the
  // tracker re-runs the effect, the cleanup cancels the in-flight tick,
  // a new tick fires immediately, hits Pioneer/Midgard, gets a different
  // status, pushes again, infinitely. The tick reads the latest status
  // through a ref instead.
  const liveStatusRef = useRef(liveStatus)
  useEffect(() => { liveStatusRef.current = liveStatus }, [liveStatus])
  useEffect(() => {
    if (!open || !txid || phase !== 'submitted') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let completedMetadataPolls = 0
    const tick = async () => {
      if (cancelled) return
      let snap: PendingSwap | null = null
      const checkedAt = Date.now()
      try {
        snap = await rpcRequest<PendingSwap | null>('refreshSwap', { txid })
        // Guard after the await — dialog may have closed or switched txids.
        if (cancelled) return
        // Apply fields that the tracker only pushes once (nearTxHash, relayRequestId)
        // so the dialog is always current even if it opened after the initial push.
        if (snap?.nearTxHash) setLiveNearTxHash(snap.nearTxHash)
        if (snap?.relayRequestId) setLiveRelayRequestId(snap.relayRequestId)
        applyInboundSnap(snap)
        if (!snap) updateStatusCheck({ checkedAt, error: 'not_found' })
      } catch {
        if (!cancelled) updateStatusCheck({ checkedAt, error: 'unavailable' })
      }
      if (cancelled) return
      const s = advanceSwapStatus(liveStatusRef.current, snap?.status || liveStatusRef.current)
      if (shouldRetryCompletedSwapMetadata(s, snap?.trackingMetadataPending, completedMetadataPolls)) {
        completedMetadataPolls += 1
        timer = setTimeout(tick, 10_000)
        return
      }
      // Old saved rows can say completed while only the quote was recorded as
      // received. Keep checking until the settlement legs are available.
      if (isSwapFullySettled({ status: s, integration: snap?.integration, swapper: snap?.swapper,
        payouts: snap?.payouts, receivedOutput: snap?.receivedOutput, minimumOutput: snap?.minimumOutput })
        || s === 'failed' || s === 'refunded') return
      timer = setTimeout(tick, 10_000)
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [open, txid, phase, applyInboundSnap, updateStatusCheck])

  // ── Manual recheck — fires a single immediate poll on demand ──────
  const handleRecheck = useCallback(async () => {
    if (!txid || rechecking) return
    const generation = executionUiGeneration.current
    const checkedAt = Date.now()
    setRechecking(true)
    try {
      // Manual press forces a Pioneer rescan (?rescan=true) so a failed/stuck
      // swap can be re-derived from chain on demand.
      const snap = await rpcRequest<PendingSwap | null>('refreshSwap', { txid, rescan: true })
      if (generation !== executionUiGeneration.current) return
      if (snap?.nearTxHash) setLiveNearTxHash(snap.nearTxHash)
      if (snap?.relayRequestId) setLiveRelayRequestId(snap.relayRequestId)
      applyInboundSnap(snap)
      if (!snap) updateStatusCheck({ checkedAt, error: 'not_found' })
    } catch {
      if (generation === executionUiGeneration.current) updateStatusCheck({ checkedAt, error: 'unavailable' })
    } finally {
      if (generation === executionUiGeneration.current) setRechecking(false)
    }
  }, [txid, rechecking, applyInboundSnap, updateStatusCheck])

  // When the user switches EVM address in the dialog while a quote is active,
  // discard the stale quote and return to input so a fresh quote is fetched.
  const prevEffectiveEvmIndexRef = useRef(effectiveEvmIndex)
  useEffect(() => {
    if (prevEffectiveEvmIndexRef.current === effectiveEvmIndex) return
    prevEffectiveEvmIndexRef.current = effectiveEvmIndex
    if (fromAsset?.chainFamily !== 'evm') return
    if (phase === 'review' || phase === 'quoting') {
      setPhase('input')
      setQuote(null)
      setError(null)
    }
  }, [effectiveEvmIndex, fromAsset?.chainFamily, phase])

  // Reset live tracking when phase changes away from submitted.
  // ALL live-* fields must clear here; otherwise values from a prior
  // submitted swap leak into the next one. Specifically: a refunded
  // Maya ETH→ZEC sets liveOutboundChainId='ethereum'; if that survives
  // into a subsequent THORChain ETH→BTC swap the explorer link uses
  // ethereum for what is actually a bitcoin outbound.
  useEffect(() => {
    if (phase !== 'submitted') {
      setLiveStatus('pending')
      setLivePayouts([])
      setLiveReceivedOutput(undefined)
      setLiveConfirmations(0)
      setLiveOutboundConfirmations(undefined)
      setLiveOutboundRequired(undefined)
      setLiveOutboundTxid(undefined)
      setLiveOutboundChainId(undefined)
      setLiveRefundReason(undefined)
      setLiveSwapper(undefined)
      setLiveRelayRequestId(undefined)
      setLiveNearTxHash(undefined)
      setLiveInboundBlockNumber(undefined)
      setLiveInboundBlockHash(undefined)
      setLiveInboundGasUsed(undefined)
      setLiveInboundEffectiveGasPrice(undefined)
      setLiveInboundConfirmedAt(undefined)
      setLiveCreatedAt(undefined)
      setLiveCompletedAt(undefined)
      setStatusCheck(undefined)
      setLiveError(undefined)
      setLiveErrorActionable(undefined)
      setLiveErrorElapsedMinutes(undefined)
      setAfterFromBal(null)
      setAfterToBal(null)
      setShowConfetti(false)
      completionFiredRef.current = false
    }
  }, [phase])

  // The broadcast timestamp keeps the estimate consistent across reopens.
  useEffect(() => {
    if (!open || phase !== 'submitted') return
    setTrackingNow(Date.now())
    if (isSwapComplete || isSwapFailed) return
    const timer = setInterval(() => setTrackingNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open, phase, isSwapComplete, isSwapFailed])

  // Fire confetti + sound + fetch after-balances when swap completes
  useEffect(() => {
    if (!isSwapComplete || completionFiredRef.current) return
    const generation = executionUiGeneration.current
    completionFiredRef.current = true
    setShowConfetti(true)
    playCompletionSound()
    setTimeout(() => { if (generation === executionUiGeneration.current) setShowConfetti(false) }, 1500)
    // Fetch updated balances to show before/after diff
    const swapDestCaip = toAsset?.chainFamily === 'evm' && toAsset.contractAddress ? toAsset.caip : undefined
    rpcRequest<ChainBalance[]>(
      'getBalances',
      swapDestCaip ? { forceRefresh: true, swapDestCaips: [swapDestCaip] } : { forceRefresh: true },
      120000,
    )
      .then((result) => {
        if (generation !== executionUiGeneration.current) return
        if (!result || !fromAsset || !toAsset) return
        const fromCb = result.find(b => b.chainId === fromAsset.chainId)
        const toCb = result.find(b => b.chainId === toAsset.chainId)
        if (fromCb) {
          if (fromAsset.contractAddress && fromCb.tokens) {
            const tok = fromCb.tokens.find(t => t.contractAddress?.toLowerCase() === fromAsset.contractAddress?.toLowerCase())
            setAfterFromBal(tok?.balance || '0')
          } else {
            setAfterFromBal(fromCb.balance)
          }
        }
        if (toCb) {
          if (toAsset.contractAddress && toCb.tokens) {
            const tok = toCb.tokens.find(t => t.contractAddress?.toLowerCase() === toAsset.contractAddress?.toLowerCase())
            setAfterToBal(tok?.balance || '0')
          } else {
            setAfterToBal(toCb.balance)
          }
        }
      })
      .catch(() => {})
  }, [isSwapComplete, fromAsset, toAsset])

  // ── Derived: which step are we on? ──────────────────────────────
  // Step 0: Input (pending/confirming) — inbound tx being confirmed
  // Step 1: Protocol (confirming with enough confs) — THORChain processing
  // Step 2: Output (output_detected/output_confirming) — outbound tx
  // Step 3: Done (completed)
  const observedSwapStep = useMemo(() => {
    if (isSwapComplete) return 3
    if (liveStatus === 'completed' && requiresSettlementEvidence) return 2
    if (liveStatus === 'output_detected' || liveStatus === 'output_confirming' || liveStatus === 'output_confirmed') return 2
    if (liveStatus === 'confirming') return 1
    // Once the inbound tx has ANY confirmation it is mined and the protocol
    // owns the deposit — counting confs is no longer the story to tell. Pioneer
    // can sit on 'pending' well past that point, which stranded the stepper on
    // "Input Transaction · 4 confirmations". Confirmations arrive independently
    // of Pioneer's status, so derive the promotion locally.
    // Excludes failed/refunded: a mined-but-reverted tx must never read as progress.
    if (liveConfirmations > 0 && liveStatus !== 'failed' && liveStatus !== 'refunded') return 1
    return 0 // pending
  }, [liveStatus, liveConfirmations, isSwapComplete, requiresSettlementEvidence])
  const [progress, setProgress] = useState({ txid: null as string | null, step: 0 })
  const swapStep = retainSwapProgress(progress, txid, observedSwapStep).step
  useEffect(() => {
    setProgress(previous => retainSwapProgress(previous, txid, observedSwapStep))
  }, [txid, observedSwapStep])

  // ── Load cached balances ──────────────────────────────────────────
  // Cache-first; when the cache is null/empty (hidden wallets always — the
  // balance cache is never written for passphrase sessions — and first-run),
  // fall through to a live getBalances, mirroring Dashboard's cache-miss
  // auto-refresh. Without this the FROM picker shows "Your KeepKey is empty"
  // for hidden wallets and non-EVM fromAddress never resolves (it reads
  // balances.find()?.address). getBalances derives addresses live from the
  // device and persists nothing for hidden wallets.
  const mergeBalanceRead = useCallback((rows: ChainBalance[], requestedRevision: number) => {
    setBalances(previous => {
      const next = new Map(previous.map(row => [row.chainId, row]))
      for (const row of rows) {
        if ((chainBalancePushRevision.current.get(row.chainId) ?? 0) > requestedRevision) continue
        const current = next.get(row.chainId)
        if (current?.updatedAt && row.updatedAt && current.updatedAt > row.updatedAt) continue
        const merged = mergeTrustedBalanceSnapshot(current, row, false)
        if (merged) next.set(row.chainId, merged)
      }
      return [...next.values()]
    })
  }, [])
  useEffect(() => {
    if (!open) {
      setLoadingBalances(false)
      setBalanceInitialLoaded(false)
      return
    }
    let cancelled = false
    const generation = swapOpenGeneration.current
    const requestedRevision = balancePushRevision.current
    setLoadingBalances(true)
    setBalanceInitialLoaded(false)
    rpcRequest<{ balances: ChainBalance[]; updatedAt: number } | null>('getCachedBalances', undefined, 5000)
      .catch(() => null) // A cache miss/failure still gets one live read.
      .then(async (result) => {
        if (cancelled || generation !== swapOpenGeneration.current) return
        if (result?.balances?.length) {
          mergeBalanceRead(result.balances, requestedRevision)
          return
        }
        const live = await rpcRequest<ChainBalance[]>('getBalances', undefined, 120000)
        if (cancelled || generation !== swapOpenGeneration.current) return
        if (Array.isArray(live)) mergeBalanceRead(live, requestedRevision)
        // EVM spendable values are owner-scoped. An aggregate portfolio reply
        // does not mean its separately-delivered owner snapshot is ready yet.
        await refreshEvmAddresses()
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled || generation !== swapOpenGeneration.current) return
        setLoadingBalances(false)
        setBalanceInitialLoaded(true)
      })
    return () => { cancelled = true }
  }, [open, balanceReloadEpoch, mergeBalanceRead, refreshEvmAddresses])

  // ── Live balance sync — keep sendMax math current ──────────────────
  // Dashboard subscribes to balance-updated; SwapDialog must too, or
  // sendMax calculations run against the snapshot from dialog-open time.
  useEffect(() => {
    if (!open) return
    return onRpcMessage('balance-updated', (updated: ChainBalance) => {
      chainBalancePushRevision.current.set(updated.chainId, ++balancePushRevision.current)
      setBalances(prev => {
        const idx = prev.findIndex(b => b.chainId === updated.chainId)
        if (idx === -1) return [...prev, updated]
        const next = [...prev]
        next[idx] = mergeTrustedBalanceSnapshot(prev[idx], updated, false) ?? prev[idx]
        return next
      })
    })
  }, [open])

  useEffect(() => onRpcMessage('wallet-data-purged', () => {
    swapOpenGeneration.current++
    balancePushRevision.current++
    chainBalancePushRevision.current.clear()
    setBalances([])
    setSourceBalanceReads({})
    setBalanceInitialLoaded(false)
    setBalanceReloadEpoch(epoch => epoch + 1)
  }), [])

  // ── Load user-added custom tokens ─────────────────────────────────
  // Refetch each time the picker is opened so a token added in the previous
  // picker session (via the paste-contract Add lane) is visible immediately.
  useEffect(() => {
    if (!open) return
    rpcRequest<CustomToken[]>('getCustomTokens', undefined, 5000)
      .then((result) => { if (Array.isArray(result)) setCustomTokens(result) })
      .catch(() => {})
  }, [open, pickerSide])

  // ── Load swap assets ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingAssets(true)
    setAssetLoadError(null)
    rpcRequest<SwapAsset[]>('getSwapAssets', undefined, 20000)
      .then((result) => {
        if (!cancelled) {
          setAssets(result)
          setLoadingAssets(false)
          if (!result || result.length === 0) {
            setAssetLoadError('No swap assets available — Pioneer server may be unreachable')
          }
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.error('[SwapDialog] Failed to load assets:', e)
          setLoadingAssets(false)
          setAssetLoadError(e?.message || 'Failed to load swap assets')
        }
      })
    return () => { cancelled = true }
  }, [open])

  // ── Swap provider health — fetch on open, refresh every 60s ─────
  const refreshSwapHealth = useCallback(() => {
    setHealthRefreshing(true)
    rpcRequest<SwapHealth>('getSwapHealth')
      .then(h => { setSwapHealth(h) })
      .catch(() => {})
      .finally(() => setHealthRefreshing(false))
  }, [])

  useEffect(() => {
    if (!open) return
    let timer: ReturnType<typeof setInterval> | null = null
    refreshSwapHealth()
    timer = setInterval(refreshSwapHealth, 60_000)
    return () => { if (timer) clearInterval(timer) }
  }, [open, refreshSwapHealth])

  // ── Auto-select from asset when dialog opens with chain context ───
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (hasAutoSelected.current) return

    // Fast path: caller supplied a pre-built SwapAsset (token from AssetPage that
    // may not appear in Pioneer's GetAvailableAssets list). Use it directly.
    if (initialFromAsset) {
      console.log(`[SwapDialog] auto-select initialFromAsset="${initialFromAsset.caip}"`)
      setFromAsset(initialFromAsset)
      hasAutoSelected.current = true
      return
    }

    if (assets.length === 0) return

    let match: SwapAsset | undefined

    if (initialFromCaip) {
      const caipLower = initialFromCaip.toLowerCase()

      // 1a. Case-insensitive exact CAIP match (handles checksum address differences)
      match = assets.find(a => a.caip?.toLowerCase() === caipLower)

      // 1b. Extract contract + network from the CAIP, match both
      if (!match && initialFromCaip.includes('/')) {
        const [networkPart = '', assetPart = ''] = initialFromCaip.split('/')
        const contract = assetPart.includes(':') ? assetPart.split(':')[1]?.toLowerCase() ?? '' : assetPart.toLowerCase()
        const targetChainId = CHAINS.find(c => c.networkId?.toLowerCase() === networkPart.toLowerCase())?.id

        if (contract) {
          // Prefer chain-scoped match, fall back to contract-only
          match = assets.find(a =>
            a.contractAddress?.toLowerCase() === contract && (!targetChainId || a.chainId === targetChainId)
          ) ?? assets.find(a => a.contractAddress?.toLowerCase() === contract)
        }
      }

      console.log(`[SwapDialog] auto-select initialFromCaip="${initialFromCaip}" → match=${match?.symbol ?? 'none'} (from ${assets.length} assets)`)
    }

    // 2. Token requested but not in swap assets — open the FROM picker so the
    //    user can search manually rather than silently landing on the wrong asset.
    if (!match && initialFromCaip) {
      hasAutoSelected.current = true
      setPickerSide('from')
      return
    }

    // 3. Fall back to native asset for the context chain
    if (!match && chain) {
      match = assets.find(a => a.chainId === chain.id && !a.contractAddress)
      if (match) console.log(`[SwapDialog] auto-select fallback to native: ${match.symbol}`)
    }

    if (match) {
      setFromAsset(match)
      // Only auto-set a default output for native assets — token swaps let the user pick
      if (!match.contractAddress) {
        const defaultOut = DEFAULT_OUTPUT[match.chainId]
        if (defaultOut) {
          const outMatch = assets.find(a => a.asset === defaultOut)
          if (outMatch) setToAsset(outMatch)
        }
      }
      hasAutoSelected.current = true
    }
  }, [assets, chain, initialFromCaip, initialFromAsset])

  // Default the output to the input chain's native gas asset for a TOKEN input
  // (e.g. USDT mainnet → ETH) when no output is chosen yet. Opening swap from a
  // token page shouldn't land on a blank output; native inputs keep their own
  // DEFAULT_OUTPUT above. Runs once assets are loaded (the initialFromAsset fast
  // path sets fromAsset before assets arrive, so we can't do it inline there).
  useEffect(() => {
    if (!fromAsset || toAsset || assets.length === 0) return
    if (!fromAsset.contractAddress) return // native input handled by DEFAULT_OUTPUT
    const nativeOut = assets.find(a => a.chainId === fromAsset.chainId && !a.contractAddress)
    if (nativeOut) setToAsset(nativeOut)
  }, [fromAsset, toAsset, assets])

  // ── Resume from swap history ──────────────────────────────────────
  const hasResumedRef = useRef<string | null>(null)
  // Clear resume guard when dialog closes so re-clicking same swap works
  useEffect(() => {
    if (!open) hasResumedRef.current = null
  }, [open])
  useEffect(() => {
    if (!open || !resumeSwap || hasResumedRef.current === resumeSwap.txid) return
    hasResumedRef.current = resumeSwap.txid
    executionUiGeneration.current++
    setRefreshingQuote(false)
    setManualQuoting(false)
    setEnablingBlindSign(false)
    setRechecking(false)

    // Build SwapAsset objects from PendingSwap data, resolving chain metadata from CHAINS.
    // CAIPs are persisted on the swap row so we can resolve asset logos here without
    // a Pioneer round-trip (otherwise the resumed dialog renders empty circles).
    const fromChain = CHAINS.find(c => c.id === resumeSwap.fromChainId)
    const toChain = CHAINS.find(c => c.id === resumeSwap.toChainId)
    const from: SwapAsset = {
      asset: resumeSwap.fromAsset,
      chainId: resumeSwap.fromChainId,
      symbol: resumeSwap.fromSymbol,
      name: resumeSwap.fromSymbol,
      chainFamily: fromChain?.chainFamily ?? 'utxo',
      decimals: fromChain?.decimals ?? 8,
      caip: resumeSwap.fromCaip,
      icon: resumeSwap.fromCaip ? getAssetIcon(resumeSwap.fromCaip) : undefined,
    }
    const to: SwapAsset = {
      asset: resumeSwap.toAsset,
      chainId: resumeSwap.toChainId,
      symbol: resumeSwap.toSymbol,
      name: resumeSwap.toSymbol,
      chainFamily: toChain?.chainFamily ?? 'utxo',
      decimals: toChain?.decimals ?? 8,
      caip: resumeSwap.toCaip,
      icon: resumeSwap.toCaip ? getAssetIcon(resumeSwap.toCaip) : undefined,
    }

    setFromAsset(from)
    setToAsset(to)
    setAmount(resumeSwap.fromAmount)
    setSentAmount(resumeSwap.fromAmount)
    setTxid(resumeSwap.txid)
    setLiveStatus(resumeSwap.status)
    setLivePayouts(resumeSwap.payouts || [])
    setLiveReceivedOutput(resumeSwap.receivedOutput)
    setLiveConfirmations(resumeSwap.confirmations)
    if (resumeSwap.outboundConfirmations !== undefined) setLiveOutboundConfirmations(resumeSwap.outboundConfirmations)
    if (resumeSwap.outboundRequiredConfirmations !== undefined) setLiveOutboundRequired(resumeSwap.outboundRequiredConfirmations)
    if (isRealHash(resumeSwap.outboundTxid)) setLiveOutboundTxid(resumeSwap.outboundTxid)
    if (resumeSwap.relayRequestId) setLiveRelayRequestId(resumeSwap.relayRequestId)
    // Seed outbound chain + refund reason from the persisted record so a
    // refund's explorer link points at the source chain on first render —
    // without this, the explorer falls back to toAsset.chainId until the
    // next refresh push, and refunded ETH→ZEC briefly opens a Zcash explorer
    // for what is actually an ETH refund tx.
    if (resumeSwap.outboundChainId) setLiveOutboundChainId(resumeSwap.outboundChainId)
    if (resumeSwap.refundReason) setLiveRefundReason(resumeSwap.refundReason)
    if (resumeSwap.nearTxHash) setLiveNearTxHash(resumeSwap.nearTxHash)
    // Seed inbound location + timing + failure guidance from the persisted row
    // so a resumed dialog renders them on first paint (before any fresh poll).
    if (resumeSwap.inboundBlockNumber !== undefined && resumeSwap.inboundBlockNumber > 0) setLiveInboundBlockNumber(resumeSwap.inboundBlockNumber)
    if (resumeSwap.inboundBlockHash) setLiveInboundBlockHash(resumeSwap.inboundBlockHash)
    if (resumeSwap.inboundGasUsed) setLiveInboundGasUsed(resumeSwap.inboundGasUsed)
    if (resumeSwap.inboundEffectiveGasPrice) setLiveInboundEffectiveGasPrice(resumeSwap.inboundEffectiveGasPrice)
    if (resumeSwap.inboundConfirmedAt !== undefined) setLiveInboundConfirmedAt(resumeSwap.inboundConfirmedAt)
    if (resumeSwap.createdAt) setLiveCreatedAt(resumeSwap.createdAt)
    setLiveCompletedAt(resumeSwap.completedAt)
    setStatusCheck(resumeSwap.statusCheck)
    if (resumeSwap.error) setLiveError(resumeSwap.error)
    if (resumeSwap.errorActionable) setLiveErrorActionable(resumeSwap.errorActionable)
    if (resumeSwap.errorElapsedMinutes !== undefined) setLiveErrorElapsedMinutes(resumeSwap.errorElapsedMinutes)
    // Skip stale `swapper` for native-vault integrations — Maya forks Thor's
    // protocol naming and Pioneer historically wrote `swapper='thorchain'`
    // even for Maya pools. The badge would then render "THORChain via Maya".
    // The tracker now actively clears this in the DB on the next refresh,
    // but pre-existing rows still need this UI guard until they're touched.
    const isNativeVaultIntegration = resumeSwap.integration === 'mayachain' || resumeSwap.integration === 'thorchain'
    if (resumeSwap.swapper && !isNativeVaultIntegration) setLiveSwapper(resumeSwap.swapper)
    // If resuming a terminal swap, suppress confetti/sound
    const isTerminal = resumeSwap.status === 'completed' || resumeSwap.status === 'failed' || resumeSwap.status === 'refunded'
    if (isTerminal) completionFiredRef.current = true

    setQuote({
      expectedOutput: resumeSwap.expectedOutput,
      minimumOutput: resumeSwap.minimumOutput ?? '',
      inboundAddress: resumeSwap.inboundAddress,
      router: resumeSwap.router,
      memo: resumeSwap.memo,
      fees: { affiliate: '0', outbound: '0', totalBps: 0 },
      estimatedTime: resumeSwap.estimatedTime,
      integration: resumeSwap.integration,
      swapper: isNativeVaultIntegration ? undefined : resumeSwap.swapper,
      // Preserve real slippage from history; fall back to current setting so
      // the review screen never displays a misleading 0%.
      slippageBps: resumeSwap.slippageBps ?? slippageBps,
    })
    setPhase('submitted')
  }, [open, resumeSwap])

  // ── Derived values ────────────────────────────────────────────────
  const isZcashSource = fromAsset?.chainId === 'zcash' && !fromAsset.contractAddress
  // While Pioneer's portfolio is degraded, read the native coin on chain for
  // each signing account, as AssetPage does (audit v4 H7), so MAX and the
  // account list show a real figure. Proofs are re-read before they expire.
  const [nativeProofs, setNativeProofs] = useState<Record<string, DirectNativeProof>>({})
  const [nativeProofEpoch, setNativeProofEpoch] = useState(0)
  const nativeChainCaip = fromAsset?.chainFamily === 'evm' && !fromAsset.contractAddress && !(fromAsset.caip && isTokenCaip(fromAsset.caip))
    ? CHAINS.find(c => c.id === fromAsset.chainId)?.caip : undefined
  const nativeProofOwners = useMemo(() => !fromAsset || !nativeChainCaip ? '' : evmAddresses.addresses
    .filter(a => isBalanceUnverified(scopeSwapBalances([], undefined, evmAddresses, a.addressIndex).find(b => b.chainId === fromAsset.chainId), nativeChainCaip))
    .map(a => a.address).join(','), [fromAsset, nativeChainCaip, evmAddresses])
  useEffect(() => {
    if (!fromAsset || !nativeChainCaip || !nativeProofOwners) return
    let cancelled = false
    const chainId = fromAsset.chainId
    for (const owner of nativeProofOwners.split(',')) {
      rpcRequest<{ balance: string }>('verifyTokenBalance', { chainId, owner, caip: nativeChainCaip }, 30000)
        .then(({ balance }) => { if (!cancelled) setNativeProofs(p => ({ ...p, [`${chainId}|${owner.toLowerCase()}`]: { chainId, owner, balance, verifiedAt: Date.now() } })) })
        .catch(e => console.warn(`[SwapDialog] on-chain native balance check failed for ${chainId}:`, e))
    }
    const timer = setTimeout(() => setNativeProofEpoch(n => n + 1), DIRECT_TOKEN_PROOF_MAX_AGE_MS / 2)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [fromAsset?.chainId, nativeChainCaip, nativeProofOwners, nativeProofEpoch])
  const withNativeProof = useCallback((row: ChainBalance | undefined) => row && nativeChainCaip
    ? applyNativeProof(row, nativeChainCaip, nativeProofs[`${row.chainId}|${row.address?.toLowerCase()}`]) : row, [nativeChainCaip, nativeProofs])
  // EVM amounts, picker tiles and confidence use one selected-owner snapshot.
  const accountBalances = useMemo(() => scopeSwapBalances(balances, balance, evmAddresses, effectiveEvmIndex,
    assets.filter(a => a.chainFamily === 'evm').map(a => a.chainId)).map(b => withNativeProof(b)!), [balances, balance, evmAddresses, effectiveEvmIndex, assets, withNativeProof])
  const fromBalanceEntry = useMemo(() => fromAsset ? accountBalances.find(b => b.chainId === fromAsset.chainId) : undefined,
    [fromAsset, accountBalances])
  const fromBalance = useMemo(() => fromAsset ? swapAccountAmount(fromBalanceEntry, fromAsset) : null,
    [fromAsset, fromBalanceEntry])

  /* Confidence in the ASSET being swapped. A token proven directly over RPC
   * keeps its real figure even while its parent chain is degraded — exactly
   * what mergeTrustedBalanceSnapshot merges through. */
  const fromBalanceUnverified = useMemo(
    () => !!fromAsset && fromBalance === null,
    [fromAsset, fromBalance],
  )
  /* 'missing' = no answer for this chain yet; only 'degraded' means the refresh failed. */
  const fromBalanceReason = useMemo(
    () => fromAsset ? balanceUnverifiedReason(fromBalanceEntry, fromAsset.caip) ?? (fromBalance === null ? 'missing' : undefined) : undefined,
    [fromAsset, fromBalanceEntry, fromBalance],
  )

  /* A cached snapshot can lack the chain being swapped from (it was not in the
   * last refresh). Fetch live once per chain instead of waiting on another screen
   * to push it; after that settles, a still-missing chain is reported as such. */
  const sourceBalanceKey = fromAsset
    ? `${fromAsset.chainId}:${fromAsset.caip || fromAsset.asset}:${fromAsset.chainFamily === 'evm' ? effectiveEvmIndex : 'native'}`
    : ''
  const sourceBalanceRead = sourceBalanceReads[sourceBalanceKey]
  // A new selection is pending on its FIRST paint, before its effect can start.
  // Keep that state until both the portfolio read and EVM owner snapshot settle.
  const fromBalancePending = fromBalanceUnverified && (!balanceInitialLoaded || loadingBalances
    || (fromAsset?.chainFamily === 'evm' && !evmInitialLoaded) || !sourceBalanceRead || sourceBalanceRead === 'pending')
  useEffect(() => {
    if (!open) { swapOpenGeneration.current++; setSourceBalanceReads({}) }
  }, [open])
  useEffect(() => {
    if (!open || !fromAsset || !fromBalanceUnverified || !balanceInitialLoaded || loadingBalances
      || (fromAsset.chainFamily === 'evm' && !evmInitialLoaded) || sourceBalanceRead) return
    const sourceKey = sourceBalanceKey
    const generation = swapOpenGeneration.current
    const requestedRevision = balancePushRevision.current
    let outcome: 'settled' | 'blocked' = 'settled'
    setSourceBalanceReads(previous => ({ ...previous, [sourceKey]: 'pending' }))
    setLoadingBalances(true)
    rpcRequest<ChainBalance[]>('getBalances', undefined, 120000)
      .then(async live => {
        if (generation !== swapOpenGeneration.current) return
        if (Array.isArray(live) && live.length > 0 && live.every(row => row.syncState === 'stale')) outcome = 'blocked'
        if (Array.isArray(live)) mergeBalanceRead(live, requestedRevision)
        await refreshEvmAddresses()
      })
      .catch(error => { if (isLocalDeviceAccessError(error)) outcome = 'blocked' })
      .finally(() => {
        if (generation !== swapOpenGeneration.current) return
        setSourceBalanceReads(previous => ({ ...previous, [sourceKey]: outcome }))
        setLoadingBalances(false)
      })
    // No effect cleanup: completing a different selection cannot cancel the
    // active read. Only close/purge retire its generation and discard replies.
  }, [open, fromAsset, fromBalanceUnverified, balanceInitialLoaded, loadingBalances, evmInitialLoaded,
    sourceBalanceRead, sourceBalanceKey, mergeBalanceRead, refreshEvmAddresses])

  /* Confidence in the chain's NATIVE balance, which is a different question:
   * a directly-confirmed SPL token says nothing about the SOL that pays for
   * the transfer. Sharing one boolean let a verified token re-enable the
   * low-gas verdict against a native balance still sitting at placeholder 0. */
  const fromNativeUnverified = useMemo(() => {
    if (!fromAsset) return false
    return isBalanceUnverified(fromBalanceEntry, CHAINS.find(c => c.id === fromAsset.chainId)?.caip)
  }, [fromAsset, fromBalanceEntry])

  /* Native account-model MAX fee reservation — frontend pre-clamps the balance
   * by a conservative fee reserve so the displayed, quoted, and submitted
   * amount match what the user actually spends. UTXO/Cosmos/etc. still use
   * isMax=true server-side because their fee math depends on input set + memo. */
  const nativeFeeReservedMaxAmount = useMemo(() => {
    if (!fromAsset || !fromBalance) return null
    if (nativeMaxFeeReserve(fromAsset) <= 0) return null
    return maxSpendableAmount(fromAsset, fromBalance, maxReserveMode)
  }, [fromAsset, fromBalance, maxReserveMode])

  const tokenPrecisionReservedMaxAmount = useMemo(() => {
    if (!fromAsset?.contractAddress || !fromBalance) return null
    return tokenMaxSpendableAmount(fromBalance, fromAsset.decimals)
  }, [fromAsset, fromBalance])

  const fromAmountDecimals = useMemo(() => fromAsset ? swapAssetDecimals(fromAsset) : null, [fromAsset])

  /* Low-gas pre-flight for TOKEN swaps: fees are paid in the source chain's
   * NATIVE asset, so a token swap from a dust-native account is guaranteed to
   * die at broadcast (e.g. TRON "Account resource insufficient error") — after
   * the user already signed on-device. Warn up-front instead. Warning only,
   * not a gate: staked/delegated resources (TRON energy) can make fees free
   * without any native balance, so blocking would false-positive. */
  const fromChainLowGas = useMemo(() => {
    // A degraded chain reports 0 native, which reads as "dust" and fires this
    // warning at someone whose gas account is fine. No verdict without a
    // number — and it must be the NATIVE number: a directly-confirmed SPL
    // token clears fromBalanceUnverified while SOL itself is still unknown.
    if (!fromAsset || fromNativeUnverified) return null
    const isToken = fromAsset.caip ? isTokenCaip(fromAsset.caip) : !!fromAsset.contractAddress
    if (!isToken) return null
    if (!fromBalanceEntry) return null
    const nativeUsd = Number(fromBalanceEntry.nativeBalanceUsd ?? 0)
    const nativeBalance = fromBalanceEntry.balance || '0'
    if (nativeUsd >= 1) return null
    const chainDef = CHAINS.find(c => c.id === fromAsset.chainId)
    return {
      symbol: chainDef?.symbol ?? fromAsset.chainId.toUpperCase(),
      coin: chainDef?.coin ?? fromAsset.chainId,
      balance: nativeBalance,
    }
  }, [fromAsset, fromNativeUnverified, fromBalanceEntry])

  /* Resolved (amount, isMax) tuple to send to the backend. For fee-reserved native
   * and token-precision-reserved MAX the amount is already clamped, so isMax
   * is dropped to keep the quote, display, and submitted amount honest. For
   * all other MAX sends, isMax remains true so the backend's chain-aware fee
   * math runs. */
  const sendAmount = useMemo(() => {
    if (!isMax) {
      const canonical = normalizeAmountInput(amount, locale, i18n.language)
      return canonical === null ? '' : canonicalSwapAmount(canonical, fromAmountDecimals) ?? ''
    }
    // `|| '0'` here meant an unverifiable balance submitted a 0-amount MAX swap.
    // Empty instead: no amount, so nothing downstream quotes or signs one.
    const computed = nativeFeeReservedMaxAmount ?? tokenPrecisionReservedMaxAmount ?? fromBalance
    return computed === null ? '' : quantizeComputedSwapAmount(computed, fromAmountDecimals) ?? ''
  }, [isMax, amount, locale, i18n.language, nativeFeeReservedMaxAmount, tokenPrecisionReservedMaxAmount, fromBalance, fromAmountDecimals])

  const sendIsMax = isMax && nativeFeeReservedMaxAmount === null && tokenPrecisionReservedMaxAmount === null
  const quotedSendAmount = quote?.netFromAmount ?? sendAmount

  /* When the native balance is too small to even cover gas, MAX is
   * unusable — flag it so the UI can show "insufficient for gas" instead
   * of letting the user submit a 0 swap. */
  const nativeMaxInsufficient = isMax && nativeFeeReservedMaxAmount !== null && parseFloat(nativeFeeReservedMaxAmount) <= 0
  const tokenMaxInsufficient = isMax && tokenPrecisionReservedMaxAmount !== null && parseFloat(tokenPrecisionReservedMaxAmount) <= 0
  const isFeeReservedNativeMax = isMax && nativeFeeReservedMaxAmount !== null

  // Derive per-unit USD price for from/to assets from cached balances
  // NOTE: cb.balanceUsd includes token USD — use nativeBalanceUsd for native asset price
  const fromPriceUsd = useMemo(() => {
    if (!fromAsset) { swapLog('[SWAP-PRICE] fromPriceUsd: no fromAsset'); return 0 }
    const cachedBalance = balances.find(b => b.chainId === fromAsset.chainId)
    const propBalance = balance && chain && fromAsset.chainId === chain.id ? balance : undefined
    const cb = [cachedBalance, propBalance].find((candidate): candidate is ChainBalance => {
      if (!candidate) return false
      if (fromAsset.contractAddress) {
        const token = candidate.tokens?.find(t => t.contractAddress?.toLowerCase() === fromAsset.contractAddress?.toLowerCase())
        return (token?.priceUsd || 0) > 0
      }
      // Prefer the candidate that actually represents this asset (e.g. the RUJI
      // ChainBalance passed as a prop) over the chain's aggregated native balance.
      return balanceIsForAsset(candidate, fromAsset) && nativePriceUsd(candidate) > 0
    }) || cachedBalance || propBalance
    if (!cb) { swapLog(`[SWAP-PRICE] fromPriceUsd: no balance for chainId=${fromAsset.chainId}`); return 0 }
    // Token assets: only ever use the token's own price. Falling through to the
    // native price logic when tokens haven't loaded yet causes a USDT swap to
    // display the ETH price ($229k for 100 USDT in one observed case). If we
    // can't find the token's price, return 0 — the UI will show "—" instead of
    // a wildly wrong number.
    if (fromAsset.contractAddress) {
      if (!cb.tokens) { swapLog(`[SWAP-PRICE] fromPriceUsd: token but cb.tokens not loaded yet`); return 0 }
      const tok = cb.tokens.find(t => t.contractAddress?.toLowerCase() === fromAsset.contractAddress?.toLowerCase())
      swapLog(`[SWAP-PRICE] fromPriceUsd: token path, contract=${fromAsset.contractAddress}, found=${!!tok}, priceUsd=${tok?.priceUsd}`)
      return tok?.priceUsd || 0
    }
    const bal = parseFloat(cb.balance)
    const nativeUsd = nativeUsdValue(cb)
    swapLog(`[SWAP-PRICE] fromPriceUsd: ${fromAsset.symbol} chainId=${fromAsset.chainId} bal=${bal} nativeUsd=${nativeUsd} nativeBalanceUsd=${cb.nativeBalanceUsd} balanceUsd=${cb.balanceUsd} tokens=${cb.tokens?.length || 0}`)
    // Never apply the chain's native price to a non-native sub-denom — return 0
    // so the caller degrades (or the TO side derives price from the quote ratio).
    if (!balanceIsForAsset(cb, fromAsset)) {
      swapLog(`[SWAP-PRICE] fromPriceUsd: ${fromAsset.symbol} is not the native asset of ${cb.symbol} balance — returning 0`)
      return 0
    }
    const result = nativePriceUsd(cb)
    swapLog(`[SWAP-PRICE] fromPriceUsd RESULT: $${result}`)
    return result
  }, [fromAsset, balance, chain, balances])

  const toPriceUsdFromBalance = useMemo(() => {
    if (!toAsset) { swapLog('[SWAP-PRICE] toPriceUsdFromBalance: no toAsset'); return 0 }
    const cb = balances.find(b => b.chainId === toAsset.chainId)
    if (!cb) { swapLog(`[SWAP-PRICE] toPriceUsdFromBalance: no balance for chainId=${toAsset.chainId}, available=${balances.map(b => b.chainId).join(',')}`); return 0 }
    // Token assets: only token price, never fall through to native (see fromPriceUsd).
    if (toAsset.contractAddress) {
      if (!cb.tokens) { swapLog(`[SWAP-PRICE] toPriceUsdFromBalance: token but cb.tokens not loaded yet`); return 0 }
      const tok = cb.tokens.find(t => t.contractAddress?.toLowerCase() === toAsset.contractAddress?.toLowerCase())
      swapLog(`[SWAP-PRICE] toPriceUsdFromBalance: token path, contract=${toAsset.contractAddress}, found=${!!tok}, priceUsd=${tok?.priceUsd}`)
      return tok?.priceUsd || 0
    }
    const bal = parseFloat(cb.balance)
    const nativeUsd = nativeUsdValue(cb)
    swapLog(`[SWAP-PRICE] toPriceUsdFromBalance: ${toAsset.symbol} chainId=${toAsset.chainId} bal=${bal} nativeUsd=${nativeUsd} nativeBalanceUsd=${cb.nativeBalanceUsd} balanceUsd=${cb.balanceUsd} tokens=${cb.tokens?.length || 0}`)
    // Non-native THORChain/Cosmos denom (TCY, RUJI, …) received into a chain whose
    // ChainBalance is the gas asset (RUNE): the native price is NOT this asset's
    // price. Return 0 so toPriceUsd derives it from the quote ratio + fromPriceUsd.
    if (!balanceIsForAsset(cb, toAsset)) {
      swapLog(`[SWAP-PRICE] toPriceUsdFromBalance: ${toAsset.symbol} is not the native asset of ${cb.symbol} balance — returning 0`)
      return 0
    }
    const result = nativePriceUsd(cb)
    swapLog(`[SWAP-PRICE] toPriceUsdFromBalance RESULT: $${result}`)
    return result
  }, [toAsset, balances])

  // Derive TO price from quote exchange rate when balance-based price is unavailable
  // (e.g., user has dust/zero native balance but tokens on the chain)
  const toPriceUsd = useMemo(() => {
    // When isMax, amount is "" — use fromBalance instead (same as quote request logic)
    const effectiveAmount = quotedSendAmount
    swapLog(`[SWAP-PRICE] toPriceUsd: balanceBased=$${toPriceUsdFromBalance} fromPriceUsd=$${fromPriceUsd} quote.expectedOutput=${quote?.expectedOutput} effectiveAmount=${effectiveAmount} isMax=${isMax}`)
    if (toPriceUsdFromBalance > 0) return toPriceUsdFromBalance
    // Fallback: derive from FROM price and quote ratio
    if (fromPriceUsd > 0 && quote?.expectedOutput && effectiveAmount) {
      const inAmt = parseFloat(effectiveAmount)
      const outAmt = parseFloat(quote.expectedOutput)
      if (inAmt > 0 && outAmt > 0) {
        const derived = (inAmt / outAmt) * fromPriceUsd
        swapLog(`[SWAP-PRICE] toPriceUsd FALLBACK: (${inAmt}/${outAmt}) * $${fromPriceUsd} = $${derived}`)
        return derived
      }
    }
    swapLog('[SWAP-PRICE] toPriceUsd: returning 0 (no price source)')
    return 0
  }, [toPriceUsdFromBalance, fromPriceUsd, quote?.expectedOutput, quotedSendAmount, isMax])

  const hasFromPrice = fromPriceUsd > 0
  const hasToPrice = toPriceUsd > 0
  /* True when toPriceUsd came from the quote ratio rather than an independent
   * price. In that case the "≈ $X" under the received amount is NOT a valuation
   * of the output — substitute the fallback and it collapses:
   *
   *     outAmt × (inAmt / outAmt) × fromPriceUsd  ≡  inAmt × fromPriceUsd
   *
   * i.e. it restates what was SENT, for any output value whatsoever. A quote
   * that returned 232,196,097,603.76 SOL still printed a perfectly plausible
   * "$49.06", because that figure never depended on the amount it appeared to
   * be pricing. Suppress it rather than let a wrong amount look corroborated. */
  const toPriceIsDerived = toPriceUsdFromBalance <= 0 && toPriceUsd > 0
  const nativeMaxReserveDisplay = useMemo(() => {
    if (!isFeeReservedNativeMax || !fromAsset || !fromBalance || nativeFeeReservedMaxAmount === null) return null
    const balanceAmount = parseFloat(fromBalance)
    const maxAmount = parseFloat(nativeFeeReservedMaxAmount)
    if (!Number.isFinite(balanceAmount) || !Number.isFinite(maxAmount)) return null
    const reserveAmount = Math.max(0, balanceAmount - maxAmount)
    if (reserveAmount <= 0) return null
    const safeReserve = nativeMaxFeeReserve(fromAsset, 'safe')
    const closerReserve = nativeMaxFeeReserve(fromAsset, 'closer')
    return {
      reserveAmount,
      reserveUsd: fromPriceUsd > 0 ? reserveAmount * fromPriceUsd : 0,
      safeReserve,
      closerReserve,
      canUseCloser: closerReserve < safeReserve,
    }
  }, [isFeeReservedNativeMax, fromAsset, fromBalance, nativeFeeReservedMaxAmount, fromPriceUsd])

  // Bidirectional conversion: crypto → fiat
  const handleCryptoChange = useCallback((v: string) => {
    const canonical = normalizeAmountInput(v, locale, i18n.language)
    setAmount(canonical ?? v)
    setIsMax(false)
    setMaxReserveMode('safe')
    if (hasFromPrice && v) {
      const n = canonical === null ? NaN : Number(canonical)
      if (!isNaN(n)) setFiatAmount((n * fromPriceUsd).toFixed(2))
      else setFiatAmount("")
    } else {
      setFiatAmount("")
    }
  }, [hasFromPrice, fromPriceUsd, locale, i18n.language])

  // ── Auto-default amount to ~$100 or max if balance < $100 ────────
  // Skip when an amount or MAX is already set: it may have come from REST seed,
  // explicit user input, or a prior session — silently flipping to MAX would
  // sign the full balance, not what the caller asked for.
  const prevAutoDefaultAsset = useRef<string | null>(null)
  useEffect(() => {
    if (!fromAsset || !fromPriceUsd || fromPriceUsd <= 0 || !fromBalance) return
    if (prevAutoDefaultAsset.current === fromAsset.asset) return
    if (amount || isMax) { prevAutoDefaultAsset.current = fromAsset.asset; return }
    prevAutoDefaultAsset.current = fromAsset.asset

    const balNum = parseFloat(fromBalance)
    if (balNum <= 0) return
    if (fromAmountDecimals === null) return
    const formatted = usdToCryptoAmount('100', fromPriceUsd, fromAmountDecimals)
    // The reserve-aware safe max already subtracts the chain's fee/rent
    // reserve (e.g. 0.01 SOL). A "$100 default" must never exceed it, or the
    // swap drains the reserve and reverts on-chain ("insufficient lamports").
    // When $100-worth meets/exceeds the safe max, fall back to MAX — which
    // clamps to the reserve-aware amount. For chains without a frontend
    // reserve (UTXO/Cosmos/tokens) safeMax == full balance, so this only fires
    // when the balance does not exceed $100 worth at the asset's precision.
    const safeMax = quantizeComputedSwapAmount(maxSpendableAmount(fromAsset, fromBalance, 'safe'), fromAmountDecimals)
    const defaultUnits = decimalToBaseUnits(formatted, fromAmountDecimals)
    const safeMaxUnits = safeMax === null ? null : decimalToBaseUnits(safeMax, fromAmountDecimals)
    if (defaultUnits === null || safeMaxUnits === null) return
    if (safeMaxUnits <= defaultUnits) {
      setIsMax(true)
      setMaxReserveMode('safe')
    } else {
      handleCryptoChange(formatted)
    }
  }, [fromAsset, fromPriceUsd, fromBalance, amount, isMax, handleCryptoChange, fromAmountDecimals])

  // Bidirectional conversion: fiat → crypto
  const handleFiatChange = useCallback((v: string) => {
    const canonical = normalizeAmountInput(v, locale, i18n.language)
    setFiatAmount(canonical ?? v)
    setIsMax(false)
    setMaxReserveMode('safe')
    if (hasFromPrice && v) {
      setAmount(canonical === null || fromAmountDecimals === null ? '' : usdToCryptoAmount(canonical, fromPriceUsd, fromAmountDecimals))
    } else {
      setAmount("")
    }
  }, [hasFromPrice, fromPriceUsd, locale, i18n.language, fromAmountDecimals])

  const toggleInputMode = useCallback(() => {
    setInputMode(prev => prev === 'crypto' ? 'fiat' : 'crypto')
  }, [])

  // USD preview of the amount actually being sent. Uses `sendAmount`, not
  // `amount`, so it still resolves under MAX — where the figure is the
  // fee-reserved max rather than anything typed. Suppressing it under MAX left
  // the user with a bare native number and no idea what it was worth.
  const amountUsdPreview = useMemo(() => {
    if (!hasFromPrice) return null
    const n = parseFloat(quotedSendAmount)
    if (isNaN(n) || n <= 0) return null
    return n * fromPriceUsd
  }, [quotedSendAmount, hasFromPrice, fromPriceUsd])

  const canonicalAmount = normalizeAmountInput(amount, locale, i18n.language)
  const amountNum = canonicalAmount === null ? NaN : Number(canonicalAmount)
  const balanceNum = fromBalance ? parseFloat(fromBalance) : 0
  const exceedsBalance = !isMax && !isNaN(amountNum) && amountNum > 0 && balanceNum > 0 && amountNum > balanceNum
  // Reserve-aware guard: an amount that fits the raw balance but spends into
  // the chain's fee/rent reserve (e.g. leaves < 0.01 SOL) reverts on-chain
  // after ATA rent + fees. Flagged separately from the hard balance error so
  // the message stays actionable ("leave ~X for fees"). For chains without a
  // frontend reserve safeMax == balance, so this never fires beyond exceedsBalance.
  const safeMaxAmountNum = fromAsset && fromBalance ? parseFloat(maxSpendableAmount(fromAsset, fromBalance, 'safe')) : 0
  const exceedsSafeMax = !isMax && !exceedsBalance && !isNaN(amountNum) && amountNum > 0 && Number.isFinite(safeMaxAmountNum) && safeMaxAmountNum > 0 && amountNum > safeMaxAmountNum
  const fromNetwork = fromAsset ? swapNetworkIdentity(fromAsset) : null
  const toNetwork = toAsset ? swapNetworkIdentity(toAsset) : null
  const networkMismatch = !!(fromNetwork?.conflict || toNetwork?.conflict)
  const sameAsset = !!(fromAsset && toAsset && sameSwapAsset(fromAsset, toAsset))

  const fromAddress = useMemo(() => {
    if (!fromAsset) return ''
    // EVM: always derive from the effective address index so fromAddress,
    // fromBalance, and fromEvmAddressIndex are always in sync.
    if (fromAsset.chainFamily === 'evm') {
      const selectedAddr = evmAddresses.addresses.find(a => a.addressIndex === effectiveEvmIndex)
      // An aggregate/prop address cannot identify this signing account. Wait
      // for its owner snapshot rather than quote owner N with index zero.
      return selectedAddr?.address || ''
    }
    // Non-EVM: prefer the prop address when chain matches (AssetPage already derived it)
    if (address && chain && fromAsset.chainId === chain.id) return address
    const cb = balances.find(b => b.chainId === fromAsset.chainId)
    return cb?.address || ''
  }, [fromAsset, address, chain, balances, evmAddresses, effectiveEvmIndex])

  // Cached/balance-pipe address — for UTXO chains other than BTC this is often
  // the xpub itself (see comment in AssetPage.tsx:246: "balance.address may be
  // empty (xpub is not an address)"). We use it as the initial value, then
  // re-derive a real receive address via the chain's rpcMethod below for the
  // display. The resolved address also flows into `toAddress` so the swap
  // memo encodes a real destination, not an extended pubkey.
  const cachedToAddress = useMemo(() => {
    if (!toAsset) return ''
    // EVM destinations share one receive address across all EVM chains — the
    // user's own device-derived address, available from evmAddresses regardless
    // of whether the balance cache has loaded. Mirror fromAddress here so a swap
    // INTO an EVM asset never stalls on an empty receive address when the balance
    // cache is empty (e.g. balance server unavailable). Without this fallback,
    // toAddress was '' until a balance-updated event happened to stream the dest
    // chain — leaving canQuote false and the receive panel a silent dead-end.
    if (toAsset.chainFamily === 'evm') {
      const selectedAddr = evmAddresses.addresses.find(a => a.addressIndex === effectiveEvmIndex)
      return selectedAddr?.address || ''
    }
    const cb = balances.find(b => b.chainId === toAsset.chainId)
    return cb?.address || ''
  }, [toAsset, balances, evmAddresses, effectiveEvmIndex])

  // Derive a real receive address for non-EVM destinations from the device when
  // the balance cache hasn't supplied one. UTXO chains additionally need this to
  // turn an xpub into a real address. EVM destinations are skipped — their
  // address comes from evmAddresses via cachedToAddress (above), cache-free.
  // This is what makes auto-quoting work for Solana/Cosmos/etc.: without it the
  // destination address stayed '' on an empty cache and the quote never fired
  // until the user hit the manual "Get Quote" button. Mirrors the re-derive
  // effect AssetPage runs on mount; the cancel flag below guards against an
  // output-asset switch landing a stale address on the wrong chain.
  const [resolvedToAddress, setResolvedToAddress] = useState<string>('')
  const [destAddressError, setDestAddressError] = useState<string | null>(null)
  useEffect(() => {
    setResolvedToAddress('')
    setDestAddressError(null)
    if (!toAsset) return
    const toChain = CHAINS.find(c => c.id === toAsset.chainId)
    if (!toChain) return
    if (toChain.chainFamily === 'evm') return
    // Fast path: cached address already looks like a real address (not an xpub).
    if (cachedToAddress && !XPUB_RE.test(cachedToAddress)) return
    let cancelled = false
    ;(async () => {
      try {
        const params: any = {
          addressNList: toChain.defaultPath,
          showDisplay: false,
          coin: toChain.coin,
        }
        if (toChain.scriptType) params.scriptType = toChain.scriptType
        const result = await rpcRequest<any>(toChain.rpcMethod, params, 60000, () => !cancelled)
        if (cancelled) return
        const addr = typeof result === 'string' ? result : (result?.address || '')
        if (addr) setResolvedToAddress(addr)
        else setDestAddressError(`Could not derive ${toChain.coin} destination address`)
      } catch (e: any) {
        if (cancelled) return
        console.warn(`[SwapDialog] Failed to derive ${toChain.coin} receive address:`, e?.message || e)
        setDestAddressError(`Failed to derive ${toChain.coin} destination address: ${e?.message || 'unknown error'}`)
      }
    })()
    return () => { cancelled = true }
  }, [toAsset, cachedToAddress])

  const keepKeyToAddress = resolvedToAddress || cachedToAddress

  const toAddress = useMemo(() => {
    if (useCustomAddress && customToAddress.trim()) return customToAddress.trim()
    return keepKeyToAddress
  }, [useCustomAddress, customToAddress, keepKeyToAddress])
  // One of this wallet's own addresses pasted as the custom recipient is not
  // an external payout (audit v4 V6); anything else is flagged in review (H1).
  const customIsOwn = useCustomAddress && !!customToAddress.trim() && (sameAddress(customToAddress, keepKeyToAddress)
    || (toAsset?.chainFamily === 'evm' && evmAddresses.addresses.some(a => sameAddress(customToAddress, a.address))))
  const externalRecipient = useCustomAddress && !!customToAddress.trim() && !customIsOwn

  const fromChainDef = useMemo(() => (
    fromAsset ? CHAINS.find(c => c.id === fromAsset.chainId) : undefined
  ), [fromAsset])

  const maxAmountReady = isMax && !isNaN(parseFloat(sendAmount)) && parseFloat(sendAmount) > 0
  const enteredAmount = inputMode === 'fiat' ? fiatAmount : amount
  const invalidAmountInput = !isMax && enteredAmount !== '' && normalizeAmountInput(enteredAmount, locale, i18n.language) === null
  const amountTooPrecise = !isMax && canonicalAmount !== null && swapAmountExceedsPrecision(canonicalAmount, fromAmountDecimals)
  const manualAmountReady = !invalidAmountInput && !amountTooPrecise && !!sendAmount && canonicalAmount !== null && Number.isFinite(amountNum) && amountNum > 0
  const validAmount = isMax ? (maxAmountReady && !nativeMaxInsufficient && !tokenMaxInsufficient) : manualAmountReady
  // SAFETY: never quote with an xpub as the destination. Pioneer will accept
  // it and substitute a self-derived address, but funds would land at an
  // address that didn't come from the user's wallet. Wait for the UTXO
  // resolver to populate a real receive address.
  const toAddressIsXpub = !!toAddress && !useCustomAddress && XPUB_RE.test(toAddress)

  const canQuote = !!(fromAsset && toAsset && !networkMismatch && !sameAsset && validAmount && fromAddress && toAddress && !toAddressIsXpub && !exceedsBalance && !exceedsSafeMax && !customAddressError)

  // Human reason a quote can't fire right now, but ONLY for the cases that
  // otherwise render nothing — a missing send/receive address. Conditions that
  // already show their own message (balance, safe-max, same asset, custom
  // address, max-insufficient, invalid amount) are excluded so we don't double
  // up. Non-null ⇒ we're in a silent dead-end the user can recover from.
  const quoteBlockReason = useMemo(() => {
    if (!fromAsset || !toAsset) return null
    if (networkMismatch) return uiText("The asset and network do not match. Select the asset again.")
    if (sameAsset || !validAmount) return null
    if (exceedsBalance || exceedsSafeMax || customAddressError) return null
    if (!fromAddress) return t("resolvingSendAddress", "Preparing your {{symbol}} send address…", { symbol: fromAsset.symbol })
    if (!toAddress && !toAddressIsXpub) return t("resolvingReceiveAddress", "Preparing your {{symbol}} receive address…", { symbol: toAsset.symbol })
    return null
  }, [fromAsset, toAsset, networkMismatch, sameAsset, validAmount, exceedsBalance, exceedsSafeMax, customAddressError, fromAddress, toAddress, toAddressIsXpub, t, uiText])

  // A missing DESTINATION address is the dead-end the manual button can fix by
  // deriving on demand. A missing SOURCE address is a transient that the quote
  // effect re-runs automatically once fromAddress populates (it's in the effect
  // deps), so we show the reason for it but no action button.
  const needsDestAddress = !!quoteBlockReason && !!fromAddress && !toAddress && !toAddressIsXpub && !useCustomAddress

  // Latest output chain id — lets the async manual-quote derivation below detect
  // an output-asset switch that happened during the (up to 60s) address RPC and
  // discard a stale result, so we never write a receive address for the wrong
  // chain (the auto-resolver useEffect has the same guard via a cancel flag).
  const toAssetChainIdRef = useRef<string | undefined>(undefined)
  useEffect(() => { toAssetChainIdRef.current = toAsset?.chainId }, [toAsset])

  // Manual "Get Quote" fallback. The stuck-empty cause is a destination receive
  // address that never resolved (empty balance cache + no resolver for non-UTXO
  // chains). Derive it on demand here, then re-fire the quote effect via
  // requoteTick. A bare requote is not enough — canQuote stays false until the
  // address exists.
  const handleManualQuote = useCallback(async () => {
    if (manualQuoting || !toAsset) return
    const generation = executionUiGeneration.current
    const requestedChainId = toAsset.chainId
    setManualQuoting(true)
    setError(null)
    try {
      if (!toAddress && !useCustomAddress) {
        const toChain = CHAINS.find(c => c.id === toAsset.chainId)
        // EVM addresses come from evmAddresses (cachedToAddress already falls
        // back to them); non-EVM chains derive a receive address from the device.
        if (toChain && toChain.chainFamily !== 'evm') {
          const params: any = { addressNList: toChain.defaultPath, showDisplay: false, coin: toChain.coin }
          if (toChain.scriptType) params.scriptType = toChain.scriptType
          const result = await rpcRequest<any>(toChain.rpcMethod, params, 60000,
            () => generation === executionUiGeneration.current && toAssetChainIdRef.current === requestedChainId)
          // Output asset switched mid-RPC → this address is for the wrong chain.
          if (generation !== executionUiGeneration.current || toAssetChainIdRef.current !== requestedChainId) return
          const addr = typeof result === 'string' ? result : (result?.address || '')
          if (addr) setResolvedToAddress(addr)
        }
        const cached = await rpcRequest<{ balances: ChainBalance[] } | null>('getCachedBalances', undefined, 8000).catch(() => null)
        if (generation !== executionUiGeneration.current || toAssetChainIdRef.current !== requestedChainId) return
        if (cached?.balances) setBalances(cached.balances)
      }
    } catch (e: any) {
      if (generation === executionUiGeneration.current && toAssetChainIdRef.current === requestedChainId) setError(e?.message || t("errorQuote"))
    } finally {
      if (generation === executionUiGeneration.current) {
        setManualQuoting(false)
        setRequoteTick(tick => tick + 1)
      }
    }
  }, [manualQuoting, toAsset, toAddress, useCustomAddress, t])

  // ── Preview-build the unsigned tx(s) when entering Confirm Quote ──
  // Fires once per quote — gives the user the exact payload to audit before
  // clicking Confirm. Build inputs (gas/nonce) may shift slightly between
  // preview and the real execute build; that's expected.
  useEffect(() => {
    // Never build a payload for a quote that is being replaced.
    if (phase !== 'review' || !quote || !fromAsset || !toAsset || refreshingQuote) {
      setPreviewBuild(null); setPreviewError(null); setPreviewLoading(false)
      return
    }
    let cancelled = false
    setPreviewLoading(true); setPreviewError(null); setPreviewBuild(null)
    // A busy KeepKey (often this effect's previous build, still running after a
    // balance tick re-fired it) is waited out behind the loading state, not shown.
    rpcRequest<SwapPreviewBuild>('previewSwapBuild', {
      fromChainId: fromAsset.chainId,
      toChainId: toAsset.chainId,
      fromCaip: fromAsset.caip!,
      toCaip: toAsset.caip!,
      amount: quote.netFromAmount ?? sendAmount,
      memo: quote.memo,
      inboundAddress: quote.inboundAddress,
      router: quote.router,
      expiry: quote.expiry,
      expectedOutput: quote.expectedOutput,
      isMax: quote.netFromAmount ? false : sendIsMax, feeLevel: 5,
      fromAddressOverride: fromAddress,
      toAddressOverride: toAddress,
      fromEvmAddressIndex: fromAsset.chainFamily === 'evm' ? effectiveEvmIndex : undefined,
      integration: quote.integration,
      swapper: quote.swapper,
      relayTx: quote.relayTx,
      // Token sources Pioneer's available-assets doesn't pre-list (e.g. SPL
      // USDT) have no decimals lookup backend-side — carry the picker's value.
      tokenDecimals: isTokenCaip(fromAsset.caip!) ? normalizeDecimals(fromAsset.decimals) ?? undefined : undefined,
    }, undefined, () => !cancelled).then((res) => { if (!cancelled) { setPreviewBuild(res); setPreviewLoading(false) } })
      .catch((e: any) => { if (!cancelled) { setPreviewError(e?.message || 'Preview failed'); setPreviewLoading(false) } })
    return () => { cancelled = true }
  }, [phase, quote, fromAsset, toAsset, sendAmount, sendIsMax, fromBalance, fromAddress, toAddress, effectiveEvmIndex, refreshingQuote])

  const swapRisk = quote?.risk ?? assessSwapRisk({
    inputAmount: Number(quote?.netFromAmount ?? sendAmount), expectedAmount: Number(quote?.expectedOutput),
    minimumAmount: Number(quote?.minimumOutput), fromPriceUsd, toPriceUsd: toPriceUsdFromBalance,
    sameAssetUnits: !!(fromAsset?.caip?.endsWith('/slip44:60') && toAsset?.caip?.endsWith('/slip44:60')
      && fromAsset.chainFamily === 'evm' && toAsset.chainFamily === 'evm'
      && !fromAsset.contractAddress && !toAsset.contractAddress),
  })
  const [riskAcceptedKey, setRiskAcceptedKey] = useState('')
  const riskKey = JSON.stringify({ open, quote, quoteFetchedAt, from: fromAsset?.caip, to: toAsset?.caip, sendAmount, slippageBps, swapRisk })
  const riskAcknowledged = riskAcceptedKey === riskKey
  const riskLocked = swapRisk.blocked || (swapRisk.requiresAcknowledgment && !riskAcknowledged)
  // Relay's order must pay the recipient being reviewed (Bun checks this too).
  const relayRecipientMismatch = !!quote?.relayOrder && !sameAddress(quote.relayOrderRecipient, toAddress)
  // A tolerance above 5% is signed only after an explicit confirmation for this quote (audit v4 V1).
  const slippageNeedsConfirm = !!quote && computeEffectiveSlippageBps(quote.slippageBps, slippageBps) > CONFIRM_SLIPPAGE_BPS
  const slippageKey = JSON.stringify({ open, quoteId: quote?.quoteId, quoteFetchedAt, slippageBps })
  const [slippageAcceptedKey, setSlippageAcceptedKey] = useState('')
  const slippageLocked = slippageNeedsConfirm && slippageAcceptedKey !== slippageKey
  const riskRows = useSwapRiskRows(swapRisk, riskAcknowledged, accepted => setRiskAcceptedKey(accepted ? riskKey : ''))
  const riskPanel = quote && toAsset && riskRows.length ? <PreflightList rows={riskRows} /> : null
  // What the KeepKey shows for the EVM transaction it signs now, screen by
  // screen (shared/eth-device-screens), from the exact transaction Bun hands
  // the device. Null when a ClearSign description goes with it, or for other chains.
  const signingMirror = useMemo(() => {
    const tx = signingTx && ethTxFromBody(signingTx as unknown as Record<string, unknown>, { clearSign: signingTx.clearSign })
    return tx ? ethSignTxMirror(tx) : null
  }, [signingTx])
  // The console fits the window: columns scroll, the decision row stays put.
  const shortWindow = usePreflightShort()
  const leftScroll = usePreflightScroll<HTMLDivElement>()
  const rightScroll = usePreflightScroll<HTMLDivElement>()
  // The panel is as tall as its content; while a quote or a payload is on its
  // way (the placeholder, then the figures) it holds its last settled height.
  const settling = phase === 'quoting' || previewLoading || refreshingQuote
  const settledHeight = useRef<number | null>(null)
  const [heldHeight, setHeldHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (settling) setHeldHeight(h => h ?? settledHeight.current)
    else setHeldHeight(null)
  }, [settling])
  useLayoutEffect(() => {
    if (!settling && heldHeight === null) settledHeight.current = dialogPanel.current?.offsetHeight ?? settledHeight.current
  })

  const auditPayloadReady = !!previewBuild?.unsignedTx
  const previewBalanceBlocked = !!previewBuild?.balance && !previewBuild.balance.sufficient
  const reviewConfirmLocked =
    phase === 'review' && (
      networkMismatch ||
      riskLocked ||
      relayRecipientMismatch ||
      slippageLocked ||
      refreshingQuote ||
      previewLoading ||
      !!previewError ||
      !auditPayloadReady ||
      previewBalanceBlocked
    )
  const reviewConfirmLockLabel =
    networkMismatch ? uiText("The asset and network do not match. Select the asset again.") :
    swapRisk.blocked ? "Route exceeds cost limit" :
    riskLocked ? "Review and acknowledge trade cost" :
    relayRecipientMismatch ? t("relayRecipientMismatchButton", "Relay order pays another address") :
    slippageLocked ? t("highSlippageConfirmButton", "Confirm the high slippage") :
    refreshingQuote ? t("refreshingQuote", "Refreshing quote...") :
    previewLoading ? t("buildingPayload", "Building payload...") :
    previewError ? t("payloadUnavailableButton", "Payload unavailable") :
    !auditPayloadReady ? t("payloadRequiredButton", "Waiting for payload") :
    previewBalanceBlocked ? t("insufficientBalanceButton", "Insufficient balance") :
    null

  // ── Quote fetching ────────────────────────────────────────────────
  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quoteVersionRef = useRef(0)

  useEffect(() => {
    // Don't re-quote when the user is actively reviewing a quote or has submitted/is signing.
    // 'review' is guarded here so balance polling doesn't wipe the quote mid-review;
    // the explicit 60s stale-check in the Confirm handler covers freshness on confirm.
    if (phase === 'review' || phase === 'submitted' || phase === 'signing' || phase === 'broadcasting' || phase === 'approving' || phase === 'blind-signing-required') return
    // A fresh mount resumes a swap in the same commit: `phase` is still 'input' here, and this would wipe the quote the resume just set.
    if (resumeSwap && hasResumedRef.current === resumeSwap.txid) return

    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current)
    setQuote(null)
    const version = ++quoteVersionRef.current
    const generation = executionUiGeneration.current

    if (!canQuote) {
      if (phase === 'quoting') setPhase('input')
      // Surface the two non-obvious reasons canQuote can be false so the user
      // doesn't sit staring at a frozen quote panel.
      if (destAddressError) setError(destAddressError)
      else if (toAddressIsXpub) setError('Resolving destination address from device…')
      return
    }

    setPhase('quoting')
    setError(null)
    setQuoteRetryable(false)

    quoteTimerRef.current = setTimeout(async () => {
      try {
        // CAIP-only — Pioneer Quote keys on CAIP. The picker's SwapAsset
        // always carries .caip (Pioneer-listed entries set it; synthesized
        // entries carry the pioneer-discovery CAIP). If a future code path
        // sets fromAsset without a CAIP, fail loud here rather than letting
        // Pioneer reject with an opaque error downstream.
        if (!fromAsset!.caip || !toAsset!.caip) {
          throw new Error('Selected assets are missing CAIP — pick again from the asset picker')
        }
        // MAX quotes read the device; wait out another request holding it.
        const result = await rpcRequest<SwapQuote>('getSwapQuote', {
          fromCaip: fromAsset!.caip,
          toCaip: toAsset!.caip,
          amount: sendAmount,
          fromAddress,
          toAddress,
          slippageBps,
          isMax: sendIsMax,
          fromEvmAddressIndex: fromAsset!.chainFamily === 'evm' ? effectiveEvmIndex : undefined,
        }, 60000, () => generation === executionUiGeneration.current && version === quoteVersionRef.current)
        if (generation !== executionUiGeneration.current || version !== quoteVersionRef.current) return
        setQuote(result)
        setQuoteFetchedAt(Date.now())
        setPhase('input')
      } catch (e: any) {
        if (generation !== executionUiGeneration.current || version !== quoteVersionRef.current) return
        const msg = e.message || ''
        // Parse common DEX node errors into user-friendly messages
        if (/not enough asset to pay for fees/i.test(msg)) {
          setError(t("swapTooSmallForFees"))
        } else if (/pool.*not available|pool.*staged/i.test(msg)) {
          setError(t("poolNotAvailable"))
        } else if (/amount less than min swap amount/i.test(msg)) {
          // THORNode rejects with `recommended_min_amount_in: <int>` where the
          // integer is in THORChain's 8-decimal internal units regardless of
          // the source chain's native decimals. Convert to the source-asset
          // human form so the user sees something they can act on.
          const minMatch = msg.match(/recommended_min_amount_in:\s*(\d+)/i)
          if (minMatch && fromAsset) {
            const minThorBaseUnits = BigInt(minMatch[1])
            const minHumanReadable = (Number(minThorBaseUnits) / 1e8).toFixed(4)
            setError(t("amountBelowMinimum", { min: minHumanReadable, symbol: fromAsset.symbol }))
          } else {
            setError(t("amountBelowMinimumGeneric"))
          }
        } else if (/request timed out/i.test(msg)) {
          // Pioneer/DEX was slow to respond — a transient failure with still-valid
          // params, so mark it retryable: the input-phase error block then shows a
          // Retry button that re-fires the quote via requoteTick.
          setError(t("quoteTimedOut", "Quote request timed out — the swap service is taking too long to respond. Tap Retry to try again."))
          setQuoteRetryable(true)
        } else {
          setError(msg || t("errorQuote"))
        }
        setPhase('input')
      }
    }, 800)

    return () => {
      if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current)
    }
  }, [fromAsset?.caip, toAsset?.caip, networkMismatch, sendAmount, sendIsMax, fromAddress, toAddress, exceedsBalance, fromBalance, slippageBps, requoteTick, destAddressError, toAddressIsXpub, effectiveEvmIndex])

  // ── Flip ──────────────────────────────────────────────────────────
  const handleFlip = useCallback(() => {
    const prev = fromAsset
    setFromAsset(toAsset)
    setToAsset(prev)
    setAmount("")
    setFiatAmount("")
    setIsMax(false)
    setMaxReserveMode('safe')
    setQuote(null)
    setPhase('input')
    setError(null)
  }, [fromAsset, toAsset])

  const handleBackToInput = useCallback(() => {
    executionUiGeneration.current++
    setRefreshingQuote(false)
    setManualQuoting(false)
    setQuote(null)
    setPhase('input')
    setError(null)
    setQuoteRetryable(false)
    setRequoteTick(tick => tick + 1)
  }, [])

  // ── Execute swap ──────────────────────────────────────────────────
  const handleExecuteSwap = useCallback(async () => {
    if (!quote || !fromAsset || !toAsset) return
    if (networkMismatch) { setError(uiText("The asset and network do not match. Select the asset again.")); return }
    const generation = executionUiGeneration.current
    if (riskLocked) { setError(swapRisk.blocked ? 'This route exceeds the 5% cost limit for trades of $1,000 or more.' : 'Review and acknowledge the trade cost before signing.'); return }
    if (relayRecipientMismatch) { setError(t("relayRecipientMismatch", "Relay's order does not pay the recipient shown. Do not proceed — get a new quote.")); return }
    if (slippageLocked) { setError(t("highSlippageConfirmRequired", "Confirm the high slippage tolerance before signing.")); return }
    if (phase === 'review') {
      if (previewLoading) {
        setError(t("payloadStillBuilding", "Transaction payload is still building. Review it before confirming."))
        return
      }
      if (previewError) {
        setError(t("payloadBuildFailed", "Transaction payload is not available: {{error}}", { error: previewError }))
        return
      }
      if (!previewBuild?.unsignedTx) {
        setError(t("payloadRequired", "Transaction payload is required before confirming."))
        return
      }
      if (previewBuild.balance && !previewBuild.balance.sufficient) {
        setError(t("insufficientBalanceButton", "Insufficient balance"))
        return
      }
    }
    const isErc20 = fromAsset.chainFamily === 'evm' && !!fromAsset.contractAddress

    // Replace an aged quote for one more review — protects against price drift
    // between when the user saw the numbers and when the swap is signed.
    const refreshForReview = async () => {
      setRefreshingQuote(true)
      try {
        const refreshed = await rpcRequest<SwapQuote>('getSwapQuote', {
          fromCaip: fromAsset.caip!,
          toCaip: toAsset.caip!,
          amount: sendAmount,
          fromAddress, toAddress, slippageBps,
          isMax: sendIsMax,
          fromEvmAddressIndex: fromAsset.chainFamily === 'evm' ? effectiveEvmIndex : undefined,
        }, 60000, () => generation === executionUiGeneration.current)
        if (generation !== executionUiGeneration.current) return
        // Call out a >1% output drop — quote degraded, user should re-review the numbers
        const oldOut = parseFloat(quote.expectedOutput || '0')
        const newOut = parseFloat(refreshed.expectedOutput || '0')
        const dropped = oldOut > 0 && newOut > 0 && (oldOut - newOut) / oldOut > 0.01
        const dropPct = (((oldOut - newOut) / oldOut) * 100).toFixed(2)
        if (dropped) console.warn(`[swap] Quote refreshed: output ${oldOut} → ${newOut} (-${dropPct}%) — aborting for re-review`)
        setQuote(refreshed)
        setQuoteFetchedAt(Date.now())
        setPreviewBuild(null)
        setError(dropped
          ? t("quoteShiftedReReview", "Quote refreshed and dropped {{pct}}% — please review the new numbers and confirm again", { pct: dropPct })
          : t("quoteRefreshedReviewPayload", "Quote refreshed. Review the rebuilt payload before confirming."))
      } catch (e: any) {
        if (generation !== executionUiGeneration.current) return
        setError(`Failed to refresh stale quote: ${e?.message || 'unknown error'}`)
      } finally {
        if (generation === executionUiGeneration.current) setRefreshingQuote(false)
      }
    }
    let liveQuote: SwapQuote = quote
    const age = Date.now() - (quoteFetchedAt || 0)
    if (age > swapRisk.quoteMaxAgeMs || (quote.quoteExpiresAt != null && Date.now() >= quote.quoteExpiresAt)) {
      await refreshForReview()
      return
    }

    setPhase(isErc20 ? 'approving' : 'signing')
    setError(null)

    // Freeze the sent amount so balance changes don't affect the display
    setSentAmount(liveQuote.netFromAmount ?? sendAmount)

    // Capture before-balances
    const fromBal = fromBalance || '0'
    setBeforeFromBal(fromBal)
    const toCb = balances.find(b => b.chainId === toAsset.chainId)
    if (toCb) {
      if (toAsset.contractAddress && toCb.tokens) {
        const tok = toCb.tokens.find(t => t.contractAddress?.toLowerCase() === toAsset.contractAddress?.toLowerCase())
        setBeforeToBal(tok?.balance || '0')
      } else {
        setBeforeToBal(toCb.balance)
      }
    } else {
      setBeforeToBal('0')
    }

    // A busy refusal happens before dispatch (no quote claimed, nothing signed):
    // wait for the KeepKey. Cancel (handleCancelSigning) ends the wait.
    const attempt = ++executeAttempt.current
    try {
      const result = await rpcRequest<{ txid: string; approvalTxid?: string }>('executeSwap', {
        quoteId: liveQuote.quoteId,
        riskAcknowledged,
        slippageAcknowledged: slippageNeedsConfirm && !slippageLocked,
        fromChainId: fromAsset.chainId,
        toChainId: toAsset.chainId,
        fromCaip: fromAsset.caip!,
        toCaip: toAsset.caip!,
        amount: sendAmount,
        memo: liveQuote.memo,
        inboundAddress: liveQuote.inboundAddress,
        router: liveQuote.router,
        expiry: liveQuote.expiry,
        expectedOutput: liveQuote.expectedOutput,
        isMax: sendIsMax,
        feeLevel: 5,
        fromAddressOverride: fromAddress,
        toAddressOverride: toAddress,
        fromEvmAddressIndex: fromAsset.chainFamily === 'evm' ? effectiveEvmIndex : undefined,
        integration: liveQuote.integration,
        swapper: liveQuote.swapper,
        relayTx: liveQuote.relayTx,
        // Same as the preview build: synthesized token sources need the
        // picker's decimals — Pioneer's available-assets won't have them.
        tokenDecimals: isTokenCaip(fromAsset.caip!) ? normalizeDecimals(fromAsset.decimals) ?? undefined : undefined,
        // A provider description only from the one this preview card named.
        runtimeProvider: previewBuild?.runtimeProvider ?? null,
      }, 600000, () => generation === executionUiGeneration.current && attempt === executeAttempt.current)

      if (generation === executionUiGeneration.current) {
        setTxid(result.txid)
        setLiveCreatedAt(Date.now())
        setPhase('submitted')
      }
      // A custom tolerance is for one swap; presets stay (audit v4 V1).
      setSlippageBps(slippageAfterSwap(slippageBps))
      window.dispatchEvent(new CustomEvent('keepkey-swap-executed', {
        detail: {
          txid: result.txid,
          fromChainId: fromAsset.chainId,
          toChainId: toAsset.chainId,
          fromCaip: fromAsset.caip,
          toCaip: toAsset.caip,
          fromSymbol: fromAsset.symbol,
          toSymbol: toAsset.symbol,
          expectedOutput: liveQuote.expectedOutput,
          // Custom destinations intentionally leave the connected wallet. Do
          // not wait for an output that should never appear in its portfolio.
          isWalletDestination: !useCustomAddress,
        },
      }))
    } catch (e: any) {
      if (generation !== executionUiGeneration.current) return
      // Cancelled while waiting for a busy KeepKey: handleCancelSigning owns the dialog.
      if (attempt !== executeAttempt.current && isDeviceBusyError(e)) return
      const raw = e?.message || ''
      // The quote aged out before the swap signature (an approval before it carries
      // no rate and still signs): fetch a fresh quote for one more review.
      if (/quote (?:has )?expired/i.test(raw)) {
        setPhase('review')
        await refreshForReview()
        return
      }
      // This exact Relay payload has no signed ClearSign descriptor and needs
      // route-specific, one-request opaque consent.
      if (raw.includes(SOLANA_BLIND_SIGNING_REQUIRED)) {
        setBlindSignError(null)
        setBlindSignCause('host')
        setQuoteFetchedAt(0)
        // The backend appends a host-side outflow check (what this transaction
        // actually moves out of the wallet, per an independent RPC simulation).
        // Absent or unparseable → the panel just omits the figures.
        try {
          const json = raw.slice(raw.indexOf(SOLANA_BLIND_SIGNING_REQUIRED) + SOLANA_BLIND_SIGNING_REQUIRED.length).trim()
          setOutflowCheck(json ? JSON.parse(json) : null)
        } catch { setOutflowCheck(null) }
        setPhase('blind-signing-required')
        return
      }
      // The DEVICE refused: firmware requires its AdvancedMode policy for any
      // transaction it cannot verify. Which transactions those are is
      // firmware-specific, so we react to the refusal rather than predicting
      // it — correct on every version, old and new.
      if (/AdvancedMode/i.test(raw)) {
        setBlindSignError(null)
        setBlindSignCause('device')
        setQuoteFetchedAt(0)
        setOutflowCheck(null)
        setPhase('blind-signing-required')
        return
      }
      // User-friendly categorization. Order: device-rejected first (most common during sign), then on-chain reverts, then network/RPC.
      let friendly = raw || t("errorSwap")
      // Firmware fails a schema it cannot verify outright and never degrades to
      // blind signing (fsm_msg_solana.h). Verification needs a signer loaded in
      // RAM. The backend now withholds the schema when AdvancedMode is off, so
      // reaching here means AdvancedMode is ON but no signer is armed for this
      // session -- which the raw message blames on the transaction instead.
      if (/Invalid Solana instruction schema/i.test(raw)) {
        friendly = t("solanaSchemaUnverified",
          "Clear-signing isn't armed on this device this session, so it couldn't verify the swap details. Load the ClearSign signer in Settings, then try again.")
      } else if (/User rejected|user denied|device.*reject/i.test(raw)) {
        friendly = t("deviceRejected", "Cancelled on device — no transaction was sent")
      } else if (/Review timed out|review timeout/i.test(raw)) {
        friendly = t("reviewTimeout", "Review timed out — no transaction was sent")
      } else if (/User rejected the transaction/i.test(raw)) {
        friendly = t("userRejectedTx", "You rejected the transaction. No funds moved.")
      } else if (/reverted on-chain/i.test(raw)) {
        friendly = t("approvalReverted", "Approval reverted on-chain — swap aborted to protect funds")
      } else if (/Insufficient.*for gas|insufficient funds/i.test(raw)) {
        friendly = t("insufficientGas", "Not enough gas in the source chain's native asset")
      } else if (/OP_RETURN.*(?:character count|too .* high)|memo is too long/i.test(raw)) {
        friendly = t("swapMemoTooLong", "This route returned a memo that is too long for the source chain. Refresh the quote or choose another route.")
      } else if (/nonce|fetch nonce/i.test(raw)) {
        friendly = t("nonceError", "Network error fetching nonce — retry in a moment")
      } else if (/timed out|ETIMEDOUT|fetch failed|network/i.test(raw)) {
        friendly = t("networkErrorSwap", "Network error — retry in a moment")
      }
      setError(friendly)
      setPhase('review')
      // Any device attempt may have signed even when its response was lost.
      // Require a fresh quote and review before another execute request.
      setQuoteFetchedAt(0)
    }
  }, [quote, quoteFetchedAt, fromAsset, toAsset, sendAmount, sendIsMax, fromBalance, fromAddress, toAddress, slippageBps, balances, phase, previewLoading, previewError, previewBuild, useCustomAddress, networkMismatch, uiText, riskLocked, riskAcknowledged, swapRisk.blocked, swapRisk.quoteMaxAgeMs, effectiveEvmIndex, relayRecipientMismatch, slippageLocked, slippageNeedsConfirm, setSlippageBps])

  // ── Reset ─────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    executionUiGeneration.current++
    setRefreshingQuote(false)
    setManualQuoting(false)
    setRechecking(false)
    setPhase('input')
    setFromAsset(null)
    setToAsset(null)
    setAmount("")
    setFiatAmount("")
    setInputMode('crypto')
    setIsMax(false)
    setMaxReserveMode('safe')
    setQuote(null)
    setError(null)
    setBlindSignError(null)
    setEnablingBlindSign(false)
    setTxid(null)
    setBeforeFromBal(null)
    setBeforeToBal(null)
    setAfterFromBal(null)
    setAfterToBal(null)
    setShowConfetti(false)
    setSentAmount(null)
    completionFiredRef.current = false
    hasAutoSelected.current = false
    hasResumedRef.current = null
    prevAutoDefaultAsset.current = null
    setUseCustomAddress(false)
    setCustomToAddress("")
    setQuoteDetailsOpen(false)
  }, [])

  const handleClose = useCallback(() => {
    onClose()
    // Closing hides the view. Bun owns execution, its lease and saved receipt.
    // Do not reset state still used by a pending execution callback.
    if (!['signing', 'broadcasting', 'approving'].includes(phase)) reset()
  }, [phase, onClose, reset])

  // Cancel a confirm-on-device prompt and back out to review. Sends a Cancel
  // message to the device (frees the transport lock + dismisses the on-screen
  // prompt), then resets the dialog to 'review' so the user can change inputs
  // or just close. Broadcasting can NOT be cancelled — the signed tx is
  // already on its way to the network and there's no unwind.
  const handleCancelSigning = useCallback(async () => {
    if (phase !== 'signing' && phase !== 'approving') return
    executeAttempt.current++ // stops a wait for a busy KeepKey before it dispatches
    const generation = executionUiGeneration.current
    try { await rpcRequest<{ ok: boolean }>('cancelForegroundDeviceOperation', undefined, 5000) } catch (e: any) {
      console.warn('[SwapDialog] cancelForegroundDeviceOperation failed:', e?.message || e)
    }
    if (generation !== executionUiGeneration.current) return
    setPhase('review')
    setQuoteFetchedAt(0)
    setError(t('swapCancelled', 'Swap cancelled — confirm again or change inputs'))
  }, [phase, t])

  // Turn on the device's AdvancedMode (Blind Signing) policy. Shipped firmware
  // has no per-transaction exception, so EVM and Solana alike sign only once
  // the policy is on. It is session state on 7.15+: the device disarms it when
  // it locks or is unplugged, so the user may be asked again.
  const handleEnableBlindSigning = useCallback(async () => {
    const generation = executionUiGeneration.current
    setEnablingBlindSign(true)
    setBlindSignError(null)
    try {
      // 0 = no timeout: this blocks on an on-device confirm AND a full
      // scrambled-matrix PIN re-entry (the device ignores the session cache).
      // A timeout could reject while the device still completes the write,
      // leaving the policy ON while the UI claims it failed.
      await rpcRequest('applyPolicy', { policyName: 'AdvancedMode', enabled: true }, 0)
    } catch (e: any) {
      if (generation !== executionUiGeneration.current) return
      const msg = e?.message || ''
      setBlindSignError(/cancel|denied|rejected/i.test(msg)
        ? t('blindSignDeclined', 'Declined on device — blind signing was not enabled.')
        : (msg || t('blindSignEnableFailed', 'Failed to enable blind signing on the device.')))
      setEnablingBlindSign(false)
      return
    }
    if (generation !== executionUiGeneration.current) return
    setError(null)
    setPhase('review')
    setEnablingBlindSign(false)
  }, [t])

  const copyTxid = useCallback(() => {
    if (!txid) return
    navigator.clipboard.writeText(txid)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
      .catch(() => {})
  }, [txid])

  const formatTime = useCallback((seconds: number) => {
    if (seconds < 60) return `~${seconds}${t("seconds")}`
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return secs > 0 ? `~${mins}${t("minutes")} ${secs}${t("seconds")}` : `~${mins}${t("minutes")}`
  }, [t])

  const busy = phase === 'approving' || phase === 'signing' || phase === 'broadcasting'
  const displayAmount = sentAmount ?? quotedSendAmount

  // Must be above early return to satisfy Rules of Hooks
  const swappableChainIds = useMemo(() => new Set(assets.map(a => a.chainId)), [assets])

  // ── Swap UI state mirror (publishes to Bun for /api/v2/swap/state) ──
  // Fire-and-forget on every meaningful state change. Bun caches the latest.
  // Why useRef + JSON: avoids spamming Bun when an unrelated render happens.
  const lastPublishedRef = useRef<string>('')
  useEffect(() => {
    if (!open) return
    const snapshot: SwapUiState = {
      phase: phase as SwapUiState['phase'],
      fromAsset: fromAsset?.asset ?? null,
      toAsset: toAsset?.asset ?? null,
      amount: sentAmount !== null && (busy || phase === 'submitted') ? sentAmount : amount,
      fiatAmount,
      inputMode,
      isMax,
      slippageBps,
      fromAddress,
      toAddress,
      useCustomAddress,
      customToAddress,
      quote,
      previewBuild,
      error,
      txid,
      trackingStatus: phase === 'submitted' ? liveStatus : null,
      confirmations: liveConfirmations,
      outboundConfirmations: liveOutboundConfirmations,
      outboundRequiredConfirmations: liveOutboundRequired,
      outboundTxid: liveOutboundTxid ?? null,
      relayRequestId: liveRelayRequestId ?? null,
      refundReason: liveRefundReason ?? null,
    }
    const serialized = JSON.stringify(snapshot)
    if (serialized === lastPublishedRef.current) return
    lastPublishedRef.current = serialized
    rpcFire('publishSwapUiState', snapshot)
  }, [open, phase, busy, sentAmount, fromAsset?.asset, toAsset?.asset, amount, fiatAmount, inputMode, isMax, slippageBps, fromAddress, toAddress, useCustomAddress, customToAddress, quote, previewBuild, error, txid, liveStatus, liveConfirmations, liveOutboundConfirmations, liveOutboundRequired, liveOutboundTxid, liveRelayRequestId, liveRefundReason])

  // Retained tracker dialogs also close without unmounting. Hidden instances
  // that never opened must not overwrite another dialog's active snapshot.
  useEffect(() => {
    if (!open) return
    return () => {
      lastPublishedRef.current = ''
      rpcFire('publishSwapUiState', {
        phase: 'closed', fromAsset: null, toAsset: null, amount: '', fiatAmount: '',
        inputMode: 'crypto', isMax: false, slippageBps: 100,
        fromAddress: '', toAddress: '', useCustomAddress: false, customToAddress: '',
        quote: null, previewBuild: null, error: null, txid: null,
        trackingStatus: null, confirmations: 0,
        outboundConfirmations: undefined, outboundRequiredConfirmations: undefined,
        outboundTxid: null, relayRequestId: null, refundReason: null,
      } satisfies SwapUiState)
    }
  }, [open])

  // ── Listen for swap-cmd messages (REST → UI control) ───────────────
  // 'open' is handled by SwapRpcMount before we mount; here we just treat
  // it as additional setters in case a second open arrives while we're up.
  //
  // Asset lookups (fromAsset/toAsset) accept either the THORChain-style
  // string ("ETH.ETH") or the CAIP ("eip155:1/slip44:60"). Pending lookups
  // race against the async asset list load — buffer them in a ref and drain
  // on the assets-loaded effect below so REST seeds don't get silently
  // dropped on first mount.
  const pendingFromAssetKeyRef = useRef<string | null>(null)
  const pendingToAssetKeyRef = useRef<string | null>(null)

  const findAssetByKey = useCallback((key: string) => {
    return assets.find(x => x.asset === key || x.caip === key)
  }, [assets])

  useEffect(() => {
    if (!open) return
    const apply = (cmd: SwapUiCommand) => {
      // Recheck in the mounted dialog as well: signing may begin between the
      // REST snapshot check and delivery of this command to the renderer.
      if (blocksSwapUiCommand(phase, cmd.kind)) return
      if (cmd.kind === 'close') { handleClose(); return }
      if (cmd.kind === 'requote') { setRequoteTick(t => t + 1); return }
      if (cmd.kind === 'advance') {
        // input → review (UI navigation only; signing still requires user button press)
        if (quote && fromAsset && toAsset) setPhase('review')
        return
      }
      if (cmd.kind === 'confirm') {
        // Click "Confirm Swap" — kicks off executeSwap. The TxReview gate
        // and the physical device button press still happen normally.
        // Mirror the on-screen button's preflight gate: refuse to advance
        // unless the preview build succeeded and balance is sufficient,
        // so REST callers can't bypass the UI's "preview failed" lock and
        // sign a tx the chain will reject.
        const insufficientBalance = !!(previewBuild?.balance && !previewBuild.balance.sufficient)
        const previewBlocked = previewLoading || !!previewError || !previewBuild?.unsignedTx || insufficientBalance
        if (phase === 'review' && quote && fromAsset && toAsset && !previewBlocked) {
          handleExecuteSwap()
        }
        return
      }
      // Both 'open' and 'set' carry the same partial-update fields below.
      if (!['fromAsset', 'toAsset', 'amount', 'isMax', 'inputMode', 'useCustomAddress', 'customToAddress', 'slippageBps']
        .some(key => Object.prototype.hasOwnProperty.call(cmd, key))) return
      // Even an idempotent edit must restart a quote invalidated by the new
      // context; merely bumping its generation could leave it quoting forever.
      handleBackToInput()
      const fields = cmd
      if ('fromAsset' in fields && fields.fromAsset !== undefined) {
        const a = fields.fromAssetDefinition || findAssetByKey(fields.fromAsset)
        if (a) { setFromAsset(a); setMaxReserveMode('safe') }
        else pendingFromAssetKeyRef.current = fields.fromAsset
      }
      if ('toAsset' in fields && fields.toAsset !== undefined) {
        const a = fields.toAssetDefinition || findAssetByKey(fields.toAsset)
        if (a) setToAsset(a)
        else pendingToAssetKeyRef.current = fields.toAsset
      }
      if ('amount' in fields && fields.amount !== undefined) {
        setAmount(fields.amount); setIsMax(false); setMaxReserveMode('safe')
      }
      if ('isMax' in fields && fields.isMax !== undefined) {
        setIsMax(fields.isMax)
        if (fields.isMax) setMaxReserveMode('safe')
      }
      if ('inputMode' in fields && fields.inputMode !== undefined) setInputMode(fields.inputMode)
      if ('useCustomAddress' in fields && fields.useCustomAddress !== undefined) setUseCustomAddress(fields.useCustomAddress)
      if ('customToAddress' in fields && fields.customToAddress !== undefined) setCustomToAddress(fields.customToAddress)
      if ('slippageBps' in fields && fields.slippageBps !== undefined) setSlippageBps(fields.slippageBps)
    }
    return onRpcMessage('swap-cmd', apply)
  }, [open, assets, handleClose, handleBackToInput, setSlippageBps, phase, quote, fromAsset, toAsset, handleExecuteSwap, findAssetByKey, previewBuild, previewError, previewLoading])

  // Drain any seed keys that arrived before the asset list finished loading.
  // Without this, REST `/swap/open` silently lost fromAsset/toAsset on first
  // mount because the async assets fetch hadn't populated yet.
  useEffect(() => {
    if (assets.length === 0) return
    if (pendingFromAssetKeyRef.current) {
      const a = findAssetByKey(pendingFromAssetKeyRef.current)
      if (a) { setFromAsset(a); setMaxReserveMode('safe'); pendingFromAssetKeyRef.current = null }
    }
    if (pendingToAssetKeyRef.current) {
      const a = findAssetByKey(pendingToAssetKeyRef.current)
      if (a) { setToAsset(a); pendingToAssetKeyRef.current = null }
    }
  }, [assets, findAssetByKey])

  const dialogPanel = useRef<HTMLDivElement>(null)
  const unsupported = !!(chain && !resumeSwap && !loadingAssets && assets.length > 0 && !swappableChainIds.has(chain.id))
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = dialogPanel.current
    return () => {
      const focused = document.activeElement
      if (opener?.isConnected && (focused === document.body || (focused && panel?.contains(focused)))) opener.focus()
    }
  }, [open])
  useEffect(() => { if (open) dialogPanel.current?.focus() }, [open, unsupported])
  const dialogKeys = (event: React.KeyboardEvent) => {
    // The picker, health details and device overlays own their own focus/keys.
    if (event.defaultPrevented || pickerSide !== null) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (healthDialogOpen) setHealthDialogOpen(false)
      else if (quoteDetailsOpen) setQuoteDetailsOpen(false)
      else if (customSlippageOpen) setCustomSlippageOpen(false)
      else handleClose()
    }
    if (event.key !== 'Tab' || healthDialogOpen || quoteDetailsOpen) return
    const nodes = [...(dialogPanel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || [])].filter(n => n.offsetParent !== null && n.getClientRects().length)
    const first = nodes[0], last = nodes[nodes.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogPanel.current)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogPanel.current)) { event.preventDefault(); first?.focus() }
  }

  if (!open) return null
  if (unsupported) {
    return (
      <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="flex-start" justifyContent="center" pt="5vh" onKeyDown={dialogKeys}>
        <Box position="absolute" inset="0" bg="rgba(11,11,14,0.72)" backdropFilter="blur(20px) saturate(140%)" onClick={busy || phase === 'submitted' ? undefined : handleClose} data-testid="swap-backdrop" />
        <Box ref={dialogPanel} role="dialog" aria-modal="true" aria-label={t('title')} tabIndex={-1}
          position="relative"
          borderRadius="22px"
          border="1px solid rgba(255,255,255,0.10)"
          p="6"
          w="400px"
          maxW="90vw"
          textAlign="center"
          style={{
            backgroundColor: "rgba(16,16,21,0.97)",
            backgroundImage: "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015))",
            backdropFilter: "blur(32px) saturate(160%)",
            WebkitBackdropFilter: "blur(32px) saturate(160%)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.06), 0 24px 60px -16px rgba(0,0,0,0.8), 0 4px 12px -4px rgba(0,0,0,0.5)",
          }}
        >
          {/* No provider badge: the swappable-asset list is a union across
              providers (THORChain, Maya, Relay, …), so a missing asset is not
              any single provider's limitation. */}
          <Text fontSize="sm" color="kk.textMuted">{t("notSupported", { coin: chain?.coin })}</Text>
          <Text fontSize="xs" color="kk.textMuted" mt="2" opacity={0.75}>
            {t("notSupportedHint", "Routes come from our swap providers and change over time — this asset may become available later.")}
          </Text>
          <Button size="sm" mt="4" variant="ghost" color="kk.textSecondary" px="4" py="2" onClick={handleClose}>{t("close")}</Button>
        </Box>
      </Box>
    )
  }

  // Top-anchored, not vertically centred: the panel grows as the quote,
  // warnings and fees arrive, and a centred panel moved up by that much
  // (Jasper, 1.6.11: 49 px over three steps), so a click aimed at a control
  // could land on another one. Anchored near the top, it only grows downward,
  // and never past the window: the console's columns scroll inside it while
  // its decision row stays on screen.
  const consoleView = !loadingAssets && (
    ((phase === 'input' || phase === 'quoting') && !assetLoadError) ||
    (phase === 'review' && !!quote && !!fromAsset && !!toAsset && !busy) ||
    (busy && !!fromAsset && !!toAsset))
  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" p="16px" onKeyDown={dialogKeys}>
      <style>{DIALOG_CSS}</style>
      <PreflightStyles />
      <Box position="absolute" inset="0" bg="rgba(11,11,14,0.72)" backdropFilter="blur(20px) saturate(140%)" onClick={busy || phase === 'submitted' ? undefined : handleClose} data-testid="swap-backdrop" />
      <Box ref={dialogPanel} role="dialog" aria-modal="true" aria-label={t('title')} tabIndex={-1} data-swap-panel
        position="relative"
        borderRadius="18px"
        w={consoleView ? "min(980px, 94vw)" : isSwapComplete && phase === 'submitted' ? "1040px" : "760px"}
        maxW="94vw"
        // Centred like every preflight dialog, as tall as its content. While a
        // quote or a payload is arriving it keeps the height it had, so the
        // panel (and the control under the pointer) does not jump; only the
        // columns scroll past the cap.
        minH={heldHeight ? `${heldHeight}px` : undefined}
        maxH="calc(100vh - 32px)"
        display="flex"
        flexDirection="column"
        overflow="hidden"
        onClick={(e) => e.stopPropagation()}
        style={{
          animation: 'kkSwapFadeIn 0.2s ease-out',
          // The preflight console's own surface (one surface, no nested cards).
          backgroundColor: "#0b0b0e",
          backgroundImage: "radial-gradient(120% 80% at 0% 0%, rgba(233,196,106,.10), transparent 55%), radial-gradient(90% 70% at 100% 100%, rgba(98,126,234,.07), transparent 60%)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,.06), 0 30px 80px -30px rgba(0,0,0,.8)",
        }}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <Flex px="22px" pt="14px" pb={consoleView ? "0" : "10px"} align="center" justify="space-between" gap="3" flexShrink={0}>
          <HStack gap="2.5" align="center" minW="0">
            {!consoleView && <ProviderBadge swapper={quote?.swapper || liveSwapper || quote?.integration} size={22} variant="compact" />}
            <span className="kk-pf-kicker">
              {phase === 'review' ? uiText("Review swap") : phase === 'submitted' ? t("swapSubmitted") : phase === 'blind-signing-required' ? t("blindSignHeader", "Blind Signing") : t("title")}
            </span>
            {/* Provider health — ascending wifi-style bars (the worst status
                sets the colour). Click for the per-provider detail dialog. */}
            {swapHealth && (() => {
              const { color, bars: activeBars, label } = swapHealthSummary(swapHealth)
              const heights   = [4, 7, 10, 13]
              return (
                <Box
                  as="button"
                  display="inline-flex"
                  alignItems="flex-end"
                  gap="2px"
                  px="1.5"
                  py="1"
                  borderRadius="md"
                  cursor="pointer"
                  bg="transparent"
                  _hover={{ bg: 'rgba(255,255,255,0.06)' }}
                  border="0"
                  title={label}
                  onClick={() => setHealthDialogOpen(true)}
                  className="electrobun-webkit-app-region-no-drag"
                  aria-label={label}
                >
                  {heights.map((h, i) => {
                    const active = i < activeBars
                    return <Box key={i} w="3px" h={`${h}px`} borderRadius="1px" bg={active ? color : 'rgba(255,255,255,0.10)'} />
                  })}
                </Box>
              )
            })()}
          </HStack>
          <HStack gap={{ base: "1", md: "3" }} align="center">
            <DocsLink href={DOCS_LINKS.swap} />
            <DocsLink href={watch('course-07-swap')} label={uiText("Watch video")} display={{ base: "none", sm: "inline-flex" }} />
            <Button size="sm" variant="ghost" color="kk.textSecondary" w="36px" h="36px" minW="36px" p="0" flexShrink={0}
              aria-label={uiText('Close swap')} title={busy ? uiText('Closing this view does not cancel the swap. Track it in Activity.') : uiText('Close swap')}
              _hover={{ color: 'kk.textPrimary', bg: 'whiteAlpha.100' }} onClick={handleClose}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </Button>
          </HStack>
        </Flex>

        {/* ── Body ────────────────────────────────────────────────── */}
        {/* The console phases (form, review, signing) are a preflight console
            that fits the panel; the other phases scroll in a padded body.
            Padding is zeroed on the complete-swap view so the 2-column
            hero/details layout reaches the modal edges. */}
        <Box
          flex="1 1 auto"
          minH="0"
          display={consoleView ? "flex" : "block"}
          flexDirection="column"
          overflowY={consoleView ? "hidden" : "auto"}
          px={consoleView || (isSwapComplete && phase === 'submitted') ? "0" : "5"}
          py={consoleView || (isSwapComplete && phase === 'submitted') ? "0" : "3"}
        >
          {/* Loading state */}
          {loadingAssets && (
            <Box py="8" textAlign="center">
              <Spinner size="md" color="kk.gold" mb="3" />
              <Text fontSize="sm" color="kk.textMuted">{t("loadingAssets")}</Text>
            </Box>
          )}

          {/* Error state — Pioneer unreachable or no assets */}
          {!loadingAssets && assetLoadError && phase === 'input' && (
            <VStack gap="3" py="6" textAlign="center">
              <Box w="48px" h="48px" borderRadius="full" bg="rgba(233,196,106,0.1)" display="flex" alignItems="center" justifyContent="center" mx="auto">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </Box>
              <Text fontSize="sm" color="kk.textSecondary">{assetLoadError}</Text>
              <Flex gap="2">
                <Button size="sm" variant="outline" color="kk.textSecondary" borderColor="kk.border"
                  px="4" py="2" _hover={{ bg: "rgba(255,255,255,0.06)" }}
                  onClick={() => { setLoadingAssets(true); setAssetLoadError(null); rpcRequest<SwapAsset[]>('getSwapAssets', undefined, 20000).then(r => { setAssets(r); setLoadingAssets(false); if (!r?.length) setAssetLoadError('No swap assets available') }).catch(e => { setLoadingAssets(false); setAssetLoadError(e?.message || 'Failed to load') }) }}>{uiText("Retry")}</Button>
                <Button size="sm" variant="ghost" color="kk.textMuted" px="4" py="2" onClick={handleClose}>
                  {t("close")}
                </Button>
              </Flex>
            </VStack>
          )}

          {phase === 'submitted' && toAsset && livePayouts.length > 0 && (
            <Box p="4" m="3" border="1px solid var(--teal)" borderRadius="lg">
              <Text fontSize="13px" fontWeight="700">{isSwapComplete ? uiText("Settlement payouts") : payoutMeetsMinimum ? uiText("Payout received — confirming settlement") : uiText("Partial payout — settlement still in progress")}</Text>
              <Text fontSize="12px" color="var(--teal)" mt="1">{uiText("Total reported received:")}{" "}{liveReceivedOutput || '0'} {toAsset.symbol}</Text>
              {!isSwapComplete && !payoutMeetsMinimum && quote && <Text fontSize="11px" color="kk.textMuted" mt="1">{uiText("Still expected: approximately")}{" "}{formatBalance(String(Math.max(0, Number(quote.expectedOutput) - Number(liveReceivedOutput || 0))))} {toAsset.symbol}{uiText(". A partial payment is not the final swap output.")}</Text>}
              {livePayouts.map((payout, index) => <Flex key={`${payout.txid}-${index}`} justify="space-between" mt="2" gap="3">
                <Text fontSize="11px">{uiText("Payment")}{" "}{index + 1}: {payout.amount} {toAsset.symbol}</Text>
                <Box as="button" fontSize="11px" color="var(--teal)" textDecoration="underline" onClick={() => {
                  const url = getExplorerTxUrl(liveOutboundChainId || toAsset.chainId, payout.txid)
                  if (url) rpcRequest('openUrl', { url }).catch(() => {})
                }}>{uiText("View transaction")}</Box>
              </Flex>)}
              <Text fontSize="10px" color="kk.textMuted" mt="2">{uiText("Reported by the settlement protocol. Explorer indexing and wallet balances can update later.")}</Text>
            </Box>
          )}

          {/* ── SUBMITTED — live tracking with step progress ──── */}
          {phase === 'submitted' && txid && fromAsset && toAsset && (
            isSwapComplete ? (
              /* ── COMPLETE: wide 2-column hero/details layout ─────
                 Modal widens to 1040px (see outer Box). Hero on the left
                 anchors the mascot at 248px inside three concentric pulse
                 rings; details on the right surface the headline result
                 and tuck tx hashes + balance deltas into collapsible
                 accordions so the screen reads at a glance but every
                 number from the old layout is still one click away. */
              <Box style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }} position="relative">
                {showConfetti && <ConfettiBurst />}

                <Box display="grid"
                  gridTemplateColumns={{ base: "1fr", md: "minmax(0, 0.95fr) minmax(0, 1.25fr)" }}>

                  {/* ── HERO (mascot + title + slim stepper) ──
                      Grid with three rows (1fr auto 1fr) so the auto-row
                      containing mascot+title+stepper is pinned to the vertical
                      center regardless of right-column height. Plain flex
                      `justify-content: center` was visually off because the
                      mascot's gravity pulled the eye above the column midpoint. */}
                  <Box position="relative" px="6" py="6"
                    display="grid"
                    gridTemplateRows="1fr auto 1fr"
                    justifyItems="center"
                    borderBottom={{ base: "1px solid", md: "0" }}
                    borderColor="kk.border"
                    overflow="hidden"
                    style={{
                      background:
                        'radial-gradient(circle at 50% 42%, rgba(233,196,106,0.10), transparent 55%),' +
                        ' radial-gradient(circle at 50% 42%, rgba(139,227,196,0.08), transparent 60%),' +
                        ' #050706',
                    }}>
                  {/* Top spacer */}
                  <Box />
                  {/* Centered content stack */}
                  <Box display="flex" flexDirection="column" alignItems="center" gap="4">
                    {/* Mascot stage — 300px frame holds rings + 248px slot */}
                    <Box position="relative" w="300px" h="300px" display="grid" style={{ placeItems: 'center' }}>
                      {/* concentric pulse rings — staggered animation delays */}
                      <Box position="absolute" top="0" left="0" right="0" bottom="0"
                        borderRadius="full" border="1px solid rgba(139,227,196,0.10)"
                        style={{ animation: 'kkPulseRing 3.6s ease-in-out infinite' }} />
                      <Box position="absolute" top="18px" left="18px" right="18px" bottom="18px"
                        borderRadius="full" border="1px solid rgba(139,227,196,0.16)"
                        style={{ animation: 'kkPulseRing 3.6s ease-in-out -1.2s infinite' }} />
                      <Box position="absolute" top="36px" left="36px" right="36px" bottom="36px"
                        borderRadius="full" border="1px solid rgba(139,227,196,0.22)"
                        style={{ animation: 'kkPulseRing 3.6s ease-in-out -2.4s infinite' }} />
                      {/* Mascot slot — clipped to a circle. Gif is sized larger than
                          the container and scale-zoomed so its black square margins fall
                          outside the round clip-path, giving a clean edge-to-edge fill. */}
                      <Box w="248px" h="248px" borderRadius="full" overflow="hidden" position="relative" bg="#0a0c0b"
                        style={{
                          boxShadow:
                            '0 18px 50px rgba(0,0,0,0.55),' +
                            ' 0 0 0 1px rgba(255,255,255,0.04) inset,' +
                            ' 0 0 60px rgba(139,227,196,0.18)',
                        }}>
                        <Image src={completedGif} alt=""
                          position="absolute" top="50%" left="50%"
                          w="320px" h="320px"
                          style={{ objectFit: 'cover', transform: 'translate(-50%, -50%)' }} />
                      </Box>
                    </Box>

                    {/* Title */}
                    <Text fontSize="24px" fontWeight="700" color="kk.textPrimary"
                      letterSpacing="-0.03em" textAlign="center" lineHeight="1.1">
                      {t("swap", "Swap")}{" "}
                      <Text as="span" color="var(--gold)"
                        fontWeight={500} fontSize="1.2em">
                        {t("completed", "completed").toLowerCase()}
                      </Text>
                    </Text>

                    {/* Slim stepper pill */}
                    <Flex align="center" justify="center" gap="2"
                      px="3.5" py="1.5"
                      bg="rgba(139,227,196,0.06)"
                      border="1px solid rgba(139,227,196,0.16)"
                      borderRadius="full"
                      fontSize="11px" color="kk.textSecondary">
                      {[t("stageInput"), t("stageProtocol"), t("stageOutput")].map((name, i, arr) => (
                        <Box as="span" key={name} display="inline-flex" alignItems="center" gap="2">
                          <Box display="inline-flex" alignItems="center" gap="1.5">
                            <Box w="14px" h="14px" borderRadius="full" bg="var(--teal)"
                              display="grid" placeItems="center"
                              style={{ boxShadow: '0 0 8px rgba(139,227,196,0.30)' }}>
                              <svg width="8" height="8" viewBox="0 0 16 16" fill="none">
                                <path d="M3.5 8.5L6.5 11.5L12.5 5" stroke="#062018" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </Box>
                            <Text as="span">{name}</Text>
                          </Box>
                          {i < arr.length - 1 && (
                            <Text as="span" color="var(--teal)" opacity={0.6} fontSize="10px">›</Text>
                          )}
                        </Box>
                      ))}
                    </Flex>
                  </Box>
                  {/* Bottom spacer */}
                  <Box />
                  </Box>

                  {/* ── DETAILS (result card + accordions) ── */}
                  <Box p="6" display="flex" flexDirection="column" gap="2.5" minW="0">
                    {/* Headline result card */}
                    <Box position="relative" bg="rgba(255,255,255,0.03)"
                      border="1px solid" borderColor="kk.border" borderRadius="lg" p="4" overflow="hidden">
                      <Box position="absolute" top="0" left="0" right="0" bottom="0" pointerEvents="none"
                        style={{ background: 'radial-gradient(120% 80% at 0% 0%, rgba(233,196,106,0.07), transparent 50%)' }} />
                      <Flex position="relative" align="center" gap="2" mb="1.5"
                        fontSize="10px" color="var(--teal)" fontWeight="600"
                        textTransform="uppercase" letterSpacing="0.10em">
                        <Box w="6px" h="6px" borderRadius="full" bg="var(--teal)"
                          style={{ boxShadow: '0 0 8px rgba(139,227,196,0.30)' }} />
                        <Text>{liveReceivedOutput ? t("youReceived", "You received") : uiText("Quoted output — received amount unverified")}</Text>
                      </Flex>
                      <Flex position="relative" align="baseline" gap="2.5">
                        <Text fontFamily="mono" fontSize="30px" fontWeight={600} color="var(--gold)"
                          letterSpacing="-0.02em" lineHeight="1.05">
                          {liveReceivedOutput ? formatBalance(liveReceivedOutput) : quote?.expectedOutput ? `~${formatBalance(quote.expectedOutput)}` : '—'}
                        </Text>
                        <Text fontSize="16px" color="kk.textSecondary" fontWeight={500}>{toAsset.symbol}</Text>
                      </Flex>
                      {hasToPrice && !toPriceIsDerived && liveReceivedOutput && (
                        <Text position="relative" mt="1" fontSize="12px" color="kk.textMuted" fontFamily="mono">
                          ≈ {fmtCompact(parseFloat(liveReceivedOutput!) * toPriceUsd)}
                          {hasFromPrice && (() => {
                            const sentUsd = parseFloat(displayAmount || '0') * fromPriceUsd
                            const recvUsd = parseFloat(liveReceivedOutput!) * toPriceUsd
                            const net = recvUsd - sentUsd
                            if (!Number.isFinite(net) || Math.abs(net) < 0.005) return null
                            return ` · ${t("netVsSend", "net")} ${net >= 0 ? '+' : '−'}${fmtCompact(Math.abs(net))} ${t("vsSend", "vs send")}`
                          })()}
                        </Text>
                      )}

                      {/* Sent row */}
                      <Flex position="relative" mt="3" pt="3" align="center" gap="2.5" fontSize="12px"
                        style={{ borderTop: '1px dashed var(--line-1, rgba(255,255,255,0.08))' }}>
                        <Text color="kk.textMuted" fontSize="11px" textTransform="uppercase" letterSpacing="0.06em" minW="44px">
                          {t("sent", "Sent")}
                        </Text>
                        <AssetIcon caip={fromAsset.caip} iconUrl={fromAsset.icon}
                          chainCaip={chainBadgeCaip(fromAsset)} size={22} alt={fromAsset.symbol} />
                        <Text fontFamily="mono" color="kk.textPrimary" fontWeight={500}>
                          {displayAmount} {fromAsset.symbol}
                        </Text>
                        <Text color="kk.textMuted" fontSize="11px">→ {toAsset.symbol}</Text>
                        <Box flex="1" />
                        {hasFromPrice && (
                          <Text color="kk.textMuted" fontFamily="mono" fontSize="11px">
                            {fmtCompact(parseFloat(displayAmount || '0') * fromPriceUsd)}
                          </Text>
                        )}
                      </Flex>
                    </Box>

                    {/* Transaction details accordion */}
                    <Box as="details" open className="kk-acc"
                      bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border"
                      borderRadius="lg" overflow="hidden">
                      <Box as="summary" px="3.5" py="2.5"
                        display="flex" alignItems="center" justifyContent="space-between" gap="3"
                        _hover={{ bg: "rgba(255,255,255,0.03)" }}
                        style={{ transition: 'background 120ms ease-out' }}>
                        <Text fontSize="12px" fontWeight={500} color="kk.textPrimary" letterSpacing="-0.01em">
                          {t("transactionDetails", "Transaction details")}
                        </Text>
                        <Flex align="center" gap="2" fontSize="11px" color="kk.textMuted" fontFamily="mono">
                          <Text>{liveOutboundTxid ? uiText("2 hashes") : uiText("1 hash")}</Text>
                          {(() => {
                            const protoHint = liveSwapper || quote?.swapper || quote?.integration
                            const tracker = providerTrackerUrl(protoHint, txid, { relayRequestId: liveRelayRequestId, nearTxHash: liveNearTxHash })
                            return tracker ? <Text>{uiText("· tracker")}</Text> : null
                          })()}
                          <svg className="kk-acc-chev" width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </Flex>
                      </Box>
                      <Box className="kk-acc-body" px="3.5" pt="1" pb="3"
                        style={{ borderTop: '1px dashed var(--line-1, rgba(255,255,255,0.08))' }}>
                        {/* Input tx */}
                        <Flex align="center" gap="2.5" py="2" minW="0">
                          <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase"
                            letterSpacing="0.06em" fontWeight={500} w="70px" flexShrink={0}>
                            {t("inputTx", "Input Tx")}
                          </Text>
                          <Text fontFamily="mono" fontSize="11.5px" color="kk.textSecondary"
                            overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1">
                            {txid}
                          </Text>
                          <HStack gap="1.5" flexShrink={0}>
                            <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                              px="2" h="26px" fontSize="11px" onClick={copyTxid}>
                              {copied ? t("copied") : t("copy")}
                            </Button>
                            {(() => {
                              const url = getExplorerTxUrl(fromAsset.chainId, txid)
                              return url ? (
                                <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                                  px="2" h="26px" fontSize="11px"
                                  onClick={() => rpcRequest('openUrl', { url }).catch(() => { })}>{uiText("Explorer")}</Button>
                              ) : null
                            })()}
                          </HStack>
                        </Flex>
                        {/* Inbound block # — where the input tx was mined. Best-effort
                            (absent on many swaps); clickable on EVM/UTXO explorers. */}
                        {liveInboundBlockNumber !== undefined && (
                          <Flex align="center" gap="2.5" py="2" minW="0"
                            style={{ borderTop: '1px dashed rgba(255,255,255,0.04)' }}>
                            <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase"
                              letterSpacing="0.06em" fontWeight={500} w="70px" flexShrink={0}>
                              {t("block", "Block")}
                            </Text>
                            <Text fontFamily="mono" fontSize="11.5px" color="kk.textSecondary"
                              overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1">
                              #{liveInboundBlockNumber.toLocaleString(getNumberLocale())}{liveInboundBlockHash ? ` · ${liveInboundBlockHash.slice(0, 10)}…` : ''}
                            </Text>
                            {(() => {
                              const url = getExplorerBlockUrl(fromAsset.chainId, liveInboundBlockNumber!)
                              return url ? (
                                <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                                  px="2" h="26px" fontSize="11px"
                                  onClick={() => rpcRequest('openUrl', { url }).catch(() => { })}>{uiText("Explorer")}</Button>
                              ) : null
                            })()}
                          </Flex>
                        )}
                        {/* Input-confirmed timing — confirmedAt minus broadcast (createdAt). */}
                        {liveInboundConfirmedAt !== undefined && liveCreatedAt !== undefined && liveInboundConfirmedAt > liveCreatedAt && (
                          <Flex align="center" gap="2.5" py="2" minW="0"
                            style={{ borderTop: '1px dashed rgba(255,255,255,0.04)' }}>
                            <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase"
                              letterSpacing="0.06em" fontWeight={500} w="70px" flexShrink={0}>
                              {t("confirmed", "Confirmed")}
                            </Text>
                            <Text fontFamily="mono" fontSize="11.5px" color="kk.textSecondary" flex="1">
                              {t("inAbout", "in")} {formatTime(Math.round((liveInboundConfirmedAt - liveCreatedAt) / 1000))}
                            </Text>
                          </Flex>
                        )}
                        {/* EVM network fee actually paid by the input tx. EVM-only —
                            gasUsed is vbytes (not gas) on UTXO/Cosmos/Solana. */}
                        {fromAsset.chainFamily === 'evm' && liveInboundGasUsed && (
                          <Flex align="center" gap="2.5" py="2" minW="0"
                            style={{ borderTop: '1px dashed rgba(255,255,255,0.04)' }}>
                            <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase"
                              letterSpacing="0.06em" fontWeight={500} w="70px" flexShrink={0}>
                              {t("gas", "Gas")}
                            </Text>
                            <Text fontFamily="mono" fontSize="11.5px" color="kk.textSecondary" flex="1">
                              {formatEvmFeePaid(liveInboundGasUsed, liveInboundEffectiveGasPrice || undefined, fromAsset.caip, getNumberLocale())}
                            </Text>
                          </Flex>
                        )}
                        {/* Output tx */}
                        {liveOutboundTxid && (
                          <Flex align="center" gap="2.5" py="2" minW="0"
                            style={{ borderTop: '1px dashed rgba(255,255,255,0.04)' }}>
                            <Text fontSize="10px" color="var(--teal)" textTransform="uppercase"
                              letterSpacing="0.06em" fontWeight={500} w="70px" flexShrink={0}>
                              {t("outputTx", "Output Tx")}
                            </Text>
                            <Text fontFamily="mono" fontSize="11.5px" color="kk.textSecondary"
                              overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1">
                              {liveOutboundTxid}
                            </Text>
                            <HStack gap="1.5" flexShrink={0}>
                              <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                                px="2" h="26px" fontSize="11px"
                                onClick={() => navigator.clipboard.writeText(liveOutboundTxid)}>
                                {t("copy")}
                              </Button>
                              {(() => {
                                const url = getExplorerTxUrl(toAsset.chainId, liveOutboundTxid)
                                return url ? (
                                  <Button size="xs" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                                    px="2" h="26px" fontSize="11px"
                                    onClick={() => rpcRequest('openUrl', { url }).catch(() => { })}>{uiText("Explorer")}</Button>
                                ) : null
                              })()}
                            </HStack>
                          </Flex>
                        )}
                        {/* Tracker row */}
                        {(() => {
                          const protoHint = liveSwapper || quote?.swapper || quote?.integration
                          const tracker = providerTrackerUrl(protoHint, txid, { relayRequestId: liveRelayRequestId, nearTxHash: liveNearTxHash })
                          return tracker ? (
                            <Flex align="center" gap="2.5" py="2" minW="0"
                              style={{ borderTop: '1px dashed rgba(255,255,255,0.04)' }}>
                              <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase"
                                letterSpacing="0.06em" fontWeight={500} w="70px" flexShrink={0}>
                                {t("tracker", "Tracker")}
                              </Text>
                              <Text fontSize="11px" color="kk.textMuted" flex="1"
                                overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                {t("trackerHint", "End-to-end status & quote breakdown")}
                              </Text>
                              <Button size="xs" variant="outline" flexShrink={0}
                                borderColor="rgba(139,227,196,0.32)" color="var(--teal)"
                                px="2" h="26px" fontSize="11px"
                                onClick={() => rpcRequest('openUrl', { url: tracker.url }).catch(() => { })}>
                                <HStack gap="1">
                                  {tracker.iconUrl && <Image src={tracker.iconUrl} w="12px" h="12px" borderRadius="full" />}
                                  <Text>{tracker.label}</Text>
                                </HStack>
                              </Button>
                            </Flex>
                          ) : null
                        })()}
                      </Box>
                    </Box>

                    {/* Balance changes accordion */}
                    {(beforeFromBal || beforeToBal) && (
                      <Box as="details" open className="kk-acc"
                        bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border"
                        borderRadius="lg" overflow="hidden">
                        <Box as="summary" px="3.5" py="2.5"
                          display="flex" alignItems="center" justifyContent="space-between" gap="3"
                          _hover={{ bg: "rgba(255,255,255,0.03)" }}
                          style={{ transition: 'background 120ms ease-out' }}>
                          <Text fontSize="12px" fontWeight={500} color="kk.textPrimary" letterSpacing="-0.01em">
                            {t("balanceChanges", "Balance changes")}
                          </Text>
                          <Flex align="center" gap="2" fontSize="11px" color="kk.textMuted" fontFamily="mono">
                            {hasFromPrice && afterFromBal && beforeFromBal && (() => {
                              const d = (parseFloat(afterFromBal) - parseFloat(beforeFromBal)) * fromPriceUsd
                              return (
                                <>
                                  <Text>{fromAsset.symbol}</Text>
                                  <Text color={d < 0 ? "var(--rose)" : "var(--teal)"}>
                                    {d >= 0 ? '+' : '−'}{fmtCompact(Math.abs(d))}
                                  </Text>
                                  {hasToPrice && afterToBal && beforeToBal && (
                                    <Text color="rgba(255,255,255,0.18)">·</Text>
                                  )}
                                </>
                              )
                            })()}
                            {hasToPrice && afterToBal && beforeToBal && (() => {
                              const d = (parseFloat(afterToBal) - parseFloat(beforeToBal)) * toPriceUsd
                              return (
                                <>
                                  <Text>{toAsset.symbol}</Text>
                                  <Text color={d < 0 ? "var(--rose)" : "var(--teal)"}>
                                    {d >= 0 ? '+' : '−'}{fmtCompact(Math.abs(d))}
                                  </Text>
                                </>
                              )
                            })()}
                            <svg className="kk-acc-chev" width="14" height="14" viewBox="0 0 16 16" fill="none">
                              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </Flex>
                        </Box>
                        <Box className="kk-acc-body" px="3.5" pt="1" pb="3"
                          style={{ borderTop: '1px dashed var(--line-1, rgba(255,255,255,0.08))' }}>
                          {/* From asset balance row */}
                          <Box display="grid" gridTemplateColumns="84px 1fr auto" alignItems="center"
                            fontFamily="mono" fontSize="12px" py="1.5">
                            <HStack gap="2" style={{ fontFamily: 'var(--font-body, inherit)' }}>
                              <AssetIcon caip={fromAsset.caip} iconUrl={fromAsset.icon} size={16} alt={fromAsset.symbol} />
                              <Text color="kk.textPrimary" fontWeight={500}>{fromAsset.symbol}</Text>
                            </HStack>
                            <HStack gap="2" color="kk.textMuted" justify="center" minW="0">
                              <Text>{beforeFromBal ? formatBalance(beforeFromBal) : '—'}</Text>
                              <Text color="kk.textMuted">→</Text>
                              <Text color="kk.textPrimary">{afterFromBal ? formatBalance(afterFromBal) : '…'}</Text>
                            </HStack>
                            <VStack gap="0" align="flex-end">
                              {afterFromBal && beforeFromBal && (
                                <Text color="var(--rose)" fontWeight={500}>
                                  {formatBalance((parseFloat(afterFromBal) - parseFloat(beforeFromBal)).toFixed(8))}
                                </Text>
                              )}
                              {hasFromPrice && afterFromBal && beforeFromBal && (
                                <Text color="var(--rose)" fontSize="11px">
                                  {fmtCompact((parseFloat(afterFromBal) - parseFloat(beforeFromBal)) * fromPriceUsd)}
                                </Text>
                              )}
                            </VStack>
                          </Box>
                          {/* To asset balance row */}
                          <Box display="grid" gridTemplateColumns="84px 1fr auto" alignItems="center"
                            fontFamily="mono" fontSize="12px" py="1.5"
                            style={{ borderTop: '1px dashed rgba(255,255,255,0.04)' }}>
                            <HStack gap="2" style={{ fontFamily: 'var(--font-body, inherit)' }}>
                              <AssetIcon caip={toAsset.caip} iconUrl={toAsset.icon} size={16} alt={toAsset.symbol} />
                              <Text color="kk.textPrimary" fontWeight={500}>{toAsset.symbol}</Text>
                            </HStack>
                            <HStack gap="2" color="kk.textMuted" justify="center" minW="0">
                              <Text>{beforeToBal ? formatBalance(beforeToBal) : '—'}</Text>
                              <Text color="kk.textMuted">→</Text>
                              <Text color="var(--teal)">{afterToBal ? formatBalance(afterToBal) : '…'}</Text>
                            </HStack>
                            <VStack gap="0" align="flex-end">
                              {afterToBal && beforeToBal && (
                                <Text color="var(--teal)" fontWeight={500}>
                                  +{formatBalance((parseFloat(afterToBal) - parseFloat(beforeToBal)).toFixed(8))}
                                </Text>
                              )}
                              {hasToPrice && afterToBal && beforeToBal && (
                                <Text color="var(--teal)" fontSize="11px">
                                  +{fmtCompact((parseFloat(afterToBal) - parseFloat(beforeToBal)) * toPriceUsd)}
                                </Text>
                              )}
                            </VStack>
                          </Box>
                        </Box>
                      </Box>
                    )}
                  </Box>
                </Box>

                {/* Footer — spans full modal width */}
                <Flex px="5" py="3.5" gap="2.5" borderTop="1px solid" borderColor="kk.border"
                  bg="rgba(255,255,255,0.012)">
                  <Button flex="1" h="42px"
                    variant="outline" borderColor="kk.border" color="kk.textPrimary"
                    borderRadius="md" fontSize="14px" fontWeight={500} letterSpacing="-0.01em"
                    _hover={{ borderColor: "rgba(255,255,255,0.18)", bg: "rgba(255,255,255,0.04)" }}
                    onClick={() => { reset(); }}>
                    {t("newSwap")}
                  </Button>
                  <Button flex="1.4" h="42px"
                    bg="var(--gold)" color="#1a1305" border="0"
                    borderRadius="md" fontSize="14px" fontWeight={600} letterSpacing="-0.01em"
                    _hover={{ bg: "var(--gold-2)", boxShadow: '0 0 24px rgba(233,196,106,0.30)' }}
                    onClick={() => { onClose(); setTimeout(reset, 200) }}>
                    {t("done")}
                  </Button>
                </Flex>
              </Box>
            ) : (
            <VStack gap="3" py="1" style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }} position="relative">
              {/* Confetti burst on completion */}
              {showConfetti && <ConfettiBurst />}

              {/* Title row + provider chip */}
              <Flex align="center" gap="3" w="full" justify="center" position="relative">
                <VStack gap="0" align="center">
                  <Text fontSize="lg" fontWeight="700" letterSpacing="-0.01em"
                    color={isSwapComplete ? "var(--teal)" : isSwapFailed ? "var(--rose)" : "kk.textPrimary"}>
                    {isSwapComplete ? t("swapCompleted") : isSwapFailed ? t("swapFailed") : t("swapSubmitted")}
                  </Text>
                  {!isSwapComplete && !isSwapFailed && (
                    <Text fontSize="xs" color="var(--gold)" fontWeight="500" mt="0.5">{liveStatus === 'completed' && requiresSettlementEvidence ? uiText("Verifying the full payout") : livePayouts.length ? uiText("Partial payout received; settlement continues") : t("waitingForConfirmations")}</Text>
                  )}
                </VStack>
                <Box position="absolute" right="0" top="50%" transform="translateY(-50%)">
                  <ProviderBadge
                    swapper={liveSwapper || quote?.swapper || quote?.integration}
                    integration={quote?.integration}
                    size={18}
                    variant="detailed"
                  />
                </Box>
              </Flex>

              {/* ── Progress bar with hero animation + checkpoints ──── */}
              <Box w="full" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="5" pt="4" pb="4">
                {/* Hero animation — embedded inside the bar component so the
                    submitted view stays compact and the bar isn't clipped by
                    a large halo above. shiftingGif covers all in-flight steps
                    (input pending, protocol confirming, output detecting);
                    completedGif takes over only when the swap settles. */}
                <Box display="flex" justifyContent="center" mb="3">
                  <Box
                    position="relative"
                    w="120px"
                    h="120px"
                    borderRadius="full"
                    overflow="hidden"
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    style={{
                      background: isSwapComplete
                        ? 'radial-gradient(circle at 50% 45%, rgba(139,227,196,0.28), rgba(139,227,196,0.06) 70%)'
                        : isSwapFailed
                          ? 'radial-gradient(circle at 50% 45%, rgba(224,140,123,0.22), rgba(224,140,123,0.05) 70%)'
                          : 'radial-gradient(circle at 50% 45%, rgba(233,196,106,0.24), rgba(233,196,106,0.05) 70%)',
                      boxShadow: isSwapComplete
                        ? '0 0 0 1px rgba(139,227,196,0.30), 0 8px 28px -10px rgba(139,227,196,0.35)'
                        : isSwapFailed
                          ? '0 0 0 1px rgba(224,140,123,0.30)'
                          : '0 0 0 1px rgba(233,196,106,0.28), 0 8px 28px -10px rgba(233,196,106,0.30)',
                    }}
                  >
                    <Image
                      src={isSwapComplete ? completedGif : shiftingGif}
                      alt=""
                      w="120px"
                      h="120px"
                      style={{
                        objectFit: 'cover',
                        filter: isSwapFailed ? 'grayscale(0.6)' : undefined,
                      }}
                    />
                  </Box>
                </Box>

                {/* Bar track + filled portion */}
                <Box position="relative" h="6px" bg="rgba(255,255,255,0.08)" borderRadius="full" mb="3">
                  {/* Filled bar — width based on step progress, animated stripes when in progress */}
                  <Box
                    position="absolute" top="0" left="0" h="6px" borderRadius="full"
                    bg={isSwapComplete ? 'linear-gradient(90deg, var(--teal-2), var(--teal))' : undefined}
                    boxShadow="0 0 8px rgba(139,227,196,0.4)"
                    w={swapStep >= 3 ? '100%' : swapStep >= 2 ? '83%' : swapStep >= 1 ? '50%' : '17%'}
                    transition="width 0.6s ease-in-out"
                    overflow="hidden"
                    style={!isSwapComplete ? {
                      backgroundImage: 'linear-gradient(45deg, rgba(139,227,196,0.9) 25%, rgba(168,239,210,0.7) 25%, rgba(168,239,210,0.7) 50%, rgba(139,227,196,0.9) 50%, rgba(139,227,196,0.9) 75%, rgba(168,239,210,0.7) 75%)',
                      backgroundSize: '40px 40px',
                      animation: 'kkBarStripes 1s linear infinite',
                    } : undefined}
                  />

                  {/* Checkpoint 0: Input — left */}
                  <Flex position="absolute" left="0" top="50%" transform="translate(-50%, -50%)" direction="column" align="center" gap="1">
                    <Box w="32px" h="32px" borderRadius="full" display="flex" alignItems="center" justifyContent="center"
                      bg={swapStep > 0 ? 'linear-gradient(135deg, var(--teal-2), var(--teal))' : 'linear-gradient(135deg, var(--teal), var(--teal))'}
                      border="2px solid" borderColor={swapStep > 0 ? 'var(--teal-2)' : 'var(--teal)'}
                      boxShadow={swapStep === 0 ? '0 4px 14px rgba(139,227,196,0.5), 0 0 25px 5px rgba(139,227,196,0.32)' : '0 2px 8px rgba(168,239,210,0.4)'}
                      style={swapStep === 0 ? { animation: 'kkSwapPulse 2s ease-in-out infinite' } : {}}>
                      {swapStep > 0 ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/></svg>
                      )}
                    </Box>
                  </Flex>

                  {/* Checkpoint 1: Protocol — center */}
                  <Flex position="absolute" left="50%" top="50%" transform="translate(-50%, -50%)" direction="column" align="center" gap="1">
                    <Box w="32px" h="32px" borderRadius="full" display="flex" alignItems="center" justifyContent="center"
                      bg={swapStep > 1 ? 'linear-gradient(135deg, var(--teal-2), var(--teal))' : swapStep === 1 ? 'linear-gradient(135deg, var(--teal), var(--teal))' : 'linear-gradient(135deg, #374151, #1F2937)'}
                      border="2px solid" borderColor={swapStep > 1 ? 'var(--teal-2)' : swapStep === 1 ? 'var(--teal)' : '#4B5563'}
                      boxShadow={swapStep === 1 ? '0 4px 14px rgba(139,227,196,0.5), 0 0 25px 5px rgba(139,227,196,0.32)' : swapStep > 1 ? '0 2px 8px rgba(168,239,210,0.4)' : '0 2px 6px rgba(75,85,99,0.3)'}
                      style={swapStep === 1 ? { animation: 'kkSwapPulse 2s ease-in-out infinite' } : {}}>
                      {swapStep > 1 ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      )}
                    </Box>
                  </Flex>

                  {/* Checkpoint 2: Output — right */}
                  <Flex position="absolute" right="0" top="50%" transform="translate(50%, -50%)" direction="column" align="center" gap="1">
                    <Box w="32px" h="32px" borderRadius="full" display="flex" alignItems="center" justifyContent="center"
                      bg={swapStep > 2 ? 'linear-gradient(135deg, var(--teal-2), var(--teal))' : swapStep === 2 ? 'linear-gradient(135deg, var(--teal), var(--teal))' : 'linear-gradient(135deg, #374151, #1F2937)'}
                      border="2px solid" borderColor={swapStep > 2 ? 'var(--teal-2)' : swapStep === 2 ? 'var(--teal)' : '#4B5563'}
                      boxShadow={swapStep === 2 ? '0 4px 14px rgba(139,227,196,0.5), 0 0 25px 5px rgba(139,227,196,0.32)' : swapStep > 2 ? '0 2px 8px rgba(168,239,210,0.4)' : '0 2px 6px rgba(75,85,99,0.3)'}
                      style={swapStep === 2 ? { animation: 'kkSwapPulse 2s ease-in-out infinite' } : {}}>
                      {swapStep > 2 ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
                      )}
                    </Box>
                  </Flex>
                </Box>

                {/* Labels row */}
                <Flex justify="space-between" mt="2" px="0">
                  <VStack gap="0" align="flex-start" w="80px">
                    <Text fontSize="10px" fontWeight="600" color={swapStep >= 0 ? 'kk.textPrimary' : 'kk.textMuted'}>{t("stageInput")}</Text>
                    {swapStep === 0 && liveConfirmations > 0 && (
                      <Text fontSize="9px" fontFamily="mono" color="var(--teal)">{liveConfirmations} {t("confirmations")}</Text>
                    )}
                    {swapStep > 0 && <Text fontSize="9px" color="var(--teal-2)">{t("statusCompleted")}</Text>}
                  </VStack>
                  <VStack gap="0" align="center" w="80px">
                    <Text fontSize="10px" fontWeight="600" color={swapStep >= 1 ? 'kk.textPrimary' : 'kk.textMuted'}>{t("stageProtocol")}</Text>
                    {swapStep === 1 && <Text fontSize="9px" color="var(--teal)">{t("statusConfirming")}...</Text>}
                    {swapStep > 1 && <Text fontSize="9px" color="var(--teal-2)">{t("statusCompleted")}</Text>}
                  </VStack>
                  <VStack gap="0" align="flex-end" w="80px">
                    <Text fontSize="10px" fontWeight="600" color={swapStep >= 2 ? 'kk.textPrimary' : 'kk.textMuted'}>{t("stageOutput")}</Text>
                    {swapStep === 2 && liveOutboundConfirmations !== undefined && (
                      <Text fontSize="9px" fontFamily="mono" color="var(--teal)">{liveOutboundConfirmations}{liveOutboundRequired ? `/${liveOutboundRequired}` : ''}</Text>
                    )}
                    {swapStep === 2 && liveOutboundConfirmations === undefined && (
                      <Text fontSize="9px" color="var(--teal)">{t("statusOutputDetected")}</Text>
                    )}
                    {swapStep > 2 && <Text fontSize="9px" color="var(--teal-2)">{t("statusCompleted")}</Text>}
                  </VStack>
                </Flex>
              </Box>

              {(elapsedSeconds !== undefined || statusCheck) && (
                <Flex w="full" justify="center" align="center" gap="3" flexWrap="wrap"
                  bg="rgba(139,227,196,0.08)" border="1px solid" borderColor="rgba(139,227,196,0.18)"
                  borderRadius="lg" px="4" py="2">
                  {elapsedSeconds !== undefined && <Text fontSize="11px" color="kk.textSecondary">
                    {t("elapsed")} {Math.floor(elapsedSeconds / 60)}:{(elapsedSeconds % 60).toString().padStart(2, '0')}
                  </Text>}
                  {!isSwapComplete && !isSwapFailed && countdown > 0 && <Text fontSize="11px" color="kk.textMuted">
                    {t("estimatedTime")} {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}
                  </Text>}
                  {statusCheck && <Text fontSize="11px" color="kk.textMuted">
                    {t("lastChecked")} {new Date(statusCheck.checkedAt).toLocaleTimeString(getDateLocale())}
                  </Text>}
                  {statusCheck?.error && <Text role="status" fontSize="11px" color="kk.textSecondary">
                    {t(statusCheck.error === 'not_found' ? "swapStatusNotFound" : "swapStatusCheckFailed")}
                  </Text>}
                </Flex>
              )}

              {/* Amount summary */}
              <Flex w="full" bg="rgba(139,227,196,0.08)" border="1px solid" borderColor="rgba(139,227,196,0.18)"
                borderRadius="xl" p="4" justify="center" align="center" gap="4">
                <VStack gap="0.5">
                  <HStack gap="3">
                    <Box style={{ animation: 'kkLogoGlow 3s ease-in-out infinite' }}>
                      <AssetIcon caip={fromAsset.caip} iconUrl={fromAsset.icon} chainCaip={chainBadgeCaip(fromAsset)} size={56} alt={fromAsset.symbol} />
                    </Box>
                    <Text fontSize="sm" fontWeight="700" color="kk.textPrimary">{displayAmount} {fromAsset.symbol}</Text>
                  </HStack>
                  {hasFromPrice && (
                    <Text fontSize="xs" color="kk.textMuted">{fmtCompact(parseFloat(displayAmount) * fromPriceUsd)}</Text>
                  )}
                </VStack>
                <Text color="var(--gold)" fontSize="md" fontWeight="700">{uiText("→")}</Text>
                <VStack gap="0.5">
                  <HStack gap="3">
                    <Box style={{ animation: 'kkLogoGlow 3s ease-in-out infinite' }}>
                      <AssetIcon caip={toAsset.caip} iconUrl={toAsset.icon} chainCaip={chainBadgeCaip(toAsset)} size={56} alt={toAsset.symbol} />
                    </Box>
                    <Text fontSize="sm" fontWeight="700" color="var(--teal)">~<GreenCountUp value={quote?.expectedOutput || '0'} color="var(--teal)" suffix={` ${toAsset.symbol}`} /></Text>
                  </HStack>
                  {hasToPrice && quote?.expectedOutput && (
                    <Text fontSize="xs" color="kk.textMuted">{fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}</Text>
                  )}
                </VStack>
              </Flex>

              {/* Input Txid + CTA buttons */}
              <Box w="full" bg="rgba(255,255,255,0.04)" borderRadius="lg" p="3">
                <Flex align="center" gap="1.5" mb="2">
                  <Text fontSize="10px" color="kk.textMuted" flexShrink={0}>{t("txid")}</Text>
                  <Text fontSize="10px" fontFamily="mono" color="kk.textPrimary" wordBreak="break-all" lineHeight="1.3" flex="1">
                    {txid}
                  </Text>
                  <Button size="xs" variant="ghost" color="kk.textSecondary" onClick={copyTxid} px="1.5" minW="auto" flexShrink={0}>
                    {copied ? t("copied") : t("copy")}
                  </Button>
                </Flex>
                {/* Inbound block # + input-confirmed timing — best-effort from
                    Pioneer; each renders only when present. */}
                {(liveInboundBlockNumber !== undefined || (liveInboundConfirmedAt !== undefined && liveCreatedAt !== undefined && liveInboundConfirmedAt > liveCreatedAt)) && (
                  <Flex align="center" gap="1.5" mb="2" wrap="wrap" fontFamily="mono" fontSize="10px">
                    {liveInboundBlockNumber !== undefined && (() => {
                      const url = getExplorerBlockUrl(fromAsset.chainId, liveInboundBlockNumber!)
                      const label = `${t("block", "Block")} #${liveInboundBlockNumber!.toLocaleString(getNumberLocale())}`
                      return url ? (
                        <Text color="var(--teal)" cursor="pointer" _hover={{ textDecoration: 'underline' }}
                          onClick={() => rpcRequest('openUrl', { url }).catch(() => {})}>{label}</Text>
                      ) : (
                        <Text color="kk.textSecondary">{label}</Text>
                      )
                    })()}
                    {liveInboundConfirmedAt !== undefined && liveCreatedAt !== undefined && liveInboundConfirmedAt > liveCreatedAt && (
                      <Text color="kk.textMuted">
                        {liveInboundBlockNumber !== undefined ? '· ' : ''}{t("confirmed", "Confirmed")} {t("inAbout", "in")} {formatTime(Math.round((liveInboundConfirmedAt - liveCreatedAt) / 1000))}
                      </Text>
                    )}
                  </Flex>
                )}
                <Flex gap="2">
                  {/* Always available — even on failed/refunded — so the user can
                      force a Pioneer rescan to recover a mis-classified swap. */}
                  <Button size="xs" flex="1" variant="outline"
                    borderColor="rgba(139,227,196,0.32)" color="var(--teal)"
                    _hover={{ bg: "rgba(139,227,196,0.10)", borderColor: "var(--teal)" }}
                    isDisabled={rechecking}
                    onClick={handleRecheck}>
                    <HStack gap="1">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        style={rechecking ? { animation: 'spin 0.8s linear infinite' } : undefined}>
                        <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                      </svg>
                      <Text fontSize="10px">{rechecking ? uiText("Checking...") : uiText("Recheck")}</Text>
                    </HStack>
                  </Button>
                  {(() => {
                    const safeTxid = txid ?? ''
                    console.log('[explorer-debug]', fromAsset.chainId, safeTxid)
                    const url = getExplorerTxUrl(fromAsset.chainId, safeTxid)
                    return url ? (
                      <Button size="xs" flex="1" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                        _hover={{ bg: "rgba(255,255,255,0.06)", color: "kk.textPrimary" }}
                        onClick={() => rpcRequest('openUrl', { url }).catch(() => {})}>
                        <HStack gap="1"><ExternalLinkIcon /><Text fontSize="10px">{uiText("Explorer")}</Text></HStack>
                      </Button>
                    ) : null
                  })()}
                  {(() => {
                    // Prefer the tracker-detected swapper (Pioneer's authoritative
                    // post-broadcast value) over the quote-time parse, which often
                    // misses `swapper` for aggregator routes.
                    const protoHint = liveSwapper || quote?.swapper || quote?.integration
                    const tracker = providerTrackerUrl(protoHint, txid, { relayRequestId: liveRelayRequestId, nearTxHash: liveNearTxHash })
                    if (!tracker) return null
                    return (
                      <Button size="xs" flex="1" variant="outline" borderColor="rgba(139,227,196,0.32)" color="var(--teal)"
                        _hover={{ bg: "rgba(139,227,196,0.10)", borderColor: "var(--teal)" }}
                        onClick={() => rpcRequest('openUrl', { url: tracker.url }).catch(() => {})}>
                        <HStack gap="1">
                          {tracker.iconUrl && <Image src={tracker.iconUrl} w="12px" h="12px" borderRadius="full" />}
                          <Text fontSize="10px">{tracker.label}</Text>
                        </HStack>
                      </Button>
                    )
                  })()}
                </Flex>
              </Box>

              {/* Failure reason + recovery guidance — the tracker pushes a
                  structured error (message + actionable) that the submitted view
                  previously dropped entirely, leaving "Swap failed" with no why. */}
              {isSwapFailed && (liveRefundReason || liveError || liveErrorActionable) && (
                <Box w="full" bg="rgba(224,140,123,0.07)" border="1px solid" borderColor="rgba(224,140,123,0.25)" borderRadius="lg" p="3">
                  <Text fontSize="10px" fontWeight="600" color="var(--rose)" textTransform="uppercase" letterSpacing="0.05em" mb="1.5">
                    {liveStatus === 'refunded' ? t("refunded", "Refunded") : t("whatHappened", "What happened")}
                  </Text>
                  {(liveRefundReason || liveError) && (
                    <Text fontSize="11px" color="kk.textSecondary" lineHeight="1.45">{liveRefundReason || liveError}</Text>
                  )}
                  {liveErrorActionable && (
                    <Text fontSize="11px" color="kk.textMuted" lineHeight="1.45" mt="1.5">{liveErrorActionable}</Text>
                  )}
                  {liveErrorElapsedMinutes !== undefined && liveErrorElapsedMinutes > 0 && (
                    <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" mt="1.5">
                      {t("stuckFor", "Unconfirmed for")} ~{liveErrorElapsedMinutes} {t("minutesShort", "min")}
                    </Text>
                  )}
                </Box>
              )}

              {/* Outbound Txid — shown when THORChain sends the output */}
              {liveOutboundTxid && (
                <Box w="full" bg="rgba(74,222,128,0.06)" border="1px solid" borderColor="rgba(139,227,196,0.18)" borderRadius="lg" p="3">
                  <Flex justify="space-between" align="center">
                    <HStack gap="1.5" minW="0" flex="1">
                      <Text fontSize="10px" color="var(--teal)" flexShrink={0}>{t("stageOutput")}</Text>
                      <Text fontSize="11px" fontFamily="mono" color="var(--teal)" wordBreak="break-all" lineHeight="1.4">
                        {liveOutboundTxid}
                      </Text>
                    </HStack>
                    <HStack gap="1">
                      <Button size="xs" variant="ghost" color="var(--teal)" px="1.5" minW="auto"
                        onClick={() => { navigator.clipboard.writeText(liveOutboundTxid) }}>
                        {t("copy")}
                      </Button>
                      {(() => {
                        // For refunds the outbound is on the SOURCE chain — the
                        // tracker fills `liveOutboundChainId` from Midgard's
                        // action.out asset. Fall back to toAsset only when the
                        // classifier hasn't run yet (older history records).
                        const outChainId = liveOutboundChainId || toAsset.chainId
                        const url = getExplorerTxUrl(outChainId, liveOutboundTxid)
                        return url ? (
                          <Button size="xs" variant="ghost" color="var(--teal)" px="1.5" minW="auto"
                            onClick={() => rpcRequest('openUrl', { url }).catch(() => {})} title={uiText("View on explorer")}>
                            <ExternalLinkIcon />
                          </Button>
                        ) : null
                      })()}
                    </HStack>
                  </Flex>
                </Box>
              )}

              {/* Before / After balance comparison — shown on completion */}
              {isSwapComplete && (beforeFromBal || beforeToBal) && (
                <Box w="full" bg="rgba(74,222,128,0.04)" border="1px solid" borderColor="rgba(74,222,128,0.12)" borderRadius="lg" p="3">
                  <Text fontSize="10px" fontWeight="600" color="var(--teal)" mb="2" textTransform="uppercase" letterSpacing="0.05em">{uiText("Balance Changes")}</Text>
                  <VStack gap="1.5" align="stretch">
                    {/* From asset balance change */}
                    <Flex justify="space-between" align="center">
                      <HStack gap="1.5">
                        <AssetIcon caip={fromAsset.caip} iconUrl={fromAsset.icon} size={14} alt={fromAsset.symbol} />
                        <Text fontSize="11px" color="kk.textSecondary">{fromAsset.symbol}</Text>
                      </HStack>
                      <VStack gap="0" align="flex-end">
                        <HStack gap="2">
                          <Text fontSize="11px" fontFamily="mono" color="kk.textMuted">
                            {beforeFromBal ? formatBalance(beforeFromBal) : '-'}
                          </Text>
                          <Text fontSize="10px" color="kk.textMuted">{uiText("→")}</Text>
                          <Text fontSize="11px" fontFamily="mono" color={afterFromBal ? 'var(--gold)' : 'kk.textMuted'}>
                            {afterFromBal ? formatBalance(afterFromBal) : '...'}
                          </Text>
                          {afterFromBal && beforeFromBal && (
                            <Text fontSize="10px" fontFamily="mono" color="var(--rose)">
                              ({formatBalance((parseFloat(afterFromBal) - parseFloat(beforeFromBal)).toFixed(8))})
                            </Text>
                          )}
                        </HStack>
                        {hasFromPrice && afterFromBal && beforeFromBal && (
                          <Text fontSize="9px" fontFamily="mono" color="var(--rose)">
                            {fmtCompact((parseFloat(afterFromBal) - parseFloat(beforeFromBal)) * fromPriceUsd)}
                          </Text>
                        )}
                      </VStack>
                    </Flex>
                    {/* To asset balance change */}
                    <Flex justify="space-between" align="center">
                      <HStack gap="1.5">
                        <AssetIcon caip={toAsset.caip} iconUrl={toAsset.icon} size={14} alt={toAsset.symbol} />
                        <Text fontSize="11px" color="kk.textSecondary">{toAsset.symbol}</Text>
                      </HStack>
                      <VStack gap="0" align="flex-end">
                        <HStack gap="2">
                          <Text fontSize="11px" fontFamily="mono" color="kk.textMuted">
                            {beforeToBal ? formatBalance(beforeToBal) : '-'}
                          </Text>
                          <Text fontSize="10px" color="kk.textMuted">{uiText("→")}</Text>
                          <Text fontSize="11px" fontFamily="mono" color={afterToBal ? 'var(--teal)' : 'kk.textMuted'}>
                            {afterToBal ? <GreenCountUp value={afterToBal} color="var(--teal)" /> : '...'}
                          </Text>
                          {afterToBal && beforeToBal && (
                            <Text fontSize="10px" fontFamily="mono" color="var(--teal)">
                              (+{formatBalance((parseFloat(afterToBal) - parseFloat(beforeToBal)).toFixed(8))})
                            </Text>
                          )}
                        </HStack>
                        {hasToPrice && afterToBal && beforeToBal && (
                          <Text fontSize="9px" fontFamily="mono" color="var(--teal)">
                            +{fmtCompact((parseFloat(afterToBal) - parseFloat(beforeToBal)) * toPriceUsd)}
                          </Text>
                        )}
                      </VStack>
                    </Flex>
                  </VStack>
                </Box>
              )}

              {/* Actions */}
              <Flex gap="2" w="full">
                <Button size="sm" flex="1" variant="outline" color="kk.textSecondary" borderColor="kk.border"
                  px="4" py="2" _hover={{ bg: "rgba(255,255,255,0.06)" }}
                  onClick={() => { reset(); }}>
                  {t("newSwap")}
                </Button>
                <Button size="sm" flex="1"
                  bg={isSwapComplete ? "var(--teal)" : "kk.gold"} color="black" fontWeight="600"
                  px="4" py="2" _hover={{ opacity: 0.9 }}
                  onClick={() => { onClose(); setTimeout(reset, 200) }}>
                  {isSwapComplete ? t("done") : t("close")}
                </Button>
              </Flex>
            </VStack>
            )
          )}

          {/* ── SIGNING / APPROVING / BROADCASTING ───────────────── */}
          {/* The KeepKey on the left as in every signing screen; the step,
              its instruction and Cancel on the right. */}
          {busy && fromAsset && toAsset && (() => {
            const approvingStep = subStage?.startsWith('approve-') || (!subStage && phase === 'approving')
            const headline = subStage === 'approve-signing'         ? t("approveOnDevice", "Approve on device")
              : subStage === 'approve-broadcasting'  ? t("approvalBroadcasting", "Broadcasting approval…")
              : subStage === 'approve-waiting-receipt' ? t("approvalWaiting", "Waiting for approval to confirm…")
              : subStage === 'swap-signing'          ? t("confirmOnDevice")
              : subStage === 'swap-broadcasting'     ? t("broadcasting")
              : phase === 'approving'                ? t("approvingToken")
              : phase === 'signing'                  ? t("confirmOnDevice")
                                                     : t("broadcasting")
            const expected = quote?.expectedOutput ? formatBalance(quote.expectedOutput) : '—'
            return (
              <div className="kk-pf kk-pf-sg kk-pf-inset" data-swap-signing style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }}>
                {/* Left: the KeepKey, still, with what it asks for. */}
                <div className="kk-pf-left kk-pf-scroll" ref={leftScroll}>
                  {/* The firmware's own screens for this transaction when Desktop can
                      compute them, following each ButtonRequest; a sketch otherwise. */}
                  {signingMirror && phase !== 'broadcasting' && !subStage?.endsWith('-broadcasting') && subStage !== 'approve-waiting-receipt'
                    ? <DeviceMirrorPanel key={`${signingTxKind}:${signingTx?.data ?? ''}`} mirror={signingMirror} devicePrompts={devicePrompts} following scale={shortWindow ? 0.8 : 1} />
                    : <>
                      <SpinningDevice motion="still" scale={shortWindow ? 0.8 : 1}
                        label={`${approvingStep ? 'APPROVE' : uiText("CONFIRM SWAP")}: ${displayAmount} ${fromAsset.symbol}`}
                        screen={<OledText kicker={approvingStep ? 'APPROVE' : uiText("CONFIRM SWAP")} headline={`${displayAmount} ${fromAsset.symbol}`} sub={`→ ~${expected} ${toAsset.symbol}`} />} />
                      <p className="kk-pf-cap" style={{ maxWidth: 'none' }}>{uiText('A sketch, not a readback. Trust your KeepKey’s own screen.')}</p>
                    </>}
                </div>
                {/* Right: what is happening now; Cancel pinned while the device waits. */}
                <div className="kk-pf-right kk-pf-split">
                  <div className="kk-pf-body kk-pf-scroll" ref={rightScroll}>
                    <div className="kk-pf-top">
                      <h3 className="kk-pf-h" style={{ fontSize: 20 }}>{headline}</h3>
                      {fromAsset.contractAddress && <em className="kk-pf-tag" style={{ color: 'var(--gold)' }}>{approvingStep ? '1/2' : '2/2'}</em>}
                    </div>
                    <div className="kk-pf-amt kk-pf-ends">
                      <div><b>{displayAmount} {fromAsset.symbol}</b>{hasFromPrice && <small>{fmtCompact(parseFloat(displayAmount) * fromPriceUsd)}</small>}</div>
                      <div><b>~{expected} {toAsset.symbol}</b>{hasToPrice && quote?.expectedOutput && <small>{fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}</small>}</div>
                    </div>
                    {/* Every step of this swap; the gold one is where it is now. */}
                    {(() => {
                      const steps = [
                        ...(fromAsset.contractAddress ? [{ key: 'approve', title: t("approveOnDevice", "Approve on device"), text: t("approvalRequired"), on: approvingStep && !subStage?.endsWith('-broadcasting') && subStage !== 'approve-waiting-receipt' }] : []),
                        { key: 'sign', title: t("confirmOnDevice"), text: t("confirmOnDeviceDesc"), on: !approvingStep && phase === 'signing' && subStage !== 'swap-broadcasting' },
                        { key: 'send', title: t("broadcasting"), text: t("broadcastingDesc"), on: phase === 'broadcasting' || !!subStage?.endsWith('-broadcasting') || subStage === 'approve-waiting-receipt' },
                      ]
                      return <div className="kk-pf-tl" data-swap-steps>
                        {steps.map((step, i) => <TimelineItem key={step.key} node={<NumberNode n={i + 1} gold={step.on} />} title={step.title}>{step.text}</TimelineItem>)}
                      </div>
                    })()}
                    <p className="kk-pf-note">{uiText('Closing this view does not cancel the swap. Track it in Activity.')}</p>
                  </div>
                  {(phase === 'signing' || phase === 'approving') && (
                    <div className="kk-pf-foot">
                      {/* Only while the device waits for a press: once confirmed and
                          broadcasting, the transaction is on its way and cannot unwind. */}
                      <div className="kk-pf-actions" style={{ gridTemplateColumns: '1fr' }}>
                        <button type="button" className="kk-pf-go kk-pf-go-danger"
                          aria-label={t('cancel', 'Cancel')}
                          title={t('cancelSwapDevice', 'Cancel - release device prompt')}
                          onClick={handleCancelSigning}>
                          {t('cancel', 'Cancel')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}

          {/* ── BLIND SIGNING REQUIRED (Solana) ─────────────────── */}
          {phase === 'blind-signing-required' && (
            <VStack gap="5" py="6" px="2" align="center" style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}>
              {/* Amber alert badge — mirrors the AdvancedMode icon in Device Settings */}
              <Flex align="center" justify="center" w="56px" h="56px" borderRadius="full" bg="rgba(245,163,59,0.12)">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#F5A33B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 9v4M12 17h.01" />
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                </svg>
              </Flex>

              <VStack gap="2" align="center" maxW="420px">
                <Text fontSize="lg" fontWeight="700" color="kk.textPrimary" textAlign="center">
                  {blindSignCause === 'device'
                    ? t('deviceBlindSignTitle', "Your KeepKey can't show this transaction")
                    : t('solanaOpaqueTitle', "Your KeepKey can't show this Solana transaction")}
                </Text>
                <Text fontSize="sm" color="kk.textSecondary" textAlign="center" lineHeight="1.5">
                  {blindSignCause === 'device'
                    ? t('deviceBlindSignBody', 'Your KeepKey has no review it can show for this transaction, so it signs it only with blind signing on. With blind signing on, the device asks you to approve without showing what the transaction does.')
                    : t('solanaOpaqueBody', 'Your KeepKey has no review it can show for this transaction, so it signs it only with blind signing on. The summary below was worked out on this computer; your KeepKey cannot confirm it.')}
                </Text>
              </VStack>

              {/* Host-side outflow check: what this transaction actually moves.
                  Deliberately NOT presented as verification — the device cannot
                  confirm it, so the wording stays "checked on this computer". */}
              {outflowCheck && (
                <Box bg="var(--ink-1)" border="1px solid var(--ink-3)" borderRadius="lg" px="3" py="2.5" maxW="420px" w="full">
                  <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.06em" mb="1.5">
                    {t('solanaOutflowHeader', 'Checked on this computer')}
                  </Text>
                  {outflowCheck.unavailable ? (
                    <Text fontSize="xs" color="kk.textSecondary" lineHeight="1.5">
                      {t('solanaOutflowUnknown', 'Could not determine what this transaction does')} — {outflowCheck.unavailable}
                    </Text>
                  ) : (
                    <>
                      <Text fontSize="xs" color="kk.textPrimary" lineHeight="1.6">
                        {t('solanaOutflowAfter', 'After this transaction your wallet holds')}:{' '}
                        <strong>{(Number(outflowCheck.solAfter) / 1e9).toFixed(6)} SOL</strong>
                        {outflowCheck.tokensAfter.map(tk => {
                          const d = tk.decimals ?? 0
                          const amt = d > 0 ? (Number(tk.amount) / 10 ** d).toFixed(Math.min(d, 6)) : tk.amount
                          return (
                            <span key={tk.mint}>
                              {' + '}<strong>{amt} {tk.symbol || `${tk.mint.slice(0, 4)}…${tk.mint.slice(-4)}`}</strong>
                            </span>
                          )
                        })}
                      </Text>
                      {outflowCheck.spending && (
                        <Text fontSize="11px" color="kk.textSecondary" mt="1">
                          {t('solanaOutflowSpending', 'You approved spending')}: {outflowCheck.spending} {outflowCheck.spendingSymbol || ''}
                        </Text>
                      )}
                      {Number(outflowCheck.solAfter) / 1e9 < 0.001 && (
                        <Text fontSize="xs" color="kk.error" mt="1.5" fontWeight="600">
                          {t('solanaOutflowDrain', 'Warning: this leaves your wallet empty. Do not sign unless that is what you intended.')}
                        </Text>
                      )}
                    </>
                  )}
                  {outflowCheck.decoded?.length ? (
                    <Box mt="2" pt="2" borderTop="1px solid var(--ink-3)">
                      <Text fontSize="10px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.06em" mb="1">
                        {t('solanaDecodedHeader', 'What this transaction does')}
                      </Text>
                      {outflowCheck.decoded.map((line, i) => (
                        <Text key={i} fontSize="11px" color="kk.textPrimary" lineHeight="1.5" fontFamily="mono">
                          {line}
                        </Text>
                      ))}
                    </Box>
                  ) : null}
                  {outflowCheck.reason && (
                    <Text fontSize="11px" color="kk.textSecondary" mt="2" lineHeight="1.45">
                      {t('solanaOpaqueReason', 'Your KeepKey cannot read this transaction because of')}: {outflowCheck.reason}
                    </Text>
                  )}
                  <Text fontSize="10px" color="kk.textMuted" mt="1.5" lineHeight="1.4">
                    {t('solanaOutflowCaveat', 'Simulated against a Solana node from this computer. Your KeepKey cannot confirm these figures.')}
                  </Text>
                </Box>
              )}

              {/* Security caveat */}
              <Flex align="flex-start" gap="2" bg="var(--ink-1)" border="1px solid var(--ink-3)" borderRadius="lg" px="3" py="2.5" maxW="420px">
                <Box color="var(--gold)" flexShrink={0} mt="0.5">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                </Box>
                <Text fontSize="11px" color="kk.textMuted" lineHeight="1.4">
                  {t('deviceBlindSignCaveat', 'Blind signing stays on until the KeepKey locks or is unplugged, for every app that uses it, not just this swap. While it is on, this app also stops showing this screen before such transactions. The device asks you to confirm and to re-enter your PIN.')}
                </Text>
              </Flex>

              {blindSignError && (
                <Box bg="rgba(224,140,123,0.10)" border="1px solid" borderColor="kk.error" borderRadius="lg" px="3" py="2" maxW="420px" w="full">
                  <Text fontSize="xs" color="kk.error" textAlign="center">{blindSignError}</Text>
                </Box>
              )}

              <Flex gap="3" w="full" maxW="420px" pt="1">
                <Button size="sm" flex="1" bg="kk.gold" color="black" fontWeight="600"
                  disabled={enablingBlindSign}
                  _hover={{ opacity: 0.9 }}
                  onClick={() => { setBlindSignError(null); setPhase('review') }}>
                  {t('back', 'Back')}
                </Button>
                <Button size="sm" flex="1" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                  loading={enablingBlindSign}
                  loadingText={t('blindSignConfirmOnDevice', 'Confirm on device…')}
                  _hover={{ bg: 'rgba(255,255,255,0.04)' }}
                  onClick={handleEnableBlindSigning}>
                  {t('deviceBlindSignEnable', 'Turn on blind signing')}
                </Button>
              </Flex>
            </VStack>
          )}

          {/* ── REVIEW (confirm quote) ──────────────────────────── */}
          {phase === 'review' && quote && fromAsset && toAsset && !busy && (() => {
            const allowance = previewBuild?.allowance
            const tokenDecimals = normalizeDecimals(fromAsset.decimals)
            const tokenAmount = (raw: string, cap = false) => {
              if (tokenDecimals === null) return raw
              try {
                const n = Number(BigInt(raw)) / Math.pow(10, tokenDecimals)
                if (cap && n > 1e15) return '∞ (max)'
                return n.toLocaleString(undefined, { maximumFractionDigits: 8 })
              } catch { return raw }
            }
            const approvedAmount = previewBuild?.approveTx ? parseApproveCalldata((previewBuild.approveTx as any).data)?.amount : undefined
            const effectiveSlippagePct = (computeEffectiveSlippageBps(quote.slippageBps, slippageBps) / 100).toFixed(1)
            // One status mark per row, most severe first (PreflightList sorts).
            const rows: PreflightRow[] = []
            if (networkMismatch) rows.push({ key: 'network', status: 'block', tag: uiText("blocks"), title: uiText("The asset and network do not match. Select the asset again.") })
            if (previewBuild?.balance && !previewBuild.balance.sufficient) rows.push({ key: 'balance', status: 'block', tag: uiText("blocks"),
              title: t("insufficientBalance", "Insufficient {{symbol}} balance", { symbol: fromAsset.symbol }),
              detail: <>{t("insufficientBalanceDetail", "You have {{have}} {{symbol}} but the swap needs {{need}} {{symbol}}. The transferFrom would revert on-chain.", { have: tokenAmount(previewBuild.balance.current), need: tokenAmount(previewBuild.balance.required), symbol: fromAsset.symbol })}{' '}
                {t("insufficientBalanceFix", "Lower the amount to ≤{{have}} or top up the source wallet before swapping.", { have: tokenAmount(previewBuild.balance.current) })}</> })
            if (previewError) rows.push({ key: 'preview', status: 'block', tag: uiText("blocks"), title: `${t("previewFailed", "Build preview failed")}: ${previewError}` })
            rows.push(...riskRows)
            if (relayRecipientMismatch) rows.push({ key: 'relay-mismatch', status: 'block', tag: uiText("blocks"), title: t("relayRecipientMismatchButton", "Relay order pays another address") })
            if (shouldWarnHighSlippage(quote.slippageBps, slippageBps)) rows.push({ key: 'slippage', status: 'warn',
              title: t("highSlippageWarning", "Slippage tolerance is high ({{pct}}%). You may receive less than expected. Consider lowering tolerance for small spreads.", { pct: effectiveSlippagePct }),
              detail: slippageNeedsConfirm ? <label className="kk-pf-check" data-high-slippage-ack>
                <input type="checkbox" checked={!slippageLocked} onChange={event => setSlippageAcceptedKey(event.target.checked ? slippageKey : '')} />
                <span>{t("highSlippageConfirm", "I accept a slippage tolerance of {{pct}}%: I may receive up to {{pct}}% less than quoted.", { pct: effectiveSlippagePct })}</span>
              </label> : undefined })
            // Firmware 7.15+ parses native TRX and TRC-20 transfers; older firmware shows a generic prompt.
            if (fromAsset.chainFamily === 'tron' && (!firmwareVersion || versionCompare(firmwareVersion, '7.15.0') < 0)) rows.push({ key: 'tron', status: 'warn',
              title: t("tronLegacySigningWarning", "Firmware before 7.15 may show a generic Tron prompt. Update firmware for native TRX and TRC-20 ClearSign details, or verify the complete payload above before approving.") })
            if (error) rows.push({ key: 'error', status: errorIsWarning ? 'warn' : 'danger', title: error,
              detail: <button type="button" className="kk-pf-link" onClick={() => setError(null)}>{t("dismiss")}</button> })
            // Where the output goes (audit v4 H1).
            rows.push(externalRecipient
              ? { key: 'recipient', status: 'danger', title: t("customRecipientNotKeepKey", "Custom recipient — not your KeepKey"), detail: <span style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{toAddress}</span> }
              : { key: 'recipient', status: 'ok', title: uiText("Received on your own account"), detail: uiText("Paid out to this KeepKey.") })
            // How many transactions the KeepKey will sign, and how far an approval reaches.
            if (allowance && !allowance.sufficient) {
              rows.push({ key: 'confirms', status: 'warn', title: uiText("Two confirmations on the device"),
                detail: uiText("First the approval, then the swap. The approval uses gas even if you cancel the swap.") })
              const exact = approvedAmount !== undefined && approvedAmount === toBigIntValue(allowance.required)
              rows.push(exact
                ? { key: 'limit', status: 'ok', title: uiText("Spending limit is exact"), detail: uiText("The approval covers {{amount}} {{symbol}}, not unlimited.", { amount: tokenAmount(allowance.required), symbol: fromAsset.symbol }) }
                : { key: 'limit', status: 'warn', title: uiText("Spending limit above this swap"), detail: uiText("The approval allows {{amount}} {{symbol}} to {{spender}}.", { amount: approvedAmount !== undefined ? tokenAmount(approvedAmount.toString(), true) : tokenAmount(allowance.required), symbol: fromAsset.symbol, spender: `${allowance.spender.slice(0, 10)}…${allowance.spender.slice(-6)}` }) })
            } else {
              rows.push({ key: 'confirms', status: 'ok', title: uiText("One confirmation on the device"),
                detail: allowance ? uiText("Already approved: {{amount}} {{symbol}} for the router.", { amount: tokenAmount(allowance.current, true), symbol: fromAsset.symbol }) : uiText("Your KeepKey signs the swap once.") })
            }
            if (quote.executionMode === 'relay-solver-deposit' && quote.relayOrderRecipient) rows.push({ key: 'relay', status: 'ok', title: uiText("Relay pays out after your deposit"),
              detail: t('relayDepositRecipient', 'The Relay order pays out to {{address}}. Your KeepKey signs only the deposit; Relay pays out afterwards.', { address: quote.relayOrderRecipient }) })
            if (isFeeReservedNativeMax && nativeMaxReserveDisplay) rows.push({ key: 'reserve', status: 'ok', title: uiText("Network fee kept aside"),
              detail: t("sendMaxGasReserveNote", { defaultValue: "Keeping ~{{reserve}} {{symbol}} for network fees{{usd}}.", reserve: formatBalance(String(nativeMaxReserveDisplay.reserveAmount)), symbol: fromAsset.symbol, usd: nativeMaxReserveDisplay.reserveUsd > 0 ? ` (${fmtCompact(nativeMaxReserveDisplay.reserveUsd)})` : '' }) })
            const pillBusy = previewLoading || refreshingQuote
            return (
              <div className="kk-pf kk-pf-sg kk-pf-inset" data-swap-review style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}>
                {/* ── Left: the route, the two amounts, the terms ── */}
                <div className="kk-pf-left kk-pf-scroll" ref={leftScroll}>
                  {/* One quote-bound summary: fiat and costs share the risk snapshot. */}
                  <div data-trade-summary style={{ display: 'grid', gap: 14 }}>
                    <div data-trade-route-map>
                      {/* The route's art (BitHighlander's) is the centrepiece; the official logos sit at the ends. */}
                      <RouteMap
                        from={{ iconUrl: fromAsset.icon, caip: fromAsset.caip, chainCaip: fromNetwork?.chainCaip, color: fromNetwork?.color, glyph: fromAsset.symbol.slice(0, 1) }}
                        to={{ iconUrl: toAsset.icon, caip: toAsset.caip, chainCaip: toNetwork?.chainCaip, color: toNetwork?.color, glyph: toAsset.symbol.slice(0, 1) }}
                        integration={quote.swapper || quote.integration || resolveProvider(quote.swapper || quote.integration).label}
                        showIntegrationLabel={false}
                        centerImageUrl={getSwapperAnimation(quote.swapper, quote.integration)}
                        centerStillUrl={getSwapperStill(quote.swapper, quote.integration)}
                      />
                    </div>
                    <div className="kk-pf-amt kk-pf-ends">
                      <div>
                        <b>{displayAmount} {fromAsset.symbol}</b>
                        <small><span data-trade-from-network>{fromNetwork?.name}</span>{swapRisk.inputUsd !== undefined && fmt(swapRisk.inputUsd) && <>{' · '}<span data-trade-input-fiat>{fmt(swapRisk.inputUsd)}</span></>}</small>
                      </div>
                      <div>
                        <b>{formatBalance(quote.expectedOutput)} {toAsset.symbol}</b>
                        <small><span data-trade-to-network>{toNetwork?.name}</span>{swapRisk.expectedUsd !== undefined && fmt(swapRisk.expectedUsd) && <>{' · '}<span data-trade-output-fiat>{fmt(swapRisk.expectedUsd)}</span></>}</small>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Right: the checklist right above the decision, ids under Technical details ── */}
                <div className="kk-pf-right kk-pf-split">
                  <div className="kk-pf-body kk-pf-scroll" ref={rightScroll}>
                    <PreflightList rows={rows} />
                    {/* The terms, read with the checks before the decision. */}
                    <dl className="kk-pf-facts" data-trade-terms>
                      <div><dt>{quote.minimumOutputSource === 'estimate' ? uiText("Estimated minimum") : uiText("Minimum receive")}</dt>
                        <dd>{formatBalance(quote.minimumOutput)} {toAsset.symbol}{swapRisk.minimumUsd !== undefined && fmt(swapRisk.minimumUsd) ? ` (${fmt(swapRisk.minimumUsd)})` : ''}</dd></div>
                      <div><dt>{uiText("Estimated swap cost")}</dt>
                        <dd><span data-trade-cost>{swapRisk.expectedLossPct !== undefined
                          ? `${swapRisk.expectedLossUsd !== undefined && fmt(swapRisk.expectedLossUsd) ? `${fmt(swapRisk.expectedLossUsd)} · ` : ''}${swapRisk.expectedLossPct.toFixed(2)}%`
                          : uiText("Price data unavailable")}</span></dd></div>
                      <div><dt>{uiText("Source network fee")}</dt><dd>{uiText("Paid separately")}</dd></div>
                      <div><dt>{uiText("Estimated time")}</dt><dd>{formatTime(quote.estimatedTime)}</dd></div>
                      <div><dt>{t("route", "Route")}</dt><dd><ProviderBadge swapper={quote.swapper} integration={quote.integration} size={16} variant="row" /></dd></div>
                      {/* Where the output goes, in full, for every route (audit v4 H1). */}
                      <div data-trade-recipient data-custom-recipient={externalRecipient ? 'true' : 'false'}>
                        <dt style={externalRecipient ? { color: 'var(--rose)' } : undefined}>{t("reviewRecipient", "Recipient")}</dt>
                        <dd style={externalRecipient ? { color: 'var(--rose)' } : undefined}>{toAddress}
                          {externalRecipient && <><br />{t("customRecipientNotKeepKey", "Custom recipient — not your KeepKey")}</>}</dd>
                      </div>
                    </dl>
                    {/* Our own swap is assumed clear: the report shows only when it is
                        not what was quoted (swapReportNeedsAttention). */}
                    {previewBuild?.clearSignReports?.approval && swapReportNeedsAttention(previewBuild.clearSignReports.approval) && <ClearSignReportCard report={previewBuild.clearSignReports.approval} title={uiText("Approval ClearSign Report")} />}
                    {previewBuild?.clearSignReports?.transaction && swapReportNeedsAttention(previewBuild.clearSignReports.transaction) && <ClearSignReportCard report={previewBuild.clearSignReports.transaction} title={uiText("Swap ClearSign Report")} />}
                    {/* The provider the swap will ask is always named: execute pins it. */}
                    {(() => {
                      const report = previewBuild?.clearSignReports?.transaction
                      const line = namedProviderLine(previewBuild?.runtimeProvider, report && swapReportNeedsAttention(report) ? report : undefined)
                      return line ? <p className="kk-pf-note" data-clearsign-provider>{line}</p> : null
                    })()}
                    {/* quote.warning is not shown: it is THORNode's note to API
                        integrators ("Do not cache this response…"). The dialog
                        enforces it: a quote older than swapRisk.quoteMaxAgeMs is
                        re-fetched and re-reviewed before signing. */}
                    <details className="kk-pf-tech" id="swap-fees-details">
                      <summary>{uiText("Technical details")}</summary>
                      <VStack gap="2" align="stretch" mt="3">
                        <ReviewRow label={`${t("from")} · CAIP-19`}><span data-trade-from-caip>{fromNetwork?.assetCaip || '—'}</span></ReviewRow>
                        <ReviewRow label={`${t("to")} · CAIP-19`}><span data-trade-to-caip>{toNetwork?.assetCaip || '—'}</span></ReviewRow>
                        <ReviewRow label={t("rate")}>
                          1 {fromAsset.symbol} = {formatBalance((parseFloat(quote.expectedOutput) / parseFloat(displayAmount || '1')).toString())} {toAsset.symbol}
                        </ReviewRow>
                        <QuoteFeeRows fees={quote.fees} />
                        <ReviewRow label={t("slippageTolerance", "Slippage tolerance")}>{(slippageBps / 100).toFixed(2)}{uiText("% max")}</ReviewRow>
                        {quote.quotedSlippageBps != null && (
                          <ReviewRow label={t("quoteSlippage", "Quote slippage")}>{(quote.quotedSlippageBps / 100).toFixed(2)}%</ReviewRow>
                        )}
                        <ReviewRow label={uiText("Minimum source")}>
                          {quote.minimumOutputSource === 'memo' ? uiText("Transaction memo") : quote.minimumOutputSource === 'estimate' ? uiText("Estimate") : uiText("Provider quote")}
                        </ReviewRow>
                        {swapRisk.minimumLossPct !== undefined && (
                          <ReviewRow label={uiText("Value difference at minimum")}>
                            {swapRisk.minimumLossUsd !== undefined ? `${fmt(swapRisk.minimumLossUsd)} · ` : ''}{swapRisk.minimumLossPct.toFixed(2)}%
                          </ReviewRow>
                        )}
                        <p className="kk-pf-note">{uiText("Swap cost compares the quoted input and output values, including the rate and route fees. The source network fee is separate. Minimum receive is an execution limit, not a guaranteed refund.")}</p>
                        {allowance && <ReviewRow label={uiText("Spender")}><span style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{allowance.spender}</span></ReviewRow>}
                        {fromAsset.chainFamily === 'evm' && previewBuild?.approveTx && (
                          <EvmTxSummaryCard title={t("approvalTx", "Approval transaction")} tx={previewBuild.approveTx} chain={fromChainDef} asset={fromAsset} isApproval />
                        )}
                        {fromAsset.chainFamily === 'evm' && previewBuild?.unsignedTx && (
                          <EvmTxSummaryCard title={previewBuild.approveTx ? t("swapTxAfterApproval", "Swap transaction after approval") : t("swapTx", "Swap transaction")}
                            tx={previewBuild.unsignedTx} chain={fromChainDef} asset={fromAsset} />
                        )}
                        {quote.router && fromAsset.chainFamily === 'evm' && <ReviewRow label={t("routerContract")}><span style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{quote.router}</span></ReviewRow>}
                        <ReviewRow label={t("vault")}><span style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{quote.inboundAddress}</span></ReviewRow>
                        {quote.memo && <ReviewRow label={uiText("memo")}><span style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{quote.memo}</span></ReviewRow>}
                        {/* The hdwallet payload, built ahead of time by previewSwapBuild,
                            so the exact transaction going to the device can be audited. */}
                        {previewLoading && <p className="kk-pf-note">{uiText("Building transaction preview…")}</p>}
                        {previewBuild?.approveTx && <>
                          <p className="kk-pf-note">{uiText("Approve tx (ERC-20 allowance)")}</p>
                          <Box as="pre" fontFamily="var(--font-mono)" fontSize="10px" lineHeight="1.5" whiteSpace="pre-wrap" overflowWrap="anywhere" bg="rgba(0,0,0,0.28)" p="2" borderRadius="md" maxH="200px" overflowY="auto" color="var(--text-1)" m="0">
                            {JSON.stringify(previewBuild.approveTx, null, 2)}
                          </Box>
                        </>}
                        {previewBuild?.unsignedTx && <>
                          <p className="kk-pf-note">{previewBuild.approveTx ? uiText("Swap tx (sent after approval)") : uiText("Technical details")}</p>
                          <Box as="pre" fontFamily="var(--font-mono)" fontSize="10px" lineHeight="1.5" whiteSpace="pre-wrap" overflowWrap="anywhere" bg="rgba(0,0,0,0.28)" p="2" borderRadius="md" maxH="240px" overflowY="auto" color="var(--text-1)" m="0">
                            {JSON.stringify(previewBuild.unsignedTx, null, 2)}
                          </Box>
                        </>}
                      </VStack>
                    </details>
                  </div>
                  {/* ── Decision: pinned under the checklist, outside the scroll ── */}
                  <div className="kk-pf-foot">
                    <div className="kk-pf-actions">
                      <button type="button" className="kk-pf-cancel" onClick={handleBackToInput}>{t("back")}</button>
                      <button type="button" className="kk-pf-go"
                        onClick={() => { if (!reviewConfirmLocked) handleExecuteSwap() }}
                        disabled={reviewConfirmLocked}
                        aria-disabled={reviewConfirmLocked}
                        aria-busy={pillBusy || undefined}>
                        {pillBusy && <span className="kk-pf-spin" aria-hidden="true" />}
                        {reviewConfirmLockLabel || uiText("Swap on KeepKey")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* ── INPUT — one surface: You pay | You receive, a pivot on the divider,
              and a decision row across both columns. ─────────────────── */}
          {!loadingAssets && !assetLoadError && (phase === 'input' || phase === 'quoting') && (() => {
            const presetSlippage = SLIPPAGE_PRESETS_BPS.includes(slippageBps as typeof SLIPPAGE_PRESETS_BPS[number])
            // Notices about the amount, one status mark each.
            const fromRows: PreflightRow[] = []
            if (fromAsset && fromChainLowGas) fromRows.push({ key: 'gas', status: 'block', title: t("lowGasTitle", { defaultValue: "Low {{symbol}} for network fees", symbol: fromChainLowGas.symbol }),
              detail: t("lowGasSwapBody", {
                defaultValue: "Sending {{token}} costs {{symbol}} in network fees — this swap will likely fail to broadcast. Deposit {{symbol}} to your {{coin}} address first. You have {{balance}} {{symbol}}.",
                token: fromAsset.symbol, symbol: fromChainLowGas.symbol, coin: fromChainLowGas.coin, balance: formatBalance(fromChainLowGas.balance),
              }) })
            if (nativeMaxInsufficient && fromAsset) fromRows.push({ key: 'max-gas', status: 'block',
              title: t("maxInsufficientForGas", { defaultValue: "Balance is below the fee reserve (~{{reserve}} {{symbol}}). Top up to swap.", reserve: nativeMaxFeeReserve(fromAsset, maxReserveMode).toString(), symbol: fromAsset.symbol }) })
            if (exceedsSafeMax && fromAsset) fromRows.push({ key: 'safe-max', status: 'warn',
              title: t("exceedsSafeMax", { defaultValue: "Leave ~{{reserve}} {{symbol}} for network fees — reduce the amount or tap MAX.", reserve: formatBalance(String(nativeMaxFeeReserve(fromAsset, 'safe'))), symbol: fromAsset.symbol }) })
            if (isFeeReservedNativeMax && !nativeMaxInsufficient && fromAsset && nativeMaxReserveDisplay) fromRows.push({ key: 'reserve', status: 'ok',
              title: t("maxReserveDisclosure", {
                defaultValue: "MAX swaps {{amount}} {{symbol}} and keeps ~{{reserve}} {{symbol}} for network fees{{usd}}.",
                amount: formatBalance(sendAmount), reserve: formatBalance(String(nativeMaxReserveDisplay.reserveAmount)), symbol: fromAsset.symbol,
                usd: nativeMaxReserveDisplay.reserveUsd > 0 ? ` (${fmtCompact(nativeMaxReserveDisplay.reserveUsd)})` : '',
              }),
              detail: nativeMaxReserveDisplay.canUseCloser ? <>
                <div className="kk-pf-modes" role="group" aria-label={uiText("Fee reserve")} style={{ marginTop: 6 }}>
                  {(['safe', 'closer'] as NativeMaxReserveMode[]).map(mode => <button key={mode} type="button" aria-pressed={maxReserveMode === mode} disabled={busy} onClick={() => setMaxReserveMode(mode)}>
                    {mode === 'safe' ? t("maxReserveSafe", "Safe") : t("maxReserveCloser", "Closer MAX")}
                  </button>)}
                </div>
                {maxReserveMode === 'closer' && <p style={{ color: 'var(--gold)' }}>{t("maxReserveCloserWarning", "Tighter gas reserve; swap may fail if gas moves before signing.")}</p>}
              </> : undefined })
            const reviewReady = phase === 'input' && !!quote && !!fromAsset && !!toAsset && !sameAsset
            const reviewLabel = reviewReady ? uiText("Review swap")
              : phase === 'quoting' ? t("gettingQuote")
              : sameAsset ? t("sameAsset")
              : !fromAsset || !toAsset ? t("selectAsset")
              : t("enterAmount")
            const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`
            return (
              <div className="kk-pf kk-pf-sg kk-pf-inset kk-pf-rows kk-pf-pivoted" data-swap-form>
                {/* ── FROM ── */}
                <div className="kk-pf-left kk-pf-scroll" ref={leftScroll}>
                  <AssetSelector label={t("youPay", "You pay")} selected={fromAsset} onOpenPicker={() => setPickerSide('from')} disabled={busy} />
                  {isZcashSource && <p className="kk-pf-detail" role="note" title={t("zcashUnshieldBeforeSwap")} style={{ margin: 0, color: 'var(--gold)' }}>{t("zcashTransparentOnlyTitle")}</p>}
                  {fromAsset && <div style={{ display: 'grid', gap: 8 }}>
                    <div className="kk-pf-top">
                      <span className="kk-pf-detail" style={{ margin: 0 }} aria-busy={fromBalancePending}>
                        <span className="kk-pf-dim">{isZcashSource ? t("zcashTransparentAvailable") : t("available")}</span>{' '}
                        <span style={{ fontFamily: 'var(--font-mono)' }}>{fromBalance !== null ? `${formatBalance(fromBalance)} ${fromAsset.symbol}` : '—'}</span>
                        {fromBalance && hasFromPrice && <span className="kk-pf-dim">{' · '}{fmtCompact(parseFloat(fromBalance) * fromPriceUsd)}</span>}
                        {(fromBalancePending || loadingBalances) && <>{' '}<Spinner size="xs" color="kk.gold" aria-label={t('loadingBalances')} /></>}
                      </span>
                      <div className="kk-pf-modes" role="group" aria-label={uiText("Amount")}>
                        {hasFromPrice && <>
                          <button type="button" aria-pressed={inputMode === 'crypto'} title={t("switchToCrypto") || `Use ${fromAsset.symbol}`} onClick={() => inputMode !== 'crypto' && toggleInputMode()}>{fromAsset.symbol}</button>
                          <button type="button" aria-pressed={inputMode === 'fiat'} title={t("switchToFiat") || `Use ${fiatSymbol}`} onClick={() => inputMode !== 'fiat' && toggleInputMode()}>{fiatSymbol}</button>
                        </>}
                        {/* MAX is a set-action, not a toggle: the auto-default effect can
                            pre-enable it, and a toggle would silently turn that off. To
                            leave MAX, the user types (onChange clears it). */}
                        <button type="button" aria-pressed={isMax} disabled={busy || fromBalance === null}
                          onClick={() => { setIsMax(true); setMaxReserveMode('safe'); setAmount(""); setFiatAmount("") }}>{t("max")}</button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
                      {inputMode === 'fiat' && <span className="kk-pf-dim" style={{ fontFamily: 'var(--font-mono)', fontSize: 22 }}>$</span>}
                      <input className="kk-pf-field"
                        inputMode="decimal"
                        aria-label={uiText("Amount")}
                        aria-invalid={invalidAmountInput || amountTooPrecise || exceedsBalance || undefined}
                        value={isMax ? (quotedSendAmount ? formatBalance(quotedSendAmount) : 'MAX') : (inputMode === 'crypto' ? amount : fiatAmount)}
                        onChange={(e) => { if (isMax) { setIsMax(false); setMaxReserveMode('safe') } inputMode === 'crypto' ? handleCryptoChange(e.target.value) : handleFiatChange(e.target.value) }}
                        placeholder={inputMode === 'fiat' ? '0.00' : t("amountPlaceholder")}
                        disabled={busy} />
                      {/* The counterpart figure; click it to type in the other unit. Under
                          MAX the input is pinned to the native figure, so it shows USD. */}
                      {hasFromPrice && (isMax
                        ? amountUsdPreview !== null && <span className="kk-pf-detail" style={{ margin: 0, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>≈ {fmtCompact(amountUsdPreview)}</span>
                        : inputMode === 'crypto' && amountUsdPreview !== null
                          ? <button type="button" className="kk-pf-link" style={{ fontFamily: 'var(--font-mono)', textDecoration: 'none', color: 'var(--text-1)', whiteSpace: 'nowrap' }} title={t("switchToFiat") || "Switch to fiat input"} onClick={toggleInputMode}>≈ {fmtCompact(amountUsdPreview)}</button>
                          : inputMode === 'fiat' && amount
                            ? <button type="button" className="kk-pf-link" style={{ fontFamily: 'var(--font-mono)', textDecoration: 'none', color: 'var(--text-1)', whiteSpace: 'nowrap' }} title={t("switchToCrypto") || `Switch to ${fromAsset.symbol} input`} onClick={toggleInputMode}>≈ {formatBalance(amount)} {fromAsset.symbol}</button>
                            : null)}
                    </div>
                    {invalidAmountInput && <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--rose)' }}>{t('invalidAmount', { ns: 'send', defaultValue: 'Enter an ungrouped decimal amount, for example 1.5. Thousands separators are not accepted.' })}</p>}
                    {amountTooPrecise && <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--rose)' }}>{t('tooManyDecimals', { ns: 'send', symbol: fromAsset.symbol, decimals: fromAmountDecimals })}</p>}
                    {exceedsBalance && <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--rose)', fontWeight: 600 }}>{t("insufficientBalance")}</p>}
                    <div role="status" aria-live="polite">
                      {fromBalanceUnverified && (fromBalancePending ? (
                        <p className="kk-pf-detail" style={{ margin: 0 }}>{t("balanceLoading", { defaultValue: "Loading {{symbol}} balance… MAX is available once it arrives.", symbol: fromAsset.symbol })}</p>
                      ) : sourceBalanceRead === 'blocked' ? (
                        <p className="kk-pf-detail" style={{ margin: 0 }}>{uiText('Balance unverified')}</p>
                      ) : (
                        <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--gold)' }}>
                          {fromBalanceReason === 'missing' ? t("balanceMissing", {
                            defaultValue: "{{symbol}} balance was not returned by the last refresh, so MAX is unavailable. Enter an amount, or refresh and try again.",
                            symbol: fromAsset.symbol,
                          }) : t("balanceUnverified", {
                            defaultValue: "{{symbol}} balance unavailable — the last refresh could not reach this chain, so MAX is unavailable. Enter an amount, or refresh and try again.",
                            symbol: fromAsset.symbol,
                          })}
                        </p>
                      ))}
                    </div>
                  </div>}
                  {fromAsset?.chainFamily === 'evm' && (
                    <div aria-label={uiText('Swap source account')} style={{ display: 'grid', gap: 6 }}>
                      <span className="kk-pf-dim" style={{ fontSize: 12 }}>{uiText('Signing account')}</span>
                      {evmAddresses.addresses.length > 1 ? <label>
                        <select className="kk-pf-field kk-pf-sm" aria-label={uiText('Swap signing account')} value={effectiveEvmIndex} disabled={busy} onChange={e => setEvmAddressIndexOverride(Number(e.target.value))}
                          style={{ fontFamily: 'var(--font-ui-sans)', background: 'var(--ink-0)' }}>
                          {evmAddresses.addresses.map(a => {
                            const own = accountBalances.find(b => b.chainId === fromAsset.chainId && b.address.toLowerCase() === a.address.toLowerCase())
                              || withNativeProof(scopeSwapBalances([], undefined, evmAddresses, a.addressIndex).find(b => b.chainId === fromAsset.chainId))
                            const amount = swapAccountAmount(own, fromAsset)
                            return <option key={a.addressIndex} value={a.addressIndex}>{uiText('Account')} #{a.addressIndex} · {amount === null ? uiText('Balance unverified') : `${formatBalance(amount)} ${fromAsset.symbol}`}</option>
                          })}
                        </select>
                      </label> : <span className="kk-pf-detail" style={{ margin: 0 }} title={signingAccount?.address}>{signingAccount ? `${uiText('Account')} #${signingAccount.addressIndex} · ${short(signingAccount.address)}` : uiText('Account unavailable')}</span>}
                      {!signingAccount && <span className="kk-pf-detail" style={{ margin: 0 }}>{uiText('Connect and verify the signing account')}</span>}
                    </div>
                  )}
                  {fromRows.length > 0 && <PreflightList rows={fromRows} />}
                </div>

                {/* Pivot on the divider: flips the two sides. */}
                <button type="button" className="kk-pf-pivot"
                  disabled={busy || !fromAsset || !toAsset}
                  onClick={() => { if (!busy && fromAsset && toAsset) handleFlip() }}
                  aria-label={uiText("Swap direction")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 3L4 7l4 4" /><path d="M4 7h16" /><path d="M16 21l4-4-4-4" /><path d="M20 17H4" />
                  </svg>
                </button>

                {/* ── TO ── */}
                <div className="kk-pf-right kk-pf-scroll" ref={rightScroll}>
                  <AssetSelector label={t("youReceive", "You receive")} selected={toAsset} onOpenPicker={() => setPickerSide('to')} disabled={busy} />
                  {toAsset && quote && (
                    <div style={{ display: 'grid', gap: 4 }} data-expected-output>
                      <span className="kk-pf-dim" style={{ fontSize: 12 }}>{t("expectedOutput")}</span>
                      <div className="kk-pf-amt"><div>
                        {/* The quoted figure itself: a count-up from 0 read as "0.00000000" for a second on every quote. */}
                        <b>{formatBalance(quote.expectedOutput)} {toAsset.symbol}</b>
                        {hasToPrice && <small>≈ {fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}</small>}
                      </div></div>
                    </div>
                  )}
                  {/* The quote computes in the slot its figure will take. */}
                  {toAsset && !quote && phase === 'quoting' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, animation: 'kkSwapFadeIn 0.25s ease-out' }}>
                      <img src={calculatingGif} alt="" width={48} height={48} style={{ objectFit: 'contain', borderRadius: '50%' }} />
                      <div>
                        <b style={{ fontSize: 13, color: 'var(--gold)' }}>{t("findingBestRoute") || uiText("Finding best route…")}</b>
                        <p className="kk-pf-detail" style={{ margin: 0 }}>{t("gettingQuote")}</p>
                      </div>
                    </div>
                  )}
                  {/* Stuck without a quote (an address did not resolve): the reason,
                      and a Get Quote that re-derives it and asks again. */}
                  {phase === 'input' && !quote && !error && (quoteBlockReason || canQuote) && (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <p className="kk-pf-detail" style={{ margin: 0 }}>{quoteBlockReason || t("readyForQuote", "Ready to fetch a fresh quote.")}</p>
                      {(!quoteBlockReason || needsDestAddress) && <div className="kk-pf-actions kk-pf-wrap" style={{ marginTop: 0 }}>
                        <button type="button" className="kk-pf-outline" disabled={manualQuoting} onClick={handleManualQuote}>
                          {manualQuoting && <span className="kk-pf-spin" aria-hidden="true" />}{manualQuoting ? t("gettingQuote") : t("getQuote", "Get Quote")}
                        </button>
                      </div>}
                    </div>
                  )}
                  {toAsset && (
                    <div style={{ display: 'grid', gap: 8 }} data-swap-recipient>
                      <PreflightList rows={[!useCustomAddress
                        ? { key: 'to', status: 'ok', title: t("keepKeyAddress"), detail: keepKeyToAddress ? <span style={{ fontFamily: 'var(--font-mono)' }} title={keepKeyToAddress}>{short(keepKeyToAddress)}</span> : undefined }
                        : customIsOwn
                          ? { key: 'to', status: 'ok', title: t("customAddressOwn", "This is your own KeepKey address") }
                          : { key: 'to', status: 'warn', title: t("customAddressWarning") }]} />
                      {useCustomAddress && <>
                        <input className="kk-pf-field kk-pf-sm" value={customToAddress} onChange={(e) => setCustomToAddress(e.target.value)}
                          placeholder={t("customAddressPlaceholder")} aria-invalid={!!customAddressError || undefined} aria-label={t("customAddressPlaceholder")} />
                        {customAddressError && <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--rose)' }}>{customAddressError}</p>}
                      </>}
                      <button type="button" className="kk-pf-link" style={{ justifySelf: 'start' }}
                        onClick={() => { setUseCustomAddress(!useCustomAddress); if (useCustomAddress) setCustomToAddress("") }}>
                        {useCustomAddress ? t("useKeepKeyAddress") : t("useCustomAddress")}
                      </button>
                    </div>
                  )}
                  {sameAsset && <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--rose)', fontWeight: 600 }}>{t("sameAsset")}</p>}
                  {/* Ids and full addresses: there when wanted, out of the way otherwise. */}
                  {(fromAsset || toAsset) && (
                    <details className="kk-pf-tech" style={{ marginTop: 'auto' }}>
                      <summary>{uiText("Technical details")}</summary>
                      <dl className="kk-pf-facts" style={{ marginTop: 8 }}>
                        {fromAsset?.caip && <div><dt>{`${t("from")} · CAIP-19`}</dt><dd>{fromAsset.caip}</dd></div>}
                        {fromAddress && <div><dt>{uiText("From address")}</dt><dd>{fromAddress}</dd></div>}
                        {toAsset?.caip && <div><dt>{`${t("to")} · CAIP-19`}</dt><dd>{toAsset.caip}</dd></div>}
                        {(useCustomAddress ? customToAddress : keepKeyToAddress) && <div><dt>{uiText("To address")}</dt><dd>{useCustomAddress ? customToAddress : keepKeyToAddress}</dd></div>}
                      </dl>
                    </details>
                  )}
                </div>

                {/* ── Decision row, across both columns, never scrolled away ── */}
                <div className="kk-pf-foot kk-pf-span">
                  {fromAsset && toAsset && (
                    <div className="kk-pf-top">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                        {/* Bps: 50 = 0.5%, 100 = 1%, 300 = 3%. Custom is an inline input:
                            window.prompt is unavailable in some WebView builds. */}
                        <span className="kk-pf-dim" style={{ fontSize: 12 }}>{t("slippage") || uiText("Slippage")}</span>
                        <div className="kk-pf-modes" role="group" aria-label={t("slippage") || uiText("Slippage")}>
                          {SLIPPAGE_PRESETS_BPS.map(bps => <button key={bps} type="button" aria-pressed={slippageBps === bps}
                            onClick={() => { setCustomSlippageOpen(false); setCustomSlippageError(null); setSlippageBps(bps) }}>
                            {(bps / 100).toFixed(bps < 100 ? 1 : 0)}%
                          </button>)}
                          {customSlippageOpen ? (
                            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
                              <input className="kk-pf-field kk-pf-sm" style={{ width: 48, padding: '0 0 2px' }} autoFocus
                                aria-label={t("customSlippage", "Custom slippage percentage")}
                                aria-invalid={!!customSlippageError || undefined}
                                value={customSlippageInput}
                                onChange={(e) => updateCustomSlippage(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && updateCustomSlippage(customSlippageInput)) setCustomSlippageOpen(false)
                                  else if (e.key === 'Escape') { setCustomSlippageOpen(false); setCustomSlippageError(null) }
                                }}
                                inputMode="decimal" />
                              <span className="kk-pf-dim" style={{ fontSize: 11 }}>%</span>
                            </span>
                          ) : (
                            <button type="button" aria-pressed={!presetSlippage} onClick={openCustomSlippage}>
                              {!presetSlippage ? `${(slippageBps / 100).toFixed(2)}%` : (t("custom") || "Custom")}
                            </button>
                          )}
                        </div>
                      </div>
                      {quote && <ProverChip swapper={quote.swapper} integration={quote.integration} onClick={() => setQuoteDetailsOpen(true)} />}
                    </div>
                  )}
                  {customSlippageError && <p className="kk-pf-detail" style={{ margin: 0, color: 'var(--rose)' }}>{customSlippageError}</p>}
                  {phase === 'input' && quote && riskPanel}
                  {/* Expected small-swap limits read as warnings, failures in rose.
                      Retry only for a retryable cause while the inputs still hold. */}
                  {error && (
                    <p className="kk-pf-detail" role="alert" style={{ margin: 0, color: errorIsWarning ? 'var(--gold)' : 'var(--rose)' }}>
                      {error}{' '}
                      {quoteRetryable && canQuote && <button type="button" className="kk-pf-link" onClick={() => { setError(null); setRequoteTick(t => t + 1) }}>{t("retry", "Retry")}</button>}
                    </p>
                  )}
                  <div className="kk-pf-actions">
                    {/^shapeshift(?:swap)?$/i.test(quote?.integration || '')
                      ? <a href="https://api.shapeshift.com/docs#description/introduction" className="kk-pf-dim"
                          onClick={(e) => { e.preventDefault(); rpcRequest("openUrl", { url: "https://api.shapeshift.com/docs#description/introduction" }).catch(() => {}) }}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, textDecoration: 'none' }}>
                          <img src={shapeshiftLogo} alt="" width={11} height={11} />{uiText("Powered by ShapeShift API")}
                        </a>
                      : <span />}
                    <button type="button" className="kk-pf-go" disabled={!reviewReady} aria-disabled={!reviewReady} aria-busy={phase === 'quoting' || undefined}
                      onClick={() => { if (reviewReady) setPhase('review') }}>
                      {phase === 'quoting' && <span className="kk-pf-spin" aria-hidden="true" />}{reviewLabel}
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}
        </Box>

        {/* ── Footer ──────────────────────────────────────────────── */}
        {!loadingAssets && !consoleView && phase !== 'submitted' && !busy && phase !== 'review' && phase !== 'blind-signing-required' && (
          <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border" justify="space-between" align="center" gap="3"
            bg="linear-gradient(90deg, transparent 0%, rgba(35,220,200,0.02) 50%, transparent 100%)">
            <Box minW="0" flex="1">
              {quote ? (
                <ProverChip
                  swapper={quote.swapper}
                  integration={quote.integration}
                  onClick={() => setQuoteDetailsOpen(true)}
                />
              ) : null /* don't claim a provider before we have a quote */}
            </Box>
            {/^shapeshift(?:swap)?$/i.test(quote?.integration || '') && <Box
              as="a"
              href="https://api.shapeshift.com/docs#description/introduction"
              onClick={(e: React.MouseEvent) => { e.preventDefault(); rpcRequest("openUrl", { url: "https://api.shapeshift.com/docs#description/introduction" }).catch(() => {}) }}
              display="flex"
              alignItems="center"
              gap="1.5"
              opacity="0.55"
              _hover={{ opacity: 1 }}
              transition="opacity 0.15s"
              flexShrink={0}
            >
              <Image src={shapeshiftLogo} alt="" w="11px" h="11px" />
              <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.04em">{uiText("Powered by ShapeShift API")}</Text>
            </Box>}
          </Flex>
        )}
      </Box>

      {/* ── Asset picker (modal-over-modal) ──────────────────────── */}
      {/* ── Swap provider status, on the preflight surface ───────── */}
      {healthDialogOpen && (
        <div className="kk-sd-overlay" style={{ zIndex: Z.assetPicker }} onClick={() => setHealthDialogOpen(false)}>
          <div className="kk-sd-panel" role="dialog" aria-modal="true" aria-label={uiText("Swap Provider Status")} onClick={e => e.stopPropagation()} data-swap-health>
            <div className="kk-sd-head">
              <div><div className="kk-pf-kicker">{uiText("via Pioneer")}</div><h2>{uiText("Swap Provider Status")}</h2></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="kk-sd-x" aria-label={uiText("Refresh")} onClick={refreshSwapHealth} disabled={healthRefreshing}>{healthRefreshing ? '↻' : '↺'}</button>
                <button type="button" className="kk-sd-x" aria-label={uiText("Close")} onClick={() => setHealthDialogOpen(false)}>×</button>
              </div>
            </div>
            <div className="kk-sd-body">
              {swapHealth && swapHealthQuoteExplanation(swapHealth) && <p className="kk-pf-detail" style={{ marginTop: 0 }}>{swapHealthQuoteExplanation(swapHealth)}</p>}
              {swapHealth ? <ol className="kk-pf-list">
                {swapHealth.integrations.map(intg => {
                  const info = resolveProvider(intg.key)
                  const { color: dotColor, label: statusLabel, description: statusDesc } = swapProviderPresentation(intg)
                  return <li key={intg.key} style={{ gridTemplateColumns: '22px minmax(0,1fr) auto', alignItems: 'start' }}>
                    <img src={info.icon} alt="" width={22} height={22} style={{ borderRadius: '50%' }} />
                    <div>
                      <b>{intg.label}</b>
                      <div className="kk-pf-detail">{statusDesc}</div>
                      {intg.checkScope === 'quote' && Number.isFinite(intg.checkedAt) && <div className="kk-pf-detail">{uiText("Last quote check")}{" "}{new Date(intg.checkedAt!).toLocaleTimeString(getDateLocale())}</div>}
                      {intg.haltedPools && intg.haltedPools.length > 0 && <div className="kk-pf-detail">
                        {uiText("Halted pools (")}{intg.haltedPools.length})
                        {intg.haltedPools.map(caip => <div key={caip} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, overflowWrap: 'anywhere' }}>{caip}</div>)}
                      </div>}
                    </div>
                    <em className="kk-pf-tag" style={{ color: dotColor }}>{statusLabel}</em>
                  </li>
                })}
              </ol> : <p className="kk-pf-detail">{uiText("Loading provider status…")}</p>}
            </div>
            <div className="kk-sd-foot">
              <span>{swapHealth?.error ? uiText("Status feed unavailable") : swapHealth ? `Updated ${new Date(swapHealth.fetchedAt).toLocaleTimeString(getDateLocale())}` : uiText("Fetching…")}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Route details (provider name click), on the preflight surface ── */}
      {quoteDetailsOpen && quote && fromAsset && toAsset && (() => {
        const info = resolveProvider(quote.swapper || quote.integration)
        return (
          <div className="kk-sd-overlay" style={{ zIndex: Z.assetPicker }} onClick={() => setQuoteDetailsOpen(false)}>
            <div className="kk-sd-panel kk-sd-narrow" role="dialog" aria-modal="true" aria-label={uiText("Route details")} onClick={e => e.stopPropagation()} data-route-details>
              <div className="kk-sd-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <img src={info.icon} alt="" width={32} height={32} style={{ borderRadius: '50%' }} />
                  <div><div className="kk-pf-kicker">{uiText("Route details")}</div><h2>{info.label}</h2></div>
                </div>
                <button type="button" className="kk-sd-x" aria-label={uiText("Close")} onClick={() => setQuoteDetailsOpen(false)}>×</button>
              </div>
              <div className="kk-sd-body">
                {quote.executionMode === 'relay-solver-deposit' && quote.relayOrderRecipient && (
                  <p className="kk-pf-detail" role="note" style={{ marginTop: 0 }}>
                    {t('relayDepositRecipient', 'The Relay order pays out to {{address}}. Your KeepKey signs only the deposit; Relay pays out afterwards.', { address: quote.relayOrderRecipient })}
                  </p>
                )}
                <VStack gap="2" align="stretch">
                  <ReviewRow label={t("rate")}>1 {fromAsset.symbol} = {formatBalance((parseFloat(quote.expectedOutput) / parseFloat(quotedSendAmount || '1')).toString())} {toAsset.symbol}</ReviewRow>
                  <ReviewRow label={t("expectedAfterFees", "Expected")}>{formatBalance(quote.expectedOutput)} {toAsset.symbol}{hasToPrice ? ` (${fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)})` : ''}</ReviewRow>
                  <ReviewRow label={t("minimumAfterFeesSlippage", "Min. receive")} accent>{formatBalance(quote.minimumOutput)} {toAsset.symbol}</ReviewRow>
                  <QuoteFeeRows fees={quote.fees} />
                  <ReviewRow label={t("slippageTolerance", "Slippage")}>{(slippageBps / 100).toFixed(2)}{uiText("% max")}</ReviewRow>
                  <ReviewRow label={t("estimatedTime")}>{formatTime(quote.estimatedTime)}</ReviewRow>
                </VStack>
              </div>
            </div>
          </div>
        )
      })()}

      <AssetPickerDialog
        open={pickerSide !== null}
        onClose={() => setPickerSide(null)}
        swappable={assets}
        balances={accountBalances}
        sourceAccountLabel={signingAccount ? `EVM · ${uiText('Account')} #${effectiveEvmIndex} · ${signingAccount.address}` : undefined}
        balancesLoading={loadingBalances}
        customTokens={customTokens}
        excludeCaip={pickerSide === 'from' ? toAsset?.caip : fromAsset?.caip}
        side={pickerSide || 'from'}
        onSelect={(a) => {
          if (pickerSide === 'from') { setFromAsset(a); setMaxReserveMode('safe') }
          else if (pickerSide === 'to') setToAsset(a)
          setQuote(null)
          setPhase('input')
          setError(null)
        }}
      />
    </Box>
  )
}
