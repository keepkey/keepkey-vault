import { useState } from "react"
import { Box, Flex, Text, Input, Button } from "@chakra-ui/react"
import { useTranslation } from "react-i18next"
import { rpcRequest } from "../lib/rpc"
import { Z } from "../lib/z-index"
import { AssetIcon } from "./AssetIcon"
import { AddressIdenticon } from "./AddressIdenticon"
import type { AddressBookEntry } from "../../shared/types"

interface Props {
  /** Recipient just sent to — pre-filled, read-only. */
  address: string
  /** CAIP-2 of the send's network (e.g. 'eip155:1'). */
  networkId: string
  /** Native CAIP of the chain, for the network icon. */
  assetCaip: string
  /** Display symbol (e.g. ETH / USDT) for the warning copy. */
  symbol: string
  onClose: () => void
  onSaved: (entry: AddressBookEntry) => void
}

/** R4 (opt-in): after a send to an address not yet in the Address Book, prompt the
 *  user to save it. Funds are already gone — this only records the contact. Saving
 *  is explicit; "Not now" leaves the address out of the book. Stamps the save date. */
export function SaveRecipientDialog({ address, networkId, assetCaip, symbol, onClose, onSaved }: Props) {
  const { t } = useTranslation("addressbook")
  const [label, setLabel] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const entry = await rpcRequest<AddressBookEntry | null>("addAddressBook", {
        networkId,
        address,
        label: label.trim() || undefined,
      }, 8000)
      if (entry) onSaved(entry)
      else setError(t("saveContactFailed", { defaultValue: "Could not save contact" }))
    } catch {
      setError(t("saveContactFailed", { defaultValue: "Could not save contact" }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Box position="fixed" inset="0" zIndex={Z.dialog} display="flex" alignItems="center" justifyContent="center"
         onClick={onClose} role="dialog" aria-modal="true">
      <Box position="absolute" inset="0" bg="blackAlpha.700" />
      <Box position="relative" bg="var(--ink-1)" border="1px solid var(--line)" borderRadius="16px" p="4"
           w="440px" maxW="92vw" display="flex" flexDirection="column" gap="3"
           onClick={(e) => e.stopPropagation()}>
        <Text fontSize="sm" fontWeight="700" color="var(--text-0)">
          {t("saveAddressTitle", { defaultValue: "New external address" })}
        </Text>

        {/* Funds-leaving warning */}
        <Flex align="center" gap="2" px="3" py="2" borderRadius="10px"
              bg="rgba(224,140,123,0.10)" border="1px solid rgba(224,140,123,0.30)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--rose)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <Text fontSize="12px" color="var(--rose)" fontWeight="600">
            {t("fundsLeavingWarning", { defaultValue: "Funds are leaving your wallet", symbol })}
          </Text>
        </Flex>

        {/* Recipient address */}
        <Flex align="center" gap="2.5" px="3" py="2.5" borderRadius="10px" bg="var(--ink-0)" border="1px solid var(--line)">
          <AddressIdenticon seed={address} size={28} />
          <Text fontSize="11px" fontFamily="mono" color="var(--text-1)" wordBreak="break-all" lineHeight="1.4" flex="1">
            {address}
          </Text>
          <AssetIcon caip={assetCaip} size={22} alt={symbol} />
        </Flex>

        <Text fontSize="12px" color="var(--text-1)">
          {t("saveAddressPrompt", { defaultValue: "Save this address to your Address Book?" })}
        </Text>

        {/* Label */}
        <Box>
          <Text fontSize="11px" color="var(--text-2)" mb="1">{t("labelOptional", { defaultValue: "Label (optional)" })}</Text>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} autoFocus
                 placeholder={t("labelPlaceholder", { defaultValue: "Label (e.g. Alice)" })}
                 size="sm" bg="var(--ink-0)" border="1px solid var(--line)" color="var(--text-0)"
                 onKeyDown={(e) => { if (e.key === "Enter") handleSave() }} />
        </Box>

        {error && <Text fontSize="11px" color="var(--rose)">{error}</Text>}

        <Flex gap="2" justify="flex-end" mt="1">
          <Button size="sm" variant="outline" color="var(--text-2)" border="1px solid var(--line)"
                  _hover={{ color: "var(--text-0)", bg: "var(--ink-2)" }} onClick={onClose} disabled={saving}>
            {t("notNow", { defaultValue: "Not now" })}
          </Button>
          <Button size="sm" bg="var(--gold)" color="var(--ink-0)" fontWeight="600"
                  _hover={{ bg: "var(--gold-2)" }} onClick={handleSave} disabled={saving}>
            {saving ? t("saving", { defaultValue: "Saving…" }) : t("save", { ns: "common", defaultValue: "Save" })}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
