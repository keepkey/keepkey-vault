/**
 * SwapDialog — Full-screen dialog for the swap flow.
 *
 * Phases: input → review → approving/signing/broadcasting → success
 * Replaces the old inline SwapView with a proper modal experience.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, Button, Input, Image, HStack } from "@chakra-ui/react"
import CountUp from "react-countup"
import { rpcRequest, rpcFire, onRpcMessage } from "../lib/rpc"
import { formatBalance } from "../lib/formatting"
import { useFiat } from "../lib/fiat-context"
import { AssetIcon } from "./AssetIcon"
import { CHAINS, getExplorerTxUrl } from "../../shared/chains"
import type { ChainDef } from "../../shared/chains"
import { getAssetIcon } from "../../shared/assetLookup"
import { validateAddress } from "../../shared/address-validation"
import type { SwapAsset, SwapQuote, ChainBalance, SwapStatusUpdate, SwapTrackingStatus, PendingSwap, SwapUiState, SwapUiCommand } from "../../shared/types"
import { Z } from "../lib/z-index"
import { providerTrackerUrl } from "../lib/trackers"
import { ProviderBadge, resolveProvider } from "./ProviderBadge"
import { computeDustWarning, shouldWarnHighSlippage, computeEffectiveSlippageBps } from "../../shared/swap-warnings"
import { AssetPickerDialog } from "./AssetPickerDialog"
import { KeepKeyDevice, RouteMap } from "./v3"
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

/** Conservative gas reserve (in native units) for native MAX swaps.
 *  Only applies to native EVM assets — token swaps spend the token, not
 *  the native, and UTXO/Cosmos MAX is computed precisely server-side from
 *  the input set. The numbers here are a UX cushion: backend still does
 *  precise gas estimation at sign time, but we want the user to *see* a
 *  realistic post-gas amount when they click MAX so they don't think the
 *  whole balance will be swapped. */
const NATIVE_EVM_GAS_RESERVE: Record<string, number> = {
  'eip155:1':     0.005,    // Ethereum L1 — swap router can cost ~$10-50
  'eip155:8453':  0.00015,  // Base — L2 cheap, but L1 data fee adds up
  'eip155:10':    0.00015,  // Optimism
  'eip155:42161': 0.0002,   // Arbitrum
  'eip155:137':   0.05,     // Polygon (MATIC)
  'eip155:56':    0.002,    // BNB Smart Chain
  'eip155:43114': 0.005,    // Avalanche C-Chain
}
const NATIVE_EVM_GAS_RESERVE_DEFAULT = 0.001

function nativeEvmGasReserve(asset: SwapAsset): number {
  if (asset.chainFamily !== 'evm' || asset.contractAddress) return 0
  return NATIVE_EVM_GAS_RESERVE[asset.chainId] ?? NATIVE_EVM_GAS_RESERVE_DEFAULT
}

/** Returns the displayable & spendable max amount for native MAX. For
 *  non-EVM-native assets, returns the full balance unchanged (UTXO etc.
 *  are handled correctly server-side and the user expectation matches). */
function maxSpendableAmount(asset: SwapAsset, balance: string): string {
  const bal = parseFloat(balance || '0')
  if (!isFinite(bal) || bal <= 0) return balance
  const reserve = nativeEvmGasReserve(asset)
  if (reserve <= 0) return balance
  const spendable = bal - reserve
  if (spendable <= 0) return '0'
  // Trim to a reasonable precision; keep the original digit count if the
  // reserve subtracts cleanly. The mono input formats this anyway.
  return spendable.toFixed(8).replace(/\.?0+$/, '')
}

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
}

// ── Main SwapDialog ─────────────────────────────────────────────────
export function SwapDialog({ open, onClose, chain, balance, address, resumeSwap }: SwapDialogProps) {
  const { t } = useTranslation("swap")
  const { fmtCompact, symbol: fiatSymbol } = useFiat()

  // ── State ─────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<SwapPhase>('input')
  const [assets, setAssets] = useState<SwapAsset[]>([])
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [assetLoadError, setAssetLoadError] = useState<string | null>(null)
  const [balances, setBalances] = useState<ChainBalance[]>([])

  const [fromAsset, setFromAsset] = useState<SwapAsset | null>(null)
  const [toAsset, setToAsset] = useState<SwapAsset | null>(null)
  // Which side opened the asset picker — null when closed. Single shared
  // AssetPickerDialog rendered at modal-over-modal z-index for both sides.
  const [pickerSide, setPickerSide] = useState<'from' | 'to' | null>(null)
  const [amount, setAmount] = useState("")
  const [fiatAmount, setFiatAmount] = useState("")
  const [inputMode, setInputMode] = useState<'crypto' | 'fiat'>('crypto')
  const [isMax, setIsMax] = useState(false)

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
  const [liveSwapper, setLiveSwapper] = useState<string | undefined>()

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
  const [previewBuild, setPreviewBuild] = useState<{
    approveTx?: any
    unsignedTx: any
    allowance?: { current: string; required: string; sufficient: boolean; spender: string; tokenContract: string }
    balance?: { current: string; required: string; sufficient: boolean; tokenContract?: string }
  } | null>(null)
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
    })

    const unsub2 = onRpcMessage('swap-complete', (swap: any) => {
      if (swap.txid !== txid) return
      setLiveStatus(swap.status || 'completed')
    })

    return () => { unsub1(); unsub2() }
  }, [txid, phase])

  // ── On-demand Pioneer polling — only while the dialog is open on this swap.
  // Pull immediately, then on a 10s tick. Stops when the swap reaches a terminal
  // state, when the user closes the dialog, or when the phase moves away.
  useEffect(() => {
    if (!txid || phase !== 'submitted') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (cancelled) return
      try { await rpcRequest('refreshSwap', { txid }) } catch { /* swap-update push will retry on next tick */ }
      if (cancelled) return
      // Stop once we have a terminal status (the swap-update listener has already updated state)
      if (liveStatus === 'completed' || liveStatus === 'failed' || liveStatus === 'refunded') return
      timer = setTimeout(tick, 10_000)
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [txid, phase, liveStatus])

  // Reset live tracking when phase changes away from submitted
  useEffect(() => {
    if (phase !== 'submitted') {
      setLiveStatus('pending')
      setLiveConfirmations(0)
      setLiveOutboundConfirmations(undefined)
      setLiveOutboundRequired(undefined)
      setLiveOutboundTxid(undefined)
      setLiveSwapper(undefined)
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
    rpcRequest<ChainBalance[]>('getBalances', undefined, 60000)
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

  // ── Auto-select from asset when dialog opens with chain context ───
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (hasAutoSelected.current || assets.length === 0 || !chain) return
    const match = assets.find(a => a.chainId === chain.id && !a.contractAddress)
    if (match) {
      setFromAsset(match)
      const defaultOut = DEFAULT_OUTPUT[chain.id]
      if (defaultOut) {
        const outMatch = assets.find(a => a.asset === defaultOut)
        if (outMatch) setToAsset(outMatch)
      }
      hasAutoSelected.current = true
    }
  }, [assets, chain])

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
    if (resumeSwap.swapper) setLiveSwapper(resumeSwap.swapper)
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
    // Check cached balances first (most up-to-date from getCachedBalances RPC)
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
  }, [fromAsset, balance, chain, balances])

  /* Native EVM MAX gas reservation — frontend pre-clamps the balance by a
   * conservative gas reserve so the displayed and submitted amount match
   * what the user actually spends. UTXO/Cosmos/etc. still use isMax=true
   * server-side because their fee math depends on input set + memo. */
  const nativeEvmMaxAmount = useMemo(() => {
    if (!fromAsset || !fromBalance) return null
    if (fromAsset.chainFamily !== 'evm' || fromAsset.contractAddress) return null
    return maxSpendableAmount(fromAsset, fromBalance)
  }, [fromAsset, fromBalance])

  /* Resolved (amount, isMax) tuple to send to the backend. For native EVM
   * MAX the amount is already clamped, so isMax is dropped to keep the
   * display honest. For non-EVM-native MAX, isMax remains true so the
   * backend's input-aware fee math runs. */
  const sendAmount = useMemo(() => {
    if (!isMax) return amount
    return nativeEvmMaxAmount ?? (fromBalance || '0')
  }, [isMax, amount, nativeEvmMaxAmount, fromBalance])

  const sendIsMax = isMax && nativeEvmMaxAmount === null

  /* When the native balance is too small to even cover gas, MAX is
   * unusable — flag it so the UI can show "insufficient for gas" instead
   * of letting the user submit a 0 swap. */
  const nativeMaxInsufficient = isMax && nativeEvmMaxAmount !== null && parseFloat(nativeEvmMaxAmount) <= 0

  // Derive per-unit USD price for from/to assets from cached balances
  // NOTE: cb.balanceUsd includes token USD — use nativeBalanceUsd for native asset price
  const fromPriceUsd = useMemo(() => {
    if (!fromAsset) { swapLog('[SWAP-PRICE] fromPriceUsd: no fromAsset'); return 0 }
    const cb = balance && chain && fromAsset.chainId === chain.id ? balance : balances.find(b => b.chainId === fromAsset.chainId)
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
    swapLog(`[SWAP-PRICE] fromPriceUsd: ${fromAsset.symbol} chainId=${fromAsset.chainId} bal=${bal} nativeBalanceUsd=${cb.nativeBalanceUsd} balanceUsd=${cb.balanceUsd} tokens=${cb.tokens?.length || 0}`)
    if (bal <= 0) return 0
    const nativeUsd = cb.nativeBalanceUsd ?? 0
    const result = nativeUsd > 0 ? nativeUsd / bal : 0
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
    const nativeUsd = cb.nativeBalanceUsd ?? 0
    swapLog(`[SWAP-PRICE] toPriceUsdFromBalance: ${toAsset.symbol} chainId=${toAsset.chainId} bal=${bal} nativeBalanceUsd=${cb.nativeBalanceUsd} balanceUsd=${cb.balanceUsd} tokens=${cb.tokens?.length || 0}`)
    if (bal <= 0) return 0
    const result = nativeUsd > 0 ? nativeUsd / bal : 0
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
  }, [toPriceUsdFromBalance, fromPriceUsd, quote?.expectedOutput, amount, isMax, fromBalance])

  const hasFromPrice = fromPriceUsd > 0
  const hasToPrice = toPriceUsd > 0

  // Bidirectional conversion: crypto → fiat
  const handleCryptoChange = useCallback((v: string) => {
    setAmount(v)
    setIsMax(false)
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
    if (fromAsset && address && chain && fromAsset.chainId === chain.id) return address
    if (!fromAsset) return ''
    const cb = balances.find(b => b.chainId === fromAsset.chainId)
    return cb?.address || ''
  }, [fromAsset, address, chain, balances])

  const keepKeyToAddress = useMemo(() => {
    if (!toAsset) return ''
    const cb = balances.find(b => b.chainId === toAsset.chainId)
    return cb?.address || ''
  }, [toAsset, balances])

  const toAddress = useMemo(() => {
    if (useCustomAddress && customToAddress.trim()) return customToAddress.trim()
    return keepKeyToAddress
  }, [useCustomAddress, customToAddress, keepKeyToAddress])

  const validAmount = (isMax && !nativeMaxInsufficient) || (amount !== '' && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0)
  const canQuote = fromAsset && toAsset && !sameAsset && validAmount && fromAddress && toAddress && !exceedsBalance && !customAddressError

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
    setPreviewLoading(true); setPreviewError(null)
    rpcRequest<{ approveTx?: any; unsignedTx: any }>('previewSwapBuild', {
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
      integration: quote.integration,
      relayTx: quote.relayTx,
    }).then((res) => { if (!cancelled) { setPreviewBuild(res); setPreviewLoading(false) } })
      .catch((e: any) => { if (!cancelled) { setPreviewError(e?.message || 'Preview failed'); setPreviewLoading(false) } })
    return () => { cancelled = true }
  }, [phase, quote, fromAsset, toAsset, amount, isMax, fromBalance, fromAddress, toAddress])

  // ── Quote fetching ────────────────────────────────────────────────
  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quoteVersionRef = useRef(0)

  useEffect(() => {
    // Don't re-quote when viewing a submitted/resumed swap or during signing
    if (phase === 'submitted' || phase === 'signing' || phase === 'broadcasting' || phase === 'approving') return

    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current)
    setQuote(null)
    const version = ++quoteVersionRef.current

    if (!canQuote) {
      if (phase === 'quoting') setPhase('input')
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
  }, [fromAsset?.asset, toAsset?.asset, amount, isMax, fromAddress, toAddress, exceedsBalance, fromBalance, slippageBps, requoteTick])

  // ── Flip ──────────────────────────────────────────────────────────
  const handleFlip = useCallback(() => {
    const prev = fromAsset
    setFromAsset(toAsset)
    setToAsset(prev)
    setAmount("")
    setFiatAmount("")
    setIsMax(false)
    setQuote(null)
    setPhase('input')
    setError(null)
  }, [fromAsset, toAsset])

  // ── Execute swap ──────────────────────────────────────────────────
  const handleExecuteSwap = useCallback(async () => {
    if (!quote || !fromAsset || !toAsset) return
    const isErc20 = !!fromAsset.contractAddress

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
        liveQuote = refreshed
        setQuote(refreshed)
        setQuoteFetchedAt(Date.now())
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
        integration: liveQuote.integration,
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
  }, [quote, quoteFetchedAt, fromAsset, toAsset, amount, isMax, fromBalance, fromAddress, toAddress, slippageBps, balances])

  // ── Reset ─────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setPhase('input')
    setFromAsset(null)
    setToAsset(null)
    setAmount("")
    setFiatAmount("")
    setInputMode('crypto')
    setIsMax(false)
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
  }, [])

  const handleClose = useCallback(() => {
    if (phase === 'signing' || phase === 'broadcasting' || phase === 'approving') return
    onClose()
    // Reset state after close animation
    setTimeout(reset, 200)
  }, [phase, onClose, reset])

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
  const isNativeEvmMax = isMax && nativeEvmMaxAmount !== null

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
    }
    const serialized = JSON.stringify(snapshot)
    if (serialized === lastPublishedRef.current) return
    lastPublishedRef.current = serialized
    rpcFire('publishSwapUiState', snapshot)
  }, [open, phase, fromAsset?.asset, toAsset?.asset, amount, fiatAmount, inputMode, isMax, slippageBps, fromAddress, toAddress, useCustomAddress, customToAddress, quote, previewBuild, error, txid])

  // Reset the cached snapshot to 'closed' when the dialog unmounts so a stale
  // open state doesn't outlive the user closing the dialog.
  useEffect(() => {
    return () => {
      rpcFire('publishSwapUiState', {
        phase: 'closed', fromAsset: null, toAsset: null, amount: '', fiatAmount: '',
        inputMode: 'crypto', isMax: false, slippageBps: 100,
        fromAddress: '', toAddress: '', useCustomAddress: false, customToAddress: '',
        quote: null, previewBuild: null, error: null, txid: null,
      } satisfies SwapUiState)
    }
  }, [])

  // ── Listen for swap-cmd messages (REST → UI control) ───────────────
  // 'open' is handled by SwapRpcMount before we mount; here we just treat
  // it as additional setters in case a second open arrives while we're up.
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
        if (phase === 'review' && quote && fromAsset && toAsset) {
          handleExecuteSwap()
        }
        return
      }
      // Both 'open' and 'set' carry the same partial-update fields below.
      const fields = cmd
      if ('fromAsset' in fields && fields.fromAsset !== undefined) {
        const a = assets.find(x => x.asset === fields.fromAsset)
        if (a) setFromAsset(a)
      }
      if ('toAsset' in fields && fields.toAsset !== undefined) {
        const a = assets.find(x => x.asset === fields.toAsset)
        if (a) setToAsset(a)
      }
      if ('amount' in fields && fields.amount !== undefined) {
        setAmount(fields.amount); setIsMax(false)
      }
      if ('isMax' in fields && fields.isMax !== undefined) setIsMax(fields.isMax)
      if ('inputMode' in fields && fields.inputMode !== undefined) setInputMode(fields.inputMode)
      if ('useCustomAddress' in fields && fields.useCustomAddress !== undefined) setUseCustomAddress(fields.useCustomAddress)
      if ('customToAddress' in fields && fields.customToAddress !== undefined) setCustomToAddress(fields.customToAddress)
      if ('slippageBps' in fields && fields.slippageBps !== undefined) setSlippageBps(fields.slippageBps)
    }
    return onRpcMessage('swap-cmd', apply)
  }, [open, assets, onClose, setSlippageBps, phase, quote, fromAsset, toAsset, handleExecuteSwap])

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
        w="760px"
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
          {!busy && (
            <Button size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto" _hover={{ color: "kk.textPrimary" }} onClick={handleClose}>
              &times;
            </Button>
          )}
        </Flex>

        {/* ── Body ────────────────────────────────────────────────── */}
        <Box px="5" py="3">
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
            <VStack gap="3" py="1" style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }} position="relative">
              {/* Confetti burst on completion */}
              {showConfetti && <ConfettiBurst />}

              {/* Hero: thorfox swap animation — shifting in-flight, completed on done */}
              <Box position="relative" w="full" display="flex" justifyContent="center" alignItems="center" pt="1" pb="0.5">
                <Box
                  position="relative"
                  w="200px"
                  h="200px"
                  borderRadius="full"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  style={{
                    background: isSwapComplete
                      ? 'radial-gradient(circle at 50% 45%, rgba(139,227,196,0.22), transparent 70%)'
                      : isSwapFailed
                        ? 'radial-gradient(circle at 50% 45%, rgba(224,140,123,0.18), transparent 70%)'
                        : 'radial-gradient(circle at 50% 45%, rgba(233,196,106,0.18), transparent 70%)',
                  }}
                >
                  <Image
                    src={isSwapComplete ? completedGif : shiftingGif}
                    alt=""
                    w="180px"
                    h="180px"
                    style={{
                      objectFit: 'contain',
                      filter: isSwapFailed ? 'grayscale(0.6)' : undefined,
                    }}
                  />
                </Box>
              </Box>

              {/* Title row + provider chip */}
              <Flex align="center" gap="3" w="full" justify="center" position="relative">
                <VStack gap="0" align="center">
                  <Text fontSize="lg" fontWeight="700" letterSpacing="-0.01em"
                    color={isSwapComplete ? "var(--teal)" : isSwapFailed ? "var(--rose)" : "kk.textPrimary"}
                    fontFamily="serif" fontStyle="italic">
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

              {/* ── Progress bar with checkpoints ────────────────────── */}
              <Box w="full" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="5" py="4">
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
                  {(() => {
                    const url = getExplorerTxUrl(fromAsset.chainId, txid)
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
                    const tracker = providerTrackerUrl(protoHint, txid)
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
                        const url = getExplorerTxUrl(toAsset.chainId, liveOutboundTxid)
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
          )}

          {/* ── SIGNING / APPROVING / BROADCASTING ───────────────── */}
          {/* ── AWAITING DEVICE — dedicated full-screen confirm
              Per handoff design: 220px KeepKey gif, prominent headline,
              concise instruction, then a single summary chip. The
              substage detail moves into the chip area as small mono text
              instead of competing with the device illustration. */}
          {busy && fromAsset && toAsset && (
            <VStack gap="6" py="6" align="center" style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }}>
              {/* Big device illustration — 220px gif drives the whole screen */}
              <Box flexShrink={0}>
                <KeepKeyDevice
                  state={subStage?.endsWith('-broadcasting') || phase === 'broadcasting' ? 'active' : 'signing'}
                  size={220}
                />
              </Box>

              {/* Headline + secondary instruction */}
              <VStack gap="1.5" align="center" textAlign="center" maxW="380px">
                <HStack gap="2" align="center">
                  <Text
                    fontSize="20px"
                    fontWeight="600"
                    color="kk.textPrimary"
                    fontFamily="serif"
                    fontStyle="italic"
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
                {isNativeEvmMax && (
                  <Text fontSize="10px" color="var(--gold)" mt="1.5">{t("sendMaxGasNote")}</Text>
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
                    />
                  </Box>
                )
              })()}

              {/* Key quote numbers — always visible, condensed */}
              <Box w="full" bg="rgba(255,255,255,0.02)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="3" py="2">
                <VStack gap="1" align="stretch">
                  <Flex justify="space-between">
                    <Text fontSize="11px" color="kk.textMuted">{t("rate")}</Text>
                    <Text fontSize="11px" fontFamily="mono" color="kk.textSecondary">
                      1 {fromAsset.symbol} = {formatBalance((parseFloat(quote.expectedOutput) / parseFloat(displayAmount || '1')).toString())} {toAsset.symbol}
                    </Text>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="11px" color="kk.textMuted">{t("minimumReceived")}</Text>
                    <Text fontSize="11px" fontFamily="mono" color="kk.textSecondary">
                      {formatBalance(quote.minimumOutput)} {toAsset.symbol}{hasToPrice ? ` (${fmtCompact(parseFloat(quote.minimumOutput) * toPriceUsd)})` : ''}
                    </Text>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="11px" color="kk.textMuted">{t("networkFee")} / {t("slippage")}</Text>
                    <Text fontSize="11px" fontFamily="mono" color="kk.textSecondary">
                      {formatBalance(quote.fees.outbound)} {toAsset.symbol} / {(quote.slippageBps / 100).toFixed(2)}%
                    </Text>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="11px" color="kk.textMuted">{t("estimatedTime")}</Text>
                    <Text fontSize="11px" color="kk.textSecondary">{formatTime(quote.estimatedTime)}</Text>
                  </Flex>
                  {quote.warning && (
                    <Text fontSize="10px" color="var(--gold)" mt="0.5">{quote.warning}</Text>
                  )}
                </VStack>
              </Box>

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
                const tokenDecimals = fromAsset.decimals
                const fmt = (raw: string) => {
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
                const tokenDecimals = fromAsset.decimals
                const fmt = (raw: string) => {
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
                  cursor={refreshingQuote || (previewBuild?.balance && !previewBuild.balance.sufficient) ? "default" : "pointer"}
                  opacity={refreshingQuote || (previewBuild?.balance && !previewBuild.balance.sufficient) ? 0.5 : 1}
                  style={{
                    background: 'linear-gradient(180deg, var(--teal-2), var(--teal))',
                    boxShadow: '0 8px 24px -8px rgba(139,227,196,0.5)',
                    transition: 'transform 0.15s, box-shadow 0.15s',
                  }}
                  _hover={refreshingQuote || (previewBuild?.balance && !previewBuild.balance.sufficient)
                    ? {}
                    : { transform: "translateY(-1px)" }}
                  onClick={() => { if (!refreshingQuote && !(previewBuild?.balance && !previewBuild.balance.sufficient)) handleExecuteSwap() }}
                  disabled={refreshingQuote || (previewBuild?.balance && !previewBuild.balance.sufficient)}
                >
                  {refreshingQuote
                    ? t("refreshingQuote", "Refreshing quote...")
                    : (previewBuild?.balance && !previewBuild.balance.sufficient)
                      ? t("insufficientBalanceButton", "Insufficient balance")
                      : (previewBuild?.allowance && !previewBuild.allowance.sufficient)
                        ? t("approveAndSwap", "Approve & Swap")
                        : t("confirmSwap")}
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
                          <Button size="xs" px="2" variant={isMax ? "solid" : "outline"}
                            bg={isMax ? "kk.gold" : "transparent"} color={isMax ? "black" : "kk.gold"}
                            borderColor={isMax ? "kk.gold" : "rgba(233,196,106,0.3)"} fontWeight="700" fontSize="10px"
                            borderRadius="md" _hover={{ bg: isMax ? "kk.goldHover" : "rgba(233,196,106,0.1)" }}
                            onClick={() => {
                              const willBe = !isMax
                              const projected = willBe ? (nativeEvmMaxAmount ?? (fromBalance || '0')) : amount
                              const cb = balances.find(b => b.chainId === fromAsset?.chainId)
                              console.log(
                                `[swap-max-debug] wasMax=${isMax} willBeMax=${willBe}` +
                                ` | fromAsset.chainId=${fromAsset?.chainId} symbol=${fromAsset?.symbol} family=${fromAsset?.chainFamily} contract=${fromAsset?.contractAddress || 'none'}` +
                                ` | fromBalance=${JSON.stringify(fromBalance)} (typeof=${typeof fromBalance})` +
                                ` | nativeEvmMaxAmount=${JSON.stringify(nativeEvmMaxAmount)}` +
                                ` | sendAmount_projected=${JSON.stringify(projected)}` +
                                ` | inputMode=${inputMode} amount=${JSON.stringify(amount)}` +
                                ` | balances.find(chainId===fromAsset.chainId).balance=${JSON.stringify(cb?.balance)}` +
                                ` | balancesLen=${balances.length}`
                              )
                              setIsMax(!isMax); setAmount(""); setFiatAmount("")
                              requestAnimationFrame(() => {
                                const input = document.querySelector<HTMLInputElement>('input[placeholder="0.0"], input[placeholder="0.00"]')
                                console.log(`[swap-max-debug] post-click input.value="${input?.value ?? '<not found>'}"`)
                              })
                            }} disabled={busy}>
                            {t("max")}
                          </Button>
                        </Flex>
                      </Flex>

                      <Box position="relative">
                        {inputMode === 'fiat' && (
                          <Text position="absolute" left="8px" top="50%" transform="translateY(-50%)" fontSize="xs" fontWeight="600" color="kk.textSecondary" pointerEvents="none" zIndex={1}>$</Text>
                        )}
                        <Input
                          value={isMax ? (sendAmount ? formatBalance(sendAmount) : 'MAX') : (inputMode === 'crypto' ? amount : fiatAmount)}
                          onChange={(e) => { if (isMax) setIsMax(false); inputMode === 'crypto' ? handleCryptoChange(e.target.value) : handleFiatChange(e.target.value) }}
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
                      {isNativeEvmMax && !nativeMaxInsufficient && fromAsset && (
                        <Text fontSize="10px" color="kk.textMuted" mt="1" fontFamily="mono" letterSpacing="0.02em">
                          {t("maxReservesGas", { defaultValue: "Reserves ~{{reserve}} {{symbol}} for network fees", reserve: nativeEvmGasReserve(fromAsset).toString(), symbol: fromAsset.symbol })}
                        </Text>
                      )}
                      {nativeMaxInsufficient && fromAsset && (
                        <Text fontSize="10px" color="kk.error" mt="1" fontWeight="600">
                          {t("maxInsufficientForGas", { defaultValue: "Balance is below the gas reserve (~{{reserve}} {{symbol}}). Top up to swap.", reserve: nativeEvmGasReserve(fromAsset).toString(), symbol: fromAsset.symbol })}
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
                      {isNativeEvmMax && (
                        <Text fontSize="9px" color="var(--gold)" mt="1">{t("sendMaxGasNote")}</Text>
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
                <ProviderBadge swapper={quote.swapper} integration={quote.integration} size={14} variant="detailed" />
              ) : null /* don't claim a provider before we have a quote — was hardcoding THORChain even for Maya-only pairs (e.g. ZEC) */}
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
      <AssetPickerDialog
        open={pickerSide !== null}
        onClose={() => setPickerSide(null)}
        swappable={assets}
        balances={balances}
        excludeCaip={pickerSide === 'from' ? toAsset?.caip : fromAsset?.caip}
        side={pickerSide || 'from'}
        onSelect={(a) => {
          if (pickerSide === 'from') setFromAsset(a)
          else if (pickerSide === 'to') setToAsset(a)
          setQuote(null)
          setPhase('input')
          setError(null)
        }}
      />
    </Box>
  )
}
