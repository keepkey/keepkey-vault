/**
 * SwapDialog — Full-screen dialog for the swap flow.
 *
 * Phases: input → review → approving/signing/broadcasting → success
 * Replaces the old inline SwapView with a proper modal experience.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, Button, Input, Image, HStack, Spinner } from "@chakra-ui/react"
import CountUp from "react-countup"
import { rpcRequest, rpcFire, onRpcMessage } from "../lib/rpc"
import { formatBalance } from "../lib/formatting"
import { useFiat } from "../lib/fiat-context"
import { AssetIcon } from "./AssetIcon"
import { CHAINS, getExplorerTxUrl } from "../../shared/chains"
import type { ChainDef } from "../../shared/chains"
import { nativeMaxSpendableAmount, normalizeDecimals, tokenMaxSpendableAmount } from "../../shared/max-send"
import { getAssetIcon } from "../../shared/assetLookup"
import { validateAddress } from "../../shared/address-validation"
import type { SwapAsset, SwapQuote, ChainBalance, CustomToken, SwapStatusUpdate, SwapTrackingStatus, PendingSwap, SwapUiState, SwapUiCommand, SwapHealth } from "../../shared/types"
import { Z } from "../lib/z-index"
import { providerTrackerUrl } from "../lib/trackers"
import { ProviderBadge, ProverChip, resolveProvider } from "./ProviderBadge"
import { getSwapperAnimation } from "../lib/swapper-animations"
import { computeDustWarning, shouldWarnHighSlippage, computeEffectiveSlippageBps } from "../../shared/swap-warnings"
import { useEvmAddresses } from "../hooks/useEvmAddresses"
import { AssetPickerDialog } from "./AssetPickerDialog"
import { KeepKeyDevice, RouteMap, SpinningDevice } from "./v3"
import calculatingGif from "../assets/swap/calculating.gif"
import shiftingGif from "../assets/swap/shifting.gif"
import completedGif from "../assets/swap/completed.gif"
import shapeshiftLogo from "../assets/providers/shapeshift.svg"

// ── Phase state machine ─────────────────────────────────────────────
type SwapPhase = 'input' | 'quoting' | 'review' | 'approving' | 'signing' | 'broadcasting' | 'submitted'

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
const NATIVE_SOLANA_FEE_RESERVE = 0.000005

function nativeMaxFeeReserve(asset: SwapAsset, mode: NativeMaxReserveMode = 'safe'): number {
  if (asset.contractAddress) return 0
  if (asset.chainFamily === 'tron') return NATIVE_TRON_FEE_RESERVE
  if (asset.chainFamily === 'solana') return NATIVE_SOLANA_FEE_RESERVE
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

// Friendly hint for a known spender contract address. Independent of the
// protocol — many ShapeShift routes (ButterSwap, Relay, Hop, etc.) use the
// same Relay aggregator router as their executor. Returns null for unknowns.
function spenderHint(addr: string | undefined): string | null {
  if (!addr) return null
  const a = addr.toLowerCase()
  if (a === '0xee0319cf0bca5d09333f9f6277743e8de31bd69a') return 'Relay aggregator router'
  if (a === '0xdef1c0ded9bec7f1a1670819833240f027b25eff') return '0x ExchangeProxy'
  if (a === '0x9008d19f58aabd9ed0d60971565aa8510560ab41') return 'CoW Vault Relayer'
  return null
}

type SwapPreviewBuild = {
  approveTx?: any
  unsignedTx: any
  allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }
  balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string }
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

function formatQuoteAssetAmount(raw: string | number | undefined, asset: SwapAsset, referenceAmount?: string): string {
  const value = raw == null ? '0' : String(raw)
  const precision = normalizeDecimals(asset.decimals) ?? 0
  if (!/^\d+$/.test(value) || precision <= 0) return formatBalance(value)
  const reference = referenceAmount ? parseFloat(referenceAmount) : 0
  const asNumber = Number(value)
  const looksLikeBaseUnits =
    value.length > Math.min(4, precision) ||
    (Number.isFinite(asNumber) && reference > 0 && asNumber > reference * 10)
  return looksLikeBaseUnits ? formatUnitsBigInt(BigInt(value), precision, 8) : formatBalance(value)
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
      <Text fontSize="11px" color="kk.textMuted" flexShrink={0}>{label}</Text>
      <Text
        fontSize="11px"
        fontFamily="mono"
        fontWeight={accent ? "700" : "500"}
        color={accent ? "var(--teal)" : "kk.textSecondary"}
        textAlign="right"
        wordBreak="break-word"
      >
        {children}
      </Text>
    </Flex>
  )
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
  const spenderName = spenderHint(approve?.spender)

  return (
    <Box bg="rgba(0,0,0,0.20)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="3" py="2">
      <Flex align="center" justify="space-between" mb="2" gap="2">
        <Text fontSize="11px" fontWeight="700" color="kk.textPrimary">{title}</Text>
        <Text fontSize="10px" color="var(--teal)" fontFamily="mono">payload ready</Text>
      </Flex>
      <VStack gap="1" align="stretch">
        <ReviewRow label="Chain">{chain?.id || 'EVM'} ({tx?.chainId ?? '-'})</ReviewRow>
        <ReviewRow label="Contract">{ellipsizeMiddle(tx?.to)}</ReviewRow>
        {isApproval && approve && (
          <>
            <ReviewRow label="Spender">{spenderName ? `${spenderName} - ${ellipsizeMiddle(approve.spender)}` : ellipsizeMiddle(approve.spender)}</ReviewRow>
            <ReviewRow label="Approval amount" accent>
              {asset ? `${formatUnitsBigInt(approve.amount, asset.decimals, 8)} ${asset.symbol}` : approve.amount.toString()}
            </ReviewRow>
          </>
        )}
        {!isApproval && (
          <ReviewRow label="Value" accent>{formatNativeUnits(value, nativeDecimals, nativeSymbol)}</ReviewRow>
        )}
        <ReviewRow label="Max network fee" accent>{formatNativeUnits(maxNetworkFee, nativeDecimals, nativeSymbol, 8)}</ReviewRow>
        {maxFeePerGas !== null ? (
          <ReviewRow label="Fee data">
            max {formatGwei(maxFeePerGas)} / priority {formatGwei(maxPriorityFeePerGas)}
          </ReviewRow>
        ) : (
          <ReviewRow label="Fee data">{formatGwei(gasPrice)}</ReviewRow>
        )}
        <ReviewRow label="Gas / nonce">{gasLimit?.toString() || '-'} / {nonce?.toString() || '-'}</ReviewRow>
        <ReviewRow label="Method">{evmMethodLabel(tx?.data)}</ReviewRow>
        <ReviewRow label="Calldata">{evmDataBytes(tx?.data)} bytes{selector ? ` - ${selector}` : ''}</ReviewRow>
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

const ChevronDownIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
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

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
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
      {prefix}
      <CountUp key={num} start={0} end={num} decimals={decimals} duration={duration} separator="," preserveValue={false} />
      {suffix}
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
  const { t } = useTranslation("swap")

  /* ── Selected asset → big prominent display ── */
  if (selected) {
    return (
      <Box>
        <Flex justify="space-between" align="center" mb="3">
          <Text fontSize="xs" color="kk.textMuted" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">{label}</Text>
          {!disabled && (
            <Box as="button" display="flex" alignItems="center" gap="1" color="kk.textMuted" fontSize="11px" fontWeight="500"
              _hover={{ color: "kk.gold" }} transition="color 0.15s"
              onClick={onOpenPicker}>
              {t("change") || "Change"} <ChevronDownIcon />
            </Box>
          )}
        </Flex>
        <Flex
          align="center" gap="5"
          cursor={disabled ? "default" : "pointer"}
          opacity={disabled ? 0.7 : 1}
          onClick={() => { if (!disabled) onOpenPicker() }}
          _hover={disabled ? {} : { opacity: 0.85 }}
          transition="opacity 0.15s"
        >
          <Box position="relative" flexShrink={0}
            style={{ animation: 'kkLogoFloat 3s ease-in-out infinite, kkLogoGlow 3s ease-in-out infinite' }}>
            <AssetIcon
              caip={selected.caip}
              iconUrl={selected.icon}
              chainCaip={chainBadgeCaip(selected)}
              size={80}
              alt={selected.symbol}
              ring="rgba(139,227,196,0.28)"
            />
          </Box>
          <VStack gap="0" align="flex-start">
            <Text fontSize="lg" fontWeight="800" color="kk.textPrimary" lineHeight="1.1">{selected.symbol}</Text>
            <Text fontSize="xs" color="kk.textSecondary">{selected.name}</Text>
          </VStack>
        </Flex>
      </Box>
    )
  }

  /* ── No asset selected → dashed prompt ── */
  return (
    <Box>
      <Text fontSize="xs" color="kk.textMuted" mb="1" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">{label}</Text>
      <Flex
        as="button"
        align="center"
        gap="3"
        w="full"
        bg="rgba(255,255,255,0.03)"
        border="2px dashed"
        borderColor="rgba(255,255,255,0.1)"
        borderRadius="xl"
        px="4" py="5"
        cursor={disabled ? "default" : "pointer"}
        opacity={disabled ? 0.6 : 1}
        _hover={disabled ? {} : { borderColor: "kk.gold", bg: "rgba(233,196,106,0.04)" }}
        transition="all 0.2s"
        onClick={() => { if (!disabled) onOpenPicker() }}
      >
        <Box w="64px" h="64px" borderRadius="full" bg="rgba(255,255,255,0.06)" display="flex" alignItems="center" justifyContent="center">
          <Text fontSize="xl" color="kk.textMuted">?</Text>
        </Box>
        <Text fontSize="md" color="kk.textMuted" flex="1" textAlign="left" fontWeight="500">{t("selectAsset")}</Text>
        {!disabled && <ChevronDownIcon />}
      </Flex>
    </Box>
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
  const { t } = useTranslation("swap")
  const { fmtCompact, symbol: fiatSymbol } = useFiat()
  const { evmAddresses } = useEvmAddresses()
  // Local EVM address selection — scoped to this dialog so switching here doesn't
  // mutate the global selected index in AssetPage. null = use global selectedIndex.
  const [evmAddressIndexOverride, setEvmAddressIndexOverride] = useState<number | null>(null)
  const effectiveEvmIndex = evmAddressIndexOverride ?? evmAddresses.selectedIndex

  // ── State ─────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<SwapPhase>('input')
  const [assets, setAssets] = useState<SwapAsset[]>([])
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [assetLoadError, setAssetLoadError] = useState<string | null>(null)
  const [balances, setBalances] = useState<ChainBalance[]>([])
  // User-added custom tokens, refetched whenever the asset picker opens so a
  // freshly-added contract shows up on the next open without restarting.
  const [customTokens, setCustomTokens] = useState<CustomToken[]>([])

  const [fromAsset, setFromAsset] = useState<SwapAsset | null>(null)
  const [toAsset, setToAsset] = useState<SwapAsset | null>(null)
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
  const [error, setError] = useState<string | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Bump to force the quote useEffect to re-run with the same inputs (used by
  // the 'requote' RPC command — re-quoting on input changes is automatic).
  const [requoteTick, setRequoteTick] = useState(0)

  // Slippage tolerance in bps. Persisted across sessions in localStorage.
  // Allowed range: 10..5000 (0.1%..50%). Reject 0 — silent zero-slippage
  // ships swaps with no protection and routinely loses funds on volatile pairs.
  const [slippageBps, setSlippageBpsState] = useState<number>(() => {
    try {
      const raw = localStorage.getItem('swap.slippageBps')
      const n = raw ? parseInt(raw, 10) : NaN
      if (Number.isFinite(n) && n >= 10 && n <= 5000) return n
    } catch { /* localStorage unavailable */ }
    return 100 // 1% default
  })
  const setSlippageBps = useCallback((bps: number) => {
    const clamped = Math.max(10, Math.min(5000, Math.round(bps)))
    setSlippageBpsState(clamped)
    try { localStorage.setItem('swap.slippageBps', String(clamped)) } catch { /* ignore */ }
  }, [])

  // ── ExecuteSwap substage (retro #1 fix) ────────────────────────
  // Coarse `phase` is approving/signing/broadcasting. For ERC-20 swaps that
  // resolves to "approving" for the entire flow including the swap step,
  // making the UI lie ("Approving token… 1/2 Waiting on KeepKey" while the
  // device is actually prompting for the SWAP). Bun pushes finer-grained
  // substages via `swap-substage` so the label can reflect the truth.
  type SwapSubStage = 'approve-signing' | 'approve-broadcasting' | 'approve-waiting-receipt' | 'swap-signing' | 'swap-broadcasting'
  const [subStage, setSubStage] = useState<SwapSubStage | null>(null)
  useEffect(() => {
    return onRpcMessage('swap-substage', (msg: { stage: SwapSubStage }) => {
      setSubStage(msg.stage)
    })
  }, [])
  // Reset substage whenever we leave the busy phases
  useEffect(() => {
    if (phase !== 'approving' && phase !== 'signing' && phase !== 'broadcasting') {
      setSubStage(null)
    }
  }, [phase])

  // ── Live swap tracking state ────────────────────────────────────
  const [liveStatus, setLiveStatus] = useState<SwapTrackingStatus>('pending')
  const [liveConfirmations, setLiveConfirmations] = useState(0)
  const [liveOutboundConfirmations, setLiveOutboundConfirmations] = useState<number | undefined>()
  const [liveOutboundRequired, setLiveOutboundRequired] = useState<number | undefined>()
  const [liveOutboundTxid, setLiveOutboundTxid] = useState<string | undefined>()
  // Outbound chain may differ from toAsset.chainId — for refunds the outbound
  // is on the SOURCE chain. Populated from the Midgard classifier in the
  // tracker; falls back to toAsset.chainId when null.
  const [liveOutboundChainId, setLiveOutboundChainId] = useState<string | undefined>()
  const [liveRefundReason, setLiveRefundReason] = useState<string | undefined>()
  const [liveSwapper, setLiveSwapper] = useState<string | undefined>()
  const [liveRelayRequestId, setLiveRelayRequestId] = useState<string | undefined>()
  const [liveNearTxHash, setLiveNearTxHash] = useState<string | undefined>()
  const [rechecking, setRechecking] = useState(false)

  // ── Countdown timer ───────────────────────────────────────────────
  const [countdown, setCountdown] = useState(0)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Before/after balance tracking ─────────────────────────────────
  const [beforeFromBal, setBeforeFromBal] = useState<string | null>(null)
  const [beforeToBal, setBeforeToBal] = useState<string | null>(null)
  const [afterFromBal, setAfterFromBal] = useState<string | null>(null)
  const [afterToBal, setAfterToBal] = useState<string | null>(null)
  const [showConfetti, setShowConfetti] = useState(false)
  const completionFiredRef = useRef(false)

  // ── Frozen amount sent (captured at execution time so balance changes don't affect display) ──
  const [sentAmount, setSentAmount] = useState<string | null>(null)

  const [showDetails, setShowDetails] = useState(false)

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
    const destChain = toAsset ? CHAINS.find(c => c.id === toAsset.chain || c.coin === toAsset.chain) : null
    if (destChain) {
      const result = validateAddress(trimmed, destChain)
      if (!result.valid) return result.error || 'Invalid address format for this chain'
    } else {
      if (/\s/.test(trimmed)) return 'Address must not contain spaces'
      if (trimmed.length < 10) return 'Address is too short'
    }
    return ''
  }, [useCustomAddress, customToAddress, toAsset])

  // ── Derived terminal status (must be before effects that depend on them) ──
  const isSwapComplete = liveStatus === 'completed'
  const isSwapFailed = liveStatus === 'failed' || liveStatus === 'refunded'

  // ── Listen for swap-update + swap-complete RPC messages ─────────
  useEffect(() => {
    if (!txid || phase !== 'submitted') return

    const unsub1 = onRpcMessage('swap-update', (update: SwapStatusUpdate) => {
      if (update.txid !== txid) return
      setLiveStatus(update.status)
      if (update.confirmations !== undefined) setLiveConfirmations(update.confirmations)
      if (update.outboundConfirmations !== undefined) setLiveOutboundConfirmations(update.outboundConfirmations)
      if (update.outboundRequiredConfirmations !== undefined) setLiveOutboundRequired(update.outboundRequiredConfirmations)
      if (update.outboundTxid) setLiveOutboundTxid(update.outboundTxid)
      if (update.swapper) setLiveSwapper(update.swapper)
      if (update.relayRequestId) setLiveRelayRequestId(update.relayRequestId)
      if (update.outboundChainId) setLiveOutboundChainId(update.outboundChainId)
      if (update.refundReason) setLiveRefundReason(update.refundReason)
      if (update.nearTxHash) setLiveNearTxHash(update.nearTxHash)
    })

    const unsub2 = onRpcMessage('swap-complete', (swap: any) => {
      if (swap.txid !== txid) return
      setLiveStatus(swap.status || 'completed')
    })

    return () => { unsub1(); unsub2() }
  }, [txid, phase])

  // ── On-demand Pioneer polling — only while the dialog is open on this swap.
  // Pull immediately on mount, then on a 10s tick. Stops when the swap
  // reaches a terminal state, when the user closes the dialog, or when the
  // phase moves away.
  //
  // NOTE: deps are deliberately [txid, phase] — NOT liveStatus. Including
  // liveStatus here causes a runaway loop: every status push from the
  // tracker re-runs the effect, the cleanup cancels the in-flight tick,
  // a new tick fires immediately, hits Pioneer/Midgard, gets a different
  // status, pushes again, infinitely. The tick reads the latest status
  // through a ref instead.
  const liveStatusRef = useRef(liveStatus)
  useEffect(() => { liveStatusRef.current = liveStatus }, [liveStatus])
  useEffect(() => {
    if (!txid || phase !== 'submitted') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (cancelled) return
      try {
        const snap = await rpcRequest<any>('refreshSwap', { txid })
        // Guard after the await — dialog may have closed or switched txids.
        if (cancelled) return
        // Apply fields that the tracker only pushes once (nearTxHash, relayRequestId)
        // so the dialog is always current even if it opened after the initial push.
        if (snap?.nearTxHash) setLiveNearTxHash(snap.nearTxHash)
        if (snap?.relayRequestId) setLiveRelayRequestId(snap.relayRequestId)
      } catch { /* swap-update push will retry on next tick */ }
      if (cancelled) return
      const s = liveStatusRef.current
      if (s === 'completed' || s === 'failed' || s === 'refunded') return
      timer = setTimeout(tick, 10_000)
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [txid, phase])

  // ── Manual recheck — fires a single immediate poll on demand ──────
  const handleRecheck = useCallback(async () => {
    if (!txid || rechecking) return
    setRechecking(true)
    try {
      const snap = await rpcRequest<any>('refreshSwap', { txid })
      if (snap?.nearTxHash) setLiveNearTxHash(snap.nearTxHash)
      if (snap?.relayRequestId) setLiveRelayRequestId(snap.relayRequestId)
    } catch { /* swap-update push covers the failure */ }
    setRechecking(false)
  }, [txid, rechecking])

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
      setLiveConfirmations(0)
      setLiveOutboundConfirmations(undefined)
      setLiveOutboundRequired(undefined)
      setLiveOutboundTxid(undefined)
      setLiveOutboundChainId(undefined)
      setLiveRefundReason(undefined)
      setLiveSwapper(undefined)
      setLiveRelayRequestId(undefined)
      setLiveNearTxHash(undefined)
      setAfterFromBal(null)
      setAfterToBal(null)
      setShowConfetti(false)
      completionFiredRef.current = false
      setCountdown(0)
      if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    }
  }, [phase])

  // Countdown timer — ticks every second from estimatedTime to 0, stops on complete/failed
  useEffect(() => {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    if (phase === 'submitted' && quote?.estimatedTime && quote.estimatedTime > 0 && !isSwapComplete && !isSwapFailed) {
      setCountdown(quote.estimatedTime)
      countdownRef.current = setInterval(() => {
        setCountdown(prev => prev > 0 ? prev - 1 : 0)
      }, 1000)
    }
    return () => { if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null } }
  }, [phase, quote?.estimatedTime, isSwapComplete, isSwapFailed])

  // Fire confetti + sound + fetch after-balances when swap completes
  useEffect(() => {
    if (!isSwapComplete || completionFiredRef.current) return
    completionFiredRef.current = true
    setShowConfetti(true)
    playCompletionSound()
    setTimeout(() => setShowConfetti(false), 1500)
    // Fetch updated balances to show before/after diff
    rpcRequest<ChainBalance[]>('getBalances', undefined, 120000)
      .then((result) => {
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
  const swapStep = useMemo(() => {
    if (liveStatus === 'completed') return 3
    if (liveStatus === 'output_detected' || liveStatus === 'output_confirming' || liveStatus === 'output_confirmed') return 2
    if (liveStatus === 'confirming') return 1
    return 0 // pending
  }, [liveStatus])

  // ── Load cached balances ──────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    rpcRequest<{ balances: ChainBalance[]; updatedAt: number } | null>('getCachedBalances', undefined, 5000)
      .then((result) => {
        if (result?.balances) setBalances(result.balances)
      })
      .catch(() => {})
  }, [open])

  // ── Live balance sync — keep sendMax math current ──────────────────
  // Dashboard subscribes to balance-updated; SwapDialog must too, or
  // sendMax calculations run against the snapshot from dialog-open time.
  useEffect(() => {
    if (!open) return
    return onRpcMessage('balance-updated', (updated: ChainBalance) => {
      setBalances(prev => {
        const idx = prev.findIndex(b => b.chainId === updated.chainId)
        if (idx === -1) return [...prev, updated]
        const next = [...prev]
        next[idx] = updated
        return next
      })
    })
  }, [open])

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

  // ── Resume from swap history ──────────────────────────────────────
  const hasResumedRef = useRef<string | null>(null)
  // Clear resume guard when dialog closes so re-clicking same swap works
  useEffect(() => {
    if (!open) hasResumedRef.current = null
  }, [open])
  useEffect(() => {
    if (!open || !resumeSwap || hasResumedRef.current === resumeSwap.txid) return
    hasResumedRef.current = resumeSwap.txid

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
    setLiveConfirmations(resumeSwap.confirmations)
    if (resumeSwap.outboundConfirmations !== undefined) setLiveOutboundConfirmations(resumeSwap.outboundConfirmations)
    if (resumeSwap.outboundRequiredConfirmations !== undefined) setLiveOutboundRequired(resumeSwap.outboundRequiredConfirmations)
    if (resumeSwap.outboundTxid) setLiveOutboundTxid(resumeSwap.outboundTxid)
    if (resumeSwap.relayRequestId) setLiveRelayRequestId(resumeSwap.relayRequestId)
    // Seed outbound chain + refund reason from the persisted record so a
    // refund's explorer link points at the source chain on first render —
    // without this, the explorer falls back to toAsset.chainId until the
    // next refresh push, and refunded ETH→ZEC briefly opens a Zcash explorer
    // for what is actually an ETH refund tx.
    if (resumeSwap.outboundChainId) setLiveOutboundChainId(resumeSwap.outboundChainId)
    if (resumeSwap.refundReason) setLiveRefundReason(resumeSwap.refundReason)
    if (resumeSwap.nearTxHash) setLiveNearTxHash(resumeSwap.nearTxHash)
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
      minimumOutput: resumeSwap.expectedOutput,
      inboundAddress: resumeSwap.inboundAddress,
      router: resumeSwap.router,
      memo: resumeSwap.memo,
      fees: { affiliate: '0', outbound: '0', totalBps: 0 },
      estimatedTime: resumeSwap.estimatedTime,
      integration: resumeSwap.integration,
      // Preserve real slippage from history; fall back to current setting so
      // the review screen never displays a misleading 0%.
      slippageBps: resumeSwap.slippageBps ?? slippageBps,
    })
    setPhase('submitted')
  }, [open, resumeSwap])

  // ── Derived values ────────────────────────────────────────────────
  const fromBalance = useMemo(() => {
    if (!fromAsset) return null
    // For EVM assets, use the effective address's per-chain balance so the
    // spendable amount reflects the address that will actually sign.
    if (fromAsset.chainFamily === 'evm' && evmAddresses.addresses.length > 0) {
      const selectedAddr = evmAddresses.addresses.find(a => a.addressIndex === effectiveEvmIndex)
      const chainBal = selectedAddr?.chainBalances?.[fromAsset.chainId]
      if (chainBal) {
        if (fromAsset.contractAddress && chainBal.tokens) {
          const token = chainBal.tokens.find(t =>
            t.contractAddress?.toLowerCase() === fromAsset.contractAddress?.toLowerCase()
          )
          if (token) return token.balance
        }
        if (!fromAsset.contractAddress) return chainBal.balance
      }
    }
    // Check cached balances (aggregated per-chain from getBalances RPC)
    const cb = balances.find(b => b.chainId === fromAsset.chainId)
    if (cb) {
      if (fromAsset.contractAddress && cb.tokens) {
        const token = cb.tokens.find(t =>
          t.contractAddress?.toLowerCase() === fromAsset.contractAddress?.toLowerCase()
        )
        if (token) return token.balance
      }
      if (!fromAsset.contractAddress) return cb.balance
    }
    // Fall back to prop balance only when cache has no entry for this chain
    if (balance && chain && fromAsset.chainId === chain.id && !fromAsset.contractAddress) {
      return balance.balance
    }
    return null
  }, [fromAsset, balance, chain, balances, evmAddresses, effectiveEvmIndex])

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

  /* Resolved (amount, isMax) tuple to send to the backend. For fee-reserved native
   * and token-precision-reserved MAX the amount is already clamped, so isMax
   * is dropped to keep the quote, display, and submitted amount honest. For
   * all other MAX sends, isMax remains true so the backend's chain-aware fee
   * math runs. */
  const sendAmount = useMemo(() => {
    if (!isMax) return amount
    return nativeFeeReservedMaxAmount ?? tokenPrecisionReservedMaxAmount ?? (fromBalance || '0')
  }, [isMax, amount, nativeFeeReservedMaxAmount, tokenPrecisionReservedMaxAmount, fromBalance])

  const sendIsMax = isMax && nativeFeeReservedMaxAmount === null && tokenPrecisionReservedMaxAmount === null

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
      return nativePriceUsd(candidate) > 0
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
    const result = nativePriceUsd(cb)
    swapLog(`[SWAP-PRICE] toPriceUsdFromBalance RESULT: $${result}`)
    return result
  }, [toAsset, balances])

  // Derive TO price from quote exchange rate when balance-based price is unavailable
  // (e.g., user has dust/zero native balance but tokens on the chain)
  const toPriceUsd = useMemo(() => {
    // When isMax, amount is "" — use fromBalance instead (same as quote request logic)
    const effectiveAmount = sendAmount
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
  }, [toPriceUsdFromBalance, fromPriceUsd, quote?.expectedOutput, sendAmount, isMax])

  const hasFromPrice = fromPriceUsd > 0
  const hasToPrice = toPriceUsd > 0
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
    setAmount(v)
    setIsMax(false)
    setMaxReserveMode('safe')
    if (hasFromPrice && v) {
      const n = parseFloat(v)
      if (!isNaN(n)) setFiatAmount((n * fromPriceUsd).toFixed(2))
      else setFiatAmount("")
    } else {
      setFiatAmount("")
    }
  }, [hasFromPrice, fromPriceUsd])

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
    const balUsd = balNum * fromPriceUsd

    if (balUsd <= 100) {
      setIsMax(true)
      setMaxReserveMode('safe')
    } else {
      const cryptoAmount = 100 / fromPriceUsd
      const formatted = cryptoAmount < 1
        ? cryptoAmount.toPrecision(6)
        : cryptoAmount.toFixed(6).replace(/\.?0+$/, '')
      handleCryptoChange(formatted)
    }
  }, [fromAsset, fromPriceUsd, fromBalance, amount, isMax, handleCryptoChange])

  // Bidirectional conversion: fiat → crypto
  const handleFiatChange = useCallback((v: string) => {
    setFiatAmount(v)
    setIsMax(false)
    setMaxReserveMode('safe')
    if (hasFromPrice && v) {
      const n = parseFloat(v)
      if (!isNaN(n)) {
        const crypto = n / fromPriceUsd
        setAmount(crypto < 1 ? crypto.toPrecision(8) : crypto.toFixed(8).replace(/\.?0+$/, ''))
      } else {
        setAmount("")
      }
    } else {
      setAmount("")
    }
  }, [hasFromPrice, fromPriceUsd])

  const toggleInputMode = useCallback(() => {
    setInputMode(prev => prev === 'crypto' ? 'fiat' : 'crypto')
  }, [])

  // USD preview of the entered amount
  const amountUsdPreview = useMemo(() => {
    if (!hasFromPrice || isMax) return null
    const n = parseFloat(amount)
    if (isNaN(n) || n <= 0) return null
    return n * fromPriceUsd
  }, [amount, hasFromPrice, fromPriceUsd, isMax])

  const amountNum = parseFloat(amount)
  const balanceNum = fromBalance ? parseFloat(fromBalance) : 0
  const exceedsBalance = !isMax && !isNaN(amountNum) && amountNum > 0 && balanceNum > 0 && amountNum > balanceNum
  const sameAsset = fromAsset && toAsset && fromAsset.asset === toAsset.asset

  const fromAddress = useMemo(() => {
    if (!fromAsset) return ''
    // EVM: always derive from the effective address index so fromAddress,
    // fromBalance, and fromEvmAddressIndex are always in sync.
    if (fromAsset.chainFamily === 'evm' && evmAddresses.addresses.length > 0) {
      const selectedAddr = evmAddresses.addresses.find(a => a.addressIndex === effectiveEvmIndex)
      if (selectedAddr?.address) return selectedAddr.address
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
    const cb = balances.find(b => b.chainId === toAsset.chainId)
    return cb?.address || ''
  }, [toAsset, balances])

  // For UTXO destinations, ensure we display (and use) a real receive address
  // rather than an xpub. Mirrors the re-derive effect AssetPage runs on mount.
  const [resolvedToAddress, setResolvedToAddress] = useState<string>('')
  const [destAddressError, setDestAddressError] = useState<string | null>(null)
  useEffect(() => {
    setResolvedToAddress('')
    setDestAddressError(null)
    if (!toAsset) return
    const toChain = CHAINS.find(c => c.id === toAsset.chainId)
    if (!toChain) return
    if (toChain.chainFamily !== 'utxo') return
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
        const result = await rpcRequest<any>(toChain.rpcMethod, params, 60000)
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

  const fromChainDef = useMemo(() => (
    fromAsset ? CHAINS.find(c => c.id === fromAsset.chainId) : undefined
  ), [fromAsset])

  const maxAmountReady = isMax && !isNaN(parseFloat(sendAmount)) && parseFloat(sendAmount) > 0
  const manualAmountReady = amount !== '' && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0
  const validAmount = isMax ? (maxAmountReady && !nativeMaxInsufficient && !tokenMaxInsufficient) : manualAmountReady
  // SAFETY: never quote with an xpub as the destination. Pioneer will accept
  // it and substitute a self-derived address, but funds would land at an
  // address that didn't come from the user's wallet. Wait for the UTXO
  // resolver to populate a real receive address.
  const toAddressIsXpub = !!toAddress && !useCustomAddress && XPUB_RE.test(toAddress)
  const canQuote = fromAsset && toAsset && !sameAsset && validAmount && fromAddress && toAddress && !toAddressIsXpub && !exceedsBalance && !customAddressError

  // ── Preview-build the unsigned tx(s) when entering Confirm Quote ──
  // Fires once per quote — gives the user the exact payload to audit before
  // clicking Confirm. Build inputs (gas/nonce) may shift slightly between
  // preview and the real execute build; that's expected.
  useEffect(() => {
    if (phase !== 'review' || !quote || !fromAsset || !toAsset) {
      setPreviewBuild(null); setPreviewError(null); setPreviewLoading(false)
      return
    }
    let cancelled = false
    setPreviewLoading(true); setPreviewError(null); setPreviewBuild(null)
    rpcRequest<SwapPreviewBuild>('previewSwapBuild', {
      fromChainId: fromAsset.chainId,
      toChainId: toAsset.chainId,
      fromCaip: fromAsset.caip!,
      toCaip: toAsset.caip!,
      amount: sendAmount,
      memo: quote.memo,
      inboundAddress: quote.inboundAddress,
      router: quote.router,
      expiry: quote.expiry,
      expectedOutput: quote.expectedOutput,
      isMax: sendIsMax, feeLevel: 5,
      fromAddressOverride: fromAddress,
      toAddressOverride: toAddress,
      fromEvmAddressIndex: fromAsset.chainFamily === 'evm' ? evmAddresses.selectedIndex : undefined,
      integration: quote.integration,
      relayTx: quote.relayTx,
    }).then((res) => { if (!cancelled) { setPreviewBuild(res); setPreviewLoading(false) } })
      .catch((e: any) => { if (!cancelled) { setPreviewError(e?.message || 'Preview failed'); setPreviewLoading(false) } })
    return () => { cancelled = true }
  }, [phase, quote, fromAsset, toAsset, sendAmount, sendIsMax, fromBalance, fromAddress, toAddress])

  const auditPayloadReady = !!previewBuild?.unsignedTx
  const previewBalanceBlocked = !!previewBuild?.balance && !previewBuild.balance.sufficient
  const reviewConfirmLocked =
    phase === 'review' && (
      refreshingQuote ||
      previewLoading ||
      !!previewError ||
      !auditPayloadReady ||
      previewBalanceBlocked
    )
  const reviewConfirmLockLabel =
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
    if (phase === 'review' || phase === 'submitted' || phase === 'signing' || phase === 'broadcasting' || phase === 'approving') return

    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current)
    setQuote(null)
    const version = ++quoteVersionRef.current

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
        const result = await rpcRequest<SwapQuote>('getSwapQuote', {
          fromCaip: fromAsset!.caip,
          toCaip: toAsset!.caip,
          amount: sendAmount,
          fromAddress,
          toAddress,
          slippageBps,
          isMax: sendIsMax,
        }, 30000)
        if (version !== quoteVersionRef.current) return
        setQuote(result)
        setQuoteFetchedAt(Date.now())
        setPhase('input')
      } catch (e: any) {
        if (version !== quoteVersionRef.current) return
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
        } else {
          setError(msg || t("errorQuote"))
        }
        setPhase('input')
      }
    }, 800)

    return () => {
      if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current)
    }
  }, [fromAsset?.asset, toAsset?.asset, sendAmount, sendIsMax, fromAddress, toAddress, exceedsBalance, fromBalance, slippageBps, requoteTick, destAddressError, toAddressIsXpub])

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

  // ── Execute swap ──────────────────────────────────────────────────
  const handleExecuteSwap = useCallback(async () => {
    if (!quote || !fromAsset || !toAsset) return
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

    // Refresh stale quote (>60s old) before signing — protects against price drift
    // between when the user first saw the quote and when they actually confirm.
    let liveQuote: SwapQuote = quote
    const age = Date.now() - (quoteFetchedAt || 0)
    if (age > 60_000) {
      setRefreshingQuote(true)
      try {
        const refreshed = await rpcRequest<SwapQuote>('getSwapQuote', {
          fromCaip: fromAsset.caip!,
          toCaip: toAsset.caip!,
          amount: sendAmount,
          fromAddress, toAddress, slippageBps,
          isMax: sendIsMax,
        }, 30000)
        // Block on >1% output drop — quote degraded, user should re-review
        const oldOut = parseFloat(quote.expectedOutput || '0')
        const newOut = parseFloat(refreshed.expectedOutput || '0')
        if (oldOut > 0 && newOut > 0 && (oldOut - newOut) / oldOut > 0.01) {
          const dropPct = (((oldOut - newOut) / oldOut) * 100).toFixed(2)
          console.warn(`[swap] Quote refreshed: output ${oldOut} → ${newOut} (-${dropPct}%) — aborting for re-review`)
          setQuote(refreshed)
          setQuoteFetchedAt(Date.now())
          setRefreshingQuote(false)
          setError(t("quoteShiftedReReview", "Quote refreshed and dropped {{pct}}% — please review the new numbers and confirm again", { pct: dropPct }))
          return
        }
        setQuote(refreshed)
        setQuoteFetchedAt(Date.now())
        setRefreshingQuote(false)
        setPreviewBuild(null)
        setError(t("quoteRefreshedReviewPayload", "Quote refreshed. Review the rebuilt payload before confirming."))
        return
      } catch (e: any) {
        setRefreshingQuote(false)
        setError(`Failed to refresh stale quote: ${e?.message || 'unknown error'}`)
        return
      }
      setRefreshingQuote(false)
    }

    setPhase(isErc20 ? 'approving' : 'signing')
    setError(null)

    // Freeze the sent amount so balance changes don't affect the display
    setSentAmount(sendAmount)

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

    try {
      const result = await rpcRequest<{ txid: string; approvalTxid?: string }>('executeSwap', {
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
      }, 600000)

      setTxid(result.txid)
      setPhase('submitted')
      window.dispatchEvent(new CustomEvent('keepkey-swap-executed'))
    } catch (e: any) {
      const raw = e?.message || ''
      // User-friendly categorization. Order: device-rejected first (most common during sign), then on-chain reverts, then network/RPC.
      let friendly = raw || t("errorSwap")
      if (/User rejected|user denied|device.*reject/i.test(raw)) {
        friendly = t("deviceRejected", "Cancelled on device — no transaction was sent")
      } else if (/Review timed out|review timeout/i.test(raw)) {
        friendly = t("reviewTimeout", "Review timed out — no transaction was sent")
      } else if (/User rejected the transaction/i.test(raw)) {
        friendly = t("userRejectedTx", "You rejected the transaction. No funds moved.")
      } else if (/reverted on-chain/i.test(raw)) {
        friendly = t("approvalReverted", "Approval reverted on-chain — swap aborted to protect funds")
      } else if (/Insufficient.*for gas|insufficient funds/i.test(raw)) {
        friendly = t("insufficientGas", "Not enough gas in the source chain's native asset")
      } else if (/nonce|fetch nonce/i.test(raw)) {
        friendly = t("nonceError", "Network error fetching nonce — retry in a moment")
      } else if (/timed out|ETIMEDOUT|fetch failed|network/i.test(raw)) {
        friendly = t("networkErrorSwap", "Network error — retry in a moment")
      }
      setError(friendly)
      setPhase('review')
    }
  }, [quote, quoteFetchedAt, fromAsset, toAsset, sendAmount, sendIsMax, fromBalance, fromAddress, toAddress, slippageBps, balances, phase, previewLoading, previewError, previewBuild])

  // ── Reset ─────────────────────────────────────────────────────────
  const reset = useCallback(() => {
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
    if (phase === 'signing' || phase === 'broadcasting' || phase === 'approving') return
    onClose()
    // Reset state after close animation
    setTimeout(reset, 200)
  }, [phase, onClose, reset])

  // Cancel a confirm-on-device prompt and back out to review. Sends a Cancel
  // message to the device (frees the transport lock + dismisses the on-screen
  // prompt), then resets the dialog to 'review' so the user can change inputs
  // or just close. Broadcasting can NOT be cancelled — the signed tx is
  // already on its way to the network and there's no unwind.
  const handleCancelSigning = useCallback(async () => {
    if (phase !== 'signing' && phase !== 'approving') return
    try { await rpcRequest<{ ok: boolean }>('cancelDeviceSigning', undefined, 5000) } catch (e: any) {
      console.warn('[SwapDialog] cancelDeviceSigning failed:', e?.message || e)
    }
    setPhase('review')
    setError(t('swapCancelled', 'Swap cancelled — confirm again or change inputs'))
  }, [phase, t])

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
  const displayAmount = sentAmount ?? sendAmount

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
      amount,
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
  }, [open, phase, fromAsset?.asset, toAsset?.asset, amount, fiatAmount, inputMode, isMax, slippageBps, fromAddress, toAddress, useCustomAddress, customToAddress, quote, previewBuild, error, txid, liveStatus, liveConfirmations, liveOutboundConfirmations, liveOutboundRequired, liveOutboundTxid, liveRelayRequestId, liveRefundReason])

  // Reset the cached snapshot to 'closed' when the dialog unmounts so a stale
  // open state doesn't outlive the user closing the dialog.
  useEffect(() => {
    return () => {
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
  }, [])

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
      if (cmd.kind === 'close') { onClose(); return }
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
      const fields = cmd
      if ('fromAsset' in fields && fields.fromAsset !== undefined) {
        const a = findAssetByKey(fields.fromAsset)
        if (a) { setFromAsset(a); setMaxReserveMode('safe') }
        else pendingFromAssetKeyRef.current = fields.fromAsset
      }
      if ('toAsset' in fields && fields.toAsset !== undefined) {
        const a = findAssetByKey(fields.toAsset)
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
  }, [open, assets, onClose, setSlippageBps, phase, quote, fromAsset, toAsset, handleExecuteSwap, findAssetByKey, previewBuild, previewError, previewLoading])

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

  if (!open) return null
  if (chain && !resumeSwap && !loadingAssets && assets.length > 0 && !swappableChainIds.has(chain.id)) {
    return (
      <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={handleClose}>
        <Box position="absolute" inset="0" bg="rgba(0,0,0,0.6)" backdropFilter="blur(8px)" />
        <Box position="relative" bg="kk.cardBg" border="2px solid" borderColor="rgba(139,227,196,0.4)" borderRadius="xl" boxShadow="0 0 20px rgba(139,227,196,0.12)" p="6" w="400px" maxW="90vw" onClick={(e) => e.stopPropagation()} textAlign="center">
          <Flex justify="center"><ProviderBadge swapper="thorchain" size={32} variant="compact" /></Flex>
          <Text fontSize="sm" color="kk.textMuted" mt="3">{t("notSupported", { coin: chain.coin })}</Text>
          <Button size="sm" mt="4" variant="ghost" color="kk.textSecondary" px="4" py="2" onClick={handleClose}>{t("close")}</Button>
        </Box>
      </Box>
    )
  }

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={handleClose}>
      <style>{DIALOG_CSS}</style>
      <Box position="absolute" inset="0" bg="rgba(0,0,0,0.6)" backdropFilter="blur(8px)" />
      <Box
        position="relative"
        bg="linear-gradient(180deg, var(--ink-2), var(--ink-1))"
        border="1px solid var(--line-2)"
        borderRadius="var(--r-xl)"
        boxShadow="0 20px 80px -20px rgba(139,227,196,0.20), 0 0 0 1px rgba(255,255,255,0.04) inset"
        w={isSwapComplete && phase === 'submitted' ? "1040px" : "760px"}
        maxW="94vw"
        maxH="90vh"
        overflow="auto"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <Flex px="5" py="2.5" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between"
          bg="transparent">
          <HStack gap="2">
            <ProviderBadge swapper={quote?.swapper || liveSwapper || quote?.integration} size={22} variant="compact" />
            <Text fontSize="sm" fontWeight="700" color="kk.textPrimary" letterSpacing="-0.01em">
              {phase === 'review' ? t("review") : phase === 'submitted' ? t("swapSubmitted") : t("title")}
            </Text>
          </HStack>
          <HStack gap="2" align="center">
            {/* Provider health dots — click to open detail dialog */}
            {swapHealth && (
              <HStack
                gap="2" px="2" py="1" borderRadius="full" cursor="pointer"
                bg="rgba(255,255,255,0.04)" _hover={{ bg: 'rgba(255,255,255,0.08)' }}
                border="1px solid" borderColor="kk.border"
                title="Click for swap provider status"
                onClick={() => setHealthDialogOpen(true)}
              >
                {swapHealth.integrations.map(intg => {
                  const dotColor =
                    intg.status === 'ok'       ? '#22c55e' :
                    intg.status === 'degraded' ? '#f59e0b' :
                    intg.status === 'offline'  ? '#ef4444' : '#6b7280'
                  const hoverLabel =
                    intg.status === 'ok'       ? `${intg.label}: operational` :
                    intg.status === 'degraded' ? `${intg.label}: ${intg.detail || 'some pairs unavailable'}` :
                    intg.status === 'offline'  ? `${intg.label}: unreachable` :
                    `${intg.label}: status unknown`
                  return (
                    <Box key={intg.key} title={hoverLabel}
                      w="7px" h="7px" borderRadius="full" flexShrink={0}
                      style={{
                        background: dotColor,
                        boxShadow: intg.status === 'ok' ? `0 0 5px ${dotColor}99` : 'none',
                      }}
                    />
                  )
                })}
              </HStack>
            )}
            {!busy && (
              <Button size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto" _hover={{ color: "kk.textPrimary" }} onClick={handleClose}>
                &times;
              </Button>
            )}
          </HStack>
        </Flex>

        {/* ── Body ────────────────────────────────────────────────── */}
        {/* Padding zeroed on the complete-swap view so the 2-column hero/details
            layout reaches the modal edges and the footer can span full width. */}
        <Box
          px={isSwapComplete && phase === 'submitted' ? "0" : "5"}
          py={isSwapComplete && phase === 'submitted' ? "0" : "3"}
        >
          {/* Loading state */}
          {loadingAssets && (
            <Box py="8" textAlign="center">
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
                  onClick={() => { setLoadingAssets(true); setAssetLoadError(null); rpcRequest<SwapAsset[]>('getSwapAssets', undefined, 20000).then(r => { setAssets(r); setLoadingAssets(false); if (!r?.length) setAssetLoadError('No swap assets available') }).catch(e => { setLoadingAssets(false); setAssetLoadError(e?.message || 'Failed to load') }) }}>
                  Retry
                </Button>
                <Button size="sm" variant="ghost" color="kk.textMuted" px="4" py="2" onClick={handleClose}>
                  {t("close")}
                </Button>
              </Flex>
            </VStack>
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
                        <Text>{t("youReceived", "You received")}</Text>
                      </Flex>
                      <Flex position="relative" align="baseline" gap="2.5">
                        <Text fontFamily="mono" fontSize="30px" fontWeight={600} color="var(--gold)"
                          letterSpacing="-0.02em" lineHeight="1.05">
                          ~{quote?.expectedOutput ? formatBalance(quote.expectedOutput) : '—'}
                        </Text>
                        <Text fontSize="16px" color="kk.textSecondary" fontWeight={500}>{toAsset.symbol}</Text>
                      </Flex>
                      {hasToPrice && quote?.expectedOutput && (
                        <Text position="relative" mt="1" fontSize="12px" color="kk.textMuted" fontFamily="mono">
                          ≈ {fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}
                          {hasFromPrice && (() => {
                            const sentUsd = parseFloat(displayAmount || '0') * fromPriceUsd
                            const recvUsd = parseFloat(quote.expectedOutput) * toPriceUsd
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
                          <Text>{liveOutboundTxid ? '2 hashes' : '1 hash'}</Text>
                          {(() => {
                            const protoHint = liveSwapper || quote?.swapper || quote?.integration
                            const tracker = providerTrackerUrl(protoHint, txid, { relayRequestId: liveRelayRequestId, nearTxHash: liveNearTxHash })
                            return tracker ? <Text>· tracker</Text> : null
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
                                  onClick={() => rpcRequest('openUrl', { url }).catch(() => { })}>
                                  Explorer
                                </Button>
                              ) : null
                            })()}
                          </HStack>
                        </Flex>
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
                                    onClick={() => rpcRequest('openUrl', { url }).catch(() => { })}>
                                    Explorer
                                  </Button>
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
                    <Text fontSize="xs" color="var(--gold)" fontWeight="500" mt="0.5">{t("waitingForConfirmations")}</Text>
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
                    w={isSwapComplete ? '100%' : swapStep === 2 ? '83%' : swapStep === 1 ? '50%' : '17%'}
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

              {/* Live countdown — only show when not complete */}
              {!isSwapComplete && !isSwapFailed && (countdown > 0 || (quote?.estimatedTime && quote.estimatedTime > 0)) && (
                <Flex w="full" justify="center" align="center" gap="3"
                  bg="rgba(139,227,196,0.08)" border="1px solid" borderColor="rgba(139,227,196,0.18)"
                  borderRadius="lg" px="4" py="2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                  <Text fontSize="sm" fontFamily="mono" fontWeight="700" color="var(--teal)">
                    {countdown > 0 ? (
                      <>{Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}</>
                    ) : formatTime(quote?.estimatedTime || 0)}
                  </Text>
                  <Text fontSize="10px" color="kk.textMuted">{t("estimatedTime")}</Text>
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
                <Text color="var(--gold)" fontSize="md" fontWeight="700">&rarr;</Text>
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
                <Flex gap="2">
                  {!isSwapComplete && !isSwapFailed && (
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
                        <Text fontSize="10px">{rechecking ? 'Checking...' : 'Recheck'}</Text>
                      </HStack>
                    </Button>
                  )}
                  {(() => {
                    const safeTxid = txid ?? ''
                    console.log('[explorer-debug]', fromAsset.chainId, safeTxid)
                    const url = getExplorerTxUrl(fromAsset.chainId, safeTxid)
                    return url ? (
                      <Button size="xs" flex="1" variant="outline" borderColor="kk.border" color="kk.textSecondary"
                        _hover={{ bg: "rgba(255,255,255,0.06)", color: "kk.textPrimary" }}
                        onClick={() => rpcRequest('openUrl', { url }).catch(() => {})}>
                        <HStack gap="1"><ExternalLinkIcon /><Text fontSize="10px">Explorer</Text></HStack>
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
                            onClick={() => rpcRequest('openUrl', { url }).catch(() => {})} title="View on explorer">
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
                  <Text fontSize="10px" fontWeight="600" color="var(--teal)" mb="2" textTransform="uppercase" letterSpacing="0.05em">
                    Balance Changes
                  </Text>
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
                          <Text fontSize="10px" color="kk.textMuted">&rarr;</Text>
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
                          <Text fontSize="10px" color="kk.textMuted">&rarr;</Text>
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
          {/* ── AWAITING DEVICE — dedicated full-screen confirm
              Per handoff design: 220px KeepKey gif, prominent headline,
              concise instruction, then a single summary chip. The
              substage detail moves into the chip area as small mono text
              instead of competing with the device illustration. */}
          {busy && fromAsset && toAsset && (
            <VStack gap="6" py="6" align="center" position="relative" style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }}>
              {/* Cancel/X — only meaningful while the device is awaiting a
                  button press (signing/approving). Once the user has confirmed
                  on device and we're broadcasting, the tx is already going
                  to the network and there's no unwind. */}
              {(phase === 'signing' || phase === 'approving') && (
                <Box position="absolute" top="0" right="0">
                  <Button
                    size="sm"
                    variant="ghost"
                    color="kk.textMuted"
                    px="2"
                    minW="auto"
                    aria-label={t('cancel', 'Cancel')}
                    title={t('cancelSwapDevice', 'Cancel - release device prompt')}
                    onClick={handleCancelSigning}
                    _hover={{ color: 'kk.textPrimary' }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </Button>
                </Box>
              )}

              {/* Big device illustration — 6-face CSS-3D KeepKey rotating
                  around its Y axis. The OLED face mirrors the swap pair the
                  user is being asked to confirm so the device shown matches
                  the action requested. */}
              <Box flexShrink={0} w="380px" maxW="100%">
                <SpinningDevice
                  durationSeconds={subStage?.endsWith('-broadcasting') || phase === 'broadcasting' ? 8 : 14}
                  screen={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, opacity: 0.55, letterSpacing: 2, marginBottom: 4 }}>
                          {(subStage === 'approve-signing' || phase === 'approving') ? 'APPROVE' : 'CONFIRM SWAP'}
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1 }}>
                          {displayAmount} {fromAsset.symbol}
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 0.5, marginTop: 6 }}>
                          → ~{quote?.expectedOutput ? formatBalance(quote.expectedOutput) : '—'} {toAsset.symbol}
                        </div>
                        <div style={{ fontSize: 9, opacity: 0.4, letterSpacing: 1, marginTop: 4 }}>
                          {(quote?.swapper || quote?.integration || '').toString().toUpperCase()}
                        </div>
                      </div>
                      <div style={{ width: 38, height: 38, borderRadius: '50%',
                                    border: '1.5px solid rgba(232,230,220,0.85)',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>
                        ▶
                      </div>
                    </div>
                  }
                />
              </Box>

              {/* Headline + secondary instruction */}
              <VStack gap="1.5" align="center" textAlign="center" maxW="380px">
                <HStack gap="2" align="center">
                  <Text
                    fontSize="20px"
                    fontWeight="600"
                    color="kk.textPrimary"
                    letterSpacing="-0.01em"
                  >
                    {subStage === 'approve-signing'         ? t("approveOnDevice", "Approve on device")
                     : subStage === 'approve-broadcasting'  ? t("approvalBroadcasting", "Broadcasting approval…")
                     : subStage === 'approve-waiting-receipt' ? t("approvalWaiting", "Waiting for approval to confirm…")
                     : subStage === 'swap-signing'          ? t("confirmOnDevice")
                     : subStage === 'swap-broadcasting'     ? t("broadcasting")
                     : phase === 'approving'                ? t("approvingToken")
                     : phase === 'signing'                  ? t("confirmOnDevice")
                                                            : t("broadcasting")}
                  </Text>
                  {fromAsset?.contractAddress && (
                    <Box bg="rgba(233,196,106,0.12)" border="1px solid" borderColor="rgba(233,196,106,0.3)" px="1.5" py="0.5" borderRadius="md">
                      <Text fontSize="10px" fontWeight="700" color="var(--gold)" fontFamily="mono">
                        {subStage?.startsWith('approve-') ? '1/2'
                         : subStage?.startsWith('swap-')  ? '2/2'
                         : phase === 'approving'          ? '1/2'
                                                          : '2/2'}
                      </Text>
                    </Box>
                  )}
                </HStack>
                <Text fontSize="13px" color="kk.textSecondary" lineHeight="1.5">
                  {subStage === 'approve-signing'         ? t("approvalRequired")
                   : subStage === 'approve-broadcasting'  ? t("approvalBroadcastingDesc", "Submitting the approval to the network…")
                   : subStage === 'approve-waiting-receipt' ? t("approvalWaitingDesc", "Waiting for the approval to mine before we can sign the swap.")
                   : subStage === 'swap-signing'          ? t("confirmOnDeviceDesc")
                   : subStage === 'swap-broadcasting'     ? t("broadcastingDesc")
                   : phase === 'signing'                  ? t("confirmOnDeviceDesc")
                   : phase === 'approving'                ? t("approvalRequired")
                                                          : t("broadcastingDesc")}
                </Text>
              </VStack>

              {/* Summary chip — single inline pill, mono numbers */}
              <Flex
                align="center"
                gap="3.5"
                px="5"
                py="3"
                bg="var(--ink-1)"
                border="1px solid var(--ink-3)"
                borderRadius="14px"
              >
                <Text fontSize="14px" fontWeight="600" color="kk.textPrimary" fontFamily="mono">
                  {displayAmount} {fromAsset.symbol}
                </Text>
                <Box color="var(--gold)" flexShrink={0}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                  </svg>
                </Box>
                <Text fontSize="14px" fontWeight="600" color="var(--teal-2)" fontFamily="mono">
                  ~<GreenCountUp value={quote?.expectedOutput || '0'} color="var(--teal-2)" suffix={` ${toAsset.symbol}`} />
                </Text>
              </Flex>
              {hasFromPrice && (
                <Text fontSize="11px" color="kk.textMuted" fontFamily="mono" mt="-3">
                  {fmtCompact(parseFloat(displayAmount) * fromPriceUsd)}
                  {hasToPrice && quote?.expectedOutput ? ` → ${fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}` : ''}
                </Text>
              )}
            </VStack>
          )}

          {/* ── REVIEW (confirm quote) ──────────────────────────── */}
          {phase === 'review' && quote && fromAsset && toAsset && !busy && (
            <VStack gap="2" style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}>
              {/* Combined send/receive — single tight card with from → to */}
              <Box w="full" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="xl" p="3">
                <Flex align="center" gap="3">
                  <AssetIcon caip={fromAsset.caip} iconUrl={fromAsset.icon} chainCaip={chainBadgeCaip(fromAsset)} size={40} alt={fromAsset.symbol} />
                  <Box flex="1" minW="0">
                    <Text fontSize="sm" fontWeight="700" color="kk.textPrimary" truncate>{displayAmount} {fromAsset.symbol}</Text>
                    {hasFromPrice && (
                      <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">{fmtCompact(parseFloat(displayAmount) * fromPriceUsd)}</Text>
                    )}
                  </Box>
                  <Box color="var(--gold)" flexShrink={0}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                  </Box>
                  <Box flex="1" minW="0" textAlign="right">
                    <Text fontSize="sm" fontWeight="700" color="var(--teal)" truncate>~<GreenCountUp value={quote.expectedOutput} color="var(--teal)" suffix={` ${toAsset.symbol}`} /></Text>
                    {hasToPrice && (
                      <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">{fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}</Text>
                    )}
                  </Box>
                  <AssetIcon caip={toAsset.caip} iconUrl={toAsset.icon} chainCaip={chainBadgeCaip(toAsset)} size={40} alt={toAsset.symbol} />
                </Flex>
                {isFeeReservedNativeMax && fromAsset && nativeMaxReserveDisplay && (
                  <Text fontSize="10px" color="var(--gold)" mt="1.5">
                    {t("sendMaxGasReserveNote", {
                      defaultValue: "Keeping ~{{reserve}} {{symbol}} for network fees{{usd}}.",
                      reserve: formatBalance(String(nativeMaxReserveDisplay.reserveAmount)),
                      symbol: fromAsset.symbol,
                      usd: nativeMaxReserveDisplay.reserveUsd > 0 ? ` (${fmtCompact(nativeMaxReserveDisplay.reserveUsd)})` : '',
                    })}
                  </Text>
                )}
              </Box>

              {/* Animated route map — gold dot travels from-token →
                  integration → to-token. Shows the actual swap topology
                  (not just a pill). Integration label uses Pioneer's
                  authoritative swapper name when available. */}
              {(() => {
                const info = resolveProvider(quote.swapper || quote.integration)
                const integrationName = quote.swapper || quote.integration || info.name
                const fromColor = CHAINS.find(c => c.id === fromAsset.chainId)?.color
                const toColor   = CHAINS.find(c => c.id === toAsset.chainId)?.color
                return (
                  <Box w="full" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="xl" px="3" py="3">
                    <Flex align="center" justify="space-between" mb="1.5" px="1">
                      <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.04em" textTransform="uppercase">
                        {t("route", "Route")}
                      </Text>
                      <ProviderBadge swapper={quote.swapper} integration={quote.integration} size={16} variant="compact" />
                    </Flex>
                    <RouteMap
                      from={{ iconUrl: fromAsset.icon, color: fromColor, glyph: fromAsset.symbol.slice(0, 1) }}
                      to={{ iconUrl: toAsset.icon, color: toColor, glyph: toAsset.symbol.slice(0, 1) }}
                      integration={typeof integrationName === 'string' ? integrationName : undefined}
                      centerImageUrl={getSwapperAnimation(quote.swapper, quote.integration)}
                    />
                  </Box>
                )
              })()}

              {/* Key quote numbers — always visible, condensed */}
              <Box w="full" bg="rgba(255,255,255,0.02)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="3" py="2">
                <VStack gap="1" align="stretch">
                  <ReviewRow label={t("rate")}>
                    1 {fromAsset.symbol} = {formatBalance((parseFloat(quote.expectedOutput) / parseFloat(displayAmount || '1')).toString())} {toAsset.symbol}
                  </ReviewRow>
                  <ReviewRow label={t("expectedAfterFees", "Expected after fees")}>
                    {formatBalance(quote.expectedOutput)} {toAsset.symbol}{hasToPrice ? ` (${fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)})` : ''}
                  </ReviewRow>
                  <ReviewRow label={t("minimumAfterFeesSlippage", "Minimum receive after fees/slippage")} accent>
                    {formatBalance(quote.minimumOutput)} {toAsset.symbol}{hasToPrice ? ` (${fmtCompact(parseFloat(quote.minimumOutput) * toPriceUsd)})` : ''}
                  </ReviewRow>
                  <ReviewRow label={t("protocolFee", "Protocol fee")}>
                    {formatQuoteAssetAmount(quote.fees.outbound, toAsset, quote.expectedOutput)} {toAsset.symbol} ({(quote.fees.totalBps / 100).toFixed(2)}%)
                  </ReviewRow>
                  <ReviewRow label={t("slippageTolerance", "Slippage tolerance")}>
                    {(slippageBps / 100).toFixed(2)}% max
                  </ReviewRow>
                  <ReviewRow label={t("quoteSlippage", "Quote slippage")}>
                    {(quote.slippageBps / 100).toFixed(2)}%
                  </ReviewRow>
                  <ReviewRow label={t("estimatedTime")}>
                    {formatTime(quote.estimatedTime)}
                  </ReviewRow>
                </VStack>
              </Box>

              {fromAsset.chainFamily === 'evm' && (
                <Box w="full" bg="rgba(255,255,255,0.02)" border="1px solid" borderColor={auditPayloadReady ? "rgba(139,227,196,0.22)" : "rgba(233,196,106,0.28)"} borderRadius="lg" px="3" py="2">
                  <Flex align="center" justify="space-between" mb="2" gap="2">
                    <Text fontSize="11px" fontWeight="700" color="kk.textPrimary">
                      {t("evmSummary", "EVM summary")}
                    </Text>
                    <Text fontSize="10px" fontFamily="mono" color={auditPayloadReady ? "var(--teal)" : "var(--gold)"}>
                      {previewLoading
                        ? t("payloadBuilding", "building payload")
                        : previewError
                          ? t("payloadFailed", "payload failed")
                          : auditPayloadReady
                            ? t("payloadReady", "payload ready")
                            : t("payloadRequiredShort", "payload required")}
                    </Text>
                  </Flex>
                  <VStack gap="2" align="stretch">
                    {previewLoading && (
                      <Text fontSize="10px" color="kk.textMuted">{t("buildingPayloadDetail", "Building the exact transaction payload for review...")}</Text>
                    )}
                    {previewError && (
                      <Text fontSize="10px" color="kk.error">{t("previewFailed", "Build preview failed")}: {previewError}</Text>
                    )}
                    {previewBuild?.approveTx && (
                      <EvmTxSummaryCard
                        title={t("approvalTx", "Approval transaction")}
                        tx={previewBuild.approveTx}
                        chain={fromChainDef}
                        asset={fromAsset}
                        isApproval
                      />
                    )}
                    {previewBuild?.unsignedTx && (
                      <EvmTxSummaryCard
                        title={previewBuild.approveTx ? t("swapTxAfterApproval", "Swap transaction after approval") : t("swapTx", "Swap transaction")}
                        tx={previewBuild.unsignedTx}
                        chain={fromChainDef}
                        asset={fromAsset}
                      />
                    )}
                  </VStack>
                </Box>
              )}

              {/* Collapsible details: vault/router/memo + hdwallet payload audit */}
              <Box w="full">
                <Button size="xs" variant="ghost" color="kk.textMuted" w="full"
                  onClick={() => setShowDetails(!showDetails)}
                  _hover={{ color: "kk.textSecondary" }}>
                  {showDetails ? t("hideDetails", "Hide details") : t("showDetails", "Show details")}
                </Button>
                {showDetails && (
                  <Box bg="rgba(0,0,0,0.3)" borderRadius="md" p="2" mt="1">
                    <VStack gap="1.5" align="stretch">
                      {quote.router && fromAsset.chainFamily === 'evm' && (
                        <Flex justify="space-between" align="flex-start" gap="2">
                          <Text fontSize="10px" color="kk.textMuted" flexShrink={0}>{t("routerContract")}</Text>
                          <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all" textAlign="right">{quote.router}</Text>
                        </Flex>
                      )}
                      <Flex justify="space-between" align="flex-start" gap="2">
                        <Text fontSize="10px" color="kk.textMuted" flexShrink={0}>{t("vault")}</Text>
                        <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all" textAlign="right">{quote.inboundAddress}</Text>
                      </Flex>
                      {quote.memo && (
                        <Flex justify="space-between" align="flex-start" gap="2">
                          <Text fontSize="10px" color="kk.textMuted" flexShrink={0}>memo</Text>
                          <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all" textAlign="right">{quote.memo}</Text>
                        </Flex>
                      )}

                      {/* Hdwallet payload — built ahead of time via previewSwapBuild
                          so the user can audit the exact tx going to the device. */}
                      <Box pt="1.5" borderTop="1px solid" borderColor="kk.border">
                        {previewLoading && (
                          <Text fontSize="10px" color="kk.textMuted">Building transaction preview…</Text>
                        )}
                        {previewError && (
                          <Text fontSize="10px" color="kk.error">Preview failed: {previewError}</Text>
                        )}
                        {previewBuild?.approveTx && (
                          <Box mb="2">
                            <Text fontSize="10px" color="kk.textMuted" mb="1">Approve tx (ERC-20 allowance)</Text>
                            <Box bg="rgba(0,0,0,0.5)" borderRadius="sm" p="2" maxH="200px" overflow="auto" border="1px solid" borderColor="kk.border">
                              <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" whiteSpace="pre-wrap" wordBreak="break-all">
                                {JSON.stringify(previewBuild.approveTx, null, 2)}
                              </Text>
                            </Box>
                          </Box>
                        )}
                        {previewBuild?.unsignedTx && (
                          <Box>
                            <Text fontSize="10px" color="kk.textMuted" mb="1">
                              {previewBuild.approveTx ? 'Swap tx (sent after approval)' : 'Hdwallet payload'}
                            </Text>
                            <Box bg="rgba(0,0,0,0.5)" borderRadius="sm" p="2" maxH="240px" overflow="auto" border="1px solid" borderColor="kk.border">
                              <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" whiteSpace="pre-wrap" wordBreak="break-all">
                                {JSON.stringify(previewBuild.unsignedTx, null, 2)}
                              </Text>
                            </Box>
                          </Box>
                        )}
                      </Box>
                    </VStack>
                  </Box>
                )}
              </Box>

              {/* Preview build error — most likely insufficient gas/balance, surface upfront */}
              {previewError && (
                <Flex align="center" gap="2" bg="rgba(255,23,68,0.06)" border="1px solid" borderColor="rgba(224,140,123,0.32)" px="3" py="1.5" borderRadius="lg" w="full">
                  <Text fontSize="10px" color="kk.error">
                    {t("previewFailed", "Build preview failed")}: {previewError}
                  </Text>
                </Flex>
              )}

              {/* On-chain balance check — hard block. USDT (and most ERC-20s)
                  revert with INVALID opcode when transferFrom > balance, so we
                  refuse to sign rather than waste gas on a guaranteed revert. */}
              {previewBuild?.balance && !previewBuild.balance.sufficient && (() => {
                const b = previewBuild.balance!
                const tokenDecimals = normalizeDecimals(fromAsset.decimals)
                const fmt = (raw: string) => {
                  if (tokenDecimals === null) return raw
                  try {
                    const n = Number(BigInt(raw)) / Math.pow(10, tokenDecimals)
                    return n.toLocaleString(undefined, { maximumFractionDigits: 8 })
                  } catch { return raw }
                }
                return (
                  <Flex align="flex-start" gap="2" bg="rgba(224,140,123,0.10)" border="1px solid" borderColor="kk.error" px="3" py="2" borderRadius="lg" w="full">
                    <Box color="kk.error" flexShrink={0} mt="0.5">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                    </Box>
                    <Box flex="1">
                      <Text fontSize="11px" fontWeight="700" color="kk.error">
                        {t("insufficientBalance", "Insufficient {{symbol}} balance", { symbol: fromAsset.symbol })}
                      </Text>
                      <Text fontSize="10px" color="kk.textSecondary">
                        {t("insufficientBalanceDetail", "You have {{have}} {{symbol}} but the swap needs {{need}} {{symbol}}. The transferFrom would revert on-chain.", { have: fmt(b.current), need: fmt(b.required), symbol: fromAsset.symbol })}
                      </Text>
                      <Text fontSize="10px" color="kk.textMuted" mt="0.5">
                        {t("insufficientBalanceFix", "Lower the amount to ≤{{have}} or top up the source wallet before swapping.", { have: fmt(b.current) })}
                      </Text>
                    </Box>
                  </Flex>
                )
              })()}

              {/* ERC-20 approval status — only render when source is a token.
                  Distinguishes "approval will be added (2 device prompts)" from
                  "already approved" so the user knows what to expect. */}
              {previewBuild?.allowance && (() => {
                const a = previewBuild.allowance
                const tokenDecimals = normalizeDecimals(fromAsset.decimals)
                const fmt = (raw: string) => {
                  if (tokenDecimals === null) return raw
                  try {
                    const n = Number(BigInt(raw)) / Math.pow(10, tokenDecimals)
                    if (n > 1e15) return '∞ (max)'
                    return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
                  } catch { return raw }
                }
                if (a.sufficient) {
                  return (
                    <Flex align="center" gap="2" bg="rgba(74,222,128,0.06)" border="1px solid" borderColor="rgba(74,222,128,0.25)" px="3" py="2" borderRadius="lg" w="full">
                      <Box color="var(--teal)" flexShrink={0}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                      </Box>
                      <Box flex="1">
                        <Text fontSize="11px" fontWeight="600" color="var(--teal)">
                          Already approved · {fmt(a.current)} {fromAsset.symbol} allowance to router
                        </Text>
                        <Text fontSize="10px" color="kk.textMuted" fontFamily="mono" wordBreak="break-all">{a.spender}</Text>
                        <Text fontSize="10px" color="kk.textMuted">
                          1 device confirmation needed: swap
                        </Text>
                      </Box>
                    </Flex>
                  )
                }
                return (
                  <Flex align="flex-start" gap="2" bg="rgba(251,146,60,0.08)" border="1px solid" borderColor="rgba(251,146,60,0.35)" px="3" py="2" borderRadius="lg" w="full">
                    <Box color="var(--gold)" flexShrink={0} mt="0.5">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                    </Box>
                    <Box flex="1">
                      <Text fontSize="11px" fontWeight="700" color="var(--gold)">
                        Approval needed: {fmt(a.required)} {fromAsset.symbol}
                      </Text>
                      <Text fontSize="10px" color="kk.textSecondary">
                        Current allowance: {fmt(a.current)} {fromAsset.symbol} · spender <Text as="span" fontFamily="mono">{a.spender.slice(0, 10)}…{a.spender.slice(-6)}</Text>
                      </Text>
                      <Text fontSize="10px" color="kk.textMuted" mt="0.5">
                        2 device confirmations needed: 1) approve {fromAsset.symbol}, 2) swap. The approval consumes gas even if you cancel step 2.
                      </Text>
                    </Box>
                  </Flex>
                )
              })()}

              {/* High-slippage warning — flagged at >HIGH_SLIPPAGE_PCT.
                  Use max(quote, user) so a tight market quote doesn't hide a loose
                  user tolerance — the user's setting is the one that bounds risk. */}
              {shouldWarnHighSlippage(quote.slippageBps, slippageBps) && (
                <Flex align="center" gap="2" bg="rgba(251,146,60,0.08)" border="1px solid" borderColor="rgba(251,146,60,0.3)" px="3" py="1.5" borderRadius="lg" w="full">
                  <Text fontSize="10px" color="var(--gold)">
                    {t("highSlippageWarning", "Slippage tolerance is high ({{pct}}%). You may receive less than expected. Consider lowering tolerance for small spreads.", { pct: (computeEffectiveSlippageBps(quote.slippageBps, slippageBps) / 100).toFixed(1) })}
                  </Text>
                </Flex>
              )}

              {/* Dust-fee warning — protocol fees + spread eat too much of the swap.
                  THORChain has fixed ~$1.20 BTC outbound fee that crushes small swaps:
                  $2 in → $1.78 out is 11% loss. Tier the warning so users understand:
                  >DUST_FEE_WARNING_PCT = strongly recommend bigger amount;
                  >DUST_FEE_SEVERE_PCT  = "you're throwing money away".
                  Computed from displayed in/out USD values, not just quote.fees.totalBps,
                  so msg.value EVM fees and spread are captured. */}
              {(() => {
                const dust = computeDustWarning({
                  inAmount: parseFloat(sendAmount) || 0,
                  outAmount: parseFloat(quote.expectedOutput || '0') || 0,
                  fromPriceUsd,
                  toPriceUsd,
                })
                if (!dust) return null
                const { severe, lossPct, inUsd, lostUsd, recommendedMinUsd } = dust
                return (
                  <Flex align="center" gap="2"
                    bg={severe ? "rgba(224,140,123,0.12)" : "rgba(251,146,60,0.08)"}
                    border="1px solid"
                    borderColor={severe ? "rgba(255,23,68,0.4)" : "rgba(251,146,60,0.3)"}
                    px="3" py="2" borderRadius="lg" w="full">
                    <Text fontSize="10px" color={severe ? "kk.error" : "var(--gold)"} lineHeight="1.4">
                      {severe
                        ? t("dustFeeSevere", "⚠️ FEES EAT {{pct}}% OF THIS SWAP — you'd lose ${{lostUsd}} of your ${{inUsd}} input. THORChain has a fixed ~$1.20 outbound fee on BTC; small swaps are uneconomic. Strongly recommend ${{minUsd}}+ for this pair, or pick a different route.", { pct: lossPct.toFixed(0), lostUsd: lostUsd.toFixed(2), inUsd: inUsd.toFixed(2), minUsd: recommendedMinUsd })
                        : t("dustFeeHigh", "Heads up — fees + spread will cost {{pct}}% of this swap (~${{lostUsd}} of ${{inUsd}}). For small amounts the fixed protocol fee dominates. Larger swaps get a better rate.", { pct: lossPct.toFixed(0), lostUsd: lostUsd.toFixed(2), inUsd: inUsd.toFixed(2) })}
                    </Text>
                  </Flex>
                )
              })()}

              {/* TRON blind-sign warning OR verify-on-device note */}
              {fromAsset.chainFamily === 'tron' ? (
                <Flex align="center" gap="2" bg="rgba(251,146,60,0.08)" border="1px solid" borderColor="rgba(251,146,60,0.3)" px="3" py="1.5" borderRadius="lg" w="full">
                  <Text fontSize="10px" color="var(--gold)">
                    {t("tronBlindSignWarning", "Your KeepKey will display a generic Tron transaction prompt — it cannot decode the THORChain swap. Verify the amounts, vault, and memo above before approving on device.")}
                  </Text>
                </Flex>
              ) : (
                <Flex align="center" gap="2" bg="rgba(35,220,200,0.04)" px="3" py="1.5" borderRadius="lg" w="full">
                  <ShieldIcon />
                  <Text fontSize="10px" color="var(--teal)">{t("verifyOnDevice")}</Text>
                </Flex>
              )}

              {error && (
                <Box bg="rgba(224,140,123,0.10)" border="1px solid" borderColor="kk.error" borderRadius="lg" px="3" py="2" w="full">
                  <Flex justify="space-between" align="center" gap="2">
                    <Text fontSize="xs" color="kk.error" flex="1">{error}</Text>
                    <Button size="xs" variant="ghost" color="kk.error" px="1.5" onClick={() => setError(null)}>
                      {t("dismiss")}
                    </Button>
                  </Flex>
                </Box>
              )}

              {/* Safety note — "Address will be verified on your KeepKey
                  device." Per handoff design, this primes the user for the
                  confirm-on-device step before they sign. */}
              <Flex
                w="full"
                align="center"
                gap="2"
                px="3.5"
                py="2.5"
                bg="rgba(139,227,196,0.06)"
                border="1px solid rgba(139,227,196,0.20)"
                borderRadius="12px"
              >
                <Box flexShrink={0}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </Box>
                <Text fontSize="11px" color="var(--text-1)" letterSpacing="-0.005em">
                  {t("addressVerifiedOnDevice", "Address will be verified on your KeepKey device.")}
                </Text>
              </Flex>

              <Flex gap="2" w="full">
                <Box
                  as="button"
                  flex="1"
                  py="3"
                  borderRadius="14px"
                  fontSize="14px"
                  fontWeight="500"
                  color="var(--text-1)"
                  bg="var(--ink-2)"
                  border="1px solid var(--ink-3)"
                  cursor="pointer"
                  _hover={{ bg: "var(--ink-3)" }}
                  transition="background 0.15s"
                  onClick={() => { setQuote(null); setPhase('input') }}
                >
                  {t("back")}
                </Box>
                <Box
                  as="button"
                  flex="2"
                  py="3"
                  borderRadius="14px"
                  fontSize="14px"
                  fontWeight="600"
                  color="var(--ink-0)"
                  border="0"
                  cursor={reviewConfirmLocked ? "default" : "pointer"}
                  opacity={reviewConfirmLocked ? 0.5 : 1}
                  style={{
                    background: 'linear-gradient(180deg, var(--teal-2), var(--teal))',
                    boxShadow: '0 8px 24px -8px rgba(139,227,196,0.5)',
                    transition: 'transform 0.15s, box-shadow 0.15s',
                  }}
                  _hover={reviewConfirmLocked
                    ? {}
                    : { transform: "translateY(-1px)" }}
                  onClick={() => { if (!reviewConfirmLocked) handleExecuteSwap() }}
                  disabled={reviewConfirmLocked}
                  aria-disabled={reviewConfirmLocked}
                >
                  {reviewConfirmLockLabel ||
                    ((previewBuild?.allowance && !previewBuild.allowance.sufficient)
                      ? t("approveAndSwap", "Approve & Swap")
                      : t("confirmSwap"))}
                </Box>
              </Flex>
            </VStack>
          )}

          {/* ── INPUT — side-by-side You pay / You receive ─────────── */}
          {!loadingAssets && !assetLoadError && (phase === 'input' || phase === 'quoting') && (
            <VStack gap="2" align="stretch">
              {/* Side-by-side: FROM | center pivot | TO. Pivot is absolutely
                  positioned over the gap so the two columns stay equal-width.
                  Hover rotates 180° + glows gold to read as "swap direction". */}
              <Box position="relative">
              <Flex gap="3" align="stretch">
                {/* FROM column */}
                <Box
                  flex="1"
                  bg="linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(139,227,196,0.04) 100%)"
                  border="1px solid" borderColor="kk.border" borderRadius="xl" p="3"
                  transition="border-color 0.2s"
                  _hover={{ borderColor: "rgba(139,227,196,0.22)" }}
                >
                  <AssetSelector
                    label={t("youPay", "You pay")}
                    selected={fromAsset}
                    onOpenPicker={() => setPickerSide('from')}
                    disabled={busy}
                  />

                  {fromAsset && (
                    <Box mt="3" p="2.5" bg="rgba(0,0,0,0.2)" borderRadius="lg" border="1px solid" borderColor="rgba(255,255,255,0.06)">
                      <Flex justify="space-between" align="center" mb="2">
                        <VStack gap="0" align="flex-start">
                          <Text fontSize="9px" color="kk.textMuted" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">{t("available")}</Text>
                          <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" fontWeight="600">
                            {fromBalance ? `${formatBalance(fromBalance)} ${fromAsset.symbol}` : '\u2014'}
                          </Text>
                          {fromBalance && hasFromPrice && (
                            <Text fontSize="11px" color="kk.textSecondary" fontWeight="500">{fmtCompact(parseFloat(fromBalance) * fromPriceUsd)}</Text>
                          )}
                        </VStack>
                        <Flex gap="1" align="center">
                          {hasFromPrice && (
                            // Segmented chip — visible toggle, replaces the
                            // 9px icon-only button which users couldn't find.
                            <Flex border="1px solid" borderColor="rgba(255,255,255,0.1)" borderRadius="md" overflow="hidden">
                              <Box as="button" px="1.5" py="0.5" fontSize="10px" fontWeight="700"
                                bg={inputMode === 'crypto' ? "kk.gold" : "transparent"}
                                color={inputMode === 'crypto' ? "black" : "kk.textSecondary"}
                                cursor="pointer"
                                _hover={{ bg: inputMode === 'crypto' ? "kk.goldHover" : "rgba(255,255,255,0.05)" }}
                                onClick={() => inputMode !== 'crypto' && toggleInputMode()}
                                title={t("switchToCrypto") || `Use ${fromAsset.symbol}`}>
                                {fromAsset.symbol}
                              </Box>
                              <Box as="button" px="1.5" py="0.5" fontSize="10px" fontWeight="700"
                                bg={inputMode === 'fiat' ? "kk.gold" : "transparent"}
                                color={inputMode === 'fiat' ? "black" : "kk.textSecondary"}
                                cursor="pointer"
                                _hover={{ bg: inputMode === 'fiat' ? "kk.goldHover" : "rgba(255,255,255,0.05)" }}
                                onClick={() => inputMode !== 'fiat' && toggleInputMode()}
                                title={t("switchToFiat") || `Use ${fiatSymbol}`}>
                                {fiatSymbol}
                              </Box>
                            </Flex>
                          )}
                          {/* MAX is a set-action, not a toggle. The auto-default
                              useEffect can pre-enable MAX (small-balance case),
                              and a toggle here would silently flip that off when
                              the user clicked MAX expecting it to "do something".
                              To exit MAX mode, the user types — the input's
                              onChange already calls setIsMax(false). */}
                          <Button size="xs" px="2" variant={isMax ? "solid" : "outline"}
                            bg={isMax ? "kk.gold" : "transparent"} color={isMax ? "black" : "kk.gold"}
                            borderColor={isMax ? "kk.gold" : "rgba(233,196,106,0.3)"} fontWeight="700" fontSize="10px"
                            borderRadius="md" _hover={{ bg: isMax ? "kk.goldHover" : "rgba(233,196,106,0.1)" }}
                            onClick={() => { setIsMax(true); setMaxReserveMode('safe'); setAmount(""); setFiatAmount("") }} disabled={busy}>
                            {t("max")}
                          </Button>
                        </Flex>
                      </Flex>

                      {/* EVM address switcher — shown when multiple addresses tracked.
                          Uses local dialog state so switching here doesn't affect AssetPage. */}
                      {fromAsset?.chainFamily === 'evm' && evmAddresses.addresses.length > 1 && (
                        <Box mt="2" mb="2">
                          <Text fontSize="8px" color="kk.textMuted" textTransform="uppercase" letterSpacing="0.08em" mb="1">From address</Text>
                          <Flex gap="1" flexWrap="wrap">
                            {evmAddresses.addresses.map(addr => {
                              const isSelected = addr.addressIndex === effectiveEvmIndex
                              const chainBal = addr.chainBalances?.[fromAsset.chainId]
                              const chainBalLoading = chainBal === undefined
                              // For selected address fall back to global balances when chainBal not yet loaded
                              let bal = 0
                              if (chainBal) {
                                bal = parseFloat(chainBal.balance)
                              } else if (isSelected) {
                                const gb = balances.find(b => b.chainId === fromAsset.chainId)
                                bal = gb ? parseFloat(gb.balance) : 0
                              }
                              const snippet = addr.address ? `${addr.address.slice(0, 6)}…${addr.address.slice(-4)}` : `#${addr.addressIndex}`
                              return (
                                <Box
                                  key={addr.addressIndex}
                                  as="button"
                                  onClick={() => setEvmAddressIndexOverride(addr.addressIndex)}
                                  px="2" py="1"
                                  borderRadius="md"
                                  border="1px solid"
                                  borderColor={isSelected ? "kk.gold" : "kk.border"}
                                  bg={isSelected ? "rgba(233,196,106,0.1)" : "rgba(255,255,255,0.03)"}
                                  cursor="pointer"
                                  transition="all 0.15s"
                                  _hover={{ borderColor: "kk.gold", bg: "rgba(233,196,106,0.06)" }}
                                  disabled={busy}
                                >
                                  <Flex direction="column" align="flex-start" gap="0">
                                    <Text fontSize="9px" fontFamily="mono" color={isSelected ? "kk.gold" : "kk.textSecondary"} fontWeight="600" lineHeight="1.3">
                                      {snippet}
                                    </Text>
                                    {chainBalLoading && !isSelected
                                      ? <Spinner size="xs" color="kk.textMuted" />
                                      : <Text fontSize="9px" fontFamily="mono" color="kk.textMuted" lineHeight="1.3">
                                          {bal > 0 ? `${bal.toFixed(4)} ${fromAsset.symbol}` : `0 ${fromAsset.symbol}`}
                                        </Text>
                                    }
                                  </Flex>
                                </Box>
                              )
                            })}
                          </Flex>
                        </Box>
                      )}

                      <Box position="relative">
                        {inputMode === 'fiat' && (
                          <Text position="absolute" left="8px" top="50%" transform="translateY(-50%)" fontSize="xs" fontWeight="600" color="kk.textSecondary" pointerEvents="none" zIndex={1}>$</Text>
                        )}
                        <Input
                          value={isMax ? (sendAmount ? formatBalance(sendAmount) : 'MAX') : (inputMode === 'crypto' ? amount : fiatAmount)}
                          onChange={(e) => { if (isMax) { setIsMax(false); setMaxReserveMode('safe') } inputMode === 'crypto' ? handleCryptoChange(e.target.value) : handleFiatChange(e.target.value) }}
                          placeholder={inputMode === 'fiat' ? '0.00' : t("amountPlaceholder")}
                          bg="rgba(0,0,0,0.4)" border="1px solid"
                          borderColor={exceedsBalance ? "kk.error" : "rgba(255,255,255,0.08)"}
                          borderRadius="lg" color="kk.textPrimary" size="sm" fontFamily="mono" fontSize="sm" fontWeight="700"
                          disabled={busy} px={inputMode === 'fiat' ? "6" : "3"}
                          _focus={{ borderColor: exceedsBalance ? "kk.error" : "kk.gold", boxShadow: exceedsBalance ? "none" : "0 0 0 1px rgba(233,196,106,0.3)" }}
                        />
                      </Box>

                      {!isMax && hasFromPrice && (
                        <Flex mt="1" px="1">
                          {inputMode === 'crypto' && amountUsdPreview !== null ? (
                            <Box as="button" onClick={toggleInputMode} cursor="pointer"
                              title={t("switchToFiat") || "Switch to fiat input"}
                              _hover={{ color: "kk.gold" }}>
                              <Text fontSize="xs" color="kk.textSecondary" fontFamily="mono">
                                ≈ {fmtCompact(amountUsdPreview)}
                              </Text>
                            </Box>
                          ) : inputMode === 'fiat' && amount ? (
                            <Box as="button" onClick={toggleInputMode} cursor="pointer"
                              title={t("switchToCrypto") || `Switch to ${fromAsset.symbol} input`}
                              _hover={{ color: "kk.gold" }}>
                              <Text fontSize="xs" color="kk.textSecondary" fontFamily="mono">
                                ≈ {formatBalance(amount)} {fromAsset.symbol}
                              </Text>
                            </Box>
                          ) : null}
                        </Flex>
                      )}
                      {exceedsBalance && (
                        <Text fontSize="10px" color="kk.error" mt="1" fontWeight="600">{t("insufficientBalance")}</Text>
                      )}
                      {isFeeReservedNativeMax && !nativeMaxInsufficient && fromAsset && nativeMaxReserveDisplay && (
                        <Box mt="2" p="2" borderRadius="md" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.18)">
                          <Text fontSize="10px" color="kk.textSecondary" fontFamily="mono" lineHeight="1.45">
                            {t("maxReserveDisclosure", {
                              defaultValue: "MAX swaps {{amount}} {{symbol}} and keeps ~{{reserve}} {{symbol}} for network fees{{usd}}.",
                              amount: formatBalance(sendAmount),
                              reserve: formatBalance(String(nativeMaxReserveDisplay.reserveAmount)),
                              symbol: fromAsset.symbol,
                              usd: nativeMaxReserveDisplay.reserveUsd > 0 ? ` (${fmtCompact(nativeMaxReserveDisplay.reserveUsd)})` : '',
                            })}
                          </Text>
                          {nativeMaxReserveDisplay.canUseCloser && (
                            <Flex mt="2" align="center" justify="space-between" gap="2" wrap="wrap">
                              <Flex p="0.5" bg="rgba(0,0,0,0.28)" border="1px solid rgba(255,255,255,0.08)" borderRadius="md" gap="0.5">
                                {(['safe', 'closer'] as NativeMaxReserveMode[]).map((mode) => {
                                  const active = maxReserveMode === mode
                                  return (
                                    <Button
                                      key={mode}
                                      type="button"
                                      px="2"
                                      py="0.5"
                                      h="20px"
                                      minW="auto"
                                      borderRadius="sm"
                                      fontSize="9px"
                                      fontWeight="700"
                                      color={active ? "black" : "kk.textSecondary"}
                                      bg={active ? "kk.gold" : "transparent"}
                                      border="0"
                                      _hover={{ bg: active ? "kk.goldHover" : "rgba(255,255,255,0.06)" }}
                                      onClick={() => setMaxReserveMode(mode)}
                                      disabled={busy}
                                    >
                                      {mode === 'safe'
                                        ? t("maxReserveSafe", "Safe")
                                        : t("maxReserveCloser", "Closer MAX")}
                                    </Button>
                                  )
                                })}
                              </Flex>
                              {maxReserveMode === 'closer' && (
                                <Text fontSize="9px" color="var(--gold)" fontFamily="mono" flex="1" minW="150px">
                                  {t("maxReserveCloserWarning", "Tighter gas reserve; swap may fail if gas moves before signing.")}
                                </Text>
                              )}
                            </Flex>
                          )}
                        </Box>
                      )}
                      {nativeMaxInsufficient && fromAsset && (
                        <Text fontSize="10px" color="kk.error" mt="1" fontWeight="600">
                          {t("maxInsufficientForGas", { defaultValue: "Balance is below the fee reserve (~{{reserve}} {{symbol}}). Top up to swap.", reserve: nativeMaxFeeReserve(fromAsset, maxReserveMode).toString(), symbol: fromAsset.symbol })}
                        </Text>
                      )}
                    </Box>
                  )}

                  {fromAsset && fromAddress && (
                    <Flex mt="2" px="1" align="center" gap="1">
                      <Box w="4px" h="4px" borderRadius="full" bg="var(--teal)" flexShrink={0} />
                      <Text fontSize="9px" fontFamily="mono" color="kk.textMuted" truncate title={fromAddress}>
                        {fromAddress.slice(0, 10)}...{fromAddress.slice(-6)}
                      </Text>
                    </Flex>
                  )}
                </Box>

                {/* Flip button — centered vertically */}
                <Flex align="center" justify="center" flexShrink={0}>
                  <Box
                    as="button" w="36px" h="36px" display="flex" alignItems="center" justifyContent="center"
                    borderRadius="full" border="2px solid" borderColor="rgba(233,196,106,0.4)"
                    bg="linear-gradient(135deg, rgba(233,196,106,0.15) 0%, rgba(233,196,106,0.05) 100%)"
                    color="var(--gold)" cursor="pointer"
                    _hover={{ borderColor: "var(--gold)", bg: "rgba(233,196,106,0.2)", transform: "rotate(180deg) scale(1.1)" }}
                    transition="all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)"
                    onClick={handleFlip}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                  </Box>
                </Flex>

                {/* TO column */}
                <Box
                  flex="1"
                  bg="linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(139,227,196,0.04) 100%)"
                  border="1px solid" borderColor="kk.border" borderRadius="xl" p="3"
                  transition="border-color 0.2s"
                  _hover={{ borderColor: "rgba(139,227,196,0.22)" }}
                >
                  <AssetSelector
                    label={t("youReceive", "You receive")}
                    selected={toAsset}
                    onOpenPicker={() => setPickerSide('to')}
                    disabled={busy}
                  />

                  {toAsset && quote && (
                    <Box mt="3" p="2.5" bg="rgba(139,227,196,0.08)" borderRadius="lg" border="1px solid" borderColor="rgba(139,227,196,0.18)">
                      <Text fontSize="9px" color="kk.textMuted" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em" mb="1">{t("expectedOutput")}</Text>
                      <Text fontSize="sm" fontFamily="mono" fontWeight="800" color="var(--teal)">
                        <GreenCountUp value={quote.expectedOutput} color="var(--teal)" suffix={` ${toAsset.symbol}`} fontSize="sm" />
                      </Text>
                      {hasToPrice && (
                        <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" fontWeight="500" mt="0.5">
                          ≈ {fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}
                        </Text>
                      )}
                      {isFeeReservedNativeMax && fromAsset && nativeMaxReserveDisplay && (
                        <Text fontSize="9px" color="var(--gold)" mt="1">
                          {t("sendMaxGasReserveNote", {
                            defaultValue: "Keeping ~{{reserve}} {{symbol}} for network fees{{usd}}.",
                            reserve: formatBalance(String(nativeMaxReserveDisplay.reserveAmount)),
                            symbol: fromAsset.symbol,
                            usd: nativeMaxReserveDisplay.reserveUsd > 0 ? ` (${fmtCompact(nativeMaxReserveDisplay.reserveUsd)})` : '',
                          })}
                        </Text>
                      )}
                    </Box>
                  )}

                  {/* Quoting placeholder — sits in the same slot the price will
                      occupy. Reads as "your number is computing here", not as
                      a separate loading screen tacked on below the form. */}
                  {toAsset && !quote && phase === 'quoting' && (
                    <Box mt="3" p="2.5" bg="rgba(233,196,106,0.06)" borderRadius="lg" border="1px solid" borderColor="rgba(233,196,106,0.20)"
                      style={{ animation: 'kkSwapFadeIn 0.25s ease-out' }}>
                      <Text fontSize="9px" color="kk.textMuted" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em" mb="1.5">
                        {t("expectedOutput")}
                      </Text>
                      <Flex align="center" gap="3">
                        <Box
                          w="68px"
                          h="68px"
                          borderRadius="full"
                          flexShrink={0}
                          overflow="hidden"
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          style={{
                            background: 'radial-gradient(circle at 50% 45%, rgba(233,196,106,0.22), rgba(233,196,106,0.06) 70%)',
                            boxShadow: '0 0 0 1px rgba(233,196,106,0.25), 0 4px 14px -6px rgba(233,196,106,0.35)',
                          }}
                        >
                          <Image
                            src={calculatingGif}
                            alt=""
                            w="60px"
                            h="60px"
                            style={{ objectFit: 'contain' }}
                          />
                        </Box>
                        <VStack gap="0" align="flex-start" minW="0">
                          <Text fontSize="xs" color="var(--gold)" fontWeight="700" letterSpacing="-0.005em">
                            {t("findingBestRoute") || "Finding best route…"}
                          </Text>
                          <Text fontSize="10px" color="kk.textMuted" fontWeight="500">
                            {t("gettingQuote")}
                          </Text>
                        </VStack>
                      </Flex>
                    </Box>
                  )}

                  {toAsset && (
                    <Box mt="2">
                      <Flex justify="space-between" align="center" mb="1">
                        <HStack gap="1">
                          {!useCustomAddress && (
                            <>
                              <ShieldIcon />
                              <Text fontSize="9px" color="var(--teal)" fontWeight="600">{t("keepKeyAddress")}</Text>
                            </>
                          )}
                          {useCustomAddress && (
                            <Text fontSize="9px" color="var(--gold)" fontWeight="600">{t("customAddressWarning")}</Text>
                          )}
                        </HStack>
                        <Box as="button" fontSize="9px" color={useCustomAddress ? "var(--teal)" : "kk.textMuted"}
                          fontWeight="500" _hover={{ color: "kk.gold" }} transition="color 0.15s"
                          onClick={() => { setUseCustomAddress(!useCustomAddress); if (useCustomAddress) setCustomToAddress("") }}>
                          {useCustomAddress ? t("useKeepKeyAddress") : t("useCustomAddress")}
                        </Box>
                      </Flex>
                      {useCustomAddress ? (
                        <>
                          <Input value={customToAddress} onChange={(e) => setCustomToAddress(e.target.value)}
                            placeholder={t("customAddressPlaceholder")} bg="rgba(0,0,0,0.3)" border="1px solid"
                            borderColor={customAddressError ? "rgba(239,68,68,0.6)" : "rgba(251,163,36,0.2)"}
                            borderRadius="lg" color="kk.textPrimary" size="xs" fontFamily="mono" fontSize="10px" px="2"
                            _focus={{ borderColor: customAddressError ? "var(--rose)" : "var(--gold)" }} />
                          {customAddressError && (
                            <Text fontSize="9px" color="var(--rose)" mt="1">{customAddressError}</Text>
                          )}
                        </>
                      ) : keepKeyToAddress ? (
                        <Flex align="center" gap="1" px="1">
                          <Box w="4px" h="4px" borderRadius="full" bg="var(--teal)" flexShrink={0} />
                          <Text fontSize="9px" fontFamily="mono" color="kk.textSecondary" truncate title={keepKeyToAddress}>
                            {keepKeyToAddress.slice(0, 10)}...{keepKeyToAddress.slice(-6)}
                          </Text>
                        </Flex>
                      ) : null}
                    </Box>
                  )}

                  {sameAsset && (
                    <Text fontSize="10px" color="kk.error" mt="1" fontWeight="600">{t("sameAsset")}</Text>
                  )}
                </Box>
              </Flex>

              {/* Center pivot — flips fromAsset / toAsset, rotates 180° on
                  hover. Absolutely positioned so the column widths stay
                  equal. Disabled while a swap is in flight. */}
              <Box
                as="button"
                position="absolute"
                left="50%"
                top="50%"
                transform="translate(-50%, -50%)"
                w="40px"
                h="40px"
                borderRadius="full"
                bg="var(--ink-3)"
                border="1px solid var(--ink-4)"
                display="flex"
                alignItems="center"
                justifyContent="center"
                color="var(--gold)"
                style={{
                  boxShadow: '0 0 0 4px var(--ink-0), 0 6px 18px -6px rgba(0,0,0,0.6)',
                  transition: 'transform 0.3s, color 0.2s',
                }}
                _hover={{
                  color: "var(--gold-2)",
                }}
                onMouseEnter={(e: any) => { (e.currentTarget as HTMLElement).style.transform = 'translate(-50%, -50%) rotate(180deg)' }}
                onMouseLeave={(e: any) => { (e.currentTarget as HTMLElement).style.transform = 'translate(-50%, -50%) rotate(0)' }}
                disabled={busy || !fromAsset || !toAsset}
                cursor={busy || !fromAsset || !toAsset ? "default" : "pointer"}
                opacity={busy || !fromAsset || !toAsset ? 0.4 : 1}
                onClick={() => { if (!busy && fromAsset && toAsset) handleFlip() }}
                aria-label="Swap direction"
                zIndex={2}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3L4 7l4 4" />
                  <path d="M4 7h16" />
                  <path d="M16 21l4-4-4-4" />
                  <path d="M20 17H4" />
                </svg>
              </Box>
              </Box>

              {/* Slippage tolerance — visible whenever a swap target is selected.
                  Bps math: 50 = 0.5%, 100 = 1%, 300 = 3%. Custom prompts for a value. */}
              {fromAsset && toAsset && (
                <Flex align="center" justify="space-between" gap="2" px="1" py="1">
                  <Text fontSize="10px" color="kk.textMuted" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
                    {t("slippage") || "Slippage"}
                  </Text>
                  <HStack gap="1">
                    {[50, 100, 300].map(bps => {
                      const active = slippageBps === bps
                      return (
                        <Box key={bps} as="button" px="2" py="0.5" borderRadius="md"
                          bg={active ? "kk.gold" : "rgba(255,255,255,0.03)"}
                          color={active ? "black" : "kk.textSecondary"}
                          border="1px solid" borderColor={active ? "kk.gold" : "rgba(255,255,255,0.08)"}
                          fontSize="10px" fontWeight="700" cursor="pointer"
                          _hover={{ borderColor: active ? "kk.gold" : "rgba(233,196,106,0.4)" }}
                          onClick={() => setSlippageBps(bps)}>
                          {(bps / 100).toFixed(bps < 100 ? 1 : 0)}%
                        </Box>
                      )
                    })}
                    <Box as="button" px="2" py="0.5" borderRadius="md"
                      bg={![50, 100, 300].includes(slippageBps) ? "kk.gold" : "rgba(255,255,255,0.03)"}
                      color={![50, 100, 300].includes(slippageBps) ? "black" : "kk.textSecondary"}
                      border="1px solid"
                      borderColor={![50, 100, 300].includes(slippageBps) ? "kk.gold" : "rgba(255,255,255,0.08)"}
                      fontSize="10px" fontWeight="700" cursor="pointer"
                      _hover={{ borderColor: "rgba(233,196,106,0.4)" }}
                      onClick={() => {
                        const raw = prompt(`${t("slippage") || "Slippage"} %`, (slippageBps / 100).toString())
                        if (raw == null) return
                        const pct = parseFloat(raw)
                        if (!Number.isFinite(pct) || pct <= 0 || pct > 50) {
                          alert("Enter a percentage between 0.1 and 50")
                          return
                        }
                        setSlippageBps(Math.round(pct * 100))
                      }}>
                      {![50, 100, 300].includes(slippageBps) ? `${(slippageBps / 100).toFixed(2)}%` : (t("custom") || "Custom")}
                    </Box>
                  </HStack>
                </Flex>
              )}

              {/* Review Swap button — only when quote is ready. Gradient
                  matches the handoff CTA style: teal-2 → teal with a soft
                  teal glow shadow. Bigger touch target than the prior xs button. */}
              {phase === 'input' && quote && fromAsset && toAsset && !sameAsset && (
                <Box
                  as="button"
                  w="full"
                  py="3"
                  borderRadius="14px"
                  fontWeight="600"
                  fontSize="14px"
                  letterSpacing="-0.005em"
                  color="var(--ink-0)"
                  border="0"
                  cursor="pointer"
                  style={{
                    background: 'linear-gradient(180deg, var(--teal-2), var(--teal))',
                    boxShadow: '0 8px 24px -8px rgba(139,227,196,0.5)',
                    transition: 'transform 0.15s, box-shadow 0.15s',
                  }}
                  _hover={{
                    transform: "translateY(-1px)",
                  }}
                  onClick={() => setPhase('review')}
                >
                  {t("reviewSwap") || "Review Swap"}
                </Box>
              )}

              {/* Hint */}
              {phase === 'input' && fromAsset && toAsset && !sameAsset && !amount && !isMax && !quote && (
                <Text fontSize="10px" color="kk.textMuted" textAlign="center">{t("enterAmount")}</Text>
              )}

              {/* Error */}
              {error && (
                <Box bg="rgba(224,140,123,0.10)" border="1px solid" borderColor="kk.error" borderRadius="lg" p="2">
                  <Text fontSize="10px" color="kk.error">{error}</Text>
                </Box>
              )}
            </VStack>
          )}
        </Box>

        {/* ── Footer ──────────────────────────────────────────────── */}
        {!loadingAssets && phase !== 'submitted' && !busy && phase !== 'review' && (
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
            <Box
              as="a"
              href="https://api.shapeshift.com/docs#description/introduction"
              target="_blank"
              rel="noopener noreferrer"
              display="flex"
              alignItems="center"
              gap="1.5"
              opacity="0.55"
              _hover={{ opacity: 1 }}
              transition="opacity 0.15s"
              flexShrink={0}
            >
              <Image src={shapeshiftLogo} alt="" w="11px" h="11px" />
              <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.04em">
                Powered by ShapeShift API
              </Text>
            </Box>
          </Flex>
        )}
      </Box>

      {/* ── Asset picker (modal-over-modal) ──────────────────────── */}
      {/* ── Swap Provider Health Dialog ──────────────────────────── */}
      {healthDialogOpen && (
        <Box position="fixed" inset="0" zIndex={Z.assetPicker} display="flex" alignItems="center" justifyContent="center"
          bg="rgba(0,0,0,0.6)" onClick={() => setHealthDialogOpen(false)}>
          <Box
            bg="kk.bg" borderRadius="16px" border="1px solid" borderColor="kk.border"
            w="360px" maxH="80vh" overflow="auto"
            boxShadow="0 24px 64px rgba(0,0,0,0.6)"
            onClick={e => e.stopPropagation()}
            style={{ animation: 'kkSwapFadeIn 0.15s ease-out' }}
          >
            {/* Dialog header */}
            <Flex px="5" py="3" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between">
              <Text fontSize="sm" fontWeight="700" color="kk.textPrimary">Swap Provider Status</Text>
              <HStack gap="2">
                <Button size="xs" variant="ghost" color="kk.textMuted" px="2" minW="auto"
                  _hover={{ color: 'kk.textPrimary' }} onClick={refreshSwapHealth}
                  disabled={healthRefreshing}>
                  {healthRefreshing ? '↻' : '↺'}
                </Button>
                <Button size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto"
                  _hover={{ color: 'kk.textPrimary' }} onClick={() => setHealthDialogOpen(false)}>
                  &times;
                </Button>
              </HStack>
            </Flex>

            {/* Integration rows */}
            <VStack gap="0" align="stretch" px="4" py="3">
              {swapHealth?.integrations.map(intg => {
                const info = resolveProvider(intg.key)
                const dotColor =
                  intg.status === 'ok'       ? '#22c55e' :
                  intg.status === 'degraded' ? '#f59e0b' :
                  intg.status === 'offline'  ? '#ef4444' : '#6b7280'
                const statusLabel =
                  intg.status === 'ok'       ? 'Operational' :
                  intg.status === 'degraded' ? 'Degraded' :
                  intg.status === 'offline'  ? 'Offline' : 'Unknown'
                const statusDesc =
                  intg.status === 'ok'       ? 'All pools available. Quotes and swaps should work normally.' :
                  intg.status === 'degraded' ? (intg.detail || 'Some trading pairs are unavailable. Swaps on other pairs may still work.') :
                  intg.status === 'offline'  ? 'Pioneer cannot reach this provider. Quotes requiring this route will fail.' :
                  'Status could not be determined.'
                return (
                  <Box key={intg.key} py="3" borderBottom="1px solid" borderColor="kk.border"
                    _last={{ borderBottom: 'none' }}>
                    <Flex align="center" justify="space-between" mb={intg.haltedPools?.length ? '2' : '1'}>
                      <HStack gap="2">
                        <Box w="28px" h="28px" borderRadius="full" overflow="hidden" flexShrink={0}
                          bg="rgba(255,255,255,0.05)" display="flex" alignItems="center" justifyContent="center">
                          <img src={info.icon} alt={intg.label} width="22" height="22"
                            style={{ borderRadius: '50%', objectFit: 'cover' }} />
                        </Box>
                        <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{intg.label}</Text>
                      </HStack>
                      <HStack gap="1.5" align="center">
                        <Box w="7px" h="7px" borderRadius="full" flexShrink={0}
                          style={{ background: dotColor,
                            boxShadow: intg.status === 'ok' ? `0 0 5px ${dotColor}99` : 'none' }} />
                        <Text fontSize="11px" fontWeight="600" style={{ color: dotColor }}>{statusLabel}</Text>
                      </HStack>
                    </Flex>
                    <Text fontSize="11px" color="kk.textMuted" lineHeight="1.5">{statusDesc}</Text>
                    {intg.haltedPools && intg.haltedPools.length > 0 && (
                      <Box mt="2" p="2" bg="rgba(245,158,11,0.08)" borderRadius="8px"
                        border="1px solid rgba(245,158,11,0.2)">
                        <Text fontSize="10px" fontWeight="600" color="#f59e0b" mb="1">
                          Halted pools ({intg.haltedPools.length})
                        </Text>
                        <VStack gap="0.5" align="start">
                          {intg.haltedPools.map(caip => (
                            <Text key={caip} fontSize="10px" color="kk.textMuted" fontFamily="mono"
                              style={{ wordBreak: 'break-all' }}>
                              {caip}
                            </Text>
                          ))}
                        </VStack>
                      </Box>
                    )}
                  </Box>
                )
              })}
              {!swapHealth && (
                <Box py="6" textAlign="center">
                  <Text fontSize="sm" color="kk.textMuted">Loading provider status…</Text>
                </Box>
              )}
            </VStack>

            {/* Footer */}
            <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border" align="center" justify="space-between">
              <Text fontSize="10px" color="kk.textMuted">
                {swapHealth ? `Updated ${new Date(swapHealth.fetchedAt).toLocaleTimeString()}` : 'Fetching…'}
              </Text>
              <Text fontSize="10px" color="kk.textMuted">via Pioneer</Text>
            </Flex>
          </Box>
        </Box>
      )}

      {/* ── Quote details modal (ProverChip click) ─────────────────── */}
      {quoteDetailsOpen && quote && fromAsset && toAsset && (
        <Box position="fixed" inset="0" zIndex={Z.assetPicker}
          display="flex" alignItems="center" justifyContent="center"
          bg="rgba(0,0,0,0.65)" onClick={() => setQuoteDetailsOpen(false)}>
          <Box
            bg="kk.bg" borderRadius="16px" border="1px solid" borderColor="kk.border"
            w="340px"
            boxShadow="0 24px 64px rgba(0,0,0,0.7)"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            style={{ animation: 'kkSwapFadeIn 0.15s ease-out' }}
          >
            {(() => {
              const info = resolveProvider(quote.swapper || quote.integration)
              return (
                <>
                  <Flex px="5" py="4" borderBottom="1px solid" borderColor="kk.border" align="center" gap="3">
                    <Box w="40px" h="40px" borderRadius="full" overflow="hidden" flexShrink={0}
                      style={{ boxShadow: `0 0 14px ${info.color}55` }}>
                      <img src={info.icon} alt={info.label} width="40" height="40"
                        style={{ borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
                    </Box>
                    <Box flex="1">
                      <Text fontSize="15px" fontWeight="700" color="kk.textPrimary">{info.label}</Text>
                      <Text fontSize="11px" color="kk.textMuted">Route details</Text>
                    </Box>
                    <Box as="button" fontSize="20px" lineHeight="1" color="kk.textMuted" px="1"
                      cursor="pointer"
                      onClick={() => setQuoteDetailsOpen(false)}
                      style={{ background: 'none', border: 'none' }}>×</Box>
                  </Flex>
                  <VStack gap="0" align="stretch" px="4" py="3">
                    <ReviewRow label={t("rate")}>
                      1 {fromAsset.symbol} = {formatBalance((parseFloat(quote.expectedOutput) / parseFloat(sendAmount || '1')).toString())} {toAsset.symbol}
                    </ReviewRow>
                    <ReviewRow label={t("expectedAfterFees", "Expected")}>
                      {formatBalance(quote.expectedOutput)} {toAsset.symbol}
                      {hasToPrice ? ` (${fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)})` : ''}
                    </ReviewRow>
                    <ReviewRow label={t("minimumAfterFeesSlippage", "Min. receive")} accent>
                      {formatBalance(quote.minimumOutput)} {toAsset.symbol}
                    </ReviewRow>
                    <ReviewRow label={t("protocolFee", "Protocol fee")}>
                      {(quote.fees.totalBps / 100).toFixed(2)}%
                    </ReviewRow>
                    <ReviewRow label={t("slippageTolerance", "Slippage")}>
                      {(slippageBps / 100).toFixed(2)}% max
                    </ReviewRow>
                    <ReviewRow label={t("estimatedTime")}>
                      {formatTime(quote.estimatedTime)}
                    </ReviewRow>
                  </VStack>
                </>
              )
            })()}
          </Box>
        </Box>
      )}

      <AssetPickerDialog
        open={pickerSide !== null}
        onClose={() => setPickerSide(null)}
        swappable={assets}
        balances={balances}
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
