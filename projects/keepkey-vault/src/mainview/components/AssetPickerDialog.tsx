/**
 * Asset Picker v2 — full redesign from handoff (May 2026).
 *
 * FROM side: card grid of held assets, sorted by USD value.
 * TO side:   2-step flow — chain selection grid → asset list in that chain.
 *            Unavailable-route view replaces the asset list when the user taps
 *            a non-routable asset.
 */
import { useState, useEffect, useMemo, useCallback, type ReactNode } from "react"
import { Box, Flex, Text, Input } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { AssetIcon } from "./AssetIcon"
import type { SwapAsset, ChainBalance, CustomToken } from "../../shared/types"
import {
  buildAssetEntries,
  buildSearchIndex,
  searchEntries,
  chainMetaForCaip2,
  networkDisplayName,
  synthesizeSwapAsset,
  type AssetEntry,
  type SearchIndex,
} from "../../shared/swap-discovery"
import { CHAINS } from "../../shared/chains"
import { PROVIDER_LABEL } from "../../shared/swap-support-matrix"
import { Z } from "../lib/z-index"
import { useFiat } from "../lib/fiat-context"
import { rpcRequest } from "../lib/rpc"

// ── constants ──────────────────────────────────────────────────────────────

const EVM_CONTRACT_RE = /^0x[a-fA-F0-9]{40}$/
const MAX_RENDER = 150

// ── small icons ────────────────────────────────────────────────────────────

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

// ── selectability (same as before) ─────────────────────────────────────────

function isRowSelectable(entry: AssetEntry): boolean {
  const s = entry.availability.status
  if (s !== "swappable" && s !== "unknown") return false
  return chainMetaForCaip2(entry.chainId) !== null
}

// ── provider dots ───────────────────────────────────────────────────────────

// Keys match SwapProvider type from swap-support-matrix
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
  const show = providers.slice(0, 4)
  return (
    <Flex gap="1" title={providers.join(", ")}>
      {show.map(p => (
        <Box key={p} w="6px" h="6px" borderRadius="full"
          bg={PROVIDER_COLORS[p] ?? "#888"} />
      ))}
      {providers.length > 4 && <Box w="6px" h="6px" borderRadius="full" bg="var(--text-3)" />}
    </Flex>
  )
}

// ── chain badge caip helper ─────────────────────────────────────────────────

function chainBadgeCaip(entry: AssetEntry): string | undefined {
  if (entry.isNative) return undefined
  return chainMetaForCaip2(entry.chainId)?.nativeCaip
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
    <Flex
      align="center" gap="3" mx="5" mb="3" p="2.5"
      bg={same ? "rgba(139,227,196,0.06)" : "rgba(233,196,106,0.08)"}
      border="1px solid"
      borderColor={same ? "rgba(139,227,196,0.20)" : "rgba(233,196,106,0.20)"}
      borderRadius="12px" flexShrink={0}
    >
      {/* mini route diagram — real chain logos */}
      <Flex align="center" flexShrink={0}>
        {fromMeta?.nativeCaip
          ? <AssetIcon caip={fromMeta.nativeCaip} size={20} alt={fromName} />
          : <Box w="20px" h="20px" borderRadius="full" bg={chainColorForCaip2(fromChainId)} />}
        <Box w="16px" h="2px"
          bg={`repeating-linear-gradient(90deg, ${same ? "#8be3c4" : "#e9c46a"} 0 4px, transparent 4px 8px)`}
          mx="1" />
        {toMeta?.nativeCaip
          ? <AssetIcon caip={toMeta.nativeCaip} size={20} alt={toName} />
          : <Box w="20px" h="20px" borderRadius="full" bg={chainColorForCaip2(toChainId)} />}
      </Flex>

      <Box flex="1" minW="0">
        <Flex align="center" gap="2">
          <Text fontSize="11px" fontWeight="600" color="kk.textPrimary">
            {same ? <>Staying on <strong>{fromName}</strong></> : <>Crossing from <strong>{fromName}</strong> to <strong>{toName}</strong></>}
          </Text>
          {providers.length > 0 && (
            <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.06em" ml="auto">
              via {providers.slice(0, 2).join(" / ")}
            </Text>
          )}
        </Flex>
        <Text fontSize="10px" color="kk.textMuted" mt="0.5">
          {same
            ? `Same-network swap · settles in seconds`
            : `Cross-chain · est. 4–12 min · funds custodied by ${providers[0] ?? "router"} during transit`}
        </Text>
      </Box>

      <Box
        bg={same ? "var(--teal)" : "var(--gold)"}
        color="kk.bg" px="2" py="1" borderRadius="6px"
        fontSize="9px" fontWeight="700" letterSpacing="0.04em"
        flexShrink={0}
      >
        {same ? "Same network" : "Cross-chain"}
      </Box>
    </Flex>
  )
}

// ── FROM picker — held assets card grid ─────────────────────────────────────

function FromPicker({ entries, onSelect, fmtCompact }: {
  entries: AssetEntry[]; onSelect: (e: AssetEntry) => void; fmtCompact: (v: number) => string
}) {
  const { t } = useTranslation("swap")
  const [search, setSearch] = useState("")
  const held = useMemo(
    () => entries.filter(e => e.balance).sort((a, b) => (b.balance!.usd) - (a.balance!.usd)),
    [entries]
  )
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return held
    return held.filter(e =>
      `${e.symbol} ${e.name} ${networkDisplayName(e.chainId)}`.toLowerCase().includes(q)
    )
  }, [held, search])

  const totalUsd = held.reduce((s, e) => s + (e.balance?.usd ?? 0), 0)

  return (
    <>
      {/* Header */}
      <Box px="5" pb="3" flexShrink={0}>
        <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase" mb="0.5">
          {t("stepOne", "Step 1 of 2 — Pick what you're swapping")}
        </Text>
        <Flex align="baseline" justify="space-between">
          <Flex align="baseline" gap="2">
            <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.08em" textTransform="uppercase">
              {t("availableToSwap", "Available to swap")}
            </Text>
            <Text fontSize="22px" fontWeight="500" letterSpacing="-0.01em" color="kk.textPrimary" fontVariantNumeric="tabular-nums">
              {totalUsd > 0 ? fmtCompact(totalUsd) : "—"}
            </Text>
          </Flex>
          <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.04em">
            {held.length} {t("assetsAcross", "assets across")} {new Set(held.map(e => e.chainId)).size} {t("chains", "chains")}
          </Text>
        </Flex>
      </Box>

      {/* Search (only when >5 held) */}
      {held.length > 5 && (
        <Flex align="center" gap="2" mx="5" mb="3" px="3" py="2.5"
          bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border"
          borderRadius="12px" flexShrink={0} _focusWithin={{ borderColor: "rgba(255,255,255,0.16)" }}>
          <SearchIcon />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t("filterHeld", "Filter held assets…")}
            bg="transparent" border="none" color="kk.textPrimary" px="0" fontSize="12px"
            _focus={{ outline: "none", boxShadow: "none" }} />
        </Flex>
      )}

      {/* Grid */}
      <Box flex="1" overflowY="auto" px="5" pb="4">
        {filtered.length === 0 ? (
          <Flex direction="column" align="center" py="16" gap="4">
            <Box w="56px" h="56px" borderRadius="full" bg="rgba(255,255,255,0.04)"
              border="1px dashed rgba(255,255,255,0.10)" display="grid" placeItems="center"
              color="kk.textMuted">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/>
              </svg>
            </Box>
            <Box textAlign="center">
              <Text fontSize="14px" fontWeight="500" color="kk.textSecondary" mb="1">
                {t("emptyWalletTitle", "Your KeepKey is empty")}
              </Text>
              <Text fontSize="11px" color="kk.textMuted" lineHeight="1.6" maxW="340px">
                {t("emptyWalletSub", "Send some assets to your wallet first — then come back here to swap them.")}
              </Text>
            </Box>
          </Flex>
        ) : (
          <Box
            display="grid"
            gridTemplateColumns="repeat(auto-fill, minmax(170px, 1fr))"
            gap="2.5"
          >
            {filtered.map(e => <HeldCard key={e.caip} entry={e} onSelect={onSelect} fmtCompact={fmtCompact} />)}
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border"
        justify="space-between" align="center" flexShrink={0}>
        <Text fontSize="10px" color="kk.textMuted">
          {t("showingHeld", "Showing only what your KeepKey holds.")}
        </Text>
        <Text fontSize="10px" color="kk.textMuted">
          {filtered.length} {t("of", "of")} {held.length}
        </Text>
      </Flex>
    </>
  )
}

function HeldCard({ entry: e, onSelect, fmtCompact }: {
  entry: AssetEntry; onSelect: (e: AssetEntry) => void; fmtCompact: (v: number) => string
}) {
  const chainName = networkDisplayName(e.chainId)
  const chainColor = chainColorForCaip2(e.chainId)
  const providers = e.availability.providers

  return (
    <Box
      as="button" textAlign="left"
      bg="linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))"
      border="1px solid rgba(139,227,196,0.18)"
      borderRadius="14px" p="3.5" cursor="pointer"
      display="flex" flexDirection="column" gap="2.5"
      position="relative" overflow="hidden"
      transition="all 0.18s"
      color="kk.textPrimary" fontFamily="inherit"
      _hover={{ borderColor: "rgba(139,227,196,0.50)", transform: "translateY(-2px)", boxShadow: "0 16px 30px -16px rgba(139,227,196,0.30)" }}
      _before={{ content: '""', position: "absolute", top: "-1px", right: "-1px", w: "60px", h: "60px", bg: "radial-gradient(circle at top right, rgba(139,227,196,0.18), transparent 70%)", pointerEvents: "none" }}
      onClick={() => isRowSelectable(e) && onSelect(e)}
      opacity={isRowSelectable(e) ? 1 : 0.5}
    >
      {/* Top row: icon + chain + (placeholder pct) */}
      <Flex justify="space-between" align="flex-start">
        <AssetIcon caip={e.caip} iconUrl={e.iconUrl} chainCaip={chainBadgeCaip(e)} size={32} alt={e.symbol} />
      </Flex>

      {/* Symbol + chain */}
      <Box>
        <Text fontSize="16px" fontWeight="600" letterSpacing="-0.01em">{e.symbol}</Text>
        <Flex align="center" gap="1" mt="0.5">
          <Box w="6px" h="6px" borderRadius="full" bg={chainColor} flexShrink={0} />
          <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.06em" textTransform="uppercase">
            on {chainName}
          </Text>
        </Flex>
      </Box>

      {/* Balance */}
      <Box>
        <Text fontSize="15px" fontVariantNumeric="tabular-nums" letterSpacing="-0.01em">
          {e.balance!.amount}
        </Text>
        <Text fontSize="11px" color="kk.textSecondary" fontVariantNumeric="tabular-nums" mt="0.5">
          {e.balance!.usd > 0 ? fmtCompact(e.balance!.usd) : "—"}
        </Text>
      </Box>

      {/* Footer: providers */}
      <Flex justify="flex-end" align="center"
        pt="2.5" borderTop="1px solid rgba(255,255,255,0.06)">
        <ProviderDots providers={providers} />
      </Flex>
    </Box>
  )
}

// ── TO picker — chain selection step ────────────────────────────────────────

interface ChainInfo {
  caip2: string
  name: string
  family: string
  color: string
  /** Native asset CAIP-19 for use with AssetIcon (e.g. 'eip155:1/slip44:60') */
  nativeCaip: string | undefined
  heldCount: number
  totalCount: number
  routableCount: number
  providers: string[]
  isAvailable: boolean
}

function buildChainInfos(entries: AssetEntry[], fromChainId: string | null, excludeCaip: string | undefined): ChainInfo[] {
  const chainIds = new Set(entries.map(e => e.chainId))
  return [...chainIds].map(caip2 => {
    const meta = chainMetaForCaip2(caip2)
    const chain = meta ? CHAINS.find(c => c.id === meta.vaultChainId) : null
    const assetsInChain = entries.filter(e => e.chainId === caip2 && e.caip !== excludeCaip)
    const heldInChain = assetsInChain.filter(e => e.balance)
    const routableInChain = assetsInChain.filter(e => isRowSelectable(e))
    const providers = new Set<string>()
    for (const e of routableInChain) {
      for (const p of e.availability.providers) providers.add(p)
    }
    return {
      caip2,
      name: networkDisplayName(caip2),
      family: chainFamilyLabel(meta?.chainFamily ?? ""),
      color: chain?.color ?? "#555",
      nativeCaip: meta?.nativeCaip,
      heldCount: heldInChain.length,
      totalCount: assetsInChain.length,
      routableCount: routableInChain.length,
      providers: [...providers],
      isAvailable: routableInChain.length > 0,
    }
  })
}

function ChainStep({ chainInfos, fromChainId, search, onSearchChange, onPickChain }: {
  chainInfos: ChainInfo[]
  fromChainId: string | null
  search: string
  onSearchChange: (s: string) => void
  onPickChain: (caip2: string) => void
}) {
  const { t } = useTranslation("swap")
  const q = search.trim().toLowerCase()
  const matches = (c: ChainInfo) => !q || c.name.toLowerCase().includes(q) ||
    c.family.toLowerCase().includes(q)

  const sameChain    = chainInfos.filter(c => c.caip2 === fromChainId && matches(c))
  const heldChains   = chainInfos.filter(c => c.caip2 !== fromChainId && c.heldCount > 0 && c.isAvailable && matches(c))
    .sort((a, b) => b.heldCount - a.heldCount)
  const otherChains  = chainInfos.filter(c => c.caip2 !== fromChainId && c.heldCount === 0 && c.isAvailable && matches(c))
  const unavailChains = chainInfos.filter(c => !c.isAvailable && matches(c))

  return (
    <>
      {/* Search */}
      <Flex align="center" gap="2" mx="5" mb="3" px="3" py="2.5"
        bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border"
        borderRadius="12px" flexShrink={0}
        _focusWithin={{ borderColor: "rgba(255,255,255,0.16)" }}>
        <SearchIcon />
        <Input value={search} onChange={e => onSearchChange(e.target.value)}
          placeholder={t("searchChainPlaceholder", "Search destination — symbol or chain name…")}
          bg="transparent" border="none" color="kk.textPrimary" px="0" fontSize="12px"
          _focus={{ outline: "none", boxShadow: "none" }} />
        <Text fontSize="10px" color="kk.textMuted" px="1.5" py="0.5"
          border="1px solid" borderColor="kk.border" borderRadius="5px">⌘K</Text>
      </Flex>

      <Box flex="1" overflowY="auto" px="5" pb="4">
        {/* Same network */}
        {sameChain.length > 0 && (
          <ChainSection title={t("sameNetwork", "Stay on the same network")} accent="var(--gold)"
            meta={t("sameNetMeta", "no bridge, fastest settlement")}>
            <ChainGrid chains={sameChain} onPick={onPickChain} />
          </ChainSection>
        )}
        {/* Held chains */}
        {heldChains.length > 0 && (
          <ChainSection title={t("networksYouHold", "Networks you already hold")} accent="var(--teal)"
            meta={t("heldMeta", "return route via your own funds")}>
            <ChainGrid chains={heldChains} onPick={onPickChain} />
          </ChainSection>
        )}
        {/* Other chains */}
        {otherChains.length > 0 && (
          <ChainSection title={t("allNetworks", "All supported networks")} accent="var(--violet)"
            meta={`${otherChains.length} ${t("chainsAvail", "chains · cross-chain routes available")}`}>
            <ChainGrid chains={otherChains} onPick={onPickChain} />
          </ChainSection>
        )}
        {/* Unavailable */}
        {unavailChains.length > 0 && (
          <ChainSection title={t("notRoutable", "Not currently routable")} accent="var(--rose)"
            meta={`${unavailChains.length} ${t("noProviderYet", "chains · no provider supports this yet")}`}>
            <ChainGrid chains={unavailChains} onPick={() => {}} unavail />
          </ChainSection>
        )}
        {sameChain.length + heldChains.length + otherChains.length + unavailChains.length === 0 && (
          <Flex direction="column" align="center" py="16" gap="2">
            <Text fontSize="14px" fontWeight="500" color="kk.textSecondary">No matching networks</Text>
            <Text fontSize="11px" color="kk.textMuted">Try a different search term.</Text>
          </Flex>
        )}
      </Box>
    </>
  )
}

function ChainSection({ title, accent, meta, children }: {
  title: string; accent: string; meta: string; children: ReactNode
}) {
  return (
    <Box mt="5" _first={{ mt: "1.5" }}>
      <Flex align="baseline" justify="space-between" mb="2.5">
        <Flex align="center" gap="2">
          <Box w="14px" h="2px" bg={accent} borderRadius="1px" />
          <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
            {title}
          </Text>
        </Flex>
        <Text fontSize="10px" color="kk.textMuted">{meta}</Text>
      </Flex>
      {children}
    </Box>
  )
}

function ChainGrid({ chains, onPick, unavail }: {
  chains: ChainInfo[]; onPick: (caip2: string) => void; unavail?: boolean
}) {
  return (
    <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap="2.5">
      {chains.map(c => (
        <Box
          key={c.caip2} as="button" textAlign="left" fontFamily="inherit"
          display="flex" alignItems="stretch"
          bg="rgba(255,255,255,0.03)" border="1px solid" borderColor="kk.border"
          borderRadius="14px" p="0" overflow="hidden" cursor={unavail ? "not-allowed" : "pointer"}
          opacity={unavail ? 0.46 : 1} color="kk.textPrimary"
          transition="all 0.15s"
          _hover={unavail ? {} : { bg: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.10)", transform: "translateY(-1px)" }}
          onClick={() => !unavail && onPick(c.caip2)}
        >
          {/* Color stripe */}
          <Box w="4px" bg={c.color} flexShrink={0} />
          {/* Body */}
          <Box flex="1" minW="0" p="3.5" display="flex" flexDirection="column" gap="1.5">
            <Flex align="center" gap="2.5">
              {c.nativeCaip
                ? <AssetIcon caip={c.nativeCaip} size={22} alt={c.name} />
                : <Box w="22px" h="22px" borderRadius="full" bg={c.color} flexShrink={0} />}
              <Text fontSize="13px" fontWeight="600">{c.name}</Text>
              <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.08em" textTransform="uppercase" ml="auto">
                {c.family}
              </Text>
            </Flex>
            <Flex align="center" gap="2" flexWrap="wrap">
              {c.caip2 && c.heldCount > 0 && (
                <Box bg="rgba(139,227,196,0.15)" color="var(--teal)" px="1.5" py="0.5" borderRadius="4px"
                  fontSize="9px" fontWeight="600" letterSpacing="0.06em">
                  {c.heldCount} held
                </Box>
              )}
              {unavail && (
                <Box bg="rgba(159,140,224,0.15)" color="var(--violet)" px="1.5" py="0.5" borderRadius="4px"
                  fontSize="9px" fontWeight="600" letterSpacing="0.06em">
                  No route
                </Box>
              )}
              <Text fontSize="10px" color="kk.textMuted">
                {c.totalCount} {c.totalCount === 1 ? "asset" : "assets"}
              </Text>
              {!unavail && c.providers.length > 0 && (
                <>
                  <Text fontSize="10px" color="kk.textMuted">·</Text>
                  <Flex align="center" gap="1">
                    <ProviderDots providers={c.providers} />
                    <Text fontSize="10px" color="kk.textSecondary">
                      {c.providers.length} {c.providers.length === 1 ? "router" : "routers"}
                    </Text>
                  </Flex>
                </>
              )}
              {unavail && (
                <Text fontSize="10px" color="var(--rose)">no provider routes here yet</Text>
              )}
            </Flex>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

// ── TO picker — asset list step ─────────────────────────────────────────────

function AssetStep({ entries, chainCaip2, fromChainId, excludeCaip, search, onSearchChange,
  onBack, onSelect, onUnavailable }: {
  entries: AssetEntry[]
  chainCaip2: string
  fromChainId: string | null
  excludeCaip: string | undefined
  search: string
  onSearchChange: (s: string) => void
  onBack: () => void
  onSelect: (e: AssetEntry) => void
  onUnavailable: (e: AssetEntry) => void
}) {
  const { t } = useTranslation("swap")
  const chainName = networkDisplayName(chainCaip2)
  const q = search.trim().toLowerCase()

  const inChain = useMemo(() => entries.filter(e => {
    if (e.chainId !== chainCaip2) return false
    if (e.caip === excludeCaip) return false
    if (q && !`${e.symbol} ${e.name}`.toLowerCase().includes(q)) return false
    return true
  }), [entries, chainCaip2, excludeCaip, q])

  // Collect all providers across routable assets in this chain (for banner)
  const allProviders = useMemo(() => {
    const s = new Set<string>()
    for (const e of inChain) if (isRowSelectable(e)) for (const p of e.availability.providers) s.add(p)
    return [...s]
  }, [inChain])

  // Bucket assets
  const buckets = useMemo(() => {
    const b: Record<string, AssetEntry[]> = { held: [], native: [], token: [] }
    for (const e of inChain) {
      if (e.balance) { b.held.push(e); continue }
      if (e.isNative) { b.native.push(e); continue }
      b.token.push(e)
    }
    // Sort tokens by provider count desc
    b.token.sort((a, bE) => bE.availability.providers.length - a.availability.providers.length)
    return b
  }, [inChain])

  return (
    <>
      {/* Breadcrumb */}
      <Flex align="center" gap="2" mx="5" mb="2.5" fontSize="11px" color="kk.textMuted" flexShrink={0}>
        <Box as="button" display="inline-flex" alignItems="center" gap="1"
          bg="transparent" border="none" cursor="pointer" color="kk.textSecondary"
          px="2" py="1" borderRadius="8px" fontFamily="inherit" fontSize="11px"
          _hover={{ color: "kk.textPrimary", bg: "rgba(255,255,255,0.05)" }}
          onClick={onBack}>
          <BackIcon /> Networks
        </Box>
        <Text color="kk.textMuted">/</Text>
        <Text color="kk.textPrimary" fontWeight="500">{chainName}</Text>
      </Flex>

      {/* Network switch banner */}
      {fromChainId && <NetSwitchBanner fromChainId={fromChainId} toChainId={chainCaip2} providers={allProviders} />}

      {/* Search */}
      <Flex align="center" gap="2" mx="5" mb="3" px="3" py="2.5"
        bg="rgba(255,255,255,0.04)" border="1px solid" borderColor="kk.border"
        borderRadius="12px" flexShrink={0}
        _focusWithin={{ borderColor: "rgba(255,255,255,0.16)" }}>
        <SearchIcon />
        <Input value={search} onChange={e => onSearchChange(e.target.value)}
          placeholder={t("searchAssetsOnChain", `Search assets on ${chainName}…`)}
          bg="transparent" border="none" color="kk.textPrimary" px="0" fontSize="12px"
          _focus={{ outline: "none", boxShadow: "none" }} autoFocus />
      </Flex>

      {/* Asset list */}
      <Box flex="1" overflowY="auto" px="5" pb="4">
        {inChain.length === 0 ? (
          <Flex direction="column" align="center" py="16" gap="2">
            <Text fontSize="14px" fontWeight="500" color="kk.textSecondary">No matching assets</Text>
            <Text fontSize="11px" color="kk.textMuted">No asset on {chainName} matches your search.</Text>
          </Flex>
        ) : (
          <>
            {buckets.held.length > 0 && (
              <AssetSection label={t("alreadyInWallet", "Already in your wallet")} count={buckets.held.length}>
                {buckets.held.map(e => <AssetListRow key={e.caip} entry={e} onSelect={onSelect} onUnavailable={onUnavailable} />)}
              </AssetSection>
            )}
            {buckets.native.length > 0 && (
              <AssetSection label={t("nativeAsset", "Native asset")} count={buckets.native.length}>
                {buckets.native.map(e => <AssetListRow key={e.caip} entry={e} onSelect={onSelect} onUnavailable={onUnavailable} />)}
              </AssetSection>
            )}
            {buckets.token.length > 0 && (
              <AssetSection label={t("tokens", "Tokens")} count={buckets.token.length}>
                {buckets.token.map(e => <AssetListRow key={e.caip} entry={e} onSelect={onSelect} onUnavailable={onUnavailable} />)}
              </AssetSection>
            )}
          </>
        )}
      </Box>
    </>
  )
}

function AssetSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <Box mt="4" _first={{ mt: "1" }}>
      <Flex align="center" gap="2.5" mb="2">
        <Text fontSize="9px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
          {label}
        </Text>
        <Text fontSize="9px" color="kk.textSecondary">· {count}</Text>
        <Box flex="1" h="1px" bg="rgba(255,255,255,0.06)" />
      </Flex>
      {children}
    </Box>
  )
}

function AssetListRow({ entry: e, onSelect, onUnavailable }: {
  entry: AssetEntry
  onSelect: (e: AssetEntry) => void
  onUnavailable: (e: AssetEntry) => void
}) {
  const selectable = isRowSelectable(e)
  const isTryQuote = e.availability.status === "unknown"

  return (
    <Box
      as="button" w="100%" textAlign="left" fontFamily="inherit"
      display="grid"
      gridTemplateColumns="40px 1fr auto"
      alignItems="center"
      gap="3" px="3.5" py="3"
      bg={e.balance ? "linear-gradient(180deg, rgba(139,227,196,0.04), rgba(255,255,255,0.02))" : "rgba(255,255,255,0.02)"}
      border="1px solid"
      borderColor={e.balance ? "rgba(139,227,196,0.25)" : "rgba(255,255,255,0.06)"}
      borderRadius="12px" mb="1.5"
      cursor={selectable ? "pointer" : "not-allowed"}
      opacity={selectable ? 1 : 0.5}
      color="kk.textPrimary"
      transition="all 0.12s"
      _hover={selectable ? { bg: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.10)" } : {}}
      onClick={() => selectable ? onSelect(e) : onUnavailable(e)}
    >
      <AssetIcon caip={e.caip} iconUrl={e.iconUrl} chainCaip={chainBadgeCaip(e)} size={36} alt={e.symbol} />

      <Box minW="0">
        <Flex align="center" gap="2">
          <Text fontSize="13px" fontWeight="600">{e.symbol}</Text>
          {e.balance && (
            <Box bg="rgba(139,227,196,0.12)" color="var(--teal)" px="1.5" py="0.5"
              borderRadius="4px" fontSize="9px" fontWeight="600" letterSpacing="0.04em">
              HELD {e.balance.amount}
            </Box>
          )}
          {!e.balance && isTryQuote && (
            <Box bg="rgba(233,196,106,0.10)" color="var(--gold)" px="1.5" py="0.5"
              borderRadius="4px" fontSize="9px" fontWeight="600" letterSpacing="0.04em">
              TRY QUOTE
            </Box>
          )}
          {!selectable && (
            <Box bg="rgba(255,255,255,0.04)" color="kk.textMuted" px="1.5" py="0.5"
              borderRadius="4px" fontSize="9px" fontWeight="600" letterSpacing="0.04em">
              UNAVAILABLE
            </Box>
          )}
        </Flex>
        <Text fontSize="10px" color="kk.textMuted" mt="0.5" isTruncated>{e.name}</Text>
      </Box>

      <Flex direction="column" align="flex-end" gap="1">
        <ProviderDots providers={e.availability.providers} />
        <Text fontSize="9px" color="kk.textMuted">
          {e.availability.providers.length} {e.availability.providers.length === 1 ? "route" : "routes"}
        </Text>
      </Flex>
    </Box>
  )
}

// ── Unavailable route view ──────────────────────────────────────────────────

function UnavailableRouteView({ fromChainId, target, entries, onBack, onAltSelect }: {
  fromChainId: string | null
  target: AssetEntry
  entries: AssetEntry[]
  onBack: () => void
  onAltSelect: (e: AssetEntry) => void
}) {
  const { t } = useTranslation("swap")
  const sym = target.symbol
  const fromChainName = fromChainId ? networkDisplayName(fromChainId) : "?"
  const targetChainName = networkDisplayName(target.chainId)

  const alternatives = useMemo(() =>
    entries.filter(e =>
      e.caip !== target.caip &&
      e.symbol === sym &&
      isRowSelectable(e)
    ).sort((a, b) => b.availability.providers.length - a.availability.providers.length),
    [entries, target, sym]
  )

  return (
    <>
      {/* Breadcrumb */}
      <Flex align="center" gap="2" mx="5" mb="2.5" fontSize="11px" color="kk.textMuted" flexShrink={0}>
        <Box as="button" display="inline-flex" alignItems="center" gap="1"
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
          <Text fontSize="18px" fontWeight="500" letterSpacing="-0.01em" color="kk.textPrimary">
            {fromChainId ? `${sym} (${fromChainName}) → ${target.symbol} (${targetChainName})` : `${target.symbol} (${targetChainName})`}
          </Text>
          <Text fontSize="12px" color="kk.textSecondary" lineHeight="1.6" maxW="460px">
            No swap provider currently routes to{" "}
            <Text as="strong" color="kk.textPrimary">{sym} on {targetChainName}</Text>.{" "}
            {target.availability.status === "unsupported_token"
              ? `${targetChainName} natives swap fine, but this specific token isn't on any provider's list yet.`
              : `${targetChainName} isn't supported by any of our routers yet (THORChain, Mayachain, Relay, 0x, ChainFlip).`}
          </Text>
          <Flex gap="2.5" mt="2">
            <Box as="button" display="inline-flex" alignItems="center" gap="1.5"
              px="3.5" py="2" bg="rgba(233,196,106,0.10)" border="1px solid rgba(233,196,106,0.30)"
              borderRadius="10px" color="var(--gold)" fontFamily="inherit" fontSize="11px" fontWeight="600"
              cursor="pointer" _hover={{ bg: "rgba(233,196,106,0.18)" }}>
              <BellIcon /> {t("notifyWhenSupported", "Notify me when supported")}
            </Box>
          </Flex>
        </Flex>

        {/* Alternatives */}
        {alternatives.length > 0 ? (
          <Box>
            <Flex align="center" gap="2" mb="2.5">
              <Text fontSize="10px" color="var(--gold)">◆</Text>
              <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
                {t("swapToOnOtherChain", `You can swap to ${sym} on another network`)}
              </Text>
            </Flex>
            <Flex direction="column" gap="1.5">
              {alternatives.map(a => {
                const chainName = networkDisplayName(a.chainId)
                return (
                  <Box key={a.caip} as="button" w="100%" textAlign="left" fontFamily="inherit"
                    display="grid" gridTemplateColumns="40px 1fr auto auto"
                    gap="3" alignItems="center"
                    px="3.5" py="3"
                    bg="rgba(255,255,255,0.02)" border="1px solid rgba(255,255,255,0.06)"
                    borderRadius="12px" cursor="pointer" color="kk.textPrimary"
                    transition="all 0.15s"
                    _hover={{ bg: "rgba(255,255,255,0.05)", borderColor: "rgba(233,196,106,0.30)", transform: "translateX(2px)" }}
                    onClick={() => onAltSelect(a)}>
                    <AssetIcon caip={a.caip} iconUrl={a.iconUrl} chainCaip={chainBadgeCaip(a)} size={32} alt={a.symbol} />
                    <Box>
                      <Flex align="center" gap="2">
                        <Text fontSize="13px" fontWeight="600">{a.symbol}</Text>
                        {a.balance && (
                          <Box bg="rgba(139,227,196,0.12)" color="var(--teal)" px="1.5" py="0.5"
                            borderRadius="4px" fontSize="9px" fontWeight="600">HELD</Box>
                        )}
                      </Flex>
                      <Text fontSize="10px" color="kk.textMuted" mt="0.5">{a.name} · on {chainName}</Text>
                    </Box>
                    <Flex align="center" gap="1.5" px="2.5" py="1"
                      bg="rgba(139,227,196,0.08)" border="1px solid rgba(139,227,196,0.25)"
                      borderRadius="999px" fontSize="10px" color="var(--teal)" fontWeight="600">
                      <ProviderDots providers={a.availability.providers} />
                      {a.availability.providers.length} {a.availability.providers.length === 1 ? "route" : "routes"}
                    </Flex>
                    <Box color="kk.textMuted" transition="all 0.15s"
                      _groupHover={{ color: "var(--gold)", transform: "translateX(2px)" }}>
                      <ArrowRight size={14} />
                    </Box>
                  </Box>
                )
              })}
            </Flex>
          </Box>
        ) : (
          <Box>
            <Flex align="center" gap="2" mb="2.5">
              <Text fontSize="10px" color="kk.textMuted">◇</Text>
              <Text fontSize="10px" color="kk.textMuted" letterSpacing="0.12em" textTransform="uppercase">
                No alternative routes for {sym}
              </Text>
            </Flex>
            <Box p="4" bg="rgba(255,255,255,0.03)" border="1px dashed rgba(255,255,255,0.08)"
              borderRadius="12px" fontSize="11px" color="kk.textSecondary" lineHeight="1.6">
              No other supported network lists {sym}. Try a different destination asset, or enable notifications above.
            </Box>
          </Box>
        )}
      </Box>

      {/* Footer */}
      <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border"
        justify="space-between" align="center" flexShrink={0}>
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

// ── Props ───────────────────────────────────────────────────────────────────

interface AssetPickerDialogProps {
  open: boolean
  onClose: () => void
  swappable: SwapAsset[]
  balances: ChainBalance[]
  customTokens?: CustomToken[]
  excludeCaip?: string
  onSelect: (asset: SwapAsset) => void
  side: "from" | "to"
}

// ── Main component ──────────────────────────────────────────────────────────

export function AssetPickerDialog({
  open, onClose, swappable, balances, customTokens, excludeCaip, onSelect, side,
}: AssetPickerDialogProps) {
  const { fmtCompact } = useFiat()
  const { t } = useTranslation("swap")

  // Shared
  const [entries, setEntries] = useState<AssetEntry[] | null>(null)
  const [loading, setLoading]  = useState(false)

  // TO-specific navigation
  const [toChain, setToChain]         = useState<string | null>(null)
  const [unavailEntry, setUnavailEntry] = useState<AssetEntry | null>(null)
  const [search, setSearch]           = useState("")

  // FROM: EVM contract paste
  const [contractHits, setContractHits]   = useState<SwapAsset[] | null>(null)
  const [contractLooking, setContractLooking] = useState(false)
  const [contractError, setContractError] = useState<string | null>(null)

  // Extract FROM chain from excludeCaip (when side=to, excludeCaip is the FROM asset)
  const fromChainId = side === "to" && excludeCaip ? excludeCaip.split("/")[0] : null

  // Build entries on open
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    buildAssetEntries({ swappable, balances, customTokens })
      .then(list => { if (!cancelled) { setEntries(list); setLoading(false) } })
      .catch(e => {
        if (cancelled) return
        console.error("[AssetPickerDialog] buildAssetEntries failed:", e)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, swappable, balances, customTokens])

  // Reset state on open/close
  useEffect(() => {
    if (!open) { setToChain(null); setUnavailEntry(null); setSearch(""); return }
    setToChain(null); setUnavailEntry(null); setSearch("")
  }, [open])

  // Escape closes
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose() } }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  // EVM contract lookup (FROM side only)
  useEffect(() => {
    setContractHits(null); setContractError(null)
    if (!open || side !== "from") return
    const q = search.trim()
    if (!EVM_CONTRACT_RE.test(q)) return
    let cancelled = false
    setContractLooking(true)
    const timer = setTimeout(() => {
      rpcRequest<{ hits: SwapAsset[]; reason?: string }>("lookupTokenContract", { contractAddress: q }, 12000)
        .then(res => {
          if (cancelled) return
          setContractLooking(false)
          if (res.hits?.length > 0) setContractHits(res.hits)
          else setContractError(res.reason || "no-token-found")
        })
        .catch(e => {
          if (cancelled) return
          setContractLooking(false)
          setContractError(e?.message || "lookup-failed")
        })
    }, 350)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, side, search])

  // Chain infos for TO chain step
  const chainInfos = useMemo(() => {
    if (!entries) return []
    return buildChainInfos(entries, fromChainId, excludeCaip)
  }, [entries, fromChainId, excludeCaip])

  const handleSelect = useCallback((entry: AssetEntry) => {
    if (!isRowSelectable(entry)) return
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

  // Title depends on side + TO step
  let title = side === "from"
    ? t("selectFromAsset", "Select asset to swap from")
    : toChain
      ? t("selectToAsset", "Select asset to swap to")
      : t("chooseNetwork", "Choose destination network")

  let stepLabel = side === "from"
    ? t("stepOne", "Step 1 of 2 — Pick what you're swapping")
    : toChain
      ? t("stepTwoAsset", `Step 2 of 2 — Pick an asset on ${networkDisplayName(toChain)}`)
      : t("stepTwoChain", "Step 2 of 2 — Choose destination network")

  // Footer text for TO side
  const toFooter = toChain
    ? `${entries?.filter(e => e.chainId === toChain).length ?? 0} assets on ${networkDisplayName(toChain)}`
    : `${chainInfos.length} networks · ${swappable.length.toLocaleString()} swappable assets`

  return (
    <Box
      position="fixed" inset="0" zIndex={Z.assetPicker}
      display="flex" alignItems="center" justifyContent="center"
      onClick={onClose}
    >
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box
        position="relative"
        bg="#101015"
        border="1px solid rgba(255,255,255,0.10)"
        borderRadius="22px"
        boxShadow="0 1px 0 rgba(255,255,255,0.05) inset, 0 18px 60px -18px rgba(0,0,0,0.9)"
        w="660px" maxW="94vw" h="680px" maxH="90vh"
        display="flex" flexDirection="column"
        overflow="hidden"
        fontFamily="'Geist Mono', ui-monospace, monospace"
        onClick={(e) => e.stopPropagation()}
        _before={{
          content: '""', position: "absolute", inset: "0",
          bg: "radial-gradient(800px 400px at 50% -10%, rgba(233,196,106,0.04), transparent 60%)",
          pointerEvents: "none",
        }}
      >
        {/* Header */}
        <Flex align="center" justify="space-between" px="5" pt="4.5" pb="3.5" flexShrink={0}
          position="relative" zIndex={1}>
          <Box>
            <Text fontSize="10px" letterSpacing="0.12em" textTransform="uppercase"
              color="kk.textMuted" mb="1">{stepLabel}</Text>
            <Text fontSize="16px" fontWeight="600" letterSpacing="-0.01em" color="kk.textPrimary">
              {unavailEntry ? t("routeUnavailable", "That route isn't available — yet") : title}
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
        <Box flex="1" minH="0" display="flex" flexDirection="column" position="relative" zIndex={1}>
          {loading ? (
            <Flex flex="1" align="center" justify="center">
              <Text fontSize="12px" color="kk.textMuted">{t("loading", "Loading…")}</Text>
            </Flex>
          ) : !entries ? null
          : side === "from" ? (
            <FromPicker entries={entries} onSelect={handleSelect} fmtCompact={fmtCompact} />
          ) : unavailEntry ? (
            <UnavailableRouteView
              fromChainId={fromChainId}
              target={unavailEntry}
              entries={entries}
              onBack={() => setUnavailEntry(null)}
              onAltSelect={(e) => { setUnavailEntry(null); handleSelect(e) }}
            />
          ) : toChain ? (
            <>
              <AssetStep
                entries={entries}
                chainCaip2={toChain}
                fromChainId={fromChainId}
                excludeCaip={excludeCaip}
                search={search}
                onSearchChange={setSearch}
                onBack={() => { setToChain(null); setSearch("") }}
                onSelect={handleSelect}
                onUnavailable={setUnavailEntry}
              />
              {/* Footer for asset step */}
              <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border"
                justify="space-between" align="center" flexShrink={0} bg="#101015">
                <Text fontSize="10px" color="kk.textMuted">{toFooter}</Text>
                <Text fontSize="10px" color="kk.textMuted">Chain → Token</Text>
              </Flex>
            </>
          ) : (
            <>
              <ChainStep
                chainInfos={chainInfos}
                fromChainId={fromChainId}
                search={search}
                onSearchChange={setSearch}
                onPickChain={(caip2) => { setToChain(caip2); setSearch("") }}
              />
              {/* Footer for chain step */}
              <Flex px="5" py="2.5" borderTop="1px solid" borderColor="kk.border"
                justify="space-between" align="center" flexShrink={0} bg="#101015">
                <Text fontSize="10px" color="kk.textMuted">{toFooter}</Text>
                <Text fontSize="10px" color="kk.textMuted">Pick a network to continue</Text>
              </Flex>
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}
