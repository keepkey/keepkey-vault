import { useState, useMemo, useCallback } from "react"
import type { ReactNode } from "react"
import { Box, Flex, Text, Input, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { CHAINS, getExplorerTxUrl, caipToNetworkId } from "../../shared/chains"
import { useAddressBook } from "../hooks/useAddressBook"
import { AddressIdenticon } from "./AddressIdenticon"
import { AssetIcon } from "./AssetIcon"
import type { AddressBookEntry, AddressBookTx } from "../../shared/types"

const chainById = new Map(CHAINS.map(c => [c.id, c]))
const chainByNetwork = new Map(CHAINS.map(c => [c.networkId, c]))

interface DisplayEntry extends AddressBookEntry {
  /** All underlying entry ids this row represents (own EVM collapses the same
   *  address across eip155 networks into one card). Edit/delete/history act on
   *  every member id; chain filtering matches any member chain. */
  memberIds: string[]
  memberChainIds: string[]
  networkCount?: number
}

/** Top-level Address Book destination (R1/R6). Unified list of own wallets + saved
 *  recipients, with a GitHub-squares identicon (R3), chain filter, search, and a
 *  per-address outbound-history drilldown (R7). */
export function AddressBookView() {
  const { t } = useTranslation("addressbook")
  const { entries, loading, seeding, saveLabel, remove } = useAddressBook()
  const [search, setSearch] = useState("")
  const [chainFilter, setChainFilter] = useState<string>("all")

  // Collapse own EVM rows (same address across many eip155 networks) into one card,
  // retaining every member id + chain so operations aggregate correctly.
  const display = useMemo<DisplayEntry[]>(() => {
    const out: DisplayEntry[] = []
    const ownEvmByAddr = new Map<string, DisplayEntry>()
    for (const e of entries) {
      const fam = chainById.get(e.chainId)?.chainFamily
      if (e.kind === "own" && fam === "evm") {
        const ex = ownEvmByAddr.get(e.address)
        if (ex) {
          ex.networkCount = (ex.networkCount || 1) + 1
          ex.memberIds.push(e.id)
          if (!ex.memberChainIds.includes(e.chainId)) ex.memberChainIds.push(e.chainId)
          continue
        }
        const d: DisplayEntry = { ...e, networkCount: 1, memberIds: [e.id], memberChainIds: [e.chainId] }
        ownEvmByAddr.set(e.address, d)
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
      .filter(e => !q || e.label?.toLowerCase().includes(q) || e.address.toLowerCase().includes(q))
  }, [display, chainFilter, search])

  const ownCount = useMemo(() => display.filter(e => e.kind === "own").length, [display])

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
          {ownCount > 0 && <Badge>{ownCount} {t("myWalletsLabel", { defaultValue: "my wallets" })}</Badge>}
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
             placeholder={t("searchPlaceholder", { defaultValue: "Search label or address…" })}
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
        <Flex direction="column" gap="1.5">
          {filtered.map(e => <Row key={e.id} entry={e} onSave={handleSave} onRemove={handleRemove} />)}
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

function Row({ entry, onSave, onRemove }: {
  entry: DisplayEntry
  onSave: (ids: string[], label: string) => Promise<void> | void
  onRemove: (ids: string[]) => Promise<void> | void
}) {
  const { t } = useTranslation("addressbook")
  const chain = chainById.get(entry.chainId)
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
        <AddressIdenticon address={entry.address} chainId={entry.chainId} size={32} />
        <Flex direction="column" minW="0" flex="1">
          <Flex align="center" gap="1.5">
            <Text fontSize="13px" fontWeight="600" color="var(--text-0)" truncate>
              {entry.label || t("unlabeled", { defaultValue: "Unlabeled" })}
            </Text>
            {entry.kind === "own" && (
              <Text fontSize="9px" color="var(--teal)" bg="rgba(139,227,196,0.10)" px="1" borderRadius="sm">
                {t("ownWallet", { defaultValue: "My wallet" })}{entry.networkCount && entry.networkCount > 1 ? ` · ${entry.networkCount}` : ""}
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
