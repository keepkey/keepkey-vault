import { useState, useMemo } from "react"
import { Box, Flex, Text, Input, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { CHAINS } from "../../shared/chains"
import { validateAddress } from "../../shared/address-validation"
import { AssetIcon } from "./AssetIcon"
import type { AddressBookEntry } from "../../shared/types"

const NETWORKS = CHAINS.filter(c => !c.hidden)

/** Manually add an external contact: pick a network, paste an address (validated
 *  client-side against that chain), and label it. Saves via the addAddressBook RPC. */
export function AddAddressDialog({ onClose, onAdded }: { onClose: () => void; onAdded?: (e: AddressBookEntry) => void }) {
  const { t } = useTranslation("addressbook")
  const [chainId, setChainId] = useState<string>("")
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [chainSearch, setChainSearch] = useState("")
  const [address, setAddress] = useState("")
  const [label, setLabel] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chain = useMemo(() => NETWORKS.find(c => c.id === chainId), [chainId])
  const validation = useMemo(
    () => (address.trim() && chain ? validateAddress(address, chain) : null),
    [address, chain],
  )
  const canSave = !!chain && !!address.trim() && validation?.valid === true && !saving

  const filteredNetworks = useMemo(() => {
    const q = chainSearch.trim().toLowerCase()
    return NETWORKS.filter(c => !q || c.symbol.toLowerCase().includes(q) || c.coin.toLowerCase().includes(q))
  }, [chainSearch])

  const handleAdd = async () => {
    if (!chain || !canSave) return
    setSaving(true)
    setError(null)
    try {
      const entry = await rpcRequest<AddressBookEntry | null>("addAddressBook", {
        networkId: chain.networkId,
        address: address.trim(),
        label: label.trim() || undefined,
      }, 8000)
      if (entry) onAdded?.(entry)
      onClose()
    } catch {
      setError(t("addContactFailed", { defaultValue: "Could not add address" }))
      setSaving(false)
    }
  }

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center"
         onClick={onClose} role="dialog" aria-modal="true">
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box position="relative" bg="var(--ink-1)" border="1px solid var(--line)" borderRadius="16px" p="4"
           w="440px" maxW="92vw" maxH="80vh" display="flex" flexDirection="column" gap="3"
           onClick={(e) => e.stopPropagation()}>
        <Text fontSize="sm" fontWeight="700" color="var(--text-0)">{t("addAddress", { defaultValue: "Add address" })}</Text>

        {/* Network dropdown */}
        <Box>
          <Text fontSize="11px" color="var(--text-2)" mb="1">{t("network", { defaultValue: "Network" })}</Text>
          <Flex as="button" w="full" align="center" gap="2" px="3" h="36px" borderRadius="10px"
                bg="var(--ink-0)" border="1px solid var(--line)" textAlign="left"
                _hover={{ borderColor: "var(--gold)" }} onClick={() => setDropdownOpen(o => !o)}>
            {chain ? (
              <>
                <AssetIcon caip={chain.caip} size={18} alt={chain.symbol} />
                <Text fontSize="13px" color="var(--text-0)" flex="1" truncate>{chain.coin}</Text>
                <Text fontSize="11px" color="var(--text-2)">{chain.symbol}</Text>
              </>
            ) : (
              <Text fontSize="13px" color="var(--text-2)" flex="1">{t("selectNetwork", { defaultValue: "Select a network…" })}</Text>
            )}
            <Box color="var(--text-3)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            </Box>
          </Flex>
          {dropdownOpen && (
            <Box mt="1" bg="var(--ink-0)" border="1px solid var(--line)" borderRadius="10px" maxH="240px" overflowY="auto" p="1">
              <Input value={chainSearch} onChange={(e) => setChainSearch(e.target.value)} autoFocus
                     placeholder={t("searchNetwork", { defaultValue: "Search networks…" })}
                     size="xs" mb="1" bg="var(--ink-1)" border="1px solid var(--line)" color="var(--text-0)" />
              {filteredNetworks.map(c => (
                <Flex key={c.id} as="button" w="full" align="center" gap="2" px="2" py="1.5" borderRadius="8px"
                      textAlign="left" _hover={{ bg: "rgba(233,196,106,0.06)" }}
                      onClick={() => { setChainId(c.id); setDropdownOpen(false); setChainSearch("") }}>
                  <AssetIcon caip={c.caip} size={18} alt={c.symbol} />
                  <Text fontSize="13px" color="var(--text-0)" flex="1" truncate>{c.coin}</Text>
                  <Text fontSize="11px" color="var(--text-2)">{c.symbol}</Text>
                </Flex>
              ))}
            </Box>
          )}
        </Box>

        {/* Address */}
        <Box>
          <Text fontSize="11px" color="var(--text-2)" mb="1">{t("addressField", { defaultValue: "Address" })}</Text>
          <Input value={address} onChange={(e) => setAddress(e.target.value)}
                 placeholder={chain ? t("addressForNetwork", { defaultValue: "{{symbol}} address", symbol: chain.symbol }) : t("addressField", { defaultValue: "Address" })}
                 size="sm" fontFamily="mono" bg="var(--ink-0)" border="1px solid var(--line)" color="var(--text-0)"
                 wordBreak="break-all" />
          {validation && !validation.valid && (
            <Text fontSize="11px" color="var(--rose)" mt="1">{t(validation.error!, { ns: "send", defaultValue: "Invalid address" })}</Text>
          )}
          {validation?.valid && (
            <Text fontSize="11px" color="var(--teal)" mt="1">✓ {t("validAddress", { defaultValue: "Valid {{symbol}} address", symbol: chain?.symbol || "" })}</Text>
          )}
        </Box>

        {/* Label */}
        <Box>
          <Text fontSize="11px" color="var(--text-2)" mb="1">{t("labelOptional", { defaultValue: "Label (optional)" })}</Text>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100}
                 placeholder={t("labelPlaceholder", { defaultValue: "Label (e.g. Alice)" })}
                 size="sm" bg="var(--ink-0)" border="1px solid var(--line)" color="var(--text-0)"
                 onKeyDown={(e) => { if (e.key === "Enter" && canSave) handleAdd() }} />
        </Box>

        {error && <Text fontSize="11px" color="var(--rose)">{error}</Text>}

        <Flex gap="2" justify="flex-end" mt="1">
          <Button size="sm" variant="outline" color="var(--text-2)" border="1px solid var(--line)"
                  _hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }} onClick={onClose}>
            {t("cancel", { ns: "common", defaultValue: "Cancel" })}
          </Button>
          <Button size="sm" bg="var(--gold)" color="var(--ink-0)" fontWeight="600"
                  _hover={{ bg: "var(--gold-2)" }} onClick={handleAdd} disabled={!canSave}>
            {saving ? t("adding", { defaultValue: "Adding…" }) : t("addAddress", { defaultValue: "Add address" })}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
