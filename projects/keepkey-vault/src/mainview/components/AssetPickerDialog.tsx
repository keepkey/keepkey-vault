/**
 * Modal-over-modal asset picker. Opens on top of SwapDialog.
 *
 * Differs from the inline AssetSelector it replaces:
 *   - Searches the entire pioneer-discovery universe (~30k CAIPs), not just
 *     Pioneer's swappable subset.
 *   - Bucket-sorted: held → Pioneer-swappable → matrix-swappable → unknown
 *     → unsupported. Ranked when the user types.
 *   - Per-row availability badge with reason (so the user understands why
 *     a token they searched for can't be swapped).
 *   - Caps render volume: empty query shows only held + swappable buckets;
 *     typing expands the surface to the full universe.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { Box, Flex, Text, Input, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { AssetIcon } from "./AssetIcon"
import type { SwapAsset, ChainBalance } from "../../shared/types"
import {
  buildAssetEntries,
  buildSearchIndex,
  searchEntries,
  bucketFor,
  chainMetaForCaip2,
  networkDisplayName,
  synthesizeSwapAsset,
  type AssetEntry,
  type SearchIndex,
} from "../../shared/swap-discovery"
import { PROVIDER_LABEL, type AvailabilityStatus } from "../../shared/swap-support-matrix"
import { Z } from "../lib/z-index"
import { useFiat } from "../lib/fiat-context"
import { rpcRequest } from "../lib/rpc"
import { networkDisplayName as nd } from "../../shared/swap-discovery"

const EVM_CONTRACT_RE = /^0x[a-fA-F0-9]{40}$/

const MAX_RENDER = 200

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
)

interface AssetPickerDialogProps {
  open: boolean
  onClose: () => void
  /** Pioneer GetAvailableAssets cached result. */
  swappable: SwapAsset[]
  /** Connected wallet's per-chain balances. */
  balances: ChainBalance[]
  /** CAIP-19 of the asset on the OPPOSITE side of the swap — excluded so the
   *  user can't pick the same asset on both legs. */
  excludeCaip?: string
  /** Fired when the user picks a Pioneer-swappable asset. The dialog refuses
   *  to fire onSelect for non-swappable rows (they're rendered disabled). */
  onSelect: (asset: SwapAsset) => void
  /** Whether this picker is for the FROM side ("From which asset?") or TO. */
  side: "from" | "to"
}

function chainBadgeCaip(entry: AssetEntry): string | undefined {
  // For tokens, AssetIcon's chainCaip prop expects the chain's full CAIP-19
  // native asset id (e.g. 'eip155:1/slip44:60') — that's what caipToIcon
  // base64-encodes for the keepkey.info URL. Passing the bare CAIP-2 'eip155:1'
  // produced a broken URL and a missing badge in v1.
  if (entry.isNative) return undefined
  return chainMetaForCaip2(entry.chainId)?.nativeCaip
}

/** Decide whether a row is selectable.
 *
 *  Two gates:
 *    1. Matrix says swappable or unknown (try-quote).
 *    2. Vault has a ChainDef for this chain — without one we can't derive
 *       the destination address, sign for the source, or build the tx.
 *       Without the gate, matrix-swappable chains like Berachain/Linea/
 *       Celo/Sonic etc. (Relay routes them, but vault has no chain entry)
 *       rendered as selectable then silently swallowed the click — the
 *       synthesizer returned null because chainMetaForCaip2 was null. */
function isRowSelectable(entry: AssetEntry): boolean {
  const status = entry.availability.status
  if (status !== 'swappable' && status !== 'unknown') return false
  return chainMetaForCaip2(entry.chainId) !== null
}

/** Build a human-readable reason for why an asset can't be selected (or has
 *  ambiguous availability). The matrix returns CAIP-formatted reasons like
 *  "tron:27Lqcw is not currently supported"; this swaps in the chain's
 *  display name and produces something a user can act on. Returns null only
 *  for cleanly swappable rows that vault can also operate on. */
function humanReason(entry: AssetEntry): string | null {
  const status = entry.availability.status
  const chain = networkDisplayName(entry.chainId)
  const vaultKnowsChain = chainMetaForCaip2(entry.chainId) !== null

  // Matrix says we can route, but vault has no ChainDef → can't sign or
  // derive an address → not actually selectable. This catches Berachain /
  // Linea / Celo / Sonic / Mode / Manta / Mantle / Scroll / zkSync / Blast
  // — the matrix added them per Relay coverage but vault's chains.ts doesn't
  // have entries yet, so until that lands the picker has to be honest.
  if ((status === 'swappable' || status === 'unknown') && !vaultKnowsChain) {
    return `${chain} routing is supported but vault doesn't have this chain configured yet — sign and address-derive paths are blocked.`
  }
  if (status === 'swappable') return null
  if (status === 'unknown') {
    return `${chain} is supported — Pioneer didn't pre-list this token, but a quote may still route via aggregators (try it).`
  }
  if (status === 'unsupported_token') {
    return `${chain} natives swap fine, but this specific token isn't routable through any provider yet.`
  }
  // unsupported_chain
  return `${chain} isn't supported by any swap provider yet (THORChain, Mayachain, Relay, 0x, ChainFlip, ShapeShift).`
}

export function AssetPickerDialog({
  open, onClose, swappable, balances, excludeCaip, onSelect, side,
}: AssetPickerDialogProps) {
  const { t } = useTranslation("swap")
  const { fmtCompact } = useFiat()
  const [search, setSearch] = useState("")
  const [entries, setEntries] = useState<AssetEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /* Paste-contract auto-add: when the search query is a valid EVM address
   * and the discovery universe has no matches, we offer to fetch the
   * token's metadata directly from the chain RPC and add it as a custom
   * swap asset. The lookup is debounced so we don't fire it on every
   * keystroke while pasting. */
  const [contractHits, setContractHits] = useState<SwapAsset[] | null>(null)
  const [contractLooking, setContractLooking] = useState(false)
  const [contractError, setContractError] = useState<string | null>(null)

  // Lazy-build the unified entry list on first open. Recompute when swappable
  // or balances change so newly-detected tokens show up.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    buildAssetEntries({ swappable, balances })
      .then(list => { if (!cancelled) { setEntries(list); setLoading(false) } })
      .catch(e => {
        if (cancelled) return
        console.error("[AssetPickerDialog] buildAssetEntries failed:", e)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, swappable, balances])

  // Reset query and focus search input on each open
  useEffect(() => {
    if (!open) return
    setSearch("")
    const id = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(id)
  }, [open])

  // Esc closes the picker — keyboard convention. Only bound while open so we
  // don't intercept keystrokes meant for SwapDialog or other components.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const searchIndex: SearchIndex | null = useMemo(
    () => entries ? buildSearchIndex(entries) : null,
    [entries],
  )

  const visible = useMemo(() => {
    if (!searchIndex) return []
    let list = searchEntries(searchIndex, search)
    if (excludeCaip) list = list.filter(e => e.caip !== excludeCaip)
    // Empty query: only show held + Pioneer-swappable + matrix-swappable
    // (buckets 0-5). Saves rendering ~30k DOM nodes when nothing is typed.
    if (!search.trim()) list = list.filter(e => bucketFor(e) <= 5)
    return list.slice(0, MAX_RENDER)
  }, [searchIndex, search, excludeCaip])

  /* Probe the chain RPCs when the user pastes a contract that doesn't match
   * anything in discovery. Debounced 350ms so a fast-typed address doesn't
   * fire 40 lookups. Reset on close / query change. */
  useEffect(() => {
    setContractHits(null)
    setContractError(null)
    if (!open) return
    const q = search.trim()
    if (!EVM_CONTRACT_RE.test(q)) return
    if (visible.length > 0) return /* discovery already had it — skip lookup */
    let cancelled = false
    setContractLooking(true)
    const timer = setTimeout(() => {
      rpcRequest<{ hits: SwapAsset[]; reason?: string }>('lookupTokenContract', { contractAddress: q }, 12000)
        .then(res => {
          if (cancelled) return
          setContractLooking(false)
          if (res.hits && res.hits.length > 0) setContractHits(res.hits)
          else setContractError(res.reason || 'no-token-found')
        })
        .catch(e => {
          if (cancelled) return
          setContractLooking(false)
          setContractError(e?.message || 'lookup-failed')
        })
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, search, visible.length])

  const handleSelect = useCallback((entry: AssetEntry) => {
    if (!isRowSelectable(entry)) return
    // Prefer Pioneer-listed SwapAsset (canonical asset name + verified routing).
    // Fall back to a synthesized one when Pioneer didn't include this CAIP —
    // matches the "try quote" UX and lets Pioneer reject with a real reason
    // instead of the picker silently swallowing the click.
    const base = entry.swappable ?? synthesizeSwapAsset(entry)
    if (!base) {
      console.warn('[AssetPickerDialog] No vault chain config for', entry.chainId, '- refusing select')
      return
    }
    // Force the outgoing CAIP to match the canonicalized form the picker
    // resolved to (entry.caip went through canonicalizeCaip at build time;
    // base.caip is whatever pioneer-server emitted, which can drift —
    // currently pioneer-server uses /erc20: for BSC tokens but discovery
    // emits /bep20:; mirror this in case pioneer-server ever diverges).
    const asset = base.caip === entry.caip ? base : { ...base, caip: entry.caip }
    onSelect(asset)
    onClose()
  }, [onSelect, onClose])

  if (!open) return null

  const title = side === "from" ? t("selectFromAsset", "Select asset to swap from") : t("selectToAsset", "Select asset to swap to")

  return (
    <Box
      position="fixed" inset="0" zIndex={Z.assetPicker}
      display="flex" alignItems="center" justifyContent="center"
      onClick={onClose}
    >
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box
        position="relative"
        bg="kk.cardBg"
        border="2px solid"
        borderColor="rgba(139,227,196,0.4)"
        borderRadius="xl"
        boxShadow="0 0 20px rgba(139,227,196,0.1)"
        w="600px" maxW="92vw" h="640px" maxH="88vh"
        display="flex" flexDirection="column"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <Flex align="center" justify="space-between" px="5" py="4" borderBottom="1px solid" borderColor="kk.border">
          <Text fontSize="md" fontWeight="700" color="kk.textPrimary">{title}</Text>
          <Button size="xs" variant="ghost" color="kk.textMuted" onClick={onClose}>&times;</Button>
        </Flex>

        {/* Search input */}
        <Flex align="center" gap="2" px="5" py="3" borderBottom="1px solid" borderColor="kk.border">
          <SearchIcon />
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchAssetsPlaceholder", "Search by symbol, name, or CAIP…")}
            bg="transparent" border="none" color="kk.textPrimary" px="0"
            _focus={{ outline: "none", boxShadow: "none" }}
          />
        </Flex>

        {/* List */}
        <Box flex="1" overflow="auto">
          {loading && (
            <Text fontSize="xs" color="kk.textMuted" p="6" textAlign="center">{t("loading", "Loading…")}</Text>
          )}
          {!loading && visible.length === 0 && (
            <Box p="6" textAlign="center">
              {/* Paste-contract auto-add lane.
               *  Triggers when the user types/pastes a 0x..40-char address
               *  and discovery has no entry for it. We probe every EVM RPC
               *  in parallel and surface every chain that returned valid
               *  ERC20 metadata as a one-click "Add as custom token" row. */}
              {EVM_CONTRACT_RE.test(search.trim()) ? (
                <>
                  {contractLooking && (
                    <Text fontSize="xs" color="kk.textMuted">
                      {t("contractLookingUp", "Looking up contract on every chain…")}
                    </Text>
                  )}
                  {!contractLooking && contractHits && contractHits.length > 0 && (
                    <Box>
                      <Text fontSize="11px" color="var(--text-3)" letterSpacing="0.06em" textTransform="uppercase" mb="2.5">
                        {t("contractFoundOn", "Found on", { count: contractHits.length })}
                      </Text>
                      <Flex direction="column" gap="2">
                        {contractHits.map(hit => (
                          <Flex
                            key={hit.caip}
                            as="button"
                            align="center"
                            gap="3"
                            px="3" py="2.5"
                            bg="rgba(233,196,106,0.06)"
                            border="1px solid"
                            borderColor="rgba(233,196,106,0.30)"
                            borderRadius="lg"
                            _hover={{ bg: "rgba(233,196,106,0.14)", borderColor: "rgba(233,196,106,0.55)" }}
                            cursor="pointer"
                            textAlign="left"
                            onClick={() => { onSelect(hit); onClose() }}
                          >
                            <AssetIcon
                              caip={hit.caip}
                              chainCaip={`${hit.chainId}/slip44:60`}
                              size={32}
                              alt={hit.symbol}
                            />
                            <Box flex="1" minW="0">
                              <Flex align="center" gap="2">
                                <Text fontSize="sm" fontWeight="700" color="kk.textPrimary">{hit.symbol}</Text>
                                <Text fontSize="9px" color="var(--gold)" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
                                  {nd(hit.chainId)}
                                </Text>
                              </Flex>
                              <Text fontSize="10px" color="kk.textMuted" truncate>{hit.name}</Text>
                            </Box>
                            <Text fontSize="9px" color="var(--gold)" fontWeight="700" letterSpacing="0.05em" textTransform="uppercase" flexShrink={0}>
                              {t("addCustomToken", "Add")}
                            </Text>
                          </Flex>
                        ))}
                      </Flex>
                      <Text fontSize="10px" color="kk.textMuted" mt="3" lineHeight="1.5">
                        {t("contractSafetyNote", "Custom tokens skip Vault's verified list. Verify the symbol matches the project before swapping.")}
                      </Text>
                    </Box>
                  )}
                  {!contractLooking && contractHits && contractHits.length === 0 && (
                    <Text fontSize="xs" color="kk.textMuted">
                      {t("contractNotFoundOnAnyChain", "No ERC20 found at this address on any supported chain.")}
                    </Text>
                  )}
                  {!contractLooking && !contractHits && contractError && (
                    <Text fontSize="xs" color="kk.error">
                      {t("contractLookupFailed", "Couldn't reach a chain RPC to look up this contract. Try again.")}
                    </Text>
                  )}
                </>
              ) : (
                <Text fontSize="xs" color="kk.textMuted">
                  {search.trim()
                    ? t("noAssetsMatchSearch", "No assets match your search.")
                    : t("noAssetsAvailable", "No swappable assets available.")}
                </Text>
              )}
            </Box>
          )}
          {!loading && visible.map(e => <AssetRow key={e.caip} entry={e} onSelect={handleSelect} fmtCompact={fmtCompact} t={t} />)}
          {!loading && visible.length === MAX_RENDER && (
            <Text fontSize="10px" color="kk.textMuted" p="3" textAlign="center">
              {t("resultsCapped", "Showing first {{n}} matches — refine your search to narrow down.", { n: MAX_RENDER })}
            </Text>
          )}
        </Box>

        {/* Hint footer when query is empty */}
        {!loading && !search.trim() && (
          <Box px="5" py="2.5" borderTop="1px solid" borderColor="kk.border" bg="rgba(255,255,255,0.02)">
            <Text fontSize="10px" color="kk.textMuted">
              {t("emptyQueryHint", "Showing held + swappable assets. Type to search the full {{count}}-asset universe.", { count: entries?.length ?? 0 })}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}

interface AssetRowProps {
  entry: AssetEntry
  onSelect: (entry: AssetEntry) => void
  fmtCompact: (v: number) => string
  t: any  // i18next TFunction — overloaded enough that typing it explicitly is more pain than value
}

function AssetRow({ entry, onSelect, fmtCompact, t }: AssetRowProps) {
  const status = entry.availability.status
  const selectable = isRowSelectable(entry)
  // For tokens, surface the network so USDT-on-ETH vs USDT-on-BSC is unambiguous.
  // Falls back to discovery's chain name (covers chains vault doesn't have a ChainDef for).
  const networkLabel = networkDisplayName(entry.chainId)
  const reason = humanReason(entry)
  const isUnsupported = !selectable

  return (
    <Box
      px="4" py="2.5" mx="1" borderRadius="lg"
      cursor={selectable ? "pointer" : "not-allowed"}
      opacity={selectable ? 1 : 0.7}
      _hover={selectable ? { bg: "rgba(139,227,196,0.06)" } : {}}
      transition="background 0.15s"
      onClick={() => { if (selectable) onSelect(entry) }}
      borderLeft={isUnsupported ? "3px solid rgba(255,99,99,0.35)" : "3px solid transparent"}
    >
      <Flex align="center" gap="3">
        <AssetIcon
          caip={entry.caip}
          iconUrl={entry.iconUrl}
          chainCaip={chainBadgeCaip(entry)}
          size={40}
          alt={entry.symbol}
        />
        <Flex direction="column" flex="1" minW="0">
          <Flex align="center" gap="2">
            <Text fontSize="sm" fontWeight="600" color="kk.textPrimary">{entry.symbol}</Text>
            {!entry.isNative && (
              <Text fontSize="9px" color="var(--teal)" fontWeight="600" textTransform="uppercase" letterSpacing="0.05em">
                {t("on", "on")} {networkLabel}
              </Text>
            )}
          </Flex>
          <Flex align="center" gap="2" minW="0">
            <Text fontSize="10px" color="kk.textMuted" truncate flexShrink={0} maxW="55%">{entry.name}</Text>
            <Text fontSize="9px" color="kk.textMuted" fontFamily="mono" opacity={0.6} truncate>· {entry.chainId}</Text>
          </Flex>
        </Flex>

        {/* Right side: balance OR compact availability badge. Held assets
            show balance + USD; selectable non-held show the badge. Disabled
            (unsupported) rows render the reason inline below instead. */}
        {entry.balance ? (
          <Flex direction="column" align="flex-end" gap="0">
            <Text fontSize="xs" fontFamily="mono" color="kk.textSecondary">{entry.balance.amount}</Text>
            {entry.balance.usd > 0 && (
              <Text fontSize="10px" fontFamily="mono" color="kk.textMuted">{fmtCompact(entry.balance.usd)}</Text>
            )}
          </Flex>
        ) : (
          <AvailabilityBadge entry={entry} t={t} />
        )}
      </Flex>

      {/* Inline humanized reason — surfaced on EVERY non-swappable row so the
          user understands why a row is greyed without hovering. The matrix
          reason is CAIP-formatted; humanReason swaps in the chain display
          name (e.g. "TON" not "ton:-239") via networkDisplayName. */}
      {reason && (
        <Text fontSize="10px" color={isUnsupported ? "rgba(255,143,143,0.85)" : "kk.textMuted"}
              mt="1.5" pl="52px" lineHeight="1.4">
          {reason}
        </Text>
      )}
    </Box>
  )
}

function AvailabilityBadge({ entry, t }: { entry: AssetEntry; t: AssetRowProps["t"] }) {
  const status = entry.availability.status
  const providers = entry.availability.providers

  if (status === "swappable" && providers.length > 0) {
    const label = providers.length === 1
      ? PROVIDER_LABEL[providers[0]]
      : `${providers.length} ${t("routes", "routes")}`
    return (
      <Box bg="rgba(139,227,196,0.12)" border="1px solid" borderColor="rgba(139,227,196,0.3)" borderRadius="md" px="2" py="0.5">
        <Text fontSize="9px" color="var(--teal)" fontWeight="600">{label}</Text>
      </Box>
    )
  }
  if (status === "unknown") {
    return (
      <Box bg="rgba(233,196,106,0.08)" border="1px solid" borderColor="rgba(233,196,106,0.25)" borderRadius="md" px="2" py="0.5">
        <Text fontSize="9px" color="var(--gold)" fontWeight="600">{t("tryQuote", "try quote")}</Text>
      </Box>
    )
  }
  // unsupported_chain or unsupported_token
  return (
    <Box bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="rgba(255,255,255,0.08)" borderRadius="md" px="2" py="0.5">
      <Text fontSize="9px" color="kk.textMuted" fontWeight="600">{t("unavailable", "unavailable")}</Text>
    </Box>
  )
}
