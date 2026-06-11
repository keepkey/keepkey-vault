import { useState, useMemo, useCallback } from "react"
import type { ReactNode } from "react"
import { Box, Flex, Text, Input, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { CHAINS, getExplorerTxUrl, caipToNetworkId } from "../../shared/chains"
import { useAddressBook } from "../hooks/useAddressBook"
import { useDeviceState } from "../hooks/useDeviceState"
import { AddressIdenticon } from "./AddressIdenticon"
import { AssetIcon } from "./AssetIcon"
import { AddAddressDialog } from "./AddAddressDialog"
import type { AddressBookEntry, AddressBookTx } from "../../shared/types"

const chainById = new Map(CHAINS.map(c => [c.id, c]))
const chainByNetwork = new Map(CHAINS.map(c => [c.networkId, c]))

const shortDevice = (id?: string) => (id && id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : (id || "Wallet"))
const EXTERNAL_TAB = "__external__"

interface DisplayEntry extends AddressBookEntry {
  /** All underlying entry ids this row represents (own EVM collapses the same
   *  address across eip155 networks into one card). Edit/delete/history act on
   *  every member id; chain filtering matches any member chain. */
  memberIds: string[]
  memberChainIds: string[]
  networkCount?: number
}

/** Top-level Address Book destination (R1/R6). A global network filter sits above
 *  the tabs (one tab per device + a "Saved recipients" tab) and persists as you
 *  switch tabs. Device-seeded identicons (R3), copy-to-clipboard, manual add, and
 *  a per-address outbound-history drilldown (R7). */
export function AddressBookView() {
  const { t } = useTranslation("addressbook")
  const { entries, loading, seeding, saveLabel, remove } = useAddressBook()
  const deviceState = useDeviceState()
  // "Connected" = device attached & identified (anything but disconnected/error, with an id).
  const connectedDeviceId = (deviceState.deviceId && deviceState.state !== "disconnected" && deviceState.state !== "error")
    ? deviceState.deviceId
    : undefined
  const [search, setSearch] = useState("")
  const [chainFilter, setChainFilter] = useState<string>("all")
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  // Collapse own EVM rows (same address across many eip155 networks) into one card,
  // keyed per device, retaining every member id + chain so ops aggregate correctly.
  const display = useMemo<DisplayEntry[]>(() => {
    const out: DisplayEntry[] = []
    const ownEvmByAddr = new Map<string, DisplayEntry>()
    for (const e of entries) {
      const fam = chainById.get(e.chainId)?.chainFamily
      if (e.kind === "own" && fam === "evm") {
        const key = `${e.deviceId}:${e.address}`
        const ex = ownEvmByAddr.get(key)
        if (ex) {
          ex.networkCount = (ex.networkCount || 1) + 1
          ex.memberIds.push(e.id)
          if (!ex.memberChainIds.includes(e.chainId)) ex.memberChainIds.push(e.chainId)
          continue
        }
        const d: DisplayEntry = { ...e, networkCount: 1, memberIds: [e.id], memberChainIds: [e.chainId] }
        ownEvmByAddr.set(key, d)
        out.push(d)
      } else {
        out.push({ ...e, memberIds: [e.id], memberChainIds: [e.chainId] })
      }
    }
    return out
  }, [entries])

  // One tab per device (own), then an always-present External tab.
  const deviceTabs = useMemo(() => {
    const byDevice = new Map<string, { deviceId: string; label: string; rows: DisplayEntry[] }>()
    for (const e of display) {
      if (e.kind !== "own") continue
      const key = e.deviceId || "unknown"
      const g = byDevice.get(key) || { deviceId: key, label: e.deviceLabel || shortDevice(e.deviceId), rows: [] }
      g.rows.push(e)
      byDevice.set(key, g)
    }
    return Array.from(byDevice.values())
  }, [display])

  const externalRows = useMemo(() => display.filter(e => e.kind === "external"), [display])

  const tabs = useMemo(() => {
    const list: Array<{ id: string; label: string; connected?: boolean; external?: boolean }> =
      deviceTabs.map(g => ({ id: g.deviceId, label: g.label, connected: g.deviceId === connectedDeviceId }))
    // External tab is always shown so it's discoverable + a target for "Add address".
    list.push({ id: EXTERNAL_TAB, label: t("contacts", { defaultValue: "Saved recipients" }), external: true })
    return list
  }, [deviceTabs, connectedDeviceId, t])

  // Resolve the active tab: explicit selection if still valid, else connected device, else first.
  const effectiveTab = (activeTab && tabs.some(tb => tb.id === activeTab))
    ? activeTab
    : (tabs.find(tb => tb.connected)?.id || tabs[0]?.id || null)

  const tabRows = useMemo<DisplayEntry[]>(() => {
    if (effectiveTab === EXTERNAL_TAB) return externalRows
    return deviceTabs.find(g => g.deviceId === effectiveTab)?.rows || []
  }, [effectiveTab, deviceTabs, externalRows])

  // Global network filter — built from EVERY entry (all tabs) and kept across tab switches.
  const allChainsPresent = useMemo(() => {
    const ids = new Set<string>()
    for (const e of display) for (const c of e.memberChainIds) ids.add(c)
    return CHAINS.filter(c => ids.has(c.id))
  }, [display])

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tabRows
      .filter(e => chainFilter === "all" || e.memberChainIds.includes(chainFilter))
      .filter(e => !q || e.label?.toLowerCase().includes(q) || e.address.toLowerCase().includes(q))
  }, [tabRows, chainFilter, search])

  const handleSave = useCallback((ids: string[], label: string) =>
    Promise.all(ids.map(id => saveLabel(id, label))).then(() => {}), [saveLabel])
  const handleRemove = useCallback((ids: string[]) =>
    Promise.all(ids.map(id => remove(id))).then(() => {}), [remove])

  const onExternalTab = effectiveTab === EXTERNAL_TAB

  return (
    <Box maxW="760px" mx="auto" w="full" px="4">
      <Flex align="center" justify="space-between" mb="3" mt="2" gap="2">
        <Text fontSize="lg" fontWeight="700" color="var(--text-0)">{t("title", { defaultValue: "Address Book" })}</Text>
        <Button size="sm" variant="outline" borderColor="var(--gold)" color="var(--gold)" borderRadius="10px" px="3" h="34px"
                _hover={{ bg: "rgba(233,196,106,0.10)" }} onClick={() => setAddOpen(true)} flexShrink={0} title={t("addAddressHint", { defaultValue: "Add an address to your Address Book" })}>
          <Flex align="center" gap="1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <Text fontSize="12.5px" fontWeight="700">{t("addAddress", { defaultValue: "Add Address" })}</Text>
          </Flex>
        </Button>
      </Flex>

      {/* Global network filter — above the tabs, persists across tab switches. */}
      {allChainsPresent.length > 1 && (
        <Flex gap="1.5" mb="3" wrap="wrap">
          <Pill active={chainFilter === "all"} onClick={() => setChainFilter("all")}>{t("allNetworks", { defaultValue: "All networks" })}</Pill>
          {allChainsPresent.map(c => (
            <Pill key={c.id} active={chainFilter === c.id} onClick={() => setChainFilter(c.id)}>
              <AssetIcon caip={c.caip} size={14} alt={c.symbol} /> {c.symbol}
            </Pill>
          ))}
        </Flex>
      )}

      {/* Tabs: one per device + Saved recipients */}
      {tabs.length > 0 && (
        <Flex gap="1" mb="3" overflowX="auto" pb="1" borderBottom="1px solid var(--line)">
          {tabs.map(tb => {
            const active = tb.id === effectiveTab
            return (
              <Flex key={tb.id} as="button" align="center" gap="1.5" px="3" py="2" flexShrink={0}
                    borderBottom="2px solid" borderColor={active ? "var(--gold)" : "transparent"}
                    color={active ? "var(--text-0)" : "var(--text-2)"} fontSize="12.5px" fontWeight={active ? "700" : "500"}
                    _hover={{ color: "var(--text-0)" }} onClick={() => setActiveTab(tb.id)}>
                {tb.external ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                ) : (
                  <Box w="7px" h="7px" borderRadius="full" bg={tb.connected ? "var(--teal)" : "var(--text-2)"} title={tb.connected ? t("connected", { defaultValue: "Connected" }) : t("watchOnly", { defaultValue: "Watch-only" })} />
                )}
                <Text truncate maxW="140px">{tb.label}</Text>
              </Flex>
            )
          })}
        </Flex>
      )}

      <Input value={search} onChange={(e) => setSearch(e.target.value)}
             placeholder={t("searchPlaceholder", { defaultValue: "Search label or address…" })}
             size="sm" mb="3" bg="var(--ink-0)" border="1px solid var(--line)" color="var(--text-0)" />

      {loading || (seeding && display.length === 0) ? (
        <Text fontSize="sm" color="var(--text-2)" py="8" textAlign="center">
          {seeding ? t("seeding", { defaultValue: "Loading your wallet addresses…" }) : t("loading", { defaultValue: "Loading…" })}
        </Text>
      ) : visibleRows.length === 0 ? (
        <Text fontSize="sm" color="var(--text-2)" py="8" textAlign="center">
          {onExternalTab && externalRows.length === 0
            ? t("noContacts", { defaultValue: "No saved recipients yet — add one with “Add Address”." })
            : (chainFilter !== "all" || search.trim())
              ? t("noMatches", { defaultValue: "No addresses match your filter" })
              : t("noAddresses", { defaultValue: "No saved addresses yet" })}
        </Text>
      ) : (
        <Flex direction="column" gap="1.5">
          {visibleRows.map(e => <Row key={e.id} entry={e} connected={!!tabs.find(tb => tb.id === effectiveTab)?.connected && e.kind === "own"} onSave={handleSave} onRemove={handleRemove} />)}
        </Flex>
      )}

      {addOpen && <AddAddressDialog onClose={() => setAddOpen(false)} onAdded={() => setActiveTab(EXTERNAL_TAB)} />}
    </Box>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Flex as="button" align="center" gap="1" px="2.5" py="1" borderRadius="999px" fontSize="11.5px"
          border="1px solid var(--line)" bg={active ? "var(--ink-4)" : "transparent"}
          color={active ? "var(--text-0)" : "var(--text-2)"} _hover={{ color: "var(--text-0)", bg: "var(--ink-3)" }}
          onClick={onClick}>
      {children}
    </Flex>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  // A div (not a <button>) because it lives inside the row's <button> header — nested
  // buttons are invalid. stopPropagation so copying doesn't toggle the row.
  return (
    <Box as="span" role="button" aria-label={label} title={label} cursor="pointer" flexShrink={0}
         color={copied ? "var(--teal)" : "var(--text-3)"} _hover={{ color: "var(--text-1)" }}
         onClick={(e) => {
           e.stopPropagation()
           navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
         }}>
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
    </Box>
  )
}

function Row({ entry, connected, onSave, onRemove }: {
  entry: DisplayEntry
  connected?: boolean
  onSave: (ids: string[], label: string) => Promise<void> | void
  onRemove: (ids: string[]) => Promise<void> | void
}) {
  const { t } = useTranslation("addressbook")
  const chain = chainById.get(entry.chainId)
  const isOwn = entry.kind === "own"
  // Own avatars are seeded by device (so a device's addresses share one identicon);
  // external contacts are seeded by their address.
  const seed = isOwn ? (entry.deviceId || entry.address) : entry.address
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.label || "")
  const [history, setHistory] = useState<AddressBookTx[] | null>(null)

  const toggle = useCallback(() => {
    setExpanded(v => {
      const next = !v
      if (next && history === null) {
        Promise.all(entry.memberIds.map(id =>
          rpcRequest<AddressBookTx[]>("getAddressBookHistory", { entryId: id }, 8000).catch(() => [] as AddressBookTx[])
        )).then(lists => setHistory(lists.flat().sort((a, b) => b.broadcastAt - a.broadcastAt)))
      }
      return next
    })
  }, [entry.memberIds, history])

  return (
    <Box border="1px solid var(--line)" borderRadius="12px" bg="var(--ink-0)" overflow="hidden">
      <Flex as="button" w="full" align="center" gap="3" px="3" py="2.5" textAlign="left"
            _hover={{ bg: "var(--ink-1)" }} onClick={toggle}>
        <Box position="relative" flexShrink={0}>
          <AddressIdenticon seed={seed} size={36} />
          {isOwn && (
            <Box position="absolute" bottom="-2px" right="-2px" w="11px" h="11px" borderRadius="full"
                 bg={connected ? "var(--teal)" : "var(--text-2)"} border="2px solid var(--ink-0)"
                 title={connected ? t("connected", { defaultValue: "Connected" }) : t("watchOnly", { defaultValue: "Watch-only" })} />
          )}
        </Box>
        <Flex direction="column" minW="0" flex="1" gap="0.5">
          <Flex align="center" gap="1.5">
            <Text fontSize="13px" fontWeight="600" color="var(--text-0)" truncate>
              {entry.label || t("unlabeled", { defaultValue: "Unlabeled" })}
            </Text>
            {!isOwn && (
              <Flex align="center" gap="0.5" px="1" py="0.5" borderRadius="sm" bg="rgba(224,140,123,0.12)" border="1px solid rgba(224,140,123,0.30)" flexShrink={0}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <Text fontSize="9px" fontWeight="700" color="var(--rose)" textTransform="uppercase" letterSpacing="0.04em">
                  {t("external", { defaultValue: "External" })}
                </Text>
              </Flex>
            )}
            {entry.networkCount && entry.networkCount > 1 && (
              <Text fontSize="9px" color="var(--text-3)" bg="var(--ink-2)" px="1" borderRadius="sm">
                {entry.networkCount} {t("networksLabel", { defaultValue: "networks" })}
              </Text>
            )}
          </Flex>
          {/* Full address — no middle ellipsis; wraps for long xpubs. */}
          <Text fontSize="11px" fontFamily="mono" color="var(--text-2)" wordBreak="break-all" lineHeight="1.4">
            {entry.address}
          </Text>
          {!isOwn && entry.savedAt && (
            <Text fontSize="10px" color="var(--text-3)">
              {t("addedOn", { defaultValue: "Added {{date}}", date: new Date(entry.savedAt).toLocaleDateString() })}
            </Text>
          )}
        </Flex>
        <CopyButton value={entry.address} label={t("copyAddress", { defaultValue: "Copy address" })} />
        {chain && <AssetIcon caip={chain.caip} size={30} alt={chain.symbol} />}
      </Flex>

      {expanded && (
        <Box px="3" pb="3" pt="1" borderTop="1px solid var(--line)">
          <Flex gap="2" mb="2" mt="2">
            {editing ? (
              <>
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} size="xs" flex="1"
                       bg="var(--ink-0)" border="1px solid var(--line)" color="var(--text-0)" maxLength={100}
                       placeholder={t("labelPlaceholder", { defaultValue: "Label" })} />
                <Button size="xs" bg="var(--gold)" color="var(--ink-0)" onClick={async () => { await onSave(entry.memberIds, draft.trim()); setEditing(false) }}>
                  {t("save", { ns: "common", defaultValue: "Save" })}
                </Button>
                <Button size="xs" variant="ghost" color="var(--text-2)" onClick={() => { setDraft(entry.label || ""); setEditing(false) }}>
                  {t("cancel", { ns: "common", defaultValue: "Cancel" })}
                </Button>
              </>
            ) : (
              <>
                <Button size="xs" variant="ghost" color="var(--text-2)" _hover={{ color: "var(--teal)" }} onClick={() => setEditing(true)}>
                  {t("edit", { defaultValue: "Edit" })}
                </Button>
                <Button size="xs" variant="ghost" color="var(--text-2)" _hover={{ color: "var(--rose)" }} onClick={() => onRemove(entry.memberIds)}>
                  {t("delete", { defaultValue: "Delete" })}
                </Button>
              </>
            )}
          </Flex>

          <Text fontSize="10px" color="var(--text-3)" textTransform="uppercase" letterSpacing="0.05em" mb="1">
            {t("outboundHistory", { defaultValue: "Outbound history" })}
          </Text>
          {history === null ? (
            <Text fontSize="xs" color="var(--text-2)">{t("loading", { defaultValue: "Loading…" })}</Text>
          ) : history.length === 0 ? (
            <Text fontSize="xs" color="var(--text-2)">{t("noOutbounds", { defaultValue: "No outbound history" })}</Text>
          ) : (
            <Flex direction="column" gap="1">
              {history.map(tx => {
                const txChain = chainByNetwork.get(caipToNetworkId(tx.caip)) || chain
                const url = txChain ? getExplorerTxUrl(txChain.id, tx.txid) : null
                return (
                  <Flex key={tx.id} align="center" justify="space-between" gap="2" fontSize="11px">
                    <Text color="var(--text-2)" fontFamily="mono">{new Date(tx.broadcastAt).toLocaleDateString()}</Text>
                    <Text color="var(--text-1)" fontFamily="mono" truncate flex="1" textAlign="right">
                      {tx.amount ? `${tx.amount} ${tx.symbol || ""}` : (tx.symbol || "")}
                    </Text>
                    {url && (
                      <Text as="button" color="var(--teal)" onClick={() => rpcRequest("openUrl", { url }).catch(() => {})}>
                        {t("view", { defaultValue: "View" })}
                      </Text>
                    )}
                  </Flex>
                )
              })}
            </Flex>
          )}
        </Box>
      )}
    </Box>
  )
}
