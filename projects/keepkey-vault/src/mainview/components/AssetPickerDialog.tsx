import { useUiTranslation } from "../i18n/ui"
/**
 * Asset picker on the preflight console (roadmap P2).
 *
 * One surface, a flat list with hairlines, official logos without a disc (a
 * token wears its network's badge), amounts right-aligned, search on top,
 * colour only from logos and the six provider dots. CAIP ids live in each
 * row's tooltip and under "Technical details" on the confirm step.
 *
 * FROM: the assets this KeepKey holds, ranked by value.
 * TO:   step 1 picks the network (never pre-filled: picking the network is the
 *       defence against a token named after another chain), step 2 the asset
 *       on it ("Your assets", then "All").
 * Every pick then goes through the confirm step: network, native/token, routes.
 *
 * Keyboard: ↓ from the search box into the list, ↑/↓/Home/End between rows,
 * Enter picks, Esc closes.
 */
import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Spinner } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { swapPickerConfirmLabel, swapPickerHeading } from "../lib/swap-copy"
import { AssetIcon } from "./AssetIcon"
import { PreflightStyles } from "./preflight/PreflightConsole"
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
  searchPickerNetworks,
  type AssetEntry,
} from "../../shared/swap-discovery"
import { rpcRequest } from "../lib/rpc"
import { useDeviceState } from "../hooks/useDeviceState"
import { Z } from "../lib/z-index"
import { useFiat } from "../lib/fiat-context"
import { isSymbolSquatter } from "../../shared/symbolSquatter"
import { formatBalance } from "../lib/formatting"

const PAGE_SIZE = 40

const PICKER_CSS = `
.kk-ap-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(11,11,14,.72); backdrop-filter: blur(20px) saturate(140%); }
.kk-ap { position: relative; display: flex; flex-direction: column; width: min(720px, 100%); min-height: min(440px, calc(100vh - 32px)); max-height: min(680px, calc(100vh - 32px)); border-radius: 18px; overflow: hidden;
  color: var(--text-0); font-family: var(--font-ui-sans); background-color: #0b0b0e;
  background-image: radial-gradient(120% 80% at 0% 0%, rgba(233,196,106,.10), transparent 55%), radial-gradient(90% 70% at 100% 100%, rgba(98,126,234,.07), transparent 60%);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.06), 0 30px 80px -30px rgba(0,0,0,.8); }
.kk-ap-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 20px 24px 12px; flex: none; }
.kk-ap-head h2 { margin: 6px 0 0; font-size: 20px; font-weight: 600; letter-spacing: -.01em; line-height: 1.2; }
.kk-ap-x { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); cursor: pointer; display: grid; place-items: center; flex: none; }
.kk-ap-x:hover { color: var(--text-0); background: rgba(255,255,255,.05); }
.kk-ap-x:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
.kk-ap-bar { display: flex; align-items: center; gap: 10px; margin: 0 24px 6px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,.12); flex: none; color: var(--text-2); }
.kk-ap-bar:focus-within { border-bottom-color: var(--gold); }
.kk-ap-bar input { flex: 1; min-width: 0; background: transparent; border: 0; outline: none; color: var(--text-0); font-size: 14px; font-family: inherit; padding: 0; }
.kk-ap-bar button { background: none; border: 0; color: var(--text-2); cursor: pointer; padding: 0; line-height: 0; }
.kk-ap-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 4px 24px 4px; flex: none; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.kk-ap-tools .kk-pf-modes { flex-wrap: wrap; gap: 4px 14px; }
.kk-ap-crumb { display: flex; align-items: center; gap: 8px; margin: 0 24px 8px; flex: none; font-size: 12px; color: var(--text-2); }
.kk-ap-crumb button { background: none; border: 0; padding: 0; color: var(--gold); cursor: pointer; font: inherit; }
.kk-ap-note { margin: 0 24px 6px; flex: none; font-size: 12px; color: var(--text-2); }
.kk-ap-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 24px 12px; display: flex; flex-direction: column; }
.kk-ap-body > * { flex: none; }
.kk-ap-sec { display: flex; align-items: baseline; gap: 8px; margin: 14px 0 2px; font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .22em; text-transform: uppercase; color: var(--text-2); }
.kk-ap-sec:first-child { margin-top: 6px; }
.kk-ap-sec span { letter-spacing: 0; color: var(--text-3); }
.kk-ap-list { list-style: none; margin: 0; padding: 0; }
.kk-ap-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; gap: 14px; align-items: center; width: calc(100% + 16px); margin: 0 -8px; padding: 10px 8px;
  background: transparent; border: 0; border-top: 1px solid rgba(255,255,255,.06); border-radius: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.kk-ap-list > li:first-child > .kk-ap-row { border-top: 0; }
.kk-ap-row:hover, .kk-ap-row:focus-visible { background: rgba(255,255,255,.04); outline: none; }
.kk-ap-row:focus-visible { box-shadow: inset 2px 0 0 var(--gold); }
.kk-ap-row[aria-disabled="true"] { opacity: .5; }
.kk-ap-main { min-width: 0; }
.kk-ap-main b { font-size: 14px; font-weight: 600; }
.kk-ap-main small { display: block; font-size: 12px; color: var(--text-2); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kk-ap-tag { margin-left: 8px; font-family: var(--font-mono); font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-2); }
.kk-ap-tag.kk-ap-warn { color: var(--rose); }
.kk-ap-right { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 13px; white-space: nowrap; }
.kk-ap-right small { display: block; font-size: 11px; color: var(--text-2); margin-top: 2px; }
.kk-ap-dots { display: inline-flex; gap: 4px; align-items: center; vertical-align: middle; }
.kk-ap-dots i { width: 6px; height: 6px; border-radius: 50%; }
.kk-ap-foot { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 24px 18px; box-shadow: 0 -1px 0 rgba(255,255,255,.06); font-size: 11px; color: var(--text-2); }
.kk-ap-foot .kk-pf-actions { flex: 1; margin-top: 0; }
.kk-ap-foot .kk-pf-link { font-size: 11px; }
.kk-ap-empty { margin: auto 0; padding: 32px 0; text-align: center; color: var(--text-2); font-size: 13px; }
.kk-ap-empty b { display: block; color: var(--text-1); font-size: 14px; font-weight: 500; margin-bottom: 4px; }
.kk-ap-hero { display: flex; align-items: center; gap: 16px; padding: 8px 0 16px; }
.kk-ap-hero b { display: block; font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
.kk-ap-hero small { display: block; font-size: 13px; color: var(--text-2); margin-top: 2px; }
@media (max-height: 820px) { .kk-ap-head { padding: 16px 22px 10px; } .kk-ap-row { padding: 8px 8px; } .kk-ap-foot { padding: 10px 22px 14px; } .kk-ap-bar, .kk-ap-tools, .kk-ap-crumb, .kk-ap-note { margin-left: 22px; margin-right: 22px; } .kk-ap-body { padding: 0 22px 10px; } }
`

// ── icons ──────────────────────────────────────────────────────────────────

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>
  </svg>
)
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12"/>
  </svg>
)

// ── selectability ───────────────────────────────────────────────────────────

function isRowSelectable(entry: AssetEntry): boolean {
  const s = entry.availability.status
  if (s !== "swappable" && s !== "unknown") return false
  return chainMetaForCaip2(entry.chainId) !== null
}

// ── provider dots — the only colours besides logos ─────────────────────────

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
    <span className="kk-ap-dots" title={providers.join(", ")} aria-label={providers.join(", ")}>
      {providers.slice(0, 4).map(p => <i key={p} style={{ background: PROVIDER_COLORS[p] ?? "#888" }} />)}
      {providers.length > 4 && <i style={{ background: "rgba(255,255,255,0.2)" }} />}
    </span>
  )
}

/** A token wears its network's logo in the corner; a native coin is its network's own. */
function chainBadgeCaip(entry: AssetEntry): string | undefined {
  if (entry.isNative) return undefined
  return chainMetaForCaip2(entry.chainId)?.nativeCaip
}

// ── list pieces ─────────────────────────────────────────────────────────────

/** ↑/↓/Home/End move between the rows of the list this handler sits on. */
function moveBetweenRows(event: ReactKeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"]
  if (!keys.includes(event.key)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(".kk-ap-row")]
  if (!rows.length) return
  event.preventDefault()
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
    : event.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1)
  rows[next]?.focus()
  rows[next]?.scrollIntoView?.({ block: "nearest" })
}

function SearchBar({ value, onChange, placeholder, autoFocus, listRef }: {
  value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean
  /** ↓ from the box focuses the first row of this list. */
  listRef?: React.RefObject<HTMLDivElement | null>
}) {
  const uiText = useUiTranslation()
  return (
    <label className="kk-ap-bar">
      <SearchIcon />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoFocus={autoFocus}
        onKeyDown={e => {
          if (e.key !== "ArrowDown") return
          const first = listRef?.current?.querySelector<HTMLElement>(".kk-ap-row")
          if (first) { e.preventDefault(); first.focus() }
        }} />
      {value && <button type="button" aria-label={uiText("Clear")} onClick={() => onChange("")}><CloseIcon /></button>}
    </label>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <>
    <div className="kk-ap-sec">{title}{count !== undefined && <span>{count}</span>}</div>
    <ul className="kk-ap-list">{children}</ul>
  </>
}

function PickRow({ icon, title, tags, sub, right, onClick, disabled, tooltip, attrs }: {
  icon: ReactNode; title: ReactNode; tags?: ReactNode; sub?: ReactNode; right?: ReactNode
  onClick: () => void; disabled?: boolean; tooltip?: string; attrs?: Record<string, string>
}) {
  return (
    <li>
      <button type="button" className="kk-ap-row" aria-disabled={disabled || undefined} title={tooltip} onClick={onClick} data-picker-row {...attrs}>
        <span style={{ display: "grid", placeItems: "center" }}>{icon}</span>
        <span className="kk-ap-main"><b>{title}</b>{tags}{sub && <small>{sub}</small>}</span>
        <span className="kk-ap-right">{right}</span>
      </button>
    </li>
  )
}

function Empty({ title, hint }: { title: string; hint?: string }) {
  return <div className="kk-ap-empty"><b>{title}</b>{hint}</div>
}

function NetworkIcon({ caip, name, size = 32 }: { caip?: string; name: string; size?: number }) {
  return caip ? <AssetIcon caip={caip} size={size} alt={name} bare /> : <span style={{ width: size, height: size }} />
}

// ══════════════════════════════════════════════════════════════════════════
// FROM — the assets this KeepKey holds, ranked by value
// ══════════════════════════════════════════════════════════════════════════

function FromPicker({ entries, onSelect, fmtCompact, privateModeEnabled, balancesLoading }: {
  entries: AssetEntry[]; onSelect: (e: AssetEntry) => void; fmtCompact: (v: number) => string; privateModeEnabled: boolean; balancesLoading: boolean
}) {
  const uiText = useUiTranslation()
  const { t } = useTranslation("swap")
  const [search, setSearch] = useState("")
  const [chainFilter, setChainFilter] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const held = useMemo(
    () => entries.filter(e => e.balance).sort((a, b) => (b.balance!.usd) - (a.balance!.usd)),
    [entries]
  )
  // One filter per network in the held list, the networks holding the most value first.
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
    return list.filter(e => `${e.symbol} ${e.name} ${networkDisplayName(e.chainId)}`.toLowerCase().includes(q))
  }, [held, search, chainFilter])
  const totalUsd = held.reduce((s, e) => s + (e.balance?.usd ?? 0), 0)
  const money = (v: number) => privateModeEnabled ? "••••••" : fmtCompact(v)

  return (
    <>
      <SearchBar value={search} onChange={setSearch} placeholder={t("filterHeld", "Filter by symbol, name or network…")} autoFocus listRef={listRef} />
      {chains.length > 1 && (
        <div className="kk-ap-tools">
          <div className="kk-pf-modes" role="group" aria-label={uiText("Network")}>
            <button type="button" aria-pressed={chainFilter === null} onClick={() => setChainFilter(null)}>{uiText("All")}</button>
            {chains.map(c => <button key={c.chainId} type="button" aria-pressed={chainFilter === c.chainId}
              onClick={() => setChainFilter(prev => prev === c.chainId ? null : c.chainId)}>{networkDisplayName(c.chainId)}</button>)}
          </div>
        </div>
      )}
      <div className="kk-ap-body" ref={listRef} onKeyDown={moveBetweenRows}>
        {balancesLoading && held.length === 0 && !search ? (
          <div className="kk-ap-empty"><Spinner size="sm" color="var(--gold)" /><b style={{ marginTop: 12 }}>{t("loadingAssets", "Loading assets...")}</b>{t("loadingBalances", "Checking your KeepKey balances...")}</div>
        ) : filtered.length === 0 ? (
          <Empty title={search ? uiText("No held assets match") : t("emptyWalletTitle", "Your KeepKey is empty")}
            hint={search ? uiText("Try a different search term.") : t("emptyWalletSub", "Send some assets to your wallet first, then come back to swap.")} />
        ) : (
          <Section title={uiText("Your assets")} count={filtered.length}>
            {filtered.map(e => <AssetRow key={e.caip} entry={e} onSelect={onSelect} onUnavailable={() => {}} money={money} />)}
          </Section>
        )}
      </div>
      <div className="kk-ap-foot">
        <span>{uiText("Available to swap")} <b style={{ color: "var(--text-0)", fontFamily: "var(--font-mono)" }}>{totalUsd > 0 ? money(totalUsd) : "—"}</b></span>
        <span>{held.length}{" "}{uiText("assets ·")}{" "}{new Set(held.map(e => e.chainId)).size}{" "}{uiText("chains")}</span>
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// TO — step 1: the network
// ══════════════════════════════════════════════════════════════════════════

interface ChainInfo {
  caip2: string
  name: string
  family: string
  nativeCaip: string | undefined
  totalCount: number
  routableCount: number
  providers: string[]
  isAvailable: boolean
  /** A provider routes this chain, but the device's firmware can't sign/derive
   *  it — distinguishes "update firmware" from "no route at all". */
  firmwareGated: boolean
}

function chainFamilyLabel(family: string): string {
  const map: Record<string, string> = {
    evm: "EVM", utxo: "UTXO", cosmos: "Cosmos",
    solana: "SOL", xrp: "XRP", tron: "TRX",
    ton: "TON", "zcash-shielded": "ZEC",
  }
  return map[family] ?? family.toUpperCase()
}

function buildChainInfos(entries: AssetEntry[], excludeCaip: string | undefined): ChainInfo[] {
  const chainIds = new Set(entries.map(e => e.chainId))
  return [...chainIds].map(caip2 => {
    const meta = chainMetaForCaip2(caip2)
    const assetsInChain = entries.filter(e => e.chainId === caip2 && e.caip !== excludeCaip)
    const routableInChain = assetsInChain.filter(e => isRowSelectable(e))
    const providers = new Set<string>()
    for (const e of routableInChain) for (const p of e.availability.providers) providers.add(p)
    return {
      caip2,
      name: networkDisplayName(caip2),
      family: chainFamilyLabel(meta?.chainFamily ?? ""),
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
  const uiText = useUiTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const q = search.trim().toLowerCase()
  // Networks match on name, family or coin ticker; tokens are listed for any query.
  const { chains: matchedChains, assets: matchedAssets } = useMemo(
    () => searchPickerNetworks(chainInfos, entries, q, excludeCaip), [chainInfos, entries, q, excludeCaip])
  const available   = matchedChains.filter(c => c.isAvailable)
  const unavailable = matchedChains.filter(c => !c.isAvailable)
  const noNetworkMatches = q.length > 0 && available.length === 0 && unavailable.length === 0
  const tokenFallback = useMemo(() => {
    return [...matchedAssets]
      .sort((a, b) => {
        const aSel = isRowSelectable(a) ? 1 : 0
        const bSel = isRowSelectable(b) ? 1 : 0
        if (aSel !== bSel) return bSel - aSel
        return (b.balance?.usd ?? 0) - (a.balance?.usd ?? 0)
      })
      .slice(0, 30)
  }, [matchedAssets])
  const networkRow = (c: ChainInfo, unavail: boolean) => (
    <PickRow key={c.caip2} icon={<NetworkIcon caip={c.nativeCaip} name={c.name} />} title={c.name} tooltip={c.caip2}
      sub={unavail ? c.family : `${c.family} · ${uiText("{{count}} swappable", { count: c.routableCount })}`}
      right={unavail ? <span style={{ fontFamily: "var(--font-ui-sans)", fontSize: 12, color: "var(--text-2)" }}>{c.firmwareGated ? uiText("Update firmware") : uiText("No route")}</span> : <ProviderDots providers={c.providers} />}
      disabled={unavail} onClick={() => !unavail && onPickChain(c.caip2)} attrs={{ "data-network": c.caip2 }} />
  )

  return (
    <>
      <SearchBar value={search} onChange={onSearchChange} placeholder={uiText("Search networks or tokens…")} autoFocus listRef={listRef} />
      <div className="kk-ap-body" ref={listRef} onKeyDown={moveBetweenRows}>
        {available.length > 0 && <Section title={uiText("Supported networks")} count={available.length}>{available.map(c => networkRow(c, false))}</Section>}
        {unavailable.length > 0 && <Section title={uiText("Not currently routable")} count={unavailable.length}>{unavailable.map(c => networkRow(c, true))}</Section>}
        {tokenFallback.length > 0 && (
          <Section title={uiText("Token results")} count={tokenFallback.length}>
            {tokenFallback.map(e => <AssetRow key={e.caip} entry={e} onSelect={onSelectAsset} onUnavailable={onUnavailAsset} />)}
          </Section>
        )}
        {noNetworkMatches && tokenFallback.length === 0 && <Empty title={uiText("No matching networks or tokens")} hint={uiText("Try a different search term.")} />}
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// TO — step 2: the asset on that network
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
  const uiText = useUiTranslation()
  const listRef = useRef<HTMLDivElement>(null)
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
    const timer = setTimeout(async () => {
      setDiscoveryLoading(true)
      try {
        const hits = await rpcRequest<SwapAsset[]>('searchSwapAssets', { query: q })
        // Convert SwapAsset → AssetEntry using caip-derived chainId (CAIP-2)
        const found: AssetEntry[] = (hits ?? []).flatMap(a => {
          if (!a.caip) return []
          const caip2 = a.caip.split('/')[0]
          if (!caip2) return []
          return [{
            caip: a.caip, symbol: a.symbol, name: a.name, chainId: caip2, decimals: a.decimals,
            iconUrl: a.icon, isNative: !a.contractAddress, availability: assessWithFirmware(a.caip, firmwareVersion),
          }]
        })
        setDiscoveryHits(found)
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
      // Contract/mint match: the real contract parsed out of the CAIP.
      // base58 is case-sensitive on TRON/Solana, so match case-insensitively.
      const contract = (parseCaip(e.caip).contractAddress || '').toLowerCase()
      if (!text.includes(q) && !caipLower.includes(q) && !contract.includes(q)) return false
    }
    return true
  // Sort: held → stablecoins → native → popularity (catalog rank) → junk → unsupported.
  }).sort(compareForPicker), [entries, chainCaip2, excludeCaip, q])
  const yours = useMemo(() => inChain.filter(e => e.balance), [inChain])
  const rest = useMemo(() => inChain.filter(e => !e.balance), [inChain])

  // Every provider routing an asset here (for the crossing line).
  const allProviders = useMemo(() => {
    const s = new Set<string>()
    for (const e of inChain) if (isRowSelectable(e)) for (const p of e.availability.providers) s.add(p)
    return [...s]
  }, [inChain])

  const totalPages = Math.ceil(rest.length / PAGE_SIZE)
  const pageItems  = rest.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // ── Paste-a-contract lane ───────────────────────────────────────────────
  // When the query is an address with no catalog match, resolve it on-chain
  // (EVM eth_call / Solana RPC + Jupiter) and offer "Add & select".
  const [contractHit, setContractHit] = useState<SwapAsset | null>(null)
  // The address a lookup completed for — "still resolving" vs "resolved, nothing found",
  // so the empty state never flashes before the lookup.
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
        // Only a hit on the network being browsed (never silently switch the
        // destination's chain), and never the source asset itself (self-swap).
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
    // Defense in depth: never add+select the source asset (self-swap guard).
    if (!hit.caip || hit.caip.toLowerCase() === (excludeCaip ?? '').toLowerCase()) return
    const entry: AssetEntry = {
      caip: hit.caip, symbol: hit.symbol, name: hit.name, chainId: hit.caip.split('/')[0], decimals: hit.decimals,
      iconUrl: hit.icon, isNative: !hit.contractAddress, swappable: hit, availability: assessWithFirmware(hit.caip, firmwareVersion),
    }
    // The same gate as every row: an unswappable pasted token goes to the unavailable view.
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

  const fromName = fromChainId ? networkDisplayName(fromChainId) : null
  const same = fromChainId === chainCaip2
  return (
    <>
      <div className="kk-ap-crumb">
        <button type="button" onClick={onBack}>← {uiText("Networks")}</button>
        <span>/</span>
        <span style={{ color: "var(--text-0)" }}>{chainName}</span>
      </div>
      {fromName && (
        <p className="kk-ap-note" data-crossing>
          {same ? uiText("Same-network swap · settles in seconds")
            : <>{uiText("Crossing")}{" "}<b style={{ color: "var(--text-1)" }}>{fromName}</b> → <b style={{ color: "var(--text-1)" }}>{chainName}</b></>}
          {allProviders.length > 0 && <>{" · "}{uiText("via")}{" "}<ProviderDots providers={allProviders} /></>}
        </p>
      )}
      <SearchBar value={search} onChange={onSearchChange} placeholder={`Search assets on ${chainName}…`} autoFocus listRef={listRef} />
      <div className="kk-ap-body" ref={listRef} onKeyDown={moveBetweenRows}>
        {inChain.length > 0 ? <>
          {yours.length > 0 && page === 0 && <Section title={uiText("Your assets")} count={yours.length}>
            {yours.map(e => <AssetRow key={e.caip} entry={e} onSelect={onSelect} onUnavailable={onUnavailable} />)}
          </Section>}
          {pageItems.length > 0 && <Section title={uiText("All")} count={rest.length}>
            {pageItems.map(e => <AssetRow key={e.caip} entry={e} onSelect={onSelect} onUnavailable={onUnavailable} />)}
          </Section>}
        </> : addrQuery ? (
          // Pasted-address lane: resolving until the lookup for THIS address completes.
          contractHit ? (
            <Section title={uiText("Found via contract address")}>
              <PickRow icon={<AssetIcon caip={contractHit.caip!} iconUrl={contractHit.icon} chainCaip={contractHit.contractAddress ? chainMetaForCaip2(contractHit.caip!.split("/")[0])?.nativeCaip : undefined} size={32} alt={contractHit.symbol} bare />}
                title={contractHit.symbol} tooltip={contractHit.caip} sub={`${contractHit.name} · ${contractHit.decimals} ${uiText("decimals")}`}
                right={<span className="kk-pf-link" style={{ fontFamily: "var(--font-ui-sans)" }}>{adding ? uiText("Adding…") : uiText("Add & select")}</span>}
                onClick={() => !adding && handleAddAndSelect(contractHit)} />
            </Section>
          ) : searchedAddr === addrQuery ? (
            <Empty title={uiText("No token at that address")} hint={uiText("Double-check the contract / mint address.")} />
          ) : (
            <div className="kk-ap-empty"><Spinner size="sm" color="var(--gold)" /><b style={{ marginTop: 12 }}>{uiText("Looking up token…")}</b>{uiText("Resolving the address on")}{" "}{chainName}</div>
          )
        ) : discoveryHits.length > 0 ? (
          <Section title={uiText("Other networks — will cross-chain swap")} count={discoveryHits.length}>
            {discoveryHits.map(e => <AssetRow key={e.caip} entry={e} onSelect={onSelect} onUnavailable={onUnavailable} />)}
          </Section>
        ) : discoveryLoading ? (
          <Empty title={uiText("Searching all networks…")} />
        ) : (
          <Empty title={uiText("No assets found")} hint={uiText("Try a different search term.")} />
        )}
      </div>
      <div className="kk-ap-foot">
        <span>{inChain.length}{" "}{uiText("asset")}{inChain.length !== 1 ? "s" : ""}{" "}{uiText("on")}{" "}{chainName}{totalPages > 1 && ` · ${page + 1}/${totalPages}`}</span>
        {totalPages > 1 && <span style={{ display: "flex", gap: 16 }}>
          <button type="button" className="kk-pf-link" disabled={page === 0} style={{ opacity: page === 0 ? .4 : 1 }} onClick={() => page > 0 && setPage(p => p - 1)}>{uiText("← Prev")}</button>
          <button type="button" className="kk-pf-link" disabled={page >= totalPages - 1} style={{ opacity: page >= totalPages - 1 ? .4 : 1 }} onClick={() => page < totalPages - 1 && setPage(p => p + 1)}>{uiText("Next →")}</button>
        </span>}
      </div>
    </>
  )
}

/** One asset: official logo (a token wears its network's badge), symbol and
 *  what it is, then its amount and value — or its routes — on the right. */
function AssetRow({ entry: e, onSelect, onUnavailable, money }: {
  entry: AssetEntry
  onSelect: (e: AssetEntry) => void
  onUnavailable: (e: AssetEntry) => void
  money?: (v: number) => string
}) {
  const uiText = useUiTranslation()
  const { fmtCompact, privateModeEnabled } = useFiat()
  const usd = money ?? ((v: number) => privateModeEnabled ? "••••••" : fmtCompact(v))
  const selectable = isRowSelectable(e)
  const isTryQuote = e.availability.status === "unknown"
  // An unverified token wearing a major chain's identity, flagged in the list,
  // where the user decides; its server icon is dropped. See shared/symbolSquatter.
  const squatter = isSymbolSquatter(e.caip, e.symbol, e.name)
  const kind = isGasAsset(e) ? uiText("native") : uiText("token")
  return (
    <PickRow
      icon={<AssetIcon caip={e.caip} iconUrl={squatter ? undefined : e.iconUrl} chainCaip={chainBadgeCaip(e)} size={32} alt={e.symbol} bare />}
      title={e.symbol}
      tags={<>
        {squatter && <span className="kk-ap-tag kk-ap-warn">{uiText("NOT THE REAL")}{" "}{e.symbol.toUpperCase()}</span>}
        {!e.balance && isTryQuote && <span className="kk-ap-tag">{uiText("TRY QUOTE")}</span>}
        {!selectable && !isTryQuote && <span className="kk-ap-tag">{uiText("Unavailable")}</span>}
      </>}
      // "ETH · Base · native", never "Base · Base": the name is left out when it is the network's.
      sub={[e.name !== networkDisplayName(e.chainId) ? e.name : null, networkDisplayName(e.chainId), kind].filter(Boolean).join(' · ')}
      right={e.balance
        ? <>{formatBalance(e.balance.amount)}<small>{usd(e.balance.usd)}</small></>
        : <ProviderDots providers={e.availability.providers} />}
      tooltip={e.caip}
      disabled={!selectable}
      onClick={() => selectable ? onSelect(e) : onUnavailable(e)}
      attrs={{ "data-asset": e.caip }}
    />
  )
}

// ══════════════════════════════════════════════════════════════════════════
// Unavailable route
// ══════════════════════════════════════════════════════════════════════════

function UnavailableRouteView({ target, entries, onBack, onAltSelect }: {
  target: AssetEntry
  entries: AssetEntry[]
  onBack: () => void
  onAltSelect: (e: AssetEntry) => void
}) {
  const uiText = useUiTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const sym = target.symbol
  const targetChainName = networkDisplayName(target.chainId)
  const alternatives = useMemo(() =>
    entries.filter(e => e.caip !== target.caip && e.symbol === sym && isRowSelectable(e))
      .sort((a, b) => b.availability.providers.length - a.availability.providers.length),
    [entries, target, sym]
  )
  return (
    <>
      <div className="kk-ap-crumb"><button type="button" onClick={onBack}>← {uiText("Back to")}{" "}{targetChainName}</button></div>
      <div className="kk-ap-body" ref={listRef} onKeyDown={moveBetweenRows}>
        <div className="kk-ap-hero" data-unavailable>
          <AssetIcon caip={target.caip} iconUrl={target.iconUrl} chainCaip={chainBadgeCaip(target)} size={48} alt={sym} bare />
          <div>
            <b style={{ fontSize: 18 }}>{target.availability.status === "unsupported_firmware" ? `${sym} needs a firmware update` : `${sym} on ${targetChainName} isn't routable`}</b>
            <small>
              {target.availability.status === "unsupported_firmware"
                ? (target.availability.reason ?? `Update your KeepKey to swap ${sym} on ${targetChainName}.`)
                : target.availability.status === "unsupported_token"
                ? `${targetChainName} natives swap fine, but this specific token isn't on any provider's list yet.`
                : `${targetChainName} isn't supported by any of our routers yet (THORChain, Mayachain, Relay, 0x, ChainFlip).`}
            </small>
          </div>
        </div>
        {alternatives.length > 0 ? (
          <Section title={`${uiText("Swap to")} ${sym} ${uiText("on another network")}`} count={alternatives.length}>
            {alternatives.map(a => <PickRow key={a.caip}
              icon={<AssetIcon caip={a.caip} iconUrl={a.iconUrl} chainCaip={chainBadgeCaip(a)} size={32} alt={a.symbol} bare />}
              title={a.symbol} sub={`${a.name}${uiText("· on")} ${networkDisplayName(a.chainId)}`} tooltip={a.caip}
              right={<ProviderDots providers={a.availability.providers} />} onClick={() => onAltSelect(a)} />)}
          </Section>
        ) : <Empty title={`${uiText("No other supported network lists")} ${sym}${uiText(". Try a different destination asset.")}`} />}
      </div>
      <div className="kk-ap-foot">
        <span>{uiText("We never sign anything that can't complete.")}</span>
        <button type="button" className="kk-pf-link" onClick={onBack}>{uiText("Try a different asset")}</button>
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════════
// Confirm step — explicit breakdown before committing a selection
// ══════════════════════════════════════════════════════════════════════════

/** Confirmation gate: exactly which asset — network, native or token, routes,
 *  and its CAIP-19 — is committed, so a mis-tap or a substituted row can't
 *  silently become the selection. Both sides. */
function ConfirmStep({ entry, side, onConfirm, onBack }: {
  entry: AssetEntry
  side: "from" | "to"
  onConfirm: () => void
  onBack: () => void
}) {
  const uiText = useUiTranslation()
  const gas = isGasAsset(entry)
  const chainName = networkDisplayName(entry.chainId)
  const providers = entry.availability.providers
  return (
    <>
      <div className="kk-ap-body" data-confirm-step>
        <div className="kk-ap-hero">
          <AssetIcon caip={entry.caip} iconUrl={entry.iconUrl} chainCaip={chainBadgeCaip(entry)} size={56} alt={entry.symbol} bare />
          <div><b>{entry.symbol}</b><small>{entry.name}</small></div>
        </div>
        <dl className="kk-pf-facts" style={{ fontSize: 13 }}>
          <div><dt>{uiText("Network")}</dt><dd>{chainName}</dd></div>
          <div><dt>{uiText("Type")}</dt><dd>{gas ? uiText("Gas / native asset") : uiText("Token")}</dd></div>
          {providers.length > 0 && <div><dt>{uiText("Routes")}</dt><dd><ProviderDots providers={providers} />{" "}{providers.length} {providers.length === 1 ? uiText("route") : uiText("routes")}</dd></div>}
        </dl>
        <details className="kk-pf-tech" style={{ marginTop: 14 }}>
          <summary>{uiText("Technical details")}</summary>
          <dl className="kk-pf-facts" style={{ marginTop: 8 }}>
            <div><dt>{uiText("Network ID")}</dt><dd>{entry.chainId}</dd></div>
            <div><dt>{uiText("Asset ID")}</dt><dd>{entry.caip}</dd></div>
          </dl>
        </details>
      </div>
      <div className="kk-ap-foot">
        <div className="kk-pf-actions">
          <button type="button" className="kk-pf-cancel" onClick={onBack}>{uiText("Back")}</button>
          <button type="button" className="kk-pf-go" autoFocus onClick={onConfirm}>{swapPickerConfirmLabel(side, entry.symbol, chainName, uiText)}</button>
        </div>
      </div>
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
  sourceAccountLabel?: string
}

/** What the entry list is built from, by value: a balance poll that returns
 *  the same numbers in a new array must not rebuild (and blank) the list. */
export function pickerInputsKey(swappable: SwapAsset[], balances: ChainBalance[], customTokens: CustomToken[] | undefined, firmwareVersion: string | undefined): string {
  return JSON.stringify([
    swappable.map(s => [s.caip, s.symbol, s.name, s.icon]),
    balances.map(b => [b.chainId, b.address, b.balance, b.nativeBalanceUsd, (b.tokens || []).map(t => [t.caip, t.balance, t.balanceUsd])]),
    (customTokens || []).map(c => JSON.stringify(c)),
    firmwareVersion ?? null,
  ])
}

export function AssetPickerDialog({
  open, onClose, swappable, balances, balancesLoading = false, customTokens, excludeCaip, onSelect, side, sourceAccountLabel,
}: AssetPickerDialogProps) {
  const uiText = useUiTranslation()
  const { fmtCompact, privateModeEnabled } = useFiat()
  // Connected device's firmware version — gates chains whose `minFirmware` the
  // device can't meet (e.g. ZEC needs 7.17.0). Undefined until the first device-
  // state fetch resolves, which fails closed (firmware-restricted chains hidden).
  const { firmwareVersion } = useDeviceState()

  const [entries, setEntries]         = useState<AssetEntry[] | null>(null)
  const [loading, setLoading]         = useState(false)
  const [toChain, setToChain]         = useState<string | null>(null)
  const [unavailEntry, setUnavailEntry] = useState<AssetEntry | null>(null)
  // Pending selection awaiting explicit confirmation in the breakdown gate.
  const [confirmEntry, setConfirmEntry] = useState<AssetEntry | null>(null)
  const [search, setSearch]           = useState("")

  // FROM chain id (for the crossing line + excluding self): from excludeCaip when side=to
  const fromChainId = side === "to" && excludeCaip ? excludeCaip.split("/")[0] : null

  // Build the entry list on open, and again only when its inputs change by
  // value. The SwapDialog's balance poll hands a new (equal) array every few
  // seconds; rebuilding on identity showed "Loading…" in place of the list and
  // remounted every row and logo each time — the picker flickered. A rebuild
  // keeps the current list on screen until the new one is ready.
  const inputsKey = useMemo(() => pickerInputsKey(swappable, balances, customTokens, firmwareVersion),
    [swappable, balances, customTokens, firmwareVersion])
  const inputs = useRef({ swappable, balances, customTokens, firmwareVersion })
  inputs.current = { swappable, balances, customTokens, firmwareVersion }
  const shown = useRef<AssetEntry[] | null>(null)
  shown.current = entries
  useEffect(() => {
    if (!open) return
    let cancelled = false
    if (!shown.current) setLoading(true)
    buildAssetEntries(inputs.current)
      .then(list => { if (!cancelled) { setEntries(list); setLoading(false) } })
      .catch(e => {
        if (cancelled) return
        console.error("[AssetPickerDialog] buildAssetEntries failed:", e)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [open, inputsKey])

  // Reset navigation on open/close.
  // The TO side ALWAYS starts on the network step — never pre-fill the chain.
  // Landing straight on a token list is what lets a name-squatting token
  // ("solana" on Ethereum) be picked by someone who thinks they chose a
  // network. Picking the network is the user's defence; don't skip it.
  useEffect(() => {
    if (open) {
      setToChain(null)
      setUnavailEntry(null)
      setConfirmEntry(null)
      setSearch("")
    }
  }, [open])

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
  // committing immediately.
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

  const { title, stepLabel } = swapPickerHeading({ side, confirm: !!confirmEntry, unavailable: !!unavailEntry,
    network: toChain ? networkDisplayName(toChain) : undefined }, uiText)

  return (
    <div className="kk-ap-overlay" style={{ zIndex: Z.assetPicker }} onClick={onClose} data-asset-picker>
      <style>{PICKER_CSS}</style>
      <PreflightStyles />
      <div className="kk-ap" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="kk-ap-head">
          <div>
            <div className="kk-pf-kicker">{stepLabel}</div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="kk-ap-x" aria-label={uiText("Close")} onClick={onClose}><CloseIcon /></button>
        </div>
        {side === 'from' && sourceAccountLabel && <p className="kk-ap-note" style={{ overflowWrap: "anywhere" }} aria-label={uiText('Asset picker source account')}>{sourceAccountLabel}</p>}
        {loading && !entries ? (
          <div className="kk-ap-body"><div className="kk-ap-empty"><Spinner size="sm" color="var(--gold)" /><b style={{ marginTop: 12 }}>{uiText("Loading…")}</b></div></div>
        ) : !entries ? null
        : confirmEntry ? (
          <ConfirmStep entry={confirmEntry} side={side} onConfirm={() => commitSelect(confirmEntry)} onBack={() => setConfirmEntry(null)} />
        ) : side === "from" ? (
          <FromPicker entries={entries} onSelect={handleSelect} fmtCompact={fmtCompact} privateModeEnabled={privateModeEnabled} balancesLoading={balancesLoading} />
        ) : unavailEntry ? (
          <UnavailableRouteView target={unavailEntry} entries={entries}
            onBack={() => setUnavailEntry(null)}
            onAltSelect={(e) => { setUnavailEntry(null); handleSelect(e) }} />
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
      </div>
    </div>
  )
}
