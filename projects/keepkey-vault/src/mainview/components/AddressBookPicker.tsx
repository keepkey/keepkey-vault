import { useState, useEffect, useMemo } from "react"
import type { ReactNode } from "react"
import { Box, Flex, Text, Input } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { AddressIdenticon } from "./AddressIdenticon"
import type { AddressBookEntry } from "../../shared/types"

interface Props {
  /** CAIP-2 of the current send; only entries on this network are shown (R5). */
  networkId: string
  /** Used to drop own-wallet UTXO rows, which store an xpub (not a send target). */
  chainFamily: string
  /** Optional extra filter applied after the network/family filter. Used by the
   *  Zcash tab to gate which address type (private vs transparent) is selectable
   *  in a given context. */
  entryFilter?: (entry: AddressBookEntry) => boolean
  /** Optional per-entry badge rendered beside the label (e.g. address-type marker). */
  renderTag?: (entry: AddressBookEntry) => ReactNode
  onSelect: (entry: AddressBookEntry) => void
  onClose: () => void
}

/** Send-screen recipient picker (R5). Lists address-book entries matching the
 *  current send's network and fills the recipient on select. Overlay styled like
 *  the app's other dialogs — closes on backdrop click. */
export function AddressBookPicker({ networkId, chainFamily, entryFilter, renderTag, onSelect, onClose }: Props) {
  const { t } = useTranslation("addressbook")
  const [entries, setEntries] = useState<AddressBookEntry[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    rpcRequest<AddressBookEntry[]>("listAddressBook", { networkId, limit: 500 }, 10000)
      .then(rows => { if (alive) setEntries(rows ?? []) })
      .catch(() => { if (alive) setEntries([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [networkId])

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    return entries
      // UTXO own rows store an xpub (not a sendable address) — never offer them.
      .filter(e => chainFamily !== "utxo" || e.kind === "external")
      .filter(e => !entryFilter || entryFilter(e))
      .filter(e => !q || e.label?.toLowerCase().includes(q) || e.address.toLowerCase().includes(q))
  }, [entries, chainFamily, entryFilter, search])

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center"
         onClick={onClose} role="dialog" aria-modal="true">
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box position="relative" bg="var(--ink-1)" border="1px solid var(--line)" borderRadius="16px" p="4"
           w="420px" maxW="92vw" maxH="70vh" display="flex" flexDirection="column"
           onClick={(e) => e.stopPropagation()}>
        <Text fontSize="sm" fontWeight="600" color="var(--text-0)" mb="1">
          {t("pickerTitle", { defaultValue: "Address Book" })}
        </Text>
        <Text fontSize="11px" color="var(--text-2)" mb="3">
          {t("pickerSubtitle", { defaultValue: "Saved addresses for this network" })}
        </Text>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} autoFocus
               placeholder={t("searchPlaceholder", { defaultValue: "Search label or address…" })}
               size="sm" mb="3" bg="var(--ink-0)" border="1px solid var(--line)" color="var(--text-0)" />
        {/* minH=0: a flex child defaults to min-height:auto and won't shrink below its
            content, so overflowY:auto never clips — list spills over the search box. */}
        <Box overflowY="auto" flex="1" minH="0">
          {loading ? (
            <Text fontSize="xs" color="var(--text-2)" py="6" textAlign="center">{t("loading", { defaultValue: "Loading…" })}</Text>
          ) : matches.length === 0 ? (
            <Text fontSize="xs" color="var(--text-2)" py="6" textAlign="center">{t("noMatches", { defaultValue: "No saved addresses for this network" })}</Text>
          ) : matches.map(e => (
            <Flex key={e.id} as="button" w="full" align="center" gap="3" px="2" py="2" borderRadius="10px"
                  textAlign="left" _hover={{ bg: "rgba(233,196,106,0.06)" }} onClick={() => onSelect(e)}>
              <AddressIdenticon seed={e.kind === "own" ? (e.deviceId || e.address) : e.address} size={28} />
              <Flex direction="column" minW="0" flex="1">
                <Flex align="center" gap="1.5">
                  <Text fontSize="13px" color="var(--text-0)" truncate>{e.label || t("unlabeled", { defaultValue: "Unlabeled" })}</Text>
                  {e.kind === "own" ? (
                    <Text fontSize="9px" color="var(--teal)" bg="rgba(139,227,196,0.10)" px="1" borderRadius="sm" flexShrink={0}>
                      {e.deviceLabel || t("ownWallet", { defaultValue: "My wallet" })}
                    </Text>
                  ) : (
                    <Flex align="center" gap="0.5" px="1" py="0.5" borderRadius="sm" bg="rgba(224,140,123,0.12)" border="1px solid rgba(224,140,123,0.30)" flexShrink={0}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      <Text fontSize="9px" fontWeight="700" color="var(--rose)" textTransform="uppercase" letterSpacing="0.04em">
                        {t("external", { defaultValue: "External" })}
                      </Text>
                    </Flex>
                  )}
                  {renderTag?.(e)}
                </Flex>
                <Text fontSize="11px" fontFamily="mono" color="var(--text-2)" truncate>
                  {e.address.slice(0, 10)}…{e.address.slice(-6)}
                </Text>
              </Flex>
            </Flex>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
