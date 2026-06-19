/**
 * Asset Picker v2 — redesigned May 2026.
 *
 * FROM side: flat list of held assets ranked by USD value, square tiles, 64px icons, full CAIP.
 * TO side:   Step 1 — square network tiles (all supported, no same-network, no held-grouping).
 *            Step 2 — paginated asset list with text search for that network, 64px icons, full CAIP.
 */
import { useState, useEffect, useMemo, useCallback, type ReactNode } from "react"
import { Box, Flex, Text, Input, Spinner } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { AssetIcon } from "./AssetIcon"
import type { SwapAsset, ChainBalance, CustomToken } from "../../shared/types"
import {
  buildAssetEntries,
  chainMetaForCaip2,
  networkDisplayName,
  synthesizeSwapAsset,
  compareForPicker,
  parseCaip,
  assessWithFirmware,
  isGasAsset,
  ellipsizeCaip,
  type AssetEntry,
} from "../../shared/swap-discovery"
import { rpcRequest } from "../lib/rpc"
import { useDeviceState } from "../hooks/useDeviceState"
import { CHAINS } from "../../shared/chains"
import { Z } from "../lib/z-index"
import { useFiat } from "../lib/fiat-context"
// ── constants ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 20

// ── icons ──────────────────────────────────────────────────────────────────

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
  </svg>
)
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6L6 18M6 6l12 12"/>
  </svg>
)
const BackIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5M12 19l-7-7 7-7"/>
  </svg>
)
const ArrowRight = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 5l7 7-7 7"/>
  </svg>
)
const AlertIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
)
const BellIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
  </svg>
)

// ── chain helpers ───────────────────────────────────────────────────────────

function chainColorForCaip2(caip2: string): string {
  const meta = chainMetaForCaip2(caip2)
  if (!meta) return "#555"
  return CHAINS.find(c => c.id === meta.vaultChainId)?.color ?? "#555"
}

function chainFamilyLabel(family: string): string {
  const map: Record<string, string> = {
    evm: "EVM", utxo: "UTXO", cosmos: "Cosmos",
    solana: "SOL", xrp: "XRP", tron: "TRX",
    ton: "TON", "zcash-shielded": "ZEC",
  }
  return map[family] ?? family.toUpperCase()
}

// ── selectability ───────────────────────────────────────────────────────────

function isRowSelectable(entry: AssetEntry): boolean {
  const s = entry.availability.status
  if (s !== "swappable" && s !== "unknown") return false
  return chainMetaForCaip2(entry.chainId) !== null
}

// ── provider dots — keys match SwapProvider type ────────────────────────────

const PROVIDER_COLORS: Record<string, string> = {
  thorchain:  "#23DCC8",
  mayachain:  "#3B82F6",
  relay:      "#9F8CE0",
  zeroex:     "#5C6BC0",
  chainflip:  "#E84142",
  shapeshift: "#00C3FF",
}

function ProviderDots({ providers }: { providers: string[] }) {
  if (!providers.length) return null
  return (
    <Flex gap="1" title={providers.join(", ")} align="center">
      {providers.slice(0, 4).map(p => (
        <Box key={p} w="6px" h="6px" borderRadius="full" bg={PROVIDER_COLORS[p] ?? "#888"} />
      ))}
      {providers.length > 4 && <Box w="6px" h="6px" borderRadius="full" bg="rgba(255,255,255,0.2)" />}
    </Flex>
  )
}

// ── gas / token classifier badge ────────────────────────────────────────────

/** Small pill marking an asset as the chain's GAS (native) asset or a TOKEN.
 *  Gas assets get a gold pill so they read as "this pays for gas / is the
 *  chain's own coin" and never get confused with a same-symbol token. */
function GasTokenBadge({ entry }: { entry: AssetEntry }) {
  const gas = isGasAsset(entry)
  return (
    <Box
      bg={gas ? "rgba(233,196,106,0.14)" : "rgba(255,255,255,0.06)"}
      color={gas ? "var(--gold)" : "kk.textMuted"}
      px="1.5" py="0.5" borderRadius="4px" fontSize="9px" fontWeight="700"
      letterSpacing="0.06em" flexShrink={0}>
      {gas ? "GAS" : "TOKEN"}
    </Box>
  )
}

// ── chain badge caip (network overlay on token icons) ──────────────────────

function chainBadgeCaip(entry: AssetEntry): string | undefined {
  if (entry.isNative) return undefined
  return chainMetaForCaip2(entry.chainId)?.nativeCaip
}

// ── shared search bar ───────────────────────────────────────────────────────

function SearchBar({ value, onChange, placeholder, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean
}) {
  return (
    <Flex align="center" gap="2" mx="5" mb="3" px="3" py="2.5"
      bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="rgba(255,255,255,0.08)"
      borderRadius="12px" flexShrink={0}
      _focusWithin={{ borderColor: "rgba(255,255,255,0.18)" }}>
      <Box color="kk.textMuted" flexShrink={0}><SearchIcon /></Box>
      <Input value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        bg="transparent" border="none" color="kk.textPrimary" px="0" fontSize="12px"
        _focus={{ outline: "none", boxShadow: "none" }}
        autoFocus={autoFocus} />
      {value && (
        <Box as="button" color="kk.textMuted" cursor="pointer" onClick={() => onChange("")}
          _hover={{ color: "kk.textPrimary" }} border="none" bg="transparent" p="0" lineHeight="1">
          <CloseIcon />
        </Box>
      )}
    </Flex>
  )
}

// ── network-switch banner ───────────────────────────────────────────────────

function NetSwitchBanner({ fromChainId, toChainId, providers }: {
  fromChainId: string; toChainId: string; providers: string[]
}) {
  const fromMeta = chainMetaForCaip2(fromChainId)
  const toMeta   = chainMetaForCaip2(toChainId)
  const fromName = networkDisplayName(fromChainId)
  const toName   = networkDisplayName(toChainId)
  const same     = fromChainId === toChainId

  return (
    <Flex align="center" gap="3" mx="5" mb="3" p="2.5"
      bg={same ? "rgba(139,227,196,0.06)" : "rgba(233,196,106,0.08)"}
      border="1px solid"
      borderColor={same ? "rgba(139,227,196,0.20)" : "rgba(233,196,106,0.20)"}
      borderRadius="12px" flexShrink={0}>
      <Flex align="center" gap="1" flexShrink={0}>
        {fromMeta?.nativeCaip
          ? <AssetIcon caip={fromMeta.nativeCaip} size={20} alt={fromName} />
          : <Box w="20px" h="20px" borderRadius="full" bg={chainColorForCaip2(fromChainId)} />}
        <Box w="16px" h="2px" mx="1"
          bg={`repeating-linear-gradient(90deg,${same ? "#8be3c4" : "#e9c46a"} 0 4px,transparent 4px 8px)`} />
        {toMeta?.nativeCaip
          ? <AssetIcon caip={toMeta.nativeCaip} size={20} alt={toName} />
          : <Box w="20px" h="20px" borderRadius="full" bg={chainColorForCaip2(toChainId)} />}
      </Flex>
      <Box flex="1" minW="0">
        <Flex align="center" gap="2">
          <Text fontSize="11px" fontWeight="600" color="kk.textPrimary">
            {same
              ? <><strong>{fromName}</strong> → <strong>{toName}</strong></>
              : <>Crossing <strong>{fromName}</strong> → <strong>{toName}</strong></>}
          </Text>
          {providers.length > 0 && (
            <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.06em" ml="auto">
              via {providers.slice(0, 2).join(" / ")}
            </Text>
          )}
        </Flex>
        <Text fontSize="10px" color="kk.textMuted" mt="0.5">
          {same
            ? "Same-network swap · settles in seconds"
            : `Cross-chain · est. 4–12 min · ${providers[0] ?? "router"} in transit`}
        </Text>
      </Box>
      <Box bg={same ? "var(--teal)" : "var(--gold)"} color="#0b0b0e"
        px="2" py="1" borderRadius="6px" fontSize="9px" fontWeight="700"
        letterSpacing="0.04em" flexShrink={0}>
        {same ? "Same" : "Cross-chain"}
      </Box>
    </Flex>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// FROM picker — all held assets, ranked by USD value, square tiles
// ══════════════════════════════════════════════════════════════════════════

/** Chip used by the FROM picker's chain-filter row. Active state lifts to
 *  white text on a 6%-white fill with a gold hairline; inactive sits muted. */
function ChainChip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <Box
      as="button"
      onClick={onClick}
      px="2.5"
      py="1"
      borderRadius="999px"
      flexShrink={0}
      cursor="pointer"
      bg={active ? "rgba(255,255,255,0.06)" : "transparent"}
      border="1px solid"
      borderColor={active ? "rgba(233,196,106,0.45)" : "rgba(255,255,255,0.08)"}
      _hover={{ borderColor: active ? "var(--gold)" : "rgba(255,255,255,0.18)", bg: active ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)" }}
      transition="all 0.15s"
      className="electrobun-webkit-app-region-no-drag"
    >
      <Flex align="center" gap="1.5">
        <Text fontSize="11px" fontWeight="600" color={active ? "var(--text-0)" : "var(--text-2)"} lineHeight="1">
          {label}
        </Text>
        <Text fontSize="10px" color="var(--text-3)" lineHeight="1" fontFamily="mono">
          {count}
        </Text>
      </Flex>
    </Box>
  )
}

function FromPicker({ entries, onSelect, fmtCompact, privateModeEnabled, balancesLoading }: {
  entries: AssetEntry[]; onSelect: (e: AssetEntry) => void; fmtCompact: (v: number) => string; privateModeEnabled: boolean; balancesLoading: boolean
}) {
  const { t } = useTranslation("swap")
  const [search, setSearch] = useState("")
  const [chainFilter, setChainFilter] = useState<string | null>(null)

  // All held assets flat, ranked by USD value
  const held = useMemo(
    () => entries.filter(e => e.balance).sort((a, b) => (b.balance!.usd) - (a.balance!.usd)),
    [entries]
  )

  // One chip per chain represented in the held list, sorted by USD held on
  // that chain — chains with the most value come first.
  const chains = useMemo(() => {
    const m = new Map<string, { chainId: string; assetCount: number; usd: number }>()
    for (const e of held) {
      const cur = m.get(e.chainId) || { chainId: e.chainId, assetCount: 0, usd: 0 }
      cur.assetCount += 1
      cur.usd += e.balance?.usd ?? 0
      m.set(e.chainId, cur)
    }
    return [...m.values()].sort((a, b) => b.usd - a.usd)
  }, [held])

  const filtered = useMemo(() => {
    let list = held
    if (chainFilter) list = list.filter(e => e.chainId === chainFilter)
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(e =>
      `${e.symbol} ${e.name} ${networkDisplayName(e.chainId)}`.toLowerCase().includes(q)
    )
  }, [held, search, chainFilter])

  const totalUsd = held.reduce((s, e) => s + (e.balance?.usd ?? 0), 0)

  return (
    <>
      {/* Summary strip */}
      <Flex align="baseline" justify="space-between" px="5" pb="3" flexShrink={0}>
        <Flex align="baseline" gap="2">
          <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.08em" textTransform="uppercase">
            Available to swap
          </Text>
          <Text fontSize="26px" fontWeight="700" letterSpacing="-0.03em" color="kk.textPrimary" fontVariantNumeric="tabular-nums">
            {totalUsd > 0 ? (privateModeEnabled ? "••••••" : fmtCompact(totalUsd)) : "—"}
          </Text>
        </Flex>
        <Text fontSize="10px" color="kk.textMuted">
          {held.length} assets · {new Set(held.map(e => e.chainId)).size} chains
        </Text>
      </Flex>

      <SearchBar value={search} onChange={setSearch} placeholder={t("filterHeld", "Filter by symbol, name or network…")} />

      {/* Chain filter chips — quick narrow by network. The "All" chip clears
          the filter; the others highlight when active. Sorted by USD value on
          that chain so the user's main chains land at the top of the list. */}
      {chains.length > 1 && (
        <Flex
          gap="1.5"
          px="5"
          pb="3"
          flexShrink={0}
          overflowX="auto"
          css={{
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <ChainChip
            label="All"
            count={held.length}
            active={chainFilter === null}
            onClick={() => setChainFilter(null)}
          />
          {chains.map(c => (
            <ChainChip
              key={c.chainId}
              label={networkDisplayName(c.chainId)}
              count={c.assetCount}
              active={chainFilter === c.chainId}
              onClick={() => setChainFilter(prev => prev === c.chainId ? null : c.chainId)}
            />
          ))}
        </Flex>
      )}

      <Box flex="1" overflowY="auto" px="5" pb="4">
        {balancesLoading && held.length === 0 && !search ? (
          <Flex direction="column" align="center" py="16" gap="4">
            <Spinner size="md" color="kk.gold" />
            <Box textAlign="center">
              <Text fontSize="14px" fontWeight="500" color="kk.textSecondary" mb="1">
                {t("loadingAssets", "Loading assets...")}
              </Text>
              <Text fontSize="11px" color="kk.textMuted" lineHeight="1.6" maxW="320px">
                {t("loadingBalances", "Checking your KeepKey balances...")}
              </Text>
            </Box>
          </Flex>
        ) : filtered.length === 0 ? (
          <Flex direction="column" align="center" py="16" gap="4">
            <Box w="56px" h="56px" borderRadius="full" bg="rgba(255,255,255,0.04)"
              border="1px dashed rgba(255,255,255,0.10)" display="grid" placeItems="center" color="kk.textMuted">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/>
              </svg>
            </Box>
            <Box textAlign="center">
              <Text fontSize="14px" fontWeight="500" color="kk.textSecondary" mb="1">
                {search ? "No held assets match" : t("emptyWalletTitle", "Your KeepKey is empty")}
              </Text>
              <Text fontSize="11px" color="kk.textMuted" lineHeight="1.6" maxW="320px">
                {search
                  ? "Try a different search term."
                  : t("emptyWalletSub", "Send some assets to your wallet first, then come back to swap.")}
              </Text>
            </Box>
          </Flex>
        ) : (
          <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(160px, 1fr))" gap="2.5">
            {filtered.map(e => <HeldTile key={e.caip} entry={e} onSelect={onSelect} fmtCompact={fmtCompact} privateModeEnabled={privateModeEnabled} />)}
          </Box>
        )}
      </Box>

      <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border"
        justify="space-between" align="center" flexShrink={0}>
        <Text fontSize="10px" color="kk.textMuted">Held assets · ranked by value</Text>
        <Text fontSize="10px" color="kk.textMuted">{filtered.length} of {held.length}</Text>
      </Flex>
    </>
  )
}

function HeldTile({ entry: e, onSelect, fmtCompact, privateModeEnabled }: {
  entry: AssetEntry; onSelect: (e: AssetEntry) => void; fmtCompact: (v: number) => string; privateModeEnabled: boolean
}) {
  const chainName = networkDisplayName(e.chainId)
  const selectable = isRowSelectable(e)
  const color = chainColorForCaip2(e.chainId)

  return (
    <Box
      as="button" textAlign="left" fontFamily="inherit"
      w="100%" aspectRatio="1"
      display="flex" flexDirection="column" justifyContent="space-between"
      bg={`linear-gradient(135deg, ${color}14 0%, rgba(255,255,255,0.02) 60%)`}
      border="1px solid" borderColor={`${color}35`}
      borderRadius="16px" p="3.5"
      position="relative" overflow="hidden"
      cursor={selectable ? "pointer" : "not-allowed"}
      opacity={selectable ? 1 : 0.5}
      color="kk.textPrimary"
      transition="all 0.18s"
      _hover={selectable ? {
        borderColor: `${color}70`,
        transform: "translateY(-2px)",
        boxShadow: `0 16px 30px -16px ${color}44`,
      } : {}}
      _before={{
        content: '""', position: "absolute", top: "-1px", right: "-1px",
        w: "70px", h: "70px",
        bg: `radial-gradient(circle at top right, ${color}28, transparent 70%)`,
        pointerEvents: "none",
      }}
      onClick={() => selectable && onSelect(e)}
    >
      {/* Chain color top stripe */}
      <Box position="absolute" top="0" left="0" right="0" h="2px"
        borderRadius="16px 16px 0 0" bg={color} opacity={0.75} />

      {/* Icon — 64px */}
      <AssetIcon caip={e.caip} iconUrl={e.iconUrl} chainCaip={chainBadgeCaip(e)} size={64} alt={e.symbol} />

      {/* Bottom info */}
      <Box mt="auto">
        <Text fontSize="18px" fontWeight="800" letterSpacing="-0.02em" lineHeight="1.2">{e.symbol}</Text>
        <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.06em" textTransform="uppercase" mt="0.5">
          {chainName}
        </Text>
        <Text fontSize="14px" fontWeight="600" fontVariantNumeric="tabular-nums" mt="1.5" letterSpacing="-0.01em">
          {e.balance!.amount}
        </Text>
        <Text fontSize="11px" fontWeight="500" color="kk.textSecondary" fontVariantNumeric="tabular-nums">{privateModeEnabled ? "••••••" : fmtCompact(e.balance!.usd)}</Text>
        {/* Full CAIP */}
        <Text fontSize="8px" color="kk.textMuted" fontFamily="mono" mt="1.5" whiteSpace="nowrap" opacity={0.6}>
          {ellipsizeCaip(e.caip)}
        </Text>
      </Box>
    </Box>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// TO picker — Step 1: network selection (square tiles)
// ══════════════════════════════════════════════════════════════════════════

interface ChainInfo {
  caip2: string
  name: string
  family: string
  color: string
  nativeCaip: string | undefined
  totalCount: number
  routableCount: number
  providers: string[]
  isAvailable: boolean
  /** A provider routes this chain, but the device's firmware can't sign/derive
   *  it — distinguishes "update firmware" from "no route at all". */
  firmwareGated: boolean
}

function buildChainInfos(entries: AssetEntry[], excludeCaip: string | undefined): ChainInfo[] {
  const chainIds = new Set(entries.map(e => e.chainId))
  return [...chainIds].map(caip2 => {
    const meta = chainMetaForCaip2(caip2)
    const chain = meta ? CHAINS.find(c => c.id === meta.vaultChainId) : null
    const assetsInChain = entries.filter(e => e.chainId === caip2 && e.caip !== excludeCaip)
    const routableInChain = assetsInChain.filter(e => isRowSelectable(e))
    const providers = new Set<string>()
    for (const e of routableInChain) for (const p of e.availability.providers) providers.add(p)
    return {
      caip2,
      name: networkDisplayName(caip2),
      family: chainFamilyLabel(meta?.chainFamily ?? ""),
      color: chain?.color ?? "#555",
      nativeCaip: meta?.nativeCaip,
      totalCount: assetsInChain.length,
      routableCount: routableInChain.length,
      providers: [...providers],
      isAvailable: routableInChain.length > 0,
      firmwareGated: routableInChain.length === 0
        && assetsInChain.some(e => e.availability.status === "unsupported_firmware"),
    }
  }).sort((a, b) => b.routableCount - a.routableCount) // most assets first
}

function ChainStep({ chainInfos, entries, search, onSearchChange, onPickChain, onSelectAsset, onUnavailAsset, excludeCaip }: {
  chainInfos: ChainInfo[]
  entries: AssetEntry[]
  search: string
  onSearchChange: (s: string) => void
  onPickChain: (caip2: string) => void
  onSelectAsset: (e: AssetEntry) => void
  onUnavailAsset: (e: AssetEntry) => void
  excludeCaip?: string
}) {
  const q = search.trim().toLowerCase()
  const available   = chainInfos.filter(c => c.isAvailable && (!q || c.name.toLowerCase().includes(q) || c.family.toLowerCase().includes(q)))
  const unavailable = chainInfos.filter(c => !c.isAvailable && (!q || c.name.toLowerCase().includes(q) || c.family.toLowerCase().includes(q)))

  // When no networks match the query, fall back to token search
  const noNetworkMatches = q.length > 0 && available.length === 0 && unavailable.length === 0
  const tokenFallback = useMemo(() => {
    if (!noNetworkMatches) return []
    return entries
      .filter(e => e.caip !== excludeCaip && `${e.symbol} ${e.name}`.toLowerCase().includes(q))
      .sort((a, b) => {
        const aSel = isRowSelectable(a) ? 1 : 0
        const bSel = isRowSelectable(b) ? 1 : 0
        if (aSel !== bSel) return bSel - aSel
        return (b.balance?.usd ?? 0) - (a.balance?.usd ?? 0)
      })
      .slice(0, 30)
  }, [noNetworkMatches, entries, q, excludeCaip])

  return (
    <>
      <SearchBar value={search} onChange={onSearchChange} placeholder="Search networks or tokens…" />

      <Box flex="1" overflowY="auto" px="5" pb="4">
        {/* Supported networks */}
        {available.length > 0 && (
          <>
            <Flex align="center" gap="2" mb="3" mt="1">
              <Box w="12px" h="2px" bg="var(--teal)" borderRadius="1px" />
              <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
                Supported networks
              </Text>
              <Text fontSize="10px" color="kk.textMuted">· {available.length}</Text>
            </Flex>
            <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(150px, 1fr))" gap="2.5" mb="5">
              {available.map(c => <NetworkTile key={c.caip2} chain={c} onPick={onPickChain} />)}
            </Box>
          </>
        )}

        {/* Unavailable */}
        {unavailable.length > 0 && (
          <>
            <Flex align="center" gap="2" mb="3">
              <Box w="12px" h="2px" bg="var(--rose)" borderRadius="1px" />
              <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
                Not currently routable
              </Text>
              <Text fontSize="10px" color="kk.textMuted">· {unavailable.length}</Text>
            </Flex>
            <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(150px, 1fr))" gap="2.5">
              {unavailable.map(c => <NetworkTile key={c.caip2} chain={c} onPick={onPickChain} unavail />)}
            </Box>
          </>
        )}

        {/* Token fallback — shown when no networks match but tokens do */}
        {noNetworkMatches && tokenFallback.length > 0 && (
          <>
            <Flex align="center" gap="2" mb="3" mt="1">
              <Box w="12px" h="2px" bg="#9F8CE0" borderRadius="1px" />
              <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
                Token results
              </Text>
              <Text fontSize="10px" color="kk.textMuted">· {tokenFallback.length}</Text>
            </Flex>
            <Flex direction="column" gap="0">
              {tokenFallback.map(e => (
                <AssetListRow key={e.caip} entry={e} onSelect={onSelectAsset} onUnavailable={onUnavailAsset} />
              ))}
            </Flex>
          </>
        )}

        {noNetworkMatches && tokenFallback.length === 0 && (
          <Flex direction="column" align="center" py="16" gap="2">
            <Text fontSize="14px" fontWeight="500" color="kk.textSecondary">No matching networks or tokens</Text>
            <Text fontSize="11px" color="kk.textMuted">Try a different search term.</Text>
          </Flex>
        )}
      </Box>
    </>
  )
}

function NetworkTile({ chain: c, onPick, unavail }: {
  chain: ChainInfo; onPick: (caip2: string) => void; unavail?: boolean
}) {
  return (
    <Box
      as="button" textAlign="left" fontFamily="inherit"
      w="100%" aspectRatio="1"
      display="flex" flexDirection="column" justifyContent="space-between"
      bg={unavail ? "rgba(255,255,255,0.02)" : `${c.color}0e`}
      border="1px solid" borderColor={unavail ? "rgba(255,255,255,0.06)" : `${c.color}28`}
      borderRadius="16px" p="3.5"
      position="relative" overflow="hidden"
      cursor={unavail ? "not-allowed" : "pointer"}
      opacity={unavail ? 0.42 : 1}
      color="kk.textPrimary"
      transition="all 0.15s"
      _hover={unavail ? {} : {
        bg: `${c.color}18`,
        borderColor: `${c.color}55`,
        transform: "translateY(-2px)",
        boxShadow: `0 12px 24px -12px ${c.color}40`,
      }}
      onClick={() => !unavail && onPick(c.caip2)}
    >
      {/* Chain color top stripe */}
      <Box position="absolute" top="0" left="0" right="0" h="2px"
        borderRadius="16px 16px 0 0" bg={c.color} opacity={unavail ? 0.3 : 0.8} />

      {/* Chain logo — 44px */}
      {c.nativeCaip
        ? <AssetIcon caip={c.nativeCaip} size={44} alt={c.name} />
        : <Box w="44px" h="44px" borderRadius="full" bg={c.color} />}

      {/* Bottom info */}
      <Box mt="auto">
        <Text fontSize="15px" fontWeight="800" letterSpacing="-0.02em" lineHeight="1.2">{c.name}</Text>
        <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.06em" textTransform="uppercase" mt="0.5">
          {c.family}
        </Text>
        <Text fontSize="11px" fontWeight="500" color={unavail && c.firmwareGated ? "var(--gold)" : "kk.textSecondary"} mt="1.5">
          {unavail ? (c.firmwareGated ? "Update firmware" : "No route") : `${c.routableCount} swappable`}
        </Text>
        {/* CAIP-2 */}
        <Text fontSize="8px" color="kk.textMuted" fontFamily="mono" mt="1" whiteSpace="nowrap" opacity={0.6}>
          {ellipsizeCaip(c.caip2)}
        </Text>
      </Box>
    </Box>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// TO picker — Step 2: asset list for a network (paginated + search)
// ══════════════════════════════════════════════════════════════════════════

function AssetStep({ entries, chainCaip2, fromChainId, excludeCaip, firmwareVersion, search, onSearchChange,
  onBack, onSelect, onUnavailable }: {
  entries: AssetEntry[]
  chainCaip2: string
  fromChainId: string | null
  excludeCaip: string | undefined
  firmwareVersion: string | undefined
  search: string
  onSearchChange: (s: string) => void
  onBack: () => void
  onSelect: (e: AssetEntry) => void
  onUnavailable: (e: AssetEntry) => void
}) {
  const chainName = networkDisplayName(chainCaip2)
  const [page, setPage] = useState(0)
  const q = search.trim().toLowerCase()

  // Reset page when search changes
  useEffect(() => { setPage(0) }, [search])

  // A pasted contract/mint address — EVM 0x… or Solana base58. Drives the
  // on-chain "paste a contract" lookup lane below when it matches no catalog row.
  // base58 is only treated as an address on solana:/tron: steps — on EVM steps a
  // base58-looking string is meaningless and would trigger a pointless lookup.
  const addrQuery = useMemo(() => {
    const rawAddr = search.trim()
    if (/^0x[a-fA-F0-9]{40}$/.test(rawAddr)) return rawAddr
    const base58Chain = chainCaip2.startsWith('solana:') || chainCaip2.startsWith('tron:')
    if (base58Chain && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawAddr)) return rawAddr
    return null
  }, [search, chainCaip2])

  // Discovery search — fires when in-chain list is empty and query is long enough.
  // Skipped for address queries, which take the dedicated contract-lookup lane.
  const [discoveryHits, setDiscoveryHits] = useState<AssetEntry[]>([])
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  useEffect(() => {
    if (addrQuery) { setDiscoveryHits([]); return }
    if (q.length < 2) { setDiscoveryHits([]); return }
    // Only search once the in-chain results are known (after inChain memo runs)
    const timer = setTimeout(async () => {
      setDiscoveryLoading(true)
      try {
        const hits = await rpcRequest<SwapAsset[]>('searchSwapAssets', { query: q })
        // Convert SwapAsset → AssetEntry using caip-derived chainId (CAIP-2)
        const entries: AssetEntry[] = (hits ?? []).flatMap(a => {
          const caip2 = a.caip.split('/')[0]
          if (!caip2) return []
          return [{
            caip: a.caip,
            symbol: a.symbol,
            name: a.name,
            chainId: caip2,
            decimals: a.decimals,
            iconUrl: a.icon,
            isNative: !a.contractAddress,
            availability: assessWithFirmware(a.caip, firmwareVersion),
          }]
        })
        setDiscoveryHits(entries)
      } catch { setDiscoveryHits([]) }
      finally { setDiscoveryLoading(false) }
    }, 400)
    return () => clearTimeout(timer)
  }, [q, addrQuery, firmwareVersion])

  const inChain = useMemo(() => entries.filter(e => {
    if (e.chainId !== chainCaip2) return false
    if (e.caip === excludeCaip) return false
    if (q) {
      const text = `${e.symbol} ${e.name}`.toLowerCase()
      const caipLower = (e.caip || '').toLowerCase()
      // Contract/mint match: parse the real contract out of the CAIP (the
      // earlier `(e as any).contractAddress` was always undefined — dead code).
      // base58 is case-sensitive on TRON/Solana, so match case-insensitively.
      const contract = (parseCaip(e.caip).contractAddress || '').toLowerCase()
      if (!text.includes(q) && !caipLower.includes(q) && !contract.includes(q)) return false
    }
    return true
  // Sort: held → stablecoins → native → popularity (catalog rank) → junk → unsupported.
  }).sort(compareForPicker), [entries, chainCaip2, excludeCaip, q])

  // Collect all providers across routable assets in chain (for banner)
  const allProviders = useMemo(() => {
    const s = new Set<string>()
    for (const e of inChain) if (isRowSelectable(e)) for (const p of e.availability.providers) s.add(p)
    return [...s]
  }, [inChain])

  const totalPages = Math.ceil(inChain.length / PAGE_SIZE)
  const pageItems  = inChain.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // ── Paste-a-contract lane ───────────────────────────────────────────────
  // When the query is an address with no catalog match, resolve it on-chain
  // (EVM eth_call / Solana RPC + Jupiter) and offer "Add & select".
  const [contractHit, setContractHit] = useState<SwapAsset | null>(null)
  // The address we've completed a lookup for — distinguishes "still resolving"
  // from "resolved, nothing found" so the empty state never flashes pre-lookup.
  const [searchedAddr, setSearchedAddr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    if (!addrQuery || inChain.length > 0) { setContractHit(null); setSearchedAddr(null); return }
    let cancelled = false
    setContractHit(null); setSearchedAddr(null)
    const timer = setTimeout(async () => {
      try {
        const res = await rpcRequest<{ hits: SwapAsset[] }>(
          'lookupTokenContract', { contractAddress: addrQuery, chainId: chainCaip2 }, 20000,
        )
        if (cancelled) return
        // Only accept a hit on the network the user is browsing — never silently
        // switch the destination to another chain (e.g. a Solana mint resolved
        // while the EVM step is open) — and exclude the source asset itself. The
        // normal list filters the FROM asset via excludeCaip, but this paste lane
        // bypassed it: pasting the source asset's own contract/mint into the
        // destination picker could re-select it and start a self-swap. Compare
        // case-insensitively to cover EVM address casing.
        setContractHit((res?.hits ?? []).find(h =>
          h.caip?.split('/')[0] === chainCaip2 &&
          (h.caip ?? '').toLowerCase() !== (excludeCaip ?? '').toLowerCase()
        ) ?? null)
      } catch {
        if (!cancelled) setContractHit(null)
      } finally {
        if (!cancelled) setSearchedAddr(addrQuery)
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [addrQuery, inChain.length, chainCaip2, excludeCaip])

  const handleAddAndSelect = useCallback(async (hit: SwapAsset) => {
    // Defense in depth: never add+select the source asset (self-swap guard) —
    // mirrors the excludeCaip filter on the normal list and the lookup hit.
    if (!hit.caip || hit.caip.toLowerCase() === (excludeCaip ?? '').toLowerCase()) return
    const entry: AssetEntry = {
      caip: hit.caip,
      symbol: hit.symbol,
      name: hit.name,
      chainId: hit.caip.split('/')[0],
      decimals: hit.decimals,
      iconUrl: hit.icon,
      isNative: !hit.contractAddress,
      swappable: hit,
      availability: assessWithFirmware(hit.caip, firmwareVersion),
    }
    // Honor the same gate as every other row: a firmware-gated (or otherwise
    // unswappable) pasted token routes to the unavailable view instead of being
    // silently added + selected. handleSelect (onSelect) re-guards, but that
    // path would no-op without telling the user why.
    if (!isRowSelectable(entry)) { onUnavailable(entry); return }
    setAdding(true)
    try {
      // Persist (best-effort) so it appears in the catalog on the next open.
      await rpcRequest('addCustomToken', { chainId: hit.chainId, contractAddress: hit.contractAddress }, 30000).catch(() => {})
      onSelect(entry)
    } finally {
      setAdding(false)
    }
  }, [onSelect, onUnavailable, excludeCaip, firmwareVersion])

  return (
    <>
      {/* Breadcrumb */}
      <Flex align="center" gap="2" mx="5" mb="2.5" flexShrink={0}>
        <Box as="button" display="inline-flex" alignItems="center" gap="1.5"
          bg="transparent" border="none" cursor="pointer" color="kk.textSecondary"
          px="2" py="1" borderRadius="8px" fontFamily="inherit" fontSize="11px"
          _hover={{ color: "kk.textPrimary", bg: "rgba(255,255,255,0.05)" }}
          onClick={onBack}>
          <BackIcon /> Networks
        </Box>
        <Text fontSize="11px" color="kk.textMuted">/</Text>
        <Text fontSize="11px" color="kk.textPrimary" fontWeight="500">{chainName}</Text>
      </Flex>

      {/* Network switch banner */}
      {fromChainId && <NetSwitchBanner fromChainId={fromChainId} toChainId={chainCaip2} providers={allProviders} />}

      {/* Search */}
      <SearchBar value={search} onChange={v => { onSearchChange(v) }}
        placeholder={`Search assets on ${chainName}…`} autoFocus />

      {/* List */}
      <Box flex="1" overflowY="auto" px="5" pb="2">
        {inChain.length > 0 ? (
          pageItems.map(e => (
            <AssetListRow key={e.caip} entry={e}
              onSelect={onSelect} onUnavailable={onUnavailable} />
          ))
        ) : addrQuery ? (
          // Pasted-address lane: on-chain lookup → add & select. Show the
          // resolving card until the lookup for THIS address completes, so the
          // empty state can't flash on the frame before the effect runs.
          contractHit ? (
            <ContractHitRow loading={false} hit={contractHit} adding={adding}
              chainName={chainName} onAdd={handleAddAndSelect} />
          ) : searchedAddr === addrQuery ? (
            <Flex direction="column" align="center" py="14" gap="2">
              <Text fontSize="14px" fontWeight="500" color="kk.textSecondary">No token at that address</Text>
              <Text fontSize="11px" color="kk.textMuted">Double-check the contract / mint address.</Text>
            </Flex>
          ) : (
            <ContractHitRow loading hit={null} adding={adding}
              chainName={chainName} onAdd={handleAddAndSelect} />
          )
        ) : discoveryHits.length > 0 ? (
          <>
            <Text fontSize="10px" color="kk.textMuted" mb="2" letterSpacing="0.06em" textTransform="uppercase">
              Other networks — will cross-chain swap
            </Text>
            {discoveryHits.map(e => (
              <AssetListRow key={e.caip} entry={e}
                onSelect={onSelect} onUnavailable={onUnavailable} />
            ))}
          </>
        ) : (
          <Flex direction="column" align="center" py="14" gap="2">
            {discoveryLoading
              ? <Text fontSize="11px" color="kk.textMuted">Searching all networks…</Text>
              : <>
                  <Text fontSize="14px" fontWeight="500" color="kk.textSecondary">No assets found</Text>
                  <Text fontSize="11px" color="kk.textMuted">Try a different search term.</Text>
                </>
            }
          </Flex>
        )}
      </Box>

      {/* Pagination + footer */}
      <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border"
        justify="space-between" align="center" flexShrink={0} bg="#101015">
        <Text fontSize="10px" color="kk.textMuted">
          {inChain.length} asset{inChain.length !== 1 ? "s" : ""} on {chainName}
          {totalPages > 1 && ` · page ${page + 1} of ${totalPages}`}
        </Text>
        {totalPages > 1 && (
          <Flex gap="2" align="center">
            <Box as="button" px="2.5" py="1" fontSize="10px" color="kk.textSecondary" fontFamily="inherit"
              bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="6px"
              cursor={page > 0 ? "pointer" : "not-allowed"} opacity={page > 0 ? 1 : 0.35}
              _hover={page > 0 ? { bg: "rgba(255,255,255,0.08)" } : {}}
              onClick={() => page > 0 && setPage(p => p - 1)}>
              ← Prev
            </Box>
            <Box as="button" px="2.5" py="1" fontSize="10px" color="kk.textSecondary" fontFamily="inherit"
              bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border" borderRadius="6px"
              cursor={page < totalPages - 1 ? "pointer" : "not-allowed"} opacity={page < totalPages - 1 ? 1 : 0.35}
              _hover={page < totalPages - 1 ? { bg: "rgba(255,255,255,0.08)" } : {}}
              onClick={() => page < totalPages - 1 && setPage(p => p + 1)}>
              Next →
            </Box>
          </Flex>
        )}
      </Flex>
    </>
  )
}

function AssetListRow({ entry: e, onSelect, onUnavailable }: {
  entry: AssetEntry
  onSelect: (e: AssetEntry) => void
  onUnavailable: (e: AssetEntry) => void
}) {
  const selectable  = isRowSelectable(e)
  const isTryQuote  = e.availability.status === "unknown"
  const chainName   = networkDisplayName(e.chainId)

  return (
    <Box
      as="button" w="100%" textAlign="left" fontFamily="inherit"
      display="flex" alignItems="center" gap="3"
      px="3" py="3"
      bg={e.balance ? "linear-gradient(90deg, rgba(139,227,196,0.04), rgba(255,255,255,0.01))" : "transparent"}
      border="1px solid"
      borderColor={e.balance ? "rgba(139,227,196,0.20)" : "rgba(255,255,255,0.05)"}
      borderRadius="12px" mb="1.5"
      cursor={selectable ? "pointer" : "not-allowed"}
      opacity={selectable ? 1 : 0.45}
      color="kk.textPrimary"
      transition="all 0.12s"
      _hover={selectable ? { bg: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.10)" } : {}}
      onClick={() => selectable ? onSelect(e) : onUnavailable(e)}
    >
      {/* Icon — 64px */}
      <Box flexShrink={0}>
        <AssetIcon caip={e.caip} iconUrl={e.iconUrl} chainCaip={chainBadgeCaip(e)} size={64} alt={e.symbol} />
      </Box>

      {/* Info */}
      <Box flex="1" minW="0">
        <Flex align="center" gap="2" flexWrap="wrap">
          <Text fontSize="15px" fontWeight="800">{e.symbol}</Text>
          <GasTokenBadge entry={e} />
          {e.balance && (
            <Box bg="rgba(139,227,196,0.12)" color="var(--teal)" px="1.5" py="0.5"
              borderRadius="4px" fontSize="9px" fontWeight="600" letterSpacing="0.04em">
              HELD · {e.balance.amount}
            </Box>
          )}
          {!e.balance && isTryQuote && (
            <Box bg="rgba(233,196,106,0.10)" color="var(--gold)" px="1.5" py="0.5"
              borderRadius="4px" fontSize="9px" fontWeight="600" letterSpacing="0.04em">
              TRY QUOTE
            </Box>
          )}
          {!selectable && !isTryQuote && (
            <Box bg="rgba(255,255,255,0.04)" color="kk.textMuted" px="1.5" py="0.5"
              borderRadius="4px" fontSize="9px" fontWeight="600" letterSpacing="0.04em">
              UNAVAILABLE
            </Box>
          )}
        </Flex>
        {/* Name + network — distinguishes USDC-on-Ethereum from USDC-on-Optimism */}
        <Text fontSize="12px" color="kk.textMuted" mt="0.5">
          {e.name} · <Text as="span" color="kk.textSecondary" fontWeight="600">{chainName}</Text>
        </Text>
        {/* Full CAIP-19 */}
        <Text fontSize="9px" color="kk.textMuted" fontFamily="mono" mt="1" opacity={0.55} whiteSpace="nowrap">
          {ellipsizeCaip(e.caip)}
        </Text>
      </Box>

      {/* Right: balance or routes */}
      <Flex direction="column" align="flex-end" gap="1" flexShrink={0}>
        {e.balance && (
          <Text fontSize="11px" fontVariantNumeric="tabular-nums" color="kk.textSecondary">
            {e.balance.amount}
          </Text>
        )}
        <ProviderDots providers={e.availability.providers} />
        {e.availability.providers.length > 0 && (
          <Text fontSize="9px" color="kk.textMuted">
            {e.availability.providers.length} {e.availability.providers.length === 1 ? "route" : "routes"}
          </Text>
        )}
      </Flex>
    </Box>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// Pasted-contract lookup row — on-chain resolved token with "Add & select"
// ══════════════════════════════════════════════════════════════════════════

function ContractHitRow({ loading, hit, adding, chainName, onAdd }: {
  loading: boolean
  hit: SwapAsset | null
  adding: boolean
  chainName: string
  onAdd: (hit: SwapAsset) => void
}) {
  if (loading || !hit) {
    return (
      <Flex align="center" gap="3" px="3.5" py="4"
        bg="rgba(233,196,106,0.04)" border="1px dashed rgba(233,196,106,0.22)" borderRadius="12px">
        <Box w="8px" h="8px" borderRadius="full" bg="var(--gold)" opacity={0.8}
          style={{ animation: "kkSwapFadeIn 0.6s ease-in-out infinite alternate" }} />
        <Box>
          <Text fontSize="12px" color="kk.textPrimary" fontWeight="600">Looking up token…</Text>
          <Text fontSize="10px" color="kk.textMuted">Resolving the address on {chainName}</Text>
        </Box>
      </Flex>
    )
  }
  const badgeCaip = hit.contractAddress && hit.caip
    ? chainMetaForCaip2(hit.caip.split("/")[0])?.nativeCaip
    : undefined
  return (
    <>
      <Text fontSize="10px" color="kk.textMuted" mb="2" letterSpacing="0.06em" textTransform="uppercase">
        Found via contract address
      </Text>
      <Flex align="center" gap="3" px="3.5" py="3"
        bg="rgba(233,196,106,0.05)" border="1px solid rgba(233,196,106,0.25)" borderRadius="12px">
        <Box flexShrink={0}>
          <AssetIcon caip={hit.caip!} iconUrl={hit.icon} chainCaip={badgeCaip} size={56} alt={hit.symbol} />
        </Box>
        <Box flex="1" minW="0">
          <Flex align="center" gap="2">
            <Text fontSize="15px" fontWeight="800">{hit.symbol}</Text>
            <Box bg="rgba(233,196,106,0.10)" color="var(--gold)" px="1.5" py="0.5"
              borderRadius="4px" fontSize="9px" fontWeight="600" letterSpacing="0.04em">NEW · TRY QUOTE</Box>
          </Flex>
          <Text fontSize="12px" color="kk.textMuted" mt="0.5">{hit.name} · {hit.decimals} decimals</Text>
          <Text fontSize="9px" color="kk.textMuted" fontFamily="mono" mt="1" opacity={0.55}
            whiteSpace="nowrap">{ellipsizeCaip(hit.caip!)}</Text>
        </Box>
        <Box as="button" flexShrink={0} fontFamily="inherit"
          px="3.5" py="2" borderRadius="10px" bg="var(--gold)" color="#0b0b0e"
          fontSize="11px" fontWeight="700" border="none"
          cursor={adding ? "wait" : "pointer"} opacity={adding ? 0.6 : 1}
          _hover={adding ? {} : { filter: "brightness(1.08)" }}
          disabled={adding}
          onClick={() => !adding && onAdd(hit)}>
          {adding ? "Adding…" : "Add & select"}
        </Box>
      </Flex>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// Unavailable route view
// ══════════════════════════════════════════════════════════════════════════

function UnavailableRouteView({ fromChainId, target, entries, onBack, onAltSelect }: {
  fromChainId: string | null
  target: AssetEntry
  entries: AssetEntry[]
  onBack: () => void
  onAltSelect: (e: AssetEntry) => void
}) {
  const { t } = useTranslation("swap")
  const sym = target.symbol
  const targetChainName = networkDisplayName(target.chainId)

  const alternatives = useMemo(() =>
    entries.filter(e => e.caip !== target.caip && e.symbol === sym && isRowSelectable(e))
      .sort((a, b) => b.availability.providers.length - a.availability.providers.length),
    [entries, target, sym]
  )

  return (
    <>
      <Flex align="center" gap="2" mx="5" mb="2.5" flexShrink={0}>
        <Box as="button" display="inline-flex" alignItems="center" gap="1.5"
          bg="transparent" border="none" cursor="pointer" color="kk.textSecondary"
          px="2" py="1" borderRadius="8px" fontFamily="inherit" fontSize="11px"
          _hover={{ color: "kk.textPrimary", bg: "rgba(255,255,255,0.05)" }}
          onClick={onBack}>
          <BackIcon /> Back to {targetChainName}
        </Box>
      </Flex>

      <Box flex="1" overflowY="auto" px="5" pb="4">
        {/* Hero */}
        <Flex direction="column" align="center" gap="3" p="5" mb="5"
          bg="linear-gradient(180deg, rgba(224,140,123,0.06), transparent)"
          border="1px solid rgba(224,140,123,0.18)" borderRadius="18px" textAlign="center">
          <Box w="56px" h="56px" borderRadius="full" bg="rgba(224,140,123,0.10)"
            display="grid" placeItems="center" color="var(--rose)">
            <AlertIcon />
          </Box>
          <Text fontSize="17px" fontWeight="500" letterSpacing="-0.01em" color="kk.textPrimary">
            {target.availability.status === "unsupported_firmware"
              ? `${sym} needs a firmware update`
              : `${sym} on ${targetChainName} isn't routable`}
          </Text>
          <Text fontSize="12px" color="kk.textSecondary" lineHeight="1.6" maxW="440px">
            {target.availability.status === "unsupported_firmware"
              ? (target.availability.reason ?? `Update your KeepKey to swap ${sym} on ${targetChainName}.`)
              : target.availability.status === "unsupported_token"
              ? `${targetChainName} natives swap fine, but this specific token isn't on any provider's list yet.`
              : `${targetChainName} isn't supported by any of our routers yet (THORChain, Mayachain, Relay, 0x, ChainFlip).`}
          </Text>
          <Box display="inline-flex" alignItems="center" gap="1.5"
            px="3.5" py="2" bg="rgba(233,196,106,0.06)" border="1px solid rgba(233,196,106,0.20)"
            borderRadius="10px" color="var(--gold)" fontFamily="inherit" fontSize="11px" fontWeight="600"
            opacity={0.5} cursor="not-allowed" title="Notifications coming soon">
            <BellIcon /> Notify me when supported
          </Box>
        </Flex>

        {/* Alternatives */}
        {alternatives.length > 0 ? (
          <>
            <Flex align="center" gap="2" mb="2.5">
              <Text fontSize="10px" color="var(--gold)">◆</Text>
              <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
                Swap to {sym} on another network
              </Text>
            </Flex>
            <Flex direction="column" gap="1.5">
              {alternatives.map(a => {
                const chainName = networkDisplayName(a.chainId)
                return (
                  <Box key={a.caip} as="button" w="100%" textAlign="left" fontFamily="inherit"
                    display="flex" alignItems="center" gap="3"
                    px="3.5" py="3"
                    bg="rgba(255,255,255,0.02)" border="1px solid rgba(255,255,255,0.06)"
                    borderRadius="12px" cursor="pointer" color="kk.textPrimary"
                    transition="all 0.15s"
                    _hover={{ bg: "rgba(255,255,255,0.05)", borderColor: "rgba(233,196,106,0.30)", transform: "translateX(2px)" }}
                    onClick={() => onAltSelect(a)}>
                    <AssetIcon caip={a.caip} iconUrl={a.iconUrl} chainCaip={chainBadgeCaip(a)} size={48} alt={a.symbol} />
                    <Box flex="1" minW="0">
                      <Flex align="center" gap="2">
                        <Text fontSize="13px" fontWeight="600">{a.symbol}</Text>
                        {a.balance && (
                          <Box bg="rgba(139,227,196,0.12)" color="var(--teal)" px="1.5" py="0.5"
                            borderRadius="4px" fontSize="9px" fontWeight="600">HELD</Box>
                        )}
                      </Flex>
                      <Text fontSize="10px" color="kk.textMuted" mt="0.5">{a.name} · on {chainName}</Text>
                      <Text fontSize="9px" color="kk.textMuted" fontFamily="mono" mt="1" opacity={0.55} whiteSpace="nowrap">{ellipsizeCaip(a.caip)}</Text>
                    </Box>
                    <Flex align="center" gap="1.5" px="2.5" py="1"
                      bg="rgba(139,227,196,0.08)" border="1px solid rgba(139,227,196,0.25)"
                      borderRadius="999px" flexShrink={0}>
                      <ProviderDots providers={a.availability.providers} />
                      <Text fontSize="10px" color="var(--teal)" fontWeight="600">
                        {a.availability.providers.length} {a.availability.providers.length === 1 ? "route" : "routes"}
                      </Text>
                    </Flex>
                    <Box color="kk.textMuted" flexShrink={0}><ArrowRight size={14} /></Box>
                  </Box>
                )
              })}
            </Flex>
          </>
        ) : (
          <Box p="4" bg="rgba(255,255,255,0.03)" border="1px dashed rgba(255,255,255,0.08)"
            borderRadius="12px" fontSize="11px" color="kk.textSecondary" lineHeight="1.6">
            No other supported network lists {sym}. Try a different destination asset.
          </Box>
        )}
      </Box>

      <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border"
        justify="space-between" align="center" flexShrink={0} bg="#101015">
        <Text fontSize="10px" color="kk.textMuted">We never sign anything that can't complete.</Text>
        <Box as="button" px="3" py="1.5" bg="rgba(255,255,255,0.05)" border="1px solid" borderColor="kk.border"
          borderRadius="8px" fontSize="11px" color="kk.textSecondary" cursor="pointer" fontFamily="inherit"
          _hover={{ bg: "rgba(255,255,255,0.08)" }} onClick={onBack}>
          Try a different asset
        </Box>
      </Flex>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// Confirm step — explicit breakdown before committing a selection
// ══════════════════════════════════════════════════════════════════════════

/** One labelled row in the breakdown table. */
function BreakdownRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex justify="space-between" align="center" gap="3" py="2.5"
      borderBottom="1px solid" borderColor="rgba(255,255,255,0.06)">
      <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.08em" textTransform="uppercase" flexShrink={0}>
        {label}
      </Text>
      <Box minW="0" textAlign="right">{children}</Box>
    </Flex>
  )
}

/** Confirmation gate. Forces the user to acknowledge exactly which asset —
 *  chain, token-vs-gas, and full CAIP-19 — they're committing to, so a mis-tap
 *  or a substituted row can't silently become the selection. Fires for both
 *  the FROM and TO sides. */
function ConfirmStep({ entry, side, onConfirm, onBack }: {
  entry: AssetEntry
  side: "from" | "to"
  onConfirm: () => void
  onBack: () => void
}) {
  const gas = isGasAsset(entry)
  const chainName = networkDisplayName(entry.chainId)
  const providers = entry.availability.providers

  return (
    <>
      <Flex align="center" gap="2" mx="5" mb="2.5" flexShrink={0}>
        <Box as="button" display="inline-flex" alignItems="center" gap="1.5"
          bg="transparent" border="none" cursor="pointer" color="kk.textSecondary"
          px="2" py="1" borderRadius="8px" fontFamily="inherit" fontSize="11px"
          _hover={{ color: "kk.textPrimary", bg: "rgba(255,255,255,0.05)" }}
          onClick={onBack}>
          <BackIcon /> Back
        </Box>
      </Flex>

      <Box flex="1" overflowY="auto" px="5" pb="4">
        {/* Hero asset */}
        <Flex direction="column" align="center" gap="3" p="5" mb="4"
          bg="linear-gradient(180deg, rgba(233,196,106,0.05), transparent)"
          border="1px solid rgba(233,196,106,0.16)" borderRadius="18px" textAlign="center">
          <AssetIcon caip={entry.caip} iconUrl={entry.iconUrl} chainCaip={chainBadgeCaip(entry)} size={72} alt={entry.symbol} />
          <Box>
            <Flex align="center" gap="2" justify="center">
              <Text fontSize="22px" fontWeight="800" letterSpacing="-0.02em">{entry.symbol}</Text>
              <GasTokenBadge entry={entry} />
            </Flex>
            <Text fontSize="12px" color="kk.textSecondary" mt="1">{entry.name}</Text>
          </Box>
        </Flex>

        {/* Breakdown table */}
        <Box bg="rgba(255,255,255,0.02)" border="1px solid rgba(255,255,255,0.06)"
          borderRadius="14px" px="4" py="1">
          <BreakdownRow label="Network">
            <Text fontSize="13px" fontWeight="700" color="kk.textPrimary">{chainName}</Text>
          </BreakdownRow>
          <BreakdownRow label="Network ID">
            <Text fontSize="11px" fontFamily="mono" color="kk.textSecondary">{entry.chainId}</Text>
          </BreakdownRow>
          <BreakdownRow label="Type">
            <Text fontSize="12px" fontWeight="700" color={gas ? "var(--gold)" : "kk.textPrimary"}>
              {gas ? "Gas / native asset" : "Token"}
            </Text>
          </BreakdownRow>
          {providers.length > 0 && (
            <BreakdownRow label="Routes">
              <Flex align="center" gap="2" justify="flex-end">
                <ProviderDots providers={providers} />
                <Text fontSize="11px" color="kk.textSecondary">
                  {providers.length} {providers.length === 1 ? "route" : "routes"}
                </Text>
              </Flex>
            </BreakdownRow>
          )}
          <Flex justify="space-between" align="center" gap="3" py="2.5">
            <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.08em" textTransform="uppercase" flexShrink={0}>
              Asset ID
            </Text>
            <Text fontSize="10px" fontFamily="mono" color="kk.textMuted" minW="0"
              wordBreak="break-all" textAlign="right">{entry.caip}</Text>
          </Flex>
        </Box>
      </Box>

      {/* Footer actions */}
      <Flex px="5" py="3" borderTop="1px solid" borderColor="kk.border"
        justify="space-between" align="center" gap="3" flexShrink={0} bg="#101015">
        <Box as="button" px="4" py="2.5" bg="rgba(255,255,255,0.05)" border="1px solid" borderColor="kk.border"
          borderRadius="10px" fontSize="12px" color="kk.textSecondary" cursor="pointer" fontFamily="inherit"
          _hover={{ bg: "rgba(255,255,255,0.08)" }} onClick={onBack}>
          Back
        </Box>
        <Box as="button" flex="1" px="4" py="2.5" bg="var(--gold)" color="#0b0b0e"
          borderRadius="10px" fontSize="12px" fontWeight="700" border="none" cursor="pointer"
          fontFamily="inherit" _hover={{ filter: "brightness(1.08)" }} onClick={onConfirm}>
          Use {entry.symbol} on {chainName} as {side === "from" ? "input" : "output"}
        </Box>
      </Flex>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// Props + main component
// ══════════════════════════════════════════════════════════════════════════

interface AssetPickerDialogProps {
  open: boolean
  onClose: () => void
  swappable: SwapAsset[]
  balances: ChainBalance[]
  balancesLoading?: boolean
  customTokens?: CustomToken[]
  excludeCaip?: string
  onSelect: (asset: SwapAsset) => void
  side: "from" | "to"
}

export function AssetPickerDialog({
  open, onClose, swappable, balances, balancesLoading = false, customTokens, excludeCaip, onSelect, side,
}: AssetPickerDialogProps) {
  const { fmtCompact, privateModeEnabled } = useFiat()
  // Connected device's firmware version — gates chains whose `minFirmware` the
  // device can't meet (e.g. ZEC needs 7.15.0). Undefined until the first device-
  // state fetch resolves, which fails closed (firmware-restricted chains hidden).
  const { firmwareVersion } = useDeviceState()

  const [entries, setEntries]         = useState<AssetEntry[] | null>(null)
  const [loading, setLoading]         = useState(false)
  const [toChain, setToChain]         = useState<string | null>(null)
  const [unavailEntry, setUnavailEntry] = useState<AssetEntry | null>(null)
  // Pending selection awaiting explicit confirmation in the breakdown gate.
  const [confirmEntry, setConfirmEntry] = useState<AssetEntry | null>(null)
  const [search, setSearch]           = useState("")

  // FROM chain id (for NetSwitchBanner + excluding self): extracted from excludeCaip when side=to
  const fromChainId = side === "to" && excludeCaip ? excludeCaip.split("/")[0] : null

  // Build entry list on open
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    buildAssetEntries({ swappable, balances, customTokens, firmwareVersion })
      .then(list => { if (!cancelled) { setEntries(list); setLoading(false) } })
      .catch(e => {
        if (cancelled) return
        console.error("[AssetPickerDialog] buildAssetEntries failed:", e)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, swappable, balances, customTokens, firmwareVersion])

  // Reset navigation on open/close.
  // On the TO side, default the chain step to the FROM token's chain so the
  // user lands directly on the same-chain asset list (the common case) instead
  // of having to pick the network again. They can still hit Back to switch.
  useEffect(() => {
    if (open) {
      setToChain(side === 'to' && fromChainId ? fromChainId : null)
      setUnavailEntry(null)
      setConfirmEntry(null)
      setSearch("")
    }
  }, [open, side, fromChainId])

  // Escape to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose() } }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // Chain infos for TO step 1
  const chainInfos = useMemo(() => {
    if (!entries) return []
    return buildChainInfos(entries, excludeCaip)
  }, [entries, excludeCaip])

  // Step 1: route any selectable row into the confirmation gate instead of
  // committing immediately. The gate shows the full chain/token-vs-gas/CAIP
  // breakdown so a mis-tap or a substituted row can't silently become the pick.
  const handleSelect = useCallback((entry: AssetEntry) => {
    if (!isRowSelectable(entry)) return
    setConfirmEntry(entry)
  }, [])

  // Step 2: commit the confirmed selection.
  const commitSelect = useCallback((entry: AssetEntry) => {
    const base = entry.swappable ?? synthesizeSwapAsset(entry)
    if (!base) {
      console.warn("[AssetPickerDialog] No vault chain config for", entry.chainId)
      return
    }
    const asset = base.caip === entry.caip ? base : { ...base, caip: entry.caip }
    onSelect(asset)
    onClose()
  }, [onSelect, onClose])

  if (!open) return null

  // Title
  const title = confirmEntry ? "Confirm your selection"
    : side === "from" ? "Select asset to swap from"
    : unavailEntry  ? "Route unavailable"
    : toChain       ? `Assets on ${networkDisplayName(toChain)}`
    :                 "Select destination network"

  const stepLabel = confirmEntry ? `Review the ${side === "from" ? "input" : "output"} before continuing`
    : side === "from" ? "Step 1 of 2 — pick what you're swapping"
    : toChain       ? `Step 2 of 2 — pick an asset on ${networkDisplayName(toChain)}`
    :                 "Step 2 of 2 — choose destination network"

  return (
    <Box position="fixed" inset="0" zIndex={Z.assetPicker}
      display="flex" alignItems="center" justifyContent="center"
      bg="rgba(11,11,14,0.28)"
      backdropFilter="blur(20px) saturate(140%)"
      onClick={onClose}>
      <Box
        position="relative"
        borderRadius="22px"
        border="1px solid rgba(255,255,255,0.10)"
        w="700px" maxW="96vw" h="700px" maxH="92vh"
        display="flex" flexDirection="column"
        overflow="hidden"
        fontFamily="'Geist Mono', ui-monospace, monospace"
        onClick={(e) => e.stopPropagation()}
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015)), rgba(16,16,21,0.78)",
          backdropFilter: "blur(32px) saturate(160%)",
          WebkitBackdropFilter: "blur(32px) saturate(160%)",
          boxShadow:
            "0 0 0 1px rgba(255,255,255,0.06), 0 24px 60px -16px rgba(0,0,0,0.8), 0 4px 12px -4px rgba(0,0,0,0.5)",
        }}
        _before={{
          content: '""', position: "absolute", inset: "0",
          bg: "radial-gradient(800px 400px at 50% -10%, rgba(233,196,106,0.04), transparent 60%)",
          pointerEvents: "none", zIndex: 0,
        }}
      >
        {/* Header */}
        <Flex align="center" justify="space-between" px="5" pt="4.5" pb="3.5" flexShrink={0} zIndex={1}>
          <Box>
            <Text fontSize="10px" letterSpacing="0.12em" textTransform="uppercase" color="kk.textMuted" mb="1">
              {stepLabel}
            </Text>
            <Text fontSize="18px" fontWeight="700" letterSpacing="-0.02em" color="kk.textPrimary">
              {title}
            </Text>
          </Box>
          <Box as="button" w="28px" h="28px" borderRadius="8px" bg="transparent" border="none"
            color="kk.textMuted" cursor="pointer" display="grid" placeItems="center"
            _hover={{ bg: "rgba(255,255,255,0.05)", color: "kk.textPrimary" }}
            onClick={onClose}>
            <CloseIcon />
          </Box>
        </Flex>

        {/* Body */}
        <Box flex="1" minH="0" display="flex" flexDirection="column" zIndex={1}>
          {loading ? (
            <Flex flex="1" align="center" justify="center">
              <Text fontSize="12px" color="kk.textMuted">Loading…</Text>
            </Flex>
          ) : !entries ? null
          : confirmEntry ? (
            <ConfirmStep
              entry={confirmEntry}
              side={side}
              onConfirm={() => commitSelect(confirmEntry)}
              onBack={() => setConfirmEntry(null)}
            />
          ) : side === "from" ? (
            <FromPicker entries={entries} onSelect={handleSelect} fmtCompact={fmtCompact} privateModeEnabled={privateModeEnabled} balancesLoading={balancesLoading} />
          ) : unavailEntry ? (
            <UnavailableRouteView
              fromChainId={fromChainId}
              target={unavailEntry}
              entries={entries}
              onBack={() => setUnavailEntry(null)}
              onAltSelect={(e) => { setUnavailEntry(null); handleSelect(e) }}
            />
          ) : toChain ? (
            <AssetStep
              entries={entries}
              chainCaip2={toChain}
              fromChainId={fromChainId}
              excludeCaip={excludeCaip}
              firmwareVersion={firmwareVersion}
              search={search}
              onSearchChange={setSearch}
              onBack={() => { setToChain(null); setSearch("") }}
              onSelect={handleSelect}
              onUnavailable={setUnavailEntry}
            />
          ) : (
            <ChainStep
              chainInfos={chainInfos}
              entries={entries}
              search={search}
              onSearchChange={setSearch}
              onPickChain={(caip2) => { setToChain(caip2); setSearch("") }}
              onSelectAsset={handleSelect}
              onUnavailAsset={setUnavailEntry}
              excludeCaip={excludeCaip}
            />
          )}
        </Box>
      </Box>
    </Box>
  )
}
