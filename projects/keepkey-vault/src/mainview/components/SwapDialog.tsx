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
import { rpcRequest, onRpcMessage } from "../lib/rpc"
import { formatBalance } from "../lib/formatting"
import { formatUsd } from "../lib/formatting"
import { getAssetIcon } from "../../shared/assetLookup"
import { CHAINS, getExplorerTxUrl } from "../../shared/chains"
import type { ChainDef } from "../../shared/chains"
import { validateAddress } from "../../shared/address-validation"
import type { SwapAsset, SwapQuote, ChainBalance, SwapStatusUpdate, SwapTrackingStatus, PendingSwap } from "../../shared/types"
import { Z } from "../lib/z-index"

// ── Phase state machine ─────────────────────────────────────────────
type SwapPhase = 'input' | 'quoting' | 'review' | 'approving' | 'signing' | 'broadcasting' | 'submitted'

// Default "to" asset when swapping from a given chain — BTC-like default to ETH, others to BTC
const DEFAULT_OUTPUT: Record<string, string> = {
  bitcoin: 'ETH.ETH',
  ethereum: 'BTC.BTC',
  litecoin: 'BTC.BTC',
  dogecoin: 'BTC.BTC',
  bitcoincash: 'BTC.BTC',
  dash: 'BTC.BTC',
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

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
)

const ThorchainIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10" fill="#23DCC8" fillOpacity="0.15" />
    <path d="M12 4l-6 8 6 8 6-8-6-8z" fill="#23DCC8" fillOpacity="0.6" />
  </svg>
)

const CheckIcon = () => (
  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

const ShieldIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#23DCC8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
  const colors = ['#4ADE80', '#23DCC8', '#FFD700', '#FF6B6B', '#A78BFA', '#3B82F6', '#FB923C', '#F472B6']
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
function GreenCountUp({ value, prefix = '', suffix = '', color = '#4ADE80', fontSize = 'inherit', duration = 1.2 }: {
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
    0%, 100% { box-shadow: 0 0 0 0 rgba(35,220,200,0.5); }
    50% { box-shadow: 0 0 0 8px rgba(35,220,200,0); }
  }
  @keyframes kkSwapCheckPop {
    0% { transform: scale(0); opacity: 0; }
    60% { transform: scale(1.2); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes kkSwapDevicePulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,215,0,0.4); transform: scale(1); }
    50% { box-shadow: 0 0 20px 8px rgba(255,215,0,0.15); transform: scale(1.02); }
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
    0%, 100% { filter: drop-shadow(0 0 8px rgba(35,220,200,0.25)); }
    50% { filter: drop-shadow(0 0 20px rgba(35,220,200,0.5)); }
  }
  @keyframes kkGoldPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255,215,0,0.4); }
    50% { box-shadow: 0 0 16px 6px rgba(255,215,0,0.15); }
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
interface AssetSelectorProps {
  label: string
  selected: SwapAsset | null
  assets: SwapAsset[]
  onSelect: (asset: SwapAsset) => void
  balances?: ChainBalance[]
  exclude?: string
  disabled?: boolean
  nativeOnly?: boolean
}

function AssetSelector({ label, selected, assets, onSelect, balances, exclude, disabled, nativeOnly }: AssetSelectorProps) {
  const { t } = useTranslation("swap")
  const fmtCompact = (v: number | string | null | undefined) => { const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0); return !isFinite(n) || n === 0 ? '' : `$${formatUsd(n)}` }
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus()
  }, [open])

  const filtered = useMemo(() => {
    let list = exclude ? assets.filter(a => a.asset !== exclude) : assets
    if (nativeOnly) list = list.filter(a => !a.contractAddress)
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(a =>
        a.symbol.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.chainId.toLowerCase().includes(q)
      )
    }
    return list.slice(0, 50)
  }, [assets, search, exclude, nativeOnly])

  const getBalance = useCallback((asset: SwapAsset): { balance: string; usd: number } | null => {
    if (!balances) return null
    const chain = balances.find(b => b.chainId === asset.chainId)
    if (!chain) return null
    if (asset.contractAddress && chain.tokens) {
      const token = chain.tokens.find(t =>
        t.contractAddress?.toLowerCase() === asset.contractAddress?.toLowerCase()
      )
      return token ? { balance: token.balance, usd: token.balanceUsd || 0 } : null
    }
    return { balance: chain.balance, usd: chain.balanceUsd || 0 }
  }, [balances])

  const chainIcon = useCallback((asset: SwapAsset) => {
    const chainDef = CHAINS.find(c => c.id === asset.chainId)
    if (chainDef?.caip) return getAssetIcon(chainDef.caip)
    return `https://pioneers.dev/coins/${asset.symbol.toLowerCase()}.png`
  }, [])

  if (open) {
    return (
      <Box>
        <Text fontSize="xs" color="kk.textMuted" mb="1">{label}</Text>
        <Box bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="lg" overflow="hidden">
          <Flex align="center" gap="2" px="3" py="2" borderBottom="1px solid" borderColor="kk.border">
            <SearchIcon />
            <Input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchAssets")}
              bg="transparent"
              border="none"
              color="kk.textPrimary"
              size="sm"
              px="0"
              _focus={{ outline: "none", boxShadow: "none" }}
            />
            <Button
              size="xs" variant="ghost" color="kk.textMuted" px="1" minW="auto"
              onClick={() => { setOpen(false); setSearch("") }}
            >
              &times;
            </Button>
          </Flex>
          <Box maxH="200px" overflow="auto">
            {filtered.length === 0 ? (
              <Text fontSize="xs" color="kk.textMuted" p="3" textAlign="center">{t("noAssets")}</Text>
            ) : (
              filtered.map((asset) => {
                const balInfo = getBalance(asset)
                return (
                  <Flex
                    key={asset.asset}
                    align="center"
                    gap="3"
                    px="3"
                    py="2.5"
                    cursor="pointer"
                    _hover={{ bg: "rgba(35,220,200,0.06)" }}
                    transition="all 0.15s"
                    onClick={() => { onSelect(asset); setOpen(false); setSearch("") }}
                    borderRadius="lg"
                    mx="1"
                  >
                    <Image
                      src={chainIcon(asset)}
                      alt={asset.symbol}
                      w="48px" h="48px"
                      borderRadius="full"
                      bg="rgba(255,255,255,0.06)"
                      border="2px solid rgba(255,255,255,0.08)"
                      onError={(e: any) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <Flex direction="column" flex="1" minW="0">
                      <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{asset.symbol}</Text>
                      <Text fontSize="10px" color="kk.textMuted" truncate>{asset.name}</Text>
                    </Flex>
                    {balInfo && (
                      <Flex direction="column" align="flex-end" gap="0">
                        <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">{formatBalance(balInfo.balance)}</Text>
                        {balInfo.usd > 0 && (
                          <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">{fmtCompact(balInfo.usd)}</Text>
                        )}
                      </Flex>
                    )}
                  </Flex>
                )
              })
            )}
          </Box>
        </Box>
      </Box>
    )
  }

  /* ── Selected asset → big prominent display ── */
  if (selected) {
    return (
      <Box>
        <Flex justify="space-between" align="center" mb="3">
          <Text fontSize="xs" color="kk.textMuted" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">{label}</Text>
          {!disabled && (
            <Box as="button" display="flex" alignItems="center" gap="1" color="kk.textMuted" fontSize="11px" fontWeight="500"
              _hover={{ color: "kk.gold" }} transition="color 0.15s"
              onClick={() => setOpen(true)}>
              {t("change") || "Change"} <ChevronDownIcon />
            </Box>
          )}
        </Flex>
        <Flex
          align="center" gap="5"
          cursor={disabled ? "default" : "pointer"}
          opacity={disabled ? 0.7 : 1}
          onClick={() => { if (!disabled) setOpen(true) }}
          _hover={disabled ? {} : { opacity: 0.85 }}
          transition="opacity 0.15s"
        >
          <Box position="relative" flexShrink={0}>
            <Image
              src={chainIcon(selected)}
              alt={selected.symbol}
              w="80px" h="80px"
              borderRadius="full"
              bg="rgba(255,255,255,0.06)"
              border="2px solid rgba(35,220,200,0.25)"
              style={{ animation: 'kkLogoFloat 3s ease-in-out infinite, kkLogoGlow 3s ease-in-out infinite' }}
              onError={(e: any) => { (e.target as HTMLImageElement).style.display = 'none' }}
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
        _hover={disabled ? {} : { borderColor: "kk.gold", bg: "rgba(255,215,0,0.04)" }}
        transition="all 0.2s"
        onClick={() => { if (!disabled) setOpen(true) }}
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
  const fmtCompact = (v: number | string | null | undefined) => { const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0); return !isFinite(n) || n === 0 ? '' : `$${formatUsd(n)}` }
  const fiatSymbol = '$'

  // ── State ─────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<SwapPhase>('input')
  const [assets, setAssets] = useState<SwapAsset[]>([])
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [assetLoadError, setAssetLoadError] = useState<string | null>(null)
  const [balances, setBalances] = useState<ChainBalance[]>([])

  const [fromAsset, setFromAsset] = useState<SwapAsset | null>(null)
  const [toAsset, setToAsset] = useState<SwapAsset | null>(null)
  const [amount, setAmount] = useState("")
  const [fiatAmount, setFiatAmount] = useState("")
  const [inputMode, setInputMode] = useState<'crypto' | 'fiat'>('crypto')
  const [isMax, setIsMax] = useState(false)

  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // ── Live swap tracking state ────────────────────────────────────
  const [liveStatus, setLiveStatus] = useState<SwapTrackingStatus>('pending')
  const [liveConfirmations, setLiveConfirmations] = useState(0)
  const [liveOutboundConfirmations, setLiveOutboundConfirmations] = useState<number | undefined>()
  const [liveOutboundRequired, setLiveOutboundRequired] = useState<number | undefined>()
  const [liveOutboundTxid, setLiveOutboundTxid] = useState<string | undefined>()

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
    })

    const unsub2 = onRpcMessage('swap-complete', (swap: any) => {
      if (swap.txid !== txid) return
      setLiveStatus(swap.status || 'completed')
    })

    return () => { unsub1(); unsub2() }
  }, [txid, phase])

  // Reset live tracking when phase changes away from submitted
  useEffect(() => {
    if (phase !== 'submitted') {
      setLiveStatus('pending')
      setLiveConfirmations(0)
      setLiveOutboundConfirmations(undefined)
      setLiveOutboundRequired(undefined)
      setLiveOutboundTxid(undefined)
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

    // Build SwapAsset objects from PendingSwap data, resolving chain metadata from CHAINS
    const fromChain = CHAINS.find(c => c.id === resumeSwap.fromChainId)
    const toChain = CHAINS.find(c => c.id === resumeSwap.toChainId)
    const from: SwapAsset = {
      asset: resumeSwap.fromAsset,
      chainId: resumeSwap.fromChainId,
      symbol: resumeSwap.fromSymbol,
      name: resumeSwap.fromSymbol,
      chainFamily: fromChain?.chainFamily ?? 'utxo',
      decimals: fromChain?.decimals ?? 8,
    }
    const to: SwapAsset = {
      asset: resumeSwap.toAsset,
      chainId: resumeSwap.toChainId,
      symbol: resumeSwap.toSymbol,
      name: resumeSwap.toSymbol,
      chainFamily: toChain?.chainFamily ?? 'utxo',
      decimals: toChain?.decimals ?? 8,
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
      slippageBps: 0,
      fromAsset: resumeSwap.fromAsset,
      toAsset: resumeSwap.toAsset,
    })
    setPhase('submitted')
  }, [open, resumeSwap])

  // ── Derived values ────────────────────────────────────────────────
  const fromBalance = useMemo(() => {
    if (!fromAsset) return null
    if (balance && chain && fromAsset.chainId === chain.id && !fromAsset.contractAddress) {
      return balance.balance
    }
    const cb = balances.find(b => b.chainId === fromAsset.chainId)
    if (!cb) return null
    if (fromAsset.contractAddress && cb.tokens) {
      const token = cb.tokens.find(t =>
        t.contractAddress?.toLowerCase() === fromAsset.contractAddress?.toLowerCase()
      )
      return token ? token.balance : null
    }
    return cb.balance
  }, [fromAsset, balance, chain, balances])

  // Derive per-unit USD price for from/to assets from cached balances
  const fromPriceUsd = useMemo(() => {
    if (!fromAsset) return 0
    const cb = balance && chain && fromAsset.chainId === chain.id ? balance : balances.find(b => b.chainId === fromAsset.chainId)
    if (!cb) return 0
    if (fromAsset.contractAddress && cb.tokens) {
      const tok = cb.tokens.find(t => t.contractAddress?.toLowerCase() === fromAsset.contractAddress?.toLowerCase())
      return tok?.priceUsd || 0
    }
    const bal = parseFloat(cb.balance)
    return bal > 0 ? (cb.balanceUsd || 0) / bal : 0
  }, [fromAsset, balance, chain, balances])

  const toPriceUsd = useMemo(() => {
    if (!toAsset) return 0
    const cb = balances.find(b => b.chainId === toAsset.chainId)
    if (!cb) return 0
    if (toAsset.contractAddress && cb.tokens) {
      const tok = cb.tokens.find(t => t.contractAddress?.toLowerCase() === toAsset.contractAddress?.toLowerCase())
      return tok?.priceUsd || 0
    }
    const bal = parseFloat(cb.balance)
    return bal > 0 ? (cb.balanceUsd || 0) / bal : 0
  }, [toAsset, balances])

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
  const prevAutoDefaultAsset = useRef<string | null>(null)
  useEffect(() => {
    if (!fromAsset || !fromPriceUsd || fromPriceUsd <= 0 || !fromBalance) return
    if (prevAutoDefaultAsset.current === fromAsset.asset) return
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
  }, [fromAsset, fromPriceUsd, fromBalance, handleCryptoChange])

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

  const validAmount = isMax || (amount !== '' && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0)
  const canQuote = fromAsset && toAsset && !sameAsset && validAmount && fromAddress && toAddress && !exceedsBalance && !customAddressError

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
        const result = await rpcRequest<SwapQuote>('getSwapQuote', {
          fromAsset: fromAsset!.asset,
          toAsset: toAsset!.asset,
          amount: isMax ? (fromBalance || '0') : amount,
          fromAddress,
          toAddress,
          slippageBps: 300,
        }, 30000)
        if (version !== quoteVersionRef.current) return
        setQuote(result)
        setPhase('input')
      } catch (e: any) {
        if (version !== quoteVersionRef.current) return
        const msg = e.message || ''
        // Parse common DEX node errors into user-friendly messages
        if (/not enough asset to pay for fees/i.test(msg)) {
          setError(t("swapTooSmallForFees"))
        } else if (/pool.*not available|pool.*staged/i.test(msg)) {
          setError(t("poolNotAvailable"))
        } else {
          setError(msg || t("errorQuote"))
        }
        setPhase('input')
      }
    }, 800)

    return () => {
      if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current)
    }
  }, [fromAsset?.asset, toAsset?.asset, amount, isMax, fromAddress, toAddress, exceedsBalance, fromBalance])

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
    setPhase(isErc20 ? 'approving' : 'signing')
    setError(null)

    // Freeze the sent amount so balance changes don't affect the display
    setSentAmount(isMax ? (fromBalance || '0') : amount)

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
        fromAsset: fromAsset.asset,
        toAsset: toAsset.asset,
        amount: isMax ? (fromBalance || '0') : amount,
        memo: quote.memo,
        inboundAddress: quote.inboundAddress,
        router: quote.router,
        expiry: quote.expiry,
        expectedOutput: quote.expectedOutput,
        isMax,
        feeLevel: 5,
        fromAddressOverride: fromAddress,
        toAddressOverride: toAddress,
      }, 180000)

      setTxid(result.txid)
      setPhase('submitted')
      window.dispatchEvent(new CustomEvent('keepkey-swap-executed'))
    } catch (e: any) {
      setError(e.message || t("errorSwap"))
      setPhase('review')
    }
  }, [quote, fromAsset, toAsset, amount, isMax, fromBalance, balances])

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
  const displayAmount = sentAmount ?? (isMax ? (fromBalance || '0') : amount)
  // sendMax on native EVM: quote uses full balance but execution subtracts gas, so output is overstated
  const isNativeEvmMax = isMax && !!fromAsset && fromAsset.chainFamily === 'evm' && !fromAsset.contractAddress

  const chainIcon = useCallback((asset: SwapAsset) => {
    const chainDef = CHAINS.find(c => c.id === asset.chainId)
    if (chainDef?.caip) return getAssetIcon(chainDef.caip)
    return `https://pioneers.dev/coins/${asset.symbol.toLowerCase()}.png`
  }, [])

  // Must be above early return to satisfy Rules of Hooks
  const swappableChainIds = useMemo(() => new Set(assets.map(a => a.chainId)), [assets])

  if (!open) return null
  if (chain && !resumeSwap && !loadingAssets && assets.length > 0 && !swappableChainIds.has(chain.id)) {
    return (
      <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={handleClose}>
        <Box position="absolute" inset="0" bg="blackAlpha.700" />
        <Box position="relative" bg="kk.cardBg" border="2px solid" borderColor="rgba(35,220,200,0.4)" borderRadius="xl" boxShadow="0 0 20px rgba(35,220,200,0.1)" p="6" w="400px" maxW="90vw" onClick={(e) => e.stopPropagation()} textAlign="center">
          <Image src="https://pioneers.dev/coins/thorchain.png" alt="THORChain" w="32px" h="32px" borderRadius="full" />
          <Text fontSize="sm" color="kk.textMuted" mt="3">{t("notSupported", { coin: chain.coin })}</Text>
          <Button size="sm" mt="4" variant="ghost" color="kk.textSecondary" px="4" py="2" onClick={handleClose}>{t("close")}</Button>
        </Box>
      </Box>
    )
  }

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={handleClose}>
      <style>{DIALOG_CSS}</style>
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box
        position="relative"
        bg="kk.cardBg"
        border="2px solid"
        borderColor={phase === 'submitted' ? '#23DCC8' : busy ? 'rgba(255,215,0,0.5)' : 'rgba(35,220,200,0.4)'}
        borderRadius="xl"
        boxShadow={phase === 'submitted' ? '0 0 24px rgba(35,220,200,0.25), 0 0 48px rgba(35,220,200,0.1)' : busy ? '0 0 20px rgba(255,215,0,0.15)' : '0 0 20px rgba(35,220,200,0.1), 0 0 40px rgba(35,220,200,0.05)'}
        w="760px"
        maxW="94vw"
        maxH="90vh"
        overflow="auto"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <Flex px="5" py="2.5" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between"
          bg="linear-gradient(90deg, rgba(35,220,200,0.03) 0%, transparent 100%)">
          <HStack gap="2">
            <Image src="https://pioneers.dev/coins/thorchain.png" alt="THORChain" w="22px" h="22px" borderRadius="full" />
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
              <Box w="48px" h="48px" borderRadius="full" bg="rgba(255,165,0,0.1)" display="flex" alignItems="center" justifyContent="center" mx="auto">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFA500" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

              {/* Status icon + title inline */}
              <Flex align="center" gap="3">
                {isSwapComplete ? (
                  <Box w="40px" h="40px" borderRadius="full" bg="rgba(74,222,128,0.1)" border="2px solid" borderColor="rgba(74,222,128,0.4)"
                    display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                    style={{ animation: 'kkSwapCheckPop 0.4s ease-out' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ADE80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  </Box>
                ) : isSwapFailed ? (
                  <Box w="40px" h="40px" borderRadius="full" bg="rgba(255,23,68,0.1)" border="2px solid" borderColor="rgba(255,23,68,0.3)"
                    display="flex" alignItems="center" justifyContent="center" flexShrink={0}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FF1744" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </Box>
                ) : (
                  <Box w="40px" h="40px" borderRadius="full" bg="rgba(35,220,200,0.08)" border="2px solid" borderColor="rgba(35,220,200,0.3)"
                    display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                    style={{ animation: 'kkSwapPulse 2s ease-in-out infinite' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#23DCC8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" opacity="0.3" /><path d="M12 6v6l4 2" />
                    </svg>
                  </Box>
                )}
                <VStack gap="0" align="flex-start">
                  <Text fontSize="md" fontWeight="700" color={isSwapComplete ? "#4ADE80" : isSwapFailed ? "#FF1744" : "kk.textPrimary"}>
                    {isSwapComplete ? t("swapCompleted") : isSwapFailed ? t("swapFailed") : t("swapSubmitted")}
                  </Text>
                  {!isSwapComplete && !isSwapFailed && (
                    <Text fontSize="xs" color="#FBBF24" fontWeight="500">{t("waitingForConfirmations")}</Text>
                  )}
                </VStack>
              </Flex>

              {/* ── Progress bar with checkpoints ────────────────────── */}
              <Box w="full" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="lg" px="5" py="4">
                {/* Bar track + filled portion */}
                <Box position="relative" h="6px" bg="rgba(255,255,255,0.08)" borderRadius="full" mb="3">
                  {/* Filled bar — width based on step progress, animated stripes when in progress */}
                  <Box
                    position="absolute" top="0" left="0" h="6px" borderRadius="full"
                    bg={isSwapComplete ? 'linear-gradient(90deg, #10B981, #059669)' : undefined}
                    boxShadow="0 0 8px rgba(35,220,200,0.4)"
                    w={isSwapComplete ? '100%' : swapStep === 2 ? '83%' : swapStep === 1 ? '50%' : '17%'}
                    transition="width 0.6s ease-in-out"
                    overflow="hidden"
                    style={!isSwapComplete ? {
                      backgroundImage: 'linear-gradient(45deg, rgba(35,220,200,0.9) 25%, rgba(16,185,129,0.7) 25%, rgba(16,185,129,0.7) 50%, rgba(35,220,200,0.9) 50%, rgba(35,220,200,0.9) 75%, rgba(16,185,129,0.7) 75%)',
                      backgroundSize: '40px 40px',
                      animation: 'kkBarStripes 1s linear infinite',
                    } : undefined}
                  />

                  {/* Checkpoint 0: Input — left */}
                  <Flex position="absolute" left="0" top="50%" transform="translate(-50%, -50%)" direction="column" align="center" gap="1">
                    <Box w="32px" h="32px" borderRadius="full" display="flex" alignItems="center" justifyContent="center"
                      bg={swapStep > 0 ? 'linear-gradient(135deg, #10B981, #059669)' : 'linear-gradient(135deg, #14B8A6, #0D9488)'}
                      border="2px solid" borderColor={swapStep > 0 ? '#10B981' : '#14B8A6'}
                      boxShadow={swapStep === 0 ? '0 4px 14px rgba(20,184,166,0.5), 0 0 25px 5px rgba(20,184,166,0.3)' : '0 2px 8px rgba(16,185,129,0.4)'}
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
                      bg={swapStep > 1 ? 'linear-gradient(135deg, #10B981, #059669)' : swapStep === 1 ? 'linear-gradient(135deg, #14B8A6, #0D9488)' : 'linear-gradient(135deg, #374151, #1F2937)'}
                      border="2px solid" borderColor={swapStep > 1 ? '#10B981' : swapStep === 1 ? '#14B8A6' : '#4B5563'}
                      boxShadow={swapStep === 1 ? '0 4px 14px rgba(20,184,166,0.5), 0 0 25px 5px rgba(20,184,166,0.3)' : swapStep > 1 ? '0 2px 8px rgba(16,185,129,0.4)' : '0 2px 6px rgba(75,85,99,0.3)'}
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
                      bg={swapStep > 2 ? 'linear-gradient(135deg, #10B981, #059669)' : swapStep === 2 ? 'linear-gradient(135deg, #14B8A6, #0D9488)' : 'linear-gradient(135deg, #374151, #1F2937)'}
                      border="2px solid" borderColor={swapStep > 2 ? '#10B981' : swapStep === 2 ? '#14B8A6' : '#4B5563'}
                      boxShadow={swapStep === 2 ? '0 4px 14px rgba(20,184,166,0.5), 0 0 25px 5px rgba(20,184,166,0.3)' : swapStep > 2 ? '0 2px 8px rgba(16,185,129,0.4)' : '0 2px 6px rgba(75,85,99,0.3)'}
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
                      <Text fontSize="9px" fontFamily="mono" color="#23DCC8">{liveConfirmations} {t("confirmations")}</Text>
                    )}
                    {swapStep > 0 && <Text fontSize="9px" color="#10B981">{t("statusCompleted")}</Text>}
                  </VStack>
                  <VStack gap="0" align="center" w="80px">
                    <Text fontSize="10px" fontWeight="600" color={swapStep >= 1 ? 'kk.textPrimary' : 'kk.textMuted'}>{t("stageProtocol")}</Text>
                    {swapStep === 1 && <Text fontSize="9px" color="#23DCC8">{t("statusConfirming")}...</Text>}
                    {swapStep > 1 && <Text fontSize="9px" color="#10B981">{t("statusCompleted")}</Text>}
                  </VStack>
                  <VStack gap="0" align="flex-end" w="80px">
                    <Text fontSize="10px" fontWeight="600" color={swapStep >= 2 ? 'kk.textPrimary' : 'kk.textMuted'}>{t("stageOutput")}</Text>
                    {swapStep === 2 && liveOutboundConfirmations !== undefined && (
                      <Text fontSize="9px" fontFamily="mono" color="#23DCC8">{liveOutboundConfirmations}{liveOutboundRequired ? `/${liveOutboundRequired}` : ''}</Text>
                    )}
                    {swapStep === 2 && liveOutboundConfirmations === undefined && (
                      <Text fontSize="9px" color="#23DCC8">{t("statusOutputDetected")}</Text>
                    )}
                    {swapStep > 2 && <Text fontSize="9px" color="#10B981">{t("statusCompleted")}</Text>}
                  </VStack>
                </Flex>
              </Box>

              {/* Live countdown — only show when not complete */}
              {!isSwapComplete && !isSwapFailed && (countdown > 0 || (quote?.estimatedTime && quote.estimatedTime > 0)) && (
                <Flex w="full" justify="center" align="center" gap="3"
                  bg="rgba(35,220,200,0.06)" border="1px solid" borderColor="rgba(35,220,200,0.15)"
                  borderRadius="lg" px="4" py="2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#23DCC8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                  <Text fontSize="sm" fontFamily="mono" fontWeight="700" color="#23DCC8">
                    {countdown > 0 ? (
                      <>{Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, '0')}</>
                    ) : formatTime(quote?.estimatedTime || 0)}
                  </Text>
                  <Text fontSize="10px" color="kk.textMuted">{t("estimatedTime")}</Text>
                </Flex>
              )}

              {/* Amount summary */}
              <Flex w="full" bg="rgba(35,220,200,0.06)" border="1px solid" borderColor="rgba(35,220,200,0.15)"
                borderRadius="xl" p="4" justify="center" align="center" gap="4">
                <VStack gap="0.5">
                  <HStack gap="3">
                    <Image src={chainIcon(fromAsset)} w="56px" h="56px" borderRadius="full"
                      style={{ animation: 'kkLogoGlow 3s ease-in-out infinite' }} />
                    <Text fontSize="sm" fontWeight="700" color="kk.textPrimary">{displayAmount} {fromAsset.symbol}</Text>
                  </HStack>
                  {hasFromPrice && (
                    <Text fontSize="xs" color="kk.textMuted">{fmtCompact(parseFloat(displayAmount) * fromPriceUsd)}</Text>
                  )}
                </VStack>
                <Text color="#FFD700" fontSize="md" fontWeight="700">&rarr;</Text>
                <VStack gap="0.5">
                  <HStack gap="3">
                    <Image src={chainIcon(toAsset)} w="56px" h="56px" borderRadius="full"
                      style={{ animation: 'kkLogoGlow 3s ease-in-out infinite' }} />
                    <Text fontSize="sm" fontWeight="700" color="#23DCC8">~<GreenCountUp value={quote?.expectedOutput || '0'} color="#23DCC8" suffix={` ${toAsset.symbol}`} /></Text>
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
                  <Button size="xs" flex="1" variant="outline" borderColor="rgba(35,220,200,0.3)" color="#23DCC8"
                    _hover={{ bg: "rgba(35,220,200,0.08)", borderColor: "#23DCC8" }}
                    onClick={() => rpcRequest('openUrl', { url: `https://track.ninerealms.com/${txid.toUpperCase()}` }).catch(() => {})}>
                    <HStack gap="1">
                      <Image src="https://pioneers.dev/coins/thorchain.png" w="12px" h="12px" borderRadius="full" />
                      <Text fontSize="10px">Track Swap</Text>
                    </HStack>
                  </Button>
                </Flex>
              </Box>

              {/* Outbound Txid — shown when THORChain sends the output */}
              {liveOutboundTxid && (
                <Box w="full" bg="rgba(74,222,128,0.06)" border="1px solid" borderColor="rgba(74,222,128,0.15)" borderRadius="lg" p="3">
                  <Flex justify="space-between" align="center">
                    <HStack gap="1.5" minW="0" flex="1">
                      <Text fontSize="10px" color="#4ADE80" flexShrink={0}>{t("stageOutput")}</Text>
                      <Text fontSize="11px" fontFamily="mono" color="#4ADE80" wordBreak="break-all" lineHeight="1.4">
                        {liveOutboundTxid}
                      </Text>
                    </HStack>
                    <HStack gap="1">
                      <Button size="xs" variant="ghost" color="#4ADE80" px="1.5" minW="auto"
                        onClick={() => { navigator.clipboard.writeText(liveOutboundTxid) }}>
                        {t("copy")}
                      </Button>
                      {(() => {
                        const url = getExplorerTxUrl(toAsset.chainId, liveOutboundTxid)
                        return url ? (
                          <Button size="xs" variant="ghost" color="#4ADE80" px="1.5" minW="auto"
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
                  <Text fontSize="10px" fontWeight="600" color="#4ADE80" mb="2" textTransform="uppercase" letterSpacing="0.05em">
                    Balance Changes
                  </Text>
                  <VStack gap="1.5" align="stretch">
                    {/* From asset balance change */}
                    <Flex justify="space-between" align="center">
                      <HStack gap="1.5">
                        <Image src={chainIcon(fromAsset)} w="14px" h="14px" borderRadius="full" />
                        <Text fontSize="11px" color="kk.textSecondary">{fromAsset.symbol}</Text>
                      </HStack>
                      <VStack gap="0" align="flex-end">
                        <HStack gap="2">
                          <Text fontSize="11px" fontFamily="mono" color="kk.textMuted">
                            {beforeFromBal ? formatBalance(beforeFromBal) : '-'}
                          </Text>
                          <Text fontSize="10px" color="kk.textMuted">&rarr;</Text>
                          <Text fontSize="11px" fontFamily="mono" color={afterFromBal ? '#FB923C' : 'kk.textMuted'}>
                            {afterFromBal ? formatBalance(afterFromBal) : '...'}
                          </Text>
                          {afterFromBal && beforeFromBal && (
                            <Text fontSize="10px" fontFamily="mono" color="#EF4444">
                              ({formatBalance((parseFloat(afterFromBal) - parseFloat(beforeFromBal)).toFixed(8))})
                            </Text>
                          )}
                        </HStack>
                        {hasFromPrice && afterFromBal && beforeFromBal && (
                          <Text fontSize="9px" fontFamily="mono" color="#EF4444">
                            {fmtCompact((parseFloat(afterFromBal) - parseFloat(beforeFromBal)) * fromPriceUsd)}
                          </Text>
                        )}
                      </VStack>
                    </Flex>
                    {/* To asset balance change */}
                    <Flex justify="space-between" align="center">
                      <HStack gap="1.5">
                        <Image src={chainIcon(toAsset)} w="14px" h="14px" borderRadius="full" />
                        <Text fontSize="11px" color="kk.textSecondary">{toAsset.symbol}</Text>
                      </HStack>
                      <VStack gap="0" align="flex-end">
                        <HStack gap="2">
                          <Text fontSize="11px" fontFamily="mono" color="kk.textMuted">
                            {beforeToBal ? formatBalance(beforeToBal) : '-'}
                          </Text>
                          <Text fontSize="10px" color="kk.textMuted">&rarr;</Text>
                          <Text fontSize="11px" fontFamily="mono" color={afterToBal ? '#4ADE80' : 'kk.textMuted'}>
                            {afterToBal ? <GreenCountUp value={afterToBal} color="#4ADE80" /> : '...'}
                          </Text>
                          {afterToBal && beforeToBal && (
                            <Text fontSize="10px" fontFamily="mono" color="#4ADE80">
                              (+{formatBalance((parseFloat(afterToBal) - parseFloat(beforeToBal)).toFixed(8))})
                            </Text>
                          )}
                        </HStack>
                        {hasToPrice && afterToBal && beforeToBal && (
                          <Text fontSize="9px" fontFamily="mono" color="#4ADE80">
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
                  bg={isSwapComplete ? "#4ADE80" : "kk.gold"} color="black" fontWeight="600"
                  px="4" py="2" _hover={{ opacity: 0.9 }}
                  onClick={() => { onClose(); setTimeout(reset, 200) }}>
                  {isSwapComplete ? t("done") : t("close")}
                </Button>
              </Flex>
            </VStack>
          )}

          {/* ── SIGNING / APPROVING / BROADCASTING ───────────────── */}
          {busy && fromAsset && toAsset && (
            <VStack gap="3" py="4" style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }}>
              {/* Device icon with label inline */}
              <Flex align="center" gap="4">
                <Box
                  w="56px" h="56px"
                  borderRadius="xl"
                  bg="rgba(255,215,0,0.08)"
                  border="2px solid"
                  borderColor="rgba(255,215,0,0.2)"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  flexShrink={0}
                  style={{ animation: 'kkSwapDevicePulse 2s ease-in-out infinite' }}
                >
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#FFD700" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                    <path d="M12 18h.01" />
                  </svg>
                </Box>
                <VStack gap="0" align="flex-start">
                  <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
                    {phase === 'approving' ? t("approvingToken") : phase === 'signing' ? t("confirmOnDevice") : t("broadcasting")}
                  </Text>
                  <Text fontSize="xs" color="kk.textMuted">
                    {phase === 'signing' ? t("confirmOnDeviceDesc") : phase === 'approving' ? t("approvalRequired") : t("broadcastingDesc")}
                  </Text>
                </VStack>
              </Flex>

              {/* Mini summary */}
              <VStack gap="0.5">
                <Flex align="center" gap="2" bg="rgba(255,255,255,0.04)" px="4" py="2" borderRadius="lg">
                  <Text fontSize="sm" color="kk.textSecondary">{displayAmount} {fromAsset.symbol}</Text>
                  <Text color="kk.textMuted">&rarr;</Text>
                  <Text fontSize="sm" color="#23DCC8">~<GreenCountUp value={quote?.expectedOutput || '0'} color="#23DCC8" suffix={` ${toAsset.symbol}`} /></Text>
                </Flex>
                {hasFromPrice && (
                  <Text fontSize="10px" color="kk.textMuted">
                    {fmtCompact(parseFloat(displayAmount) * fromPriceUsd)}
                    {hasToPrice && quote?.expectedOutput ? ` \u2192 ${fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}` : ''}
                  </Text>
                )}
              </VStack>
            </VStack>
          )}

          {/* ── REVIEW ───────────────────────────────────────────── */}
          {phase === 'review' && quote && fromAsset && toAsset && !busy && (
            <VStack gap="3" style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}>
              {/* You Send / You Receive */}
              <Box w="full">
                <Text fontSize="xs" color="kk.textMuted" mb="2" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">{t("youSend")}</Text>
                <Flex
                  align="center" gap="4" p="4"
                  bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="xl"
                >
                  <Image src={chainIcon(fromAsset)} w="56px" h="56px" borderRadius="full" border="2px solid rgba(255,255,255,0.1)"
                    style={{ animation: 'kkLogoGlow 3s ease-in-out infinite' }} />
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="800" color="kk.textPrimary">{displayAmount} {fromAsset.symbol}</Text>
                    <Flex gap="2" align="center">
                      <Text fontSize="xs" color="kk.textMuted">{fromAsset.name}</Text>
                      {hasFromPrice && (
                        <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary" fontWeight="600">{fmtCompact(parseFloat(displayAmount) * fromPriceUsd)}</Text>
                      )}
                    </Flex>
                  </Box>
                </Flex>
              </Box>

              <Flex justify="center" my="-1">
                <Box w="36px" h="36px" display="flex" alignItems="center" justifyContent="center" borderRadius="full"
                  bg="rgba(255,215,0,0.1)" border="2px solid rgba(255,215,0,0.3)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFD700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </Box>
              </Flex>

              <Box w="full" mt="-1">
                <Text fontSize="xs" color="kk.textMuted" mb="2" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">{t("youReceive")}</Text>
                <Flex
                  align="center" gap="4" p="4"
                  bg="rgba(35,220,200,0.04)" border="1px solid" borderColor="rgba(35,220,200,0.2)" borderRadius="xl"
                >
                  <Image src={chainIcon(toAsset)} w="56px" h="56px" borderRadius="full" border="2px solid rgba(35,220,200,0.2)"
                    style={{ animation: 'kkLogoGlow 3s ease-in-out infinite' }} />
                  <Box flex="1">
                    <Text fontSize="sm" fontWeight="800" color="#23DCC8">~<GreenCountUp value={quote.expectedOutput} color="#23DCC8" suffix={` ${toAsset.symbol}`} /></Text>
                    <Flex gap="2" align="center">
                      <Text fontSize="xs" color="kk.textMuted">{toAsset.name}</Text>
                      {hasToPrice && (
                        <Text fontSize="xs" fontFamily="mono" color="#23DCC8" fontWeight="600">{fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}</Text>
                      )}
                    </Flex>
                  </Box>
                </Flex>
                {isNativeEvmMax && (
                  <Text fontSize="10px" color="#FB923C" mt="1.5" px="1">{t("sendMaxGasNote")}</Text>
                )}
              </Box>

              {/* Quote details */}
              <Box
                w="full"
                bg="rgba(255,255,255,0.03)"
                border="1px solid"
                borderColor="kk.border"
                borderRadius="lg"
                p="3"
              >
                <VStack gap="1.5" align="stretch">
                  <Flex justify="space-between">
                    <Text fontSize="xs" color="kk.textMuted">{t("rate")}</Text>
                    <Flex direction="column" align="flex-end" gap="0">
                      <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">
                        1 {fromAsset.symbol} = {formatBalance(
                          (parseFloat(quote.expectedOutput) / parseFloat(displayAmount || '1')).toString()
                        )} {toAsset.symbol}
                      </Text>
                      {hasFromPrice && (
                        <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">
                          1 {fromAsset.symbol} = {fmtCompact(fromPriceUsd)}
                        </Text>
                      )}
                    </Flex>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="xs" color="kk.textMuted">{t("minimumReceived")}</Text>
                    <Flex direction="column" align="flex-end" gap="0">
                      <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">
                        {formatBalance(quote.minimumOutput)} {toAsset.symbol}
                      </Text>
                      {hasToPrice && (
                        <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">
                          {fmtCompact(parseFloat(quote.minimumOutput) * toPriceUsd)}
                        </Text>
                      )}
                    </Flex>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="xs" color="kk.textMuted">{t("networkFee")}</Text>
                    <Flex direction="column" align="flex-end" gap="0">
                      <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">
                        {formatBalance(quote.fees.outbound)} ({quote.fees.totalBps / 100}%)
                      </Text>
                      {hasToPrice && (
                        <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">
                          {fmtCompact(parseFloat(quote.fees.outbound) * toPriceUsd)}
                        </Text>
                      )}
                    </Flex>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="xs" color="kk.textMuted">{t("slippage")}</Text>
                    <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">
                      {(quote.slippageBps / 100).toFixed(2)}%
                    </Text>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="xs" color="kk.textMuted">{t("estimatedTime")}</Text>
                    <Text fontSize="xs" color="kk.textSecondary">{formatTime(quote.estimatedTime)}</Text>
                  </Flex>

                  {quote.router && fromAsset.chainFamily === 'evm' && (
                    <Flex justify="space-between" align="flex-start" gap="3">
                      <Text fontSize="xs" color="kk.textMuted" flexShrink={0}>{t("routerContract")}</Text>
                      <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all" textAlign="right">
                        {quote.router}
                      </Text>
                    </Flex>
                  )}
                  <Flex justify="space-between" align="flex-start" gap="3">
                    <Text fontSize="xs" color="kk.textMuted" flexShrink={0}>{t("vault")}</Text>
                    <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" wordBreak="break-all" textAlign="right">
                      {quote.inboundAddress}
                    </Text>
                  </Flex>

                  {quote.warning && (
                    <Text fontSize="10px" color="#FB923C" mt="1">{quote.warning}</Text>
                  )}
                </VStack>
              </Box>

              {/* Security badge */}
              <Flex align="center" gap="2" bg="rgba(35,220,200,0.04)" px="3" py="2" borderRadius="lg" w="full">
                <ShieldIcon />
                <Text fontSize="11px" color="#23DCC8">{t("verifyOnDevice")}</Text>
              </Flex>

              {/* Error */}
              {error && (
                <Box bg="rgba(255,23,68,0.08)" border="1px solid" borderColor="kk.error" borderRadius="lg" p="3" w="full">
                  <Text fontSize="xs" color="kk.error">{error}</Text>
                </Box>
              )}

              {/* Actions */}
              <Flex gap="2" w="full">
                <Button
                  size="sm" flex="1"
                  px="4" py="2"
                  variant="outline"
                  color="kk.textSecondary"
                  borderColor="kk.border"
                  _hover={{ bg: "rgba(255,255,255,0.06)" }}
                  onClick={() => { setQuote(null); setPhase('input') }}
                >
                  {t("back")}
                </Button>
                <Button
                  size="sm" flex="2"
                  px="4" py="2"
                  bg="#23DCC8"
                  color="black"
                  fontWeight="600"
                  _hover={{ opacity: 0.9 }}
                  onClick={handleExecuteSwap}
                >
                  {t("confirmSwap")}
                </Button>
              </Flex>
            </VStack>
          )}

          {/* ── INPUT — side-by-side layout ─────────────────────── */}
          {!loadingAssets && !assetLoadError && (phase === 'input' || phase === 'quoting') && (
            <VStack gap="2" align="stretch">
              {/* Side-by-side: FROM | flip | TO */}
              <Flex gap="2" align="stretch">
                {/* FROM column */}
                <Box
                  flex="1"
                  bg="linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(35,220,200,0.03) 100%)"
                  border="1px solid" borderColor="kk.border" borderRadius="xl" p="3"
                  transition="border-color 0.2s"
                  _hover={{ borderColor: "rgba(35,220,200,0.2)" }}
                >
                  <AssetSelector
                    label={t("from")}
                    selected={fromAsset}
                    assets={assets}
                    onSelect={(a) => { setFromAsset(a); setQuote(null); setPhase('input'); setError(null) }}
                    balances={balances}
                    exclude={toAsset?.asset}
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
                            <Text fontSize="10px" color="kk.textMuted">{fmtCompact(parseFloat(fromBalance) * fromPriceUsd)}</Text>
                          )}
                        </VStack>
                        <Flex gap="1" align="center">
                          {hasFromPrice && (
                            <Box as="button" display="flex" alignItems="center" gap="0.5" color="kk.textMuted" cursor="pointer"
                              _hover={{ color: "kk.gold" }} onClick={toggleInputMode}
                              title={inputMode === 'crypto' ? t("switchToFiat") : t("switchToCrypto")}>
                              <SwapInputIcon />
                              <Text fontSize="9px">{inputMode === 'crypto' ? fiatSymbol : fromAsset.symbol}</Text>
                            </Box>
                          )}
                          <Button size="xs" px="2" variant={isMax ? "solid" : "outline"}
                            bg={isMax ? "kk.gold" : "transparent"} color={isMax ? "black" : "kk.gold"}
                            borderColor={isMax ? "kk.gold" : "rgba(255,215,0,0.3)"} fontWeight="700" fontSize="10px"
                            borderRadius="md" _hover={{ bg: isMax ? "kk.goldHover" : "rgba(255,215,0,0.1)" }}
                            onClick={() => { setIsMax(!isMax); setAmount(""); setFiatAmount("") }} disabled={busy}>
                            {t("max")}
                          </Button>
                        </Flex>
                      </Flex>

                      <Box position="relative">
                        {inputMode === 'fiat' && (
                          <Text position="absolute" left="8px" top="50%" transform="translateY(-50%)" fontSize="xs" fontWeight="600" color="kk.textSecondary" pointerEvents="none" zIndex={1}>$</Text>
                        )}
                        <Input
                          value={isMax ? (fromBalance ? formatBalance(fromBalance) : 'MAX') : (inputMode === 'crypto' ? amount : fiatAmount)}
                          onChange={(e) => { if (isMax) setIsMax(false); inputMode === 'crypto' ? handleCryptoChange(e.target.value) : handleFiatChange(e.target.value) }}
                          placeholder={inputMode === 'fiat' ? '0.00' : t("amountPlaceholder")}
                          bg="rgba(0,0,0,0.4)" border="1px solid"
                          borderColor={exceedsBalance ? "kk.error" : "rgba(255,255,255,0.08)"}
                          borderRadius="lg" color="kk.textPrimary" size="sm" fontFamily="mono" fontSize="sm" fontWeight="700"
                          disabled={busy} px={inputMode === 'fiat' ? "6" : "3"}
                          _focus={{ borderColor: exceedsBalance ? "kk.error" : "kk.gold", boxShadow: exceedsBalance ? "none" : "0 0 0 1px rgba(255,215,0,0.3)" }}
                        />
                      </Box>

                      {!isMax && hasFromPrice && (
                        <Flex mt="1" px="1">
                          {inputMode === 'crypto' && amountUsdPreview !== null ? (
                            <Text fontSize="10px" color="kk.textMuted" fontFamily="mono">{fmtCompact(amountUsdPreview)}</Text>
                          ) : inputMode === 'fiat' && amount ? (
                            <Text fontSize="10px" color="kk.textMuted" fontFamily="mono">{formatBalance(amount)} {fromAsset.symbol}</Text>
                          ) : null}
                        </Flex>
                      )}
                      {exceedsBalance && (
                        <Text fontSize="10px" color="kk.error" mt="1" fontWeight="600">{t("insufficientBalance")}</Text>
                      )}
                    </Box>
                  )}

                  {fromAsset && fromAddress && (
                    <Flex mt="2" px="1" align="center" gap="1">
                      <Box w="4px" h="4px" borderRadius="full" bg="#23DCC8" flexShrink={0} />
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
                    borderRadius="full" border="2px solid" borderColor="rgba(255,215,0,0.4)"
                    bg="linear-gradient(135deg, rgba(255,215,0,0.15) 0%, rgba(255,215,0,0.05) 100%)"
                    color="#FFD700" cursor="pointer"
                    _hover={{ borderColor: "#FFD700", bg: "rgba(255,215,0,0.2)", transform: "rotate(180deg) scale(1.1)" }}
                    transition="all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)"
                    onClick={handleFlip}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFD700" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
                    </svg>
                  </Box>
                </Flex>

                {/* TO column */}
                <Box
                  flex="1"
                  bg="linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(35,220,200,0.03) 100%)"
                  border="1px solid" borderColor="kk.border" borderRadius="xl" p="3"
                  transition="border-color 0.2s"
                  _hover={{ borderColor: "rgba(35,220,200,0.2)" }}
                >
                  <AssetSelector
                    label={t("to")}
                    selected={toAsset}
                    assets={assets}
                    onSelect={(a) => { setToAsset(a); setQuote(null); setPhase('input'); setError(null) }}
                    balances={balances}
                    exclude={fromAsset?.asset}
                    disabled={busy}
                  />

                  {toAsset && quote && (
                    <Box mt="3" p="2.5" bg="rgba(35,220,200,0.06)" borderRadius="lg" border="1px solid" borderColor="rgba(35,220,200,0.15)">
                      <Text fontSize="9px" color="kk.textMuted" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em" mb="1">{t("expectedOutput")}</Text>
                      <Text fontSize="sm" fontFamily="mono" fontWeight="800" color="#23DCC8">
                        <GreenCountUp value={quote.expectedOutput} color="#23DCC8" suffix={` ${toAsset.symbol}`} fontSize="sm" />
                      </Text>
                      {hasToPrice && (
                        <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" mt="0.5">
                          {fmtCompact(parseFloat(quote.expectedOutput) * toPriceUsd)}
                        </Text>
                      )}
                      {isNativeEvmMax && (
                        <Text fontSize="9px" color="#FB923C" mt="1">{t("sendMaxGasNote")}</Text>
                      )}
                    </Box>
                  )}

                  {toAsset && (
                    <Box mt="2">
                      <Flex justify="space-between" align="center" mb="1">
                        <HStack gap="1">
                          {!useCustomAddress && (
                            <>
                              <ShieldIcon />
                              <Text fontSize="9px" color="#23DCC8" fontWeight="600">{t("keepKeyAddress")}</Text>
                            </>
                          )}
                          {useCustomAddress && (
                            <Text fontSize="9px" color="#FB923C" fontWeight="600">{t("customAddressWarning")}</Text>
                          )}
                        </HStack>
                        <Box as="button" fontSize="9px" color={useCustomAddress ? "#23DCC8" : "kk.textMuted"}
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
                            _focus={{ borderColor: customAddressError ? "#EF4444" : "#FB923C" }} />
                          {customAddressError && (
                            <Text fontSize="9px" color="#EF4444" mt="1">{customAddressError}</Text>
                          )}
                        </>
                      ) : keepKeyToAddress ? (
                        <Flex align="center" gap="1" px="1">
                          <Box w="4px" h="4px" borderRadius="full" bg="#23DCC8" flexShrink={0} />
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

              {/* Quote loading */}
              {phase === 'quoting' && (
                <Flex justify="center" py="1">
                  <Text fontSize="10px" color="kk.textMuted">{t("gettingQuote")}</Text>
                </Flex>
              )}

              {/* Review Swap button — only when quote is ready */}
              {phase === 'input' && quote && fromAsset && toAsset && !sameAsset && (
                <Button w="full" size="sm" bg="#23DCC8" color="black" fontWeight="700" fontSize="xs"
                  borderRadius="lg" _hover={{ opacity: 0.9 }} onClick={() => setPhase('review')}>
                  {t("reviewSwap") || "Review Swap"}
                </Button>
              )}

              {/* Hint */}
              {phase === 'input' && fromAsset && toAsset && !sameAsset && !amount && !isMax && !quote && (
                <Text fontSize="10px" color="kk.textMuted" textAlign="center">{t("enterAmount")}</Text>
              )}

              {/* Error */}
              {error && (
                <Box bg="rgba(255,23,68,0.08)" border="1px solid" borderColor="kk.error" borderRadius="lg" p="2">
                  <Text fontSize="10px" color="kk.error">{error}</Text>
                </Box>
              )}
            </VStack>
          )}
        </Box>

        {/* ── Footer ──────────────────────────────────────────────── */}
        {!loadingAssets && phase !== 'submitted' && !busy && phase !== 'review' && (
          <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border" justify="center"
            bg="linear-gradient(90deg, transparent 0%, rgba(35,220,200,0.02) 50%, transparent 100%)">
            <HStack gap="1.5">
              <Image src="https://pioneers.dev/coins/thorchain.png" alt="THORChain" w="14px" h="14px" borderRadius="full" />
              <Text fontSize="10px" color="kk.textMuted" fontWeight="500">
                {quote?.integration && quote.integration !== 'thorchain'
                  ? `via ${quote.integration}`
                  : t("poweredBy")}
              </Text>
            </HStack>
          </Flex>
        )}
      </Box>
    </Box>
  )
}
