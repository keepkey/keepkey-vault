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
import type { AddressBookEntry, AddressBookTx } from "../../shared/types"

const chainById = new Map(CHAINS.map(c => [c.id, c]))
const chainByNetwork = new Map(CHAINS.map(c => [c.networkId, c]))

const shortDevice = (id?: string) => (id && id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : (id || "Wallet"))

interface DisplayEntry extends AddressBookEntry {
  /** All underlying entry ids this row represents (own EVM collapses the same
   *  address across eip155 networks into one card). Edit/delete/history act on
   *  every member id; chain filtering matches any member chain. */
  memberIds: string[]
  memberChainIds: string[]
  networkCount?: number
}

/** Top-level Address Book destination (R1/R6). Own wallets are grouped by the
 *  device they belong to (across all of the user's devices, from the watch-only
 *  cache); saved recipients are listed separately. GitHub-squares identicon (R3),
 *  chain filter, search, and a per-address outbound-history drilldown (R7). */
export function AddressBookView() {
  const { t } = useTranslation("addressbook")
  const { entries, loading, seeding, saveLabel, remove } = useAddressBook()
  const deviceState = useDeviceState()
  // "Connected" = the device is physically attached and identified (ready, or mid
  // PIN/passphrase/bootloader) — anything but disconnected/error. Requires a deviceId
  // so we never light up a device we can't actually match.
  const connectedDeviceId = (deviceState.deviceId && deviceState.state !== "disconnected" && deviceState.state !== "error")
    ? deviceState.deviceId
    : undefined
  const [search, setSearch] = useState("")
  const [chainFilter, setChainFilter] = useState<string>("all")

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

  // Pills come from the raw entries so a chain that only exists inside a collapsed
  // row is still selectable.
  const chainsWithEntries = useMemo(() => {
    const ids = new Set(entries.map(e => e.chainId))
    return CHAINS.filter(c => ids.has(c.id))
  }, [entries])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return display
      .filter(e => chainFilter === "all" || e.memberChainIds.includes(chainFilter))
      .filter(e => !q || e.label?.toLowerCase().includes(q) || e.address.toLowerCase().includes(q) || e.deviceLabel?.toLowerCase().includes(q))
  }, [display, chainFilter, search])

  // Group own entries by their device; external recipients go in their own section.
  const groups = useMemo(() => {
    const own = new Map<string, { deviceId: string; label: string; rows: DisplayEntry[] }>()
    const external: DisplayEntry[] = []
    for (const e of filtered) {
      if (e.kind === "own") {
        const key = e.deviceId || "unknown"
        const g = own.get(key) || { deviceId: key, label: e.deviceLabel || shortDevice(e.deviceId), rows: [] }
        g.rows.push(e)
        own.set(key, g)
      } else {
        external.push(e)
      }
    }
    return { own: Array.from(own.values()), external }
  }, [filtered])

  const deviceCount = useMemo(() => new Set(display.filter(e => e.kind === "own").map(e => e.deviceId)).size, [display])

  const handleSave = useCallback((ids: string[], label: string) =>
    Promise.all(ids.map(id => saveLabel(id, label))).then(() => {}), [saveLabel])
  const handleRemove = useCallback((ids: string[]) =>
    Promise.all(ids.map(id => remove(id))).then(() => {}), [remove])

  return (
    <Box maxW="720px" mx="auto" w="full" px="4">
      <Flex align="center" justify="space-between" mb="3" mt="2">
        <Text fontSize="lg" fontWeight="700" color="var(--text-0)">{t("title", { defaultValue: "Address Book" })}</Text>
        <Flex gap="2">
          <Badge>{display.length} {t("addressesLabel", { defaultValue: "addresses" })}</Badge>
          {deviceCount > 0 && <Badge>{deviceCount} {t("devicesLabel", { defaultValue: "devices" })}</Badge>}
        </Flex>
      </Flex>

      <Flex gap="1.5" mb="3" wrap="wrap">
        <Pill active={chainFilter === "all"} onClick={() => setChainFilter("all")}>{t("allChains", { defaultValue: "All" })}</Pill>
        {chainsWithEntries.map(c => (
          <Pill key={c.id} active={chainFilter === c.id} onClick={() => setChainFilter(c.id)}>
            <AssetIcon caip={c.caip} size={14} alt={c.symbol} /> {c.symbol}
          </Pill>
        ))}
      </Flex>

      <Input value={search} onChange={(e) => setSearch(e.target.value)}
             placeholder={t("searchPlaceholder", { defaultValue: "Search label, address, or device…" })}
             size="sm" mb="3" bg="var(--ink-0)" border="1px solid var(--line)" color="var(--text-0)" />

      {loading || (seeding && display.length === 0) ? (
        <Text fontSize="sm" color="var(--text-2)" py="8" textAlign="center">
          {seeding ? t("seeding", { defaultValue: "Loading your wallet addresses…" }) : t("loading", { defaultValue: "Loading…" })}
        </Text>
      ) : filtered.length === 0 ? (
        <Text fontSize="sm" color="var(--text-2)" py="8" textAlign="center">
          {display.length === 0 ? t("noAddresses", { defaultValue: "No saved addresses yet" }) : t("noMatches", { defaultValue: "No addresses match your filter" })}
        </Text>
      ) : (
        <Flex direction="column" gap="4">
          {groups.own.map(g => {
            const connected = !!connectedDeviceId && g.deviceId === connectedDeviceId
            return (
              <Box key={g.deviceId}>
                <SectionHeader icon="device" connected={connected}>{g.label}</SectionHeader>
                <Flex direction="column" gap="1.5">
                  {g.rows.map(e => <Row key={e.id} entry={e} connected={connected} onSave={handleSave} onRemove={handleRemove} />)}
                </Flex>
              </Box>
            )
          })}
          {groups.external.length > 0 && (
            <Box>
              <SectionHeader icon="contact">{t("contacts", { defaultValue: "Saved recipients" })}</SectionHeader>
              <Flex direction="column" gap="1.5">
                {groups.external.map(e => <Row key={e.id} entry={e} connected={false} onSave={handleSave} onRemove={handleRemove} />)}
              </Flex>
            </Box>
          )}
        </Flex>
      )}
    </Box>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <Text fontSize="11px" color="var(--text-2)" bg="var(--ink-2)" border="1px solid var(--line)" px="2" py="0.5" borderRadius="999px">
      {children}
    </Text>
  )
}

function SectionHeader({ children, icon, connected }: { children: ReactNode; icon: "device" | "contact"; connected?: boolean }) {
  const { t } = useTranslation("addressbook")
  return (
    <Flex align="center" gap="1.5" mb="1.5" px="1">
      <Box color="var(--text-3)">
        {icon === "device" ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12" y2="18" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
        )}
      </Box>
      <Text fontSize="11px" fontWeight="700" color="var(--text-1)" textTransform="uppercase" letterSpacing="0.06em" truncate>
        {children}
      </Text>
      {icon === "device" && (
        <Flex align="center" gap="1" flexShrink={0}>
          <Box w="7px" h="7px" borderRadius="full" bg={connected ? "var(--teal)" : "var(--text-2)"} />
          <Text fontSize="9px" fontWeight="600" color={connected ? "var(--teal)" : "var(--text-2)"} textTransform="uppercase" letterSpacing="0.04em">
            {connected ? t("connected", { defaultValue: "Connected" }) : t("watchOnly", { defaultValue: "Watch-only" })}
          </Text>
        </Flex>
      )}
    </Flex>
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
        // Aggregate history across every collapsed member (own address on N networks).
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
          <AddressIdenticon seed={seed} size={32} />
          {isOwn && (
            <Box position="absolute" bottom="-2px" right="-2px" w="11px" h="11px" borderRadius="full"
                 bg={connected ? "var(--teal)" : "var(--text-2)"} border="2px solid var(--ink-0)"
                 title={connected ? t("connected", { defaultValue: "Connected" }) : t("watchOnly", { defaultValue: "Watch-only" })} />
          )}
        </Box>
        <Flex direction="column" minW="0" flex="1">
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
          <Text fontSize="11px" fontFamily="mono" color="var(--text-2)" truncate>
            {entry.address.slice(0, 12)}…{entry.address.slice(-8)}
          </Text>
        </Flex>
        {chain && <AssetIcon caip={chain.caip} size={16} alt={chain.symbol} />}
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
                // A collapsed own row aggregates txs across networks — resolve each
                // tx's chain from its own CAIP, falling back to the row's chain.
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
