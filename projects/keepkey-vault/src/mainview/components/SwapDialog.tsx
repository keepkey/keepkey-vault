/**
 * SwapDialog — Full-screen dialog for the swap flow.
 *
 * Phases: input → review → approving/signing/broadcasting → success
 * Replaces the old inline SwapView with a proper modal experience.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Box, Flex, Text, VStack, Button, Input, Image, HStack } from "@chakra-ui/react"
import { rpcRequest } from "../lib/rpc"
import { formatBalance } from "../lib/formatting"
import { getAssetIcon } from "../../shared/assetLookup"
import { CHAINS } from "../../shared/chains"
import type { ChainDef } from "../../shared/chains"
import type { SwapAsset, SwapQuote, ChainBalance } from "../../shared/types"
import { Z } from "../lib/z-index"

// ── Phase state machine ─────────────────────────────────────────────
type SwapPhase = 'input' | 'quoting' | 'review' | 'approving' | 'signing' | 'broadcasting' | 'submitted'

// ── Supported THORChain chains ──────────────────────────────────────
const SWAP_CHAIN_IDS = new Set([
  'bitcoin', 'ethereum', 'litecoin', 'dogecoin', 'bitcoincash',
  'dash', 'cosmos', 'thorchain', 'mayachain', 'avalanche',
  'bsc', 'base', 'arbitrum', 'optimism', 'polygon',
])

const DEFAULT_OUTPUT: Record<string, string> = {
  bitcoin: 'ETH.ETH',
  ethereum: 'BTC.BTC',
  litecoin: 'BTC.BTC',
  dogecoin: 'BTC.BTC',
  bitcoincash: 'BTC.BTC',
  cosmos: 'ETH.ETH',
  thorchain: 'ETH.ETH',
  avalanche: 'ETH.ETH',
  bsc: 'ETH.ETH',
  base: 'ETH.ETH',
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

  const getBalance = useCallback((asset: SwapAsset): string | null => {
    if (!balances) return null
    const chain = balances.find(b => b.chainId === asset.chainId)
    if (!chain) return null
    if (asset.contractAddress && chain.tokens) {
      const token = chain.tokens.find(t =>
        t.contractAddress?.toLowerCase() === asset.contractAddress?.toLowerCase()
      )
      return token ? token.balance : null
    }
    return chain.balance
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
                const bal = getBalance(asset)
                return (
                  <Flex
                    key={asset.asset}
                    align="center"
                    gap="3"
                    px="3"
                    py="2"
                    cursor="pointer"
                    _hover={{ bg: "rgba(255,255,255,0.06)" }}
                    transition="background 0.1s"
                    onClick={() => { onSelect(asset); setOpen(false); setSearch("") }}
                  >
                    <Image
                      src={chainIcon(asset)}
                      alt={asset.symbol}
                      w="24px" h="24px"
                      borderRadius="full"
                      bg="rgba(255,255,255,0.06)"
                      onError={(e: any) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    <Flex direction="column" flex="1" minW="0">
                      <Text fontSize="sm" fontWeight="500" color="kk.textPrimary">{asset.symbol}</Text>
                      <Text fontSize="10px" color="kk.textMuted" truncate>{asset.name}</Text>
                    </Flex>
                    {bal && (
                      <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">{formatBalance(bal)}</Text>
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

  return (
    <Box>
      <Text fontSize="xs" color="kk.textMuted" mb="1">{label}</Text>
      <Flex
        as="button"
        align="center"
        gap="3"
        w="full"
        bg="rgba(255,255,255,0.04)"
        border="1px solid"
        borderColor="kk.border"
        borderRadius="lg"
        px="3"
        py="2.5"
        cursor={disabled ? "default" : "pointer"}
        opacity={disabled ? 0.6 : 1}
        _hover={disabled ? {} : { borderColor: "kk.gold", bg: "rgba(255,215,0,0.04)" }}
        transition="all 0.15s"
        onClick={() => { if (!disabled) setOpen(true) }}
      >
        {selected ? (
          <>
            <Image
              src={chainIcon(selected)}
              alt={selected.symbol}
              w="24px" h="24px"
              borderRadius="full"
              bg="rgba(255,255,255,0.06)"
              onError={(e: any) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            <Flex direction="column" flex="1" align="flex-start" minW="0">
              <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{selected.symbol}</Text>
              <Text fontSize="10px" color="kk.textMuted">{selected.name}</Text>
            </Flex>
          </>
        ) : (
          <Text fontSize="sm" color="kk.textMuted" flex="1" textAlign="left">{t("selectAsset")}</Text>
        )}
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
}

// ── Main SwapDialog ─────────────────────────────────────────────────
export function SwapDialog({ open, onClose, chain, balance, address }: SwapDialogProps) {
  const { t } = useTranslation("swap")

  // ── State ─────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<SwapPhase>('input')
  const [assets, setAssets] = useState<SwapAsset[]>([])
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [balances, setBalances] = useState<ChainBalance[]>([])

  const [fromAsset, setFromAsset] = useState<SwapAsset | null>(null)
  const [toAsset, setToAsset] = useState<SwapAsset | null>(null)
  const [amount, setAmount] = useState("")
  const [isMax, setIsMax] = useState(false)

  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

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
    rpcRequest<SwapAsset[]>('getSwapAssets', undefined, 20000)
      .then((result) => {
        if (!cancelled) {
          setAssets(result)
          setLoadingAssets(false)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          console.error('[SwapDialog] Failed to load assets:', e)
          setLoadingAssets(false)
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

  const toAddress = useMemo(() => {
    if (!toAsset) return ''
    const cb = balances.find(b => b.chainId === toAsset.chainId)
    return cb?.address || ''
  }, [toAsset, balances])

  const validAmount = isMax || (amount !== '' && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0)
  const canQuote = fromAsset && toAsset && !sameAsset && validAmount && fromAddress && toAddress && !exceedsBalance

  // ── Quote fetching ────────────────────────────────────────────────
  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const quoteVersionRef = useRef(0)

  useEffect(() => {
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
        setPhase('review')
      } catch (e: any) {
        if (version !== quoteVersionRef.current) return
        setError(e.message || t("errorQuote"))
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
      }, 180000)

      setTxid(result.txid)
      setPhase('submitted')
      window.dispatchEvent(new CustomEvent('keepkey-swap-executed'))
    } catch (e: any) {
      setError(e.message || t("errorSwap"))
      setPhase('review')
    }
  }, [quote, fromAsset, toAsset, amount, isMax, fromBalance])

  // ── Reset ─────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setPhase('input')
    setFromAsset(null)
    setToAsset(null)
    setAmount("")
    setIsMax(false)
    setQuote(null)
    setError(null)
    setTxid(null)
    hasAutoSelected.current = false
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
  const displayAmount = isMax ? (fromBalance || '0') : amount

  const chainIcon = useCallback((asset: SwapAsset) => {
    const chainDef = CHAINS.find(c => c.id === asset.chainId)
    if (chainDef?.caip) return getAssetIcon(chainDef.caip)
    return `https://pioneers.dev/coins/${asset.symbol.toLowerCase()}.png`
  }, [])

  if (!open) return null

  // ── Not swappable ─────────────────────────────────────────────────
  if (chain && !SWAP_CHAIN_IDS.has(chain.id)) {
    return (
      <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center" onClick={handleClose}>
        <Box position="absolute" inset="0" bg="blackAlpha.700" />
        <Box position="relative" bg="kk.cardBg" border="1px solid" borderColor="kk.border" borderRadius="xl" p="6" w="400px" maxW="90vw" onClick={(e) => e.stopPropagation()} textAlign="center">
          <ThorchainIcon size={32} />
          <Text fontSize="sm" color="kk.textMuted" mt="3">{t("notSupported", { coin: chain.coin })}</Text>
          <Button size="sm" mt="4" variant="ghost" color="kk.textSecondary" onClick={handleClose}>{t("close")}</Button>
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
        border="1px solid"
        borderColor={phase === 'submitted' ? 'rgba(35,220,200,0.3)' : busy ? 'rgba(255,215,0,0.3)' : 'kk.border'}
        borderRadius="xl"
        w="480px"
        maxW="90vw"
        maxH="90vh"
        overflow="auto"
        onClick={(e) => e.stopPropagation()}
        style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <Flex px="5" py="3" borderBottom="1px solid" borderColor="kk.border" align="center" justify="space-between">
          <HStack gap="2">
            <ThorchainIcon size={18} />
            <Text fontSize="md" fontWeight="600" color="kk.textPrimary">
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
        <Box px="5" py="4">
          {/* Loading state */}
          {loadingAssets && (
            <Box py="8" textAlign="center">
              <Text fontSize="sm" color="kk.textMuted">{t("loadingAssets")}</Text>
            </Box>
          )}

          {/* ── SUBMITTED — swap broadcast, awaiting confirmations ─ */}
          {phase === 'submitted' && txid && fromAsset && toAsset && (
            <VStack gap="4" py="2" style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }}>
              {/* Pulsing broadcast indicator — NOT a checkmark */}
              <Box
                w="80px" h="80px"
                borderRadius="full"
                bg="rgba(35,220,200,0.08)"
                border="2px solid"
                borderColor="rgba(35,220,200,0.3)"
                display="flex"
                alignItems="center"
                justifyContent="center"
                style={{ animation: 'kkSwapPulse 2s ease-in-out infinite' }}
              >
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#23DCC8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" opacity="0.3" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </Box>

              <VStack gap="1">
                <Text fontSize="lg" fontWeight="700" color="kk.textPrimary">{t("swapSubmitted")}</Text>
                <Text fontSize="xs" color="#FBBF24" fontWeight="500">{t("waitingForConfirmations")}</Text>
                <Text fontSize="10px" color="kk.textMuted">{t("swapSubmittedDesc")}</Text>
              </VStack>

              {/* ETA */}
              {quote?.estimatedTime && quote.estimatedTime > 0 && (
                <Flex
                  w="full" justify="center" align="center" gap="2"
                  bg="rgba(255,215,0,0.06)" border="1px solid" borderColor="rgba(255,215,0,0.15)"
                  borderRadius="lg" px="4" py="2"
                >
                  <Text fontSize="xs" color="#FBBF24" fontWeight="600">
                    {t("estimatedTime")}: {formatTime(quote.estimatedTime)}
                  </Text>
                </Flex>
              )}

              {/* Amount summary */}
              <Flex
                w="full"
                bg="rgba(35,220,200,0.06)"
                border="1px solid"
                borderColor="rgba(35,220,200,0.15)"
                borderRadius="lg"
                p="4"
                justify="center"
                align="center"
                gap="3"
              >
                <HStack gap="2">
                  <Image src={chainIcon(fromAsset)} w="20px" h="20px" borderRadius="full" />
                  <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">
                    {displayAmount} {fromAsset.symbol}
                  </Text>
                </HStack>
                <Text color="kk.textMuted" fontSize="lg">&rarr;</Text>
                <HStack gap="2">
                  <Image src={chainIcon(toAsset)} w="20px" h="20px" borderRadius="full" />
                  <Text fontSize="sm" fontWeight="600" color="#23DCC8">
                    ~{quote?.expectedOutput} {toAsset.symbol}
                  </Text>
                </HStack>
              </Flex>

              {/* Txid */}
              <Box w="full" bg="rgba(255,255,255,0.04)" borderRadius="lg" p="3">
                <Flex justify="space-between" align="center">
                  <HStack gap="1.5" minW="0" flex="1">
                    <Text fontSize="10px" color="kk.textMuted" flexShrink={0}>{t("txid")}</Text>
                    <Text fontSize="11px" fontFamily="mono" color="kk.textPrimary" truncate title={txid}>
                      {txid.slice(0, 12)}...{txid.slice(-8)}
                    </Text>
                  </HStack>
                  <Button size="xs" variant="ghost" color="kk.textSecondary" onClick={copyTxid} px="1.5" minW="auto">
                    {copied ? t("copied") : t("copy")}
                  </Button>
                </Flex>
              </Box>

              <Text fontSize="10px" color="kk.textMuted">{t("trackingSwap")}</Text>

              {/* Actions */}
              <Flex gap="2" w="full">
                <Button
                  size="sm" flex="1"
                  variant="outline"
                  color="kk.textSecondary"
                  borderColor="kk.border"
                  _hover={{ bg: "rgba(255,255,255,0.06)" }}
                  onClick={() => { reset(); /* stay open for new swap */ }}
                >
                  {t("newSwap")}
                </Button>
                <Button
                  size="sm" flex="1"
                  bg="kk.gold"
                  color="black"
                  fontWeight="600"
                  _hover={{ bg: "kk.goldHover" }}
                  onClick={() => { onClose(); setTimeout(reset, 200) }}
                >
                  {t("close")}
                </Button>
              </Flex>
            </VStack>
          )}

          {/* ── SIGNING / APPROVING / BROADCASTING ───────────────── */}
          {busy && fromAsset && toAsset && (
            <VStack gap="4" py="6" style={{ animation: 'kkSwapFadeIn 0.3s ease-out' }}>
              {/* Device icon with pulse */}
              <Box
                w="80px" h="80px"
                borderRadius="xl"
                bg="rgba(255,215,0,0.08)"
                border="2px solid"
                borderColor="rgba(255,215,0,0.2)"
                display="flex"
                alignItems="center"
                justifyContent="center"
                style={{ animation: 'kkSwapDevicePulse 2s ease-in-out infinite' }}
              >
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#FFD700" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <path d="M12 18h.01" />
                </svg>
              </Box>

              <VStack gap="1">
                <Text fontSize="md" fontWeight="600" color="kk.textPrimary">
                  {phase === 'approving' ? t("approvingToken") : phase === 'signing' ? t("confirmOnDevice") : t("broadcasting")}
                </Text>
                <Text fontSize="xs" color="kk.textMuted" textAlign="center">
                  {phase === 'signing' ? t("confirmOnDeviceDesc") : phase === 'approving' ? t("approvalRequired") : t("broadcastingDesc")}
                </Text>
              </VStack>

              {/* Mini summary */}
              <Flex align="center" gap="2" bg="rgba(255,255,255,0.04)" px="4" py="2" borderRadius="lg">
                <Text fontSize="sm" color="kk.textSecondary">{displayAmount} {fromAsset.symbol}</Text>
                <Text color="kk.textMuted">&rarr;</Text>
                <Text fontSize="sm" color="#23DCC8">~{quote?.expectedOutput} {toAsset.symbol}</Text>
              </Flex>
            </VStack>
          )}

          {/* ── REVIEW ───────────────────────────────────────────── */}
          {phase === 'review' && quote && fromAsset && toAsset && !busy && (
            <VStack gap="4" style={{ animation: 'kkSwapFadeIn 0.2s ease-out' }}>
              {/* You Send / You Receive */}
              <Box w="full">
                <Text fontSize="xs" color="kk.textMuted" mb="1.5">{t("youSend")}</Text>
                <Flex
                  align="center" gap="3" p="3"
                  bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="lg"
                >
                  <Image src={chainIcon(fromAsset)} w="28px" h="28px" borderRadius="full" />
                  <Box flex="1">
                    <Text fontSize="lg" fontWeight="700" color="kk.textPrimary">{displayAmount} {fromAsset.symbol}</Text>
                    <Text fontSize="10px" color="kk.textMuted">{fromAsset.name}</Text>
                  </Box>
                </Flex>
              </Box>

              <Flex justify="center" my="-2">
                <Box w="28px" h="28px" display="flex" alignItems="center" justifyContent="center" borderRadius="full" bg="rgba(35,220,200,0.1)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#23DCC8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </Box>
              </Flex>

              <Box w="full" mt="-2">
                <Text fontSize="xs" color="kk.textMuted" mb="1.5">{t("youReceive")}</Text>
                <Flex
                  align="center" gap="3" p="3"
                  bg="rgba(35,220,200,0.04)" border="1px solid" borderColor="rgba(35,220,200,0.2)" borderRadius="lg"
                >
                  <Image src={chainIcon(toAsset)} w="28px" h="28px" borderRadius="full" />
                  <Box flex="1">
                    <Text fontSize="lg" fontWeight="700" color="#23DCC8">~{quote.expectedOutput} {toAsset.symbol}</Text>
                    <Text fontSize="10px" color="kk.textMuted">{toAsset.name}</Text>
                  </Box>
                </Flex>
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
                    <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">
                      1 {fromAsset.symbol} = {formatBalance(
                        (parseFloat(quote.expectedOutput) / parseFloat(displayAmount || '1')).toString()
                      )} {toAsset.symbol}
                    </Text>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="xs" color="kk.textMuted">{t("minimumReceived")}</Text>
                    <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">
                      {formatBalance(quote.minimumOutput)} {toAsset.symbol}
                    </Text>
                  </Flex>
                  <Flex justify="space-between">
                    <Text fontSize="xs" color="kk.textMuted">{t("networkFee")}</Text>
                    <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">
                      {formatBalance(quote.fees.outbound)} ({quote.fees.totalBps / 100}%)
                    </Text>
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
                    <Flex justify="space-between" align="center">
                      <Text fontSize="xs" color="kk.textMuted">{t("routerContract")}</Text>
                      <Text fontSize="9px" fontFamily="mono" color="kk.textSecondary" truncate maxW="180px" title={quote.router}>
                        {quote.router.slice(0, 8)}...{quote.router.slice(-6)}
                      </Text>
                    </Flex>
                  )}
                  <Flex justify="space-between" align="center">
                    <Text fontSize="xs" color="kk.textMuted">{t("vault")}</Text>
                    <Text fontSize="9px" fontFamily="mono" color="kk.textSecondary" truncate maxW="180px" title={quote.inboundAddress}>
                      {quote.inboundAddress.slice(0, 8)}...{quote.inboundAddress.slice(-6)}
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

          {/* ── INPUT ────────────────────────────────────────────── */}
          {!loadingAssets && (phase === 'input' || phase === 'quoting') && (
            <VStack gap="3" align="stretch">
              {/* FROM card */}
              <Box bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="xl" p="3">
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
                  <Flex mt="2" justify="space-between" align="center" px="1">
                    <HStack gap="1">
                      <Text fontSize="10px" color="kk.textMuted">{t("available")}:</Text>
                      <Text fontSize="10px" fontFamily="mono" color="kk.textSecondary" fontWeight="500">
                        {fromBalance ? `${formatBalance(fromBalance)} ${fromAsset.symbol}` : '\u2014'}
                      </Text>
                    </HStack>
                    {fromAddress && (
                      <Text fontSize="9px" fontFamily="mono" color="kk.textMuted" truncate maxW="140px" title={fromAddress}>
                        {fromAddress.slice(0, 8)}...{fromAddress.slice(-6)}
                      </Text>
                    )}
                  </Flex>
                )}

                {fromAsset && (
                  <Flex gap="2" align="center" mt="2">
                    <Input
                      value={isMax ? (fromBalance ? formatBalance(fromBalance) : 'MAX') : amount}
                      onChange={(e) => { setAmount(e.target.value); setIsMax(false) }}
                      placeholder={t("amountPlaceholder")}
                      bg="rgba(0,0,0,0.3)"
                      border="1px solid"
                      borderColor={exceedsBalance ? "kk.error" : "kk.border"}
                      color="kk.textPrimary"
                      size="sm"
                      fontFamily="mono"
                      fontSize="md"
                      disabled={isMax || busy}
                      px="3"
                      flex="1"
                      _focus={{ borderColor: exceedsBalance ? "kk.error" : "kk.gold" }}
                    />
                    <Button
                      size="sm"
                      variant={isMax ? "solid" : "outline"}
                      bg={isMax ? "kk.gold" : "transparent"}
                      color={isMax ? "black" : "kk.textSecondary"}
                      borderColor="kk.border"
                      _hover={{ bg: isMax ? "kk.goldHover" : "rgba(255,255,255,0.06)" }}
                      onClick={() => { setIsMax(!isMax); setAmount("") }}
                      h="32px"
                      fontSize="xs"
                      disabled={busy}
                    >
                      {t("max")}
                    </Button>
                  </Flex>
                )}

                {exceedsBalance && (
                  <Text fontSize="xs" color="kk.error" mt="1" px="1">{t("insufficientBalance")}</Text>
                )}
              </Box>

              {/* Flip button */}
              <Flex justify="center" my="-2" position="relative" zIndex={2}>
                <Box
                  as="button"
                  w="36px" h="36px"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  borderRadius="full"
                  border="2px solid"
                  borderColor="kk.border"
                  bg="kk.cardBg"
                  color="kk.textSecondary"
                  cursor="pointer"
                  _hover={{ borderColor: "kk.gold", color: "kk.gold", transform: "rotate(180deg)" }}
                  transition="all 0.25s"
                  onClick={handleFlip}
                >
                  <SwapArrowIcon />
                </Box>
              </Flex>

              {/* TO card */}
              <Box bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border" borderRadius="xl" p="3" mt="-2">
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
                  <Flex mt="2" justify="space-between" align="center" px="1">
                    <Text fontSize="10px" color="kk.textMuted">{t("expectedOutput")}:</Text>
                    <Text fontSize="sm" fontFamily="mono" fontWeight="600" color="#23DCC8">
                      {formatBalance(quote.expectedOutput)} {toAsset.symbol}
                    </Text>
                  </Flex>
                )}
                {toAsset && toAddress && (
                  <Flex mt="1" justify="flex-end" px="1">
                    <Text fontSize="9px" fontFamily="mono" color="kk.textMuted" truncate maxW="180px" title={toAddress}>
                      &rarr; {toAddress.slice(0, 8)}...{toAddress.slice(-6)}
                    </Text>
                  </Flex>
                )}
                {sameAsset && (
                  <Text fontSize="xs" color="kk.error" mt="1" px="1">{t("sameAsset")}</Text>
                )}
              </Box>

              {/* Quote loading */}
              {phase === 'quoting' && (
                <Flex justify="center" py="1">
                  <Text fontSize="xs" color="kk.textMuted">{t("gettingQuote")}</Text>
                </Flex>
              )}

              {/* Hint */}
              {phase === 'input' && fromAsset && toAsset && !sameAsset && !amount && !isMax && (
                <Text fontSize="xs" color="kk.textMuted" textAlign="center">{t("enterAmount")}</Text>
              )}

              {/* Error */}
              {error && (
                <Box bg="rgba(255,23,68,0.08)" border="1px solid" borderColor="kk.error" borderRadius="lg" p="3">
                  <Text fontSize="xs" color="kk.error">{error}</Text>
                </Box>
              )}
            </VStack>
          )}
        </Box>

        {/* ── Footer ──────────────────────────────────────────────── */}
        {!loadingAssets && phase !== 'submitted' && !busy && phase !== 'review' && (
          <Flex px="5" py="3" borderTop="1px solid" borderColor="kk.border" justify="center">
            <HStack gap="1">
              <ThorchainIcon />
              <Text fontSize="10px" color="kk.textMuted">
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
