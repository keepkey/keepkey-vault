import { useState, useEffect, useMemo } from "react"
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
  onSelect: (entry: AddressBookEntry) => void
  onClose: () => void
}

/** Send-screen recipient picker (R5). Lists address-book entries matching the
 *  current send's network and fills the recipient on select. Overlay styled like
 *  the app's other dialogs — closes on backdrop click. */
export function AddressBookPicker({ networkId, chainFamily, onSelect, onClose }: Props) {
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
      .filter(e => !q || e.label?.toLowerCase().includes(q) || e.address.toLowerCase().includes(q))
  }, [entries, chainFamily, search])

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
        <Box overflowY="auto" flex="1">
          {loading ? (
            <Text fontSize="xs" color="var(--text-2)" py="6" textAlign="center">{t("loading", { defaultValue: "Loading…" })}</Text>
          ) : matches.length === 0 ? (
            <Text fontSize="xs" color="var(--text-2)" py="6" textAlign="center">{t("noMatches", { defaultValue: "No saved addresses for this network" })}</Text>
          ) : matches.map(e => (
            <Flex key={e.id} as="button" w="full" align="center" gap="3" px="2" py="2" borderRadius="10px"
                  textAlign="left" _hover={{ bg: "rgba(233,196,106,0.06)" }} onClick={() => onSelect(e)}>
              <AddressIdenticon address={e.address} chainId={e.chainId} size={28} />
              <Flex direction="column" minW="0" flex="1">
                <Flex align="center" gap="1.5">
                  <Text fontSize="13px" color="var(--text-0)" truncate>{e.label || t("unlabeled", { defaultValue: "Unlabeled" })}</Text>
                  {e.kind === "own" && (
                    <Text fontSize="9px" color="var(--teal)" bg="rgba(139,227,196,0.10)" px="1" borderRadius="sm">
                      {t("ownWallet", { defaultValue: "My wallet" })}
                    </Text>
                  )}
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
