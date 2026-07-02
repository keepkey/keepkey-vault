import { useEffect, useRef, useState } from "react"
import { Box, Flex, Text } from "@chakra-ui/react"
import { FaPlus, FaCheck, FaChevronDown } from "react-icons/fa"
import { useTranslation } from "react-i18next"

export interface UtxoScriptTypeInfo {
  scriptType: string
  purpose: number
  label: string
  prefix: string
}

interface UtxoAccountSelectorProps {
  accounts: number[]
  selected: number
  onSelect: (account: number) => void
  onAddAccount: () => void
  adding: boolean
  symbol: string
  /** Optional script-type picker (Litecoin) — mirrors the BTC selector's second dropdown. */
  scripts?: UtxoScriptTypeInfo[]
  selectedScript?: string
  onSelectScript?: (scriptType: string) => void
}

/**
 * Account (+ optional script-type) dropdowns for non-BTC UTXO chains
 * (LTC/DOGE/DASH/…). Glass pills in the AssetPage action row, modeled on
 * CompactBtcSelector.
 */
export function UtxoAccountSelector({ accounts, selected, onSelect, onAddAccount, adding, symbol, scripts, selectedScript, onSelectScript }: UtxoAccountSelectorProps) {
  const { t } = useTranslation("receive")
  const [open, setOpen] = useState(false)
  const [scriptOpen, setScriptOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const scriptRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open && !scriptOpen) return
    const onDown = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
      if (scriptOpen && scriptRef.current && !scriptRef.current.contains(e.target as Node)) setScriptOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setScriptOpen(false) } }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, scriptOpen])

  const activeScript = scripts?.find(s => s.scriptType === selectedScript) || scripts?.[0]

  return (
    <Flex gap="2" align="center">
    <Box ref={ref} position="relative" display="inline-block">
      <Box
        as="button"
        onClick={() => { setOpen(o => !o); setScriptOpen(false) }}
        className="v3-glass-pill electrobun-webkit-app-region-no-drag"
        display="flex"
        alignItems="center"
        gap="2"
        px="3"
        py="1.5"
        minW="150px"
        cursor="pointer"
        transition="all 0.15s"
        _hover={{ bg: "rgba(255,255,255,0.06)" }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Box
          w="22px" h="22px" borderRadius="full" bg="rgba(255,255,255,0.06)"
          display="flex" alignItems="center" justifyContent="center" flexShrink={0}
        >
          <Text fontSize="9px" fontFamily="mono" color="var(--text-2)" fontWeight="600">
            #{selected}
          </Text>
        </Box>
        <Box flex="1" textAlign="left" minW="0">
          <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1" truncate>
            {t('account', { index: selected })}
          </Text>
          <Text fontSize="10px" fontFamily="mono" color="var(--text-3)" lineHeight="1.2" truncate>
            {symbol}
          </Text>
        </Box>
        <Box as={FaChevronDown} fontSize="9px" color="var(--text-3)" flexShrink={0} />
      </Box>

      {open && (
        <Box
          position="absolute"
          top="calc(100% + 6px)"
          left="0"
          minW="220px"
          zIndex={9999}
          className="v3-glass-card-overlay electrobun-webkit-app-region-no-drag"
          py="1.5"
        >
          {accounts.map(acct => {
            const isSel = acct === selected
            return (
              <Box
                key={acct}
                as="button"
                w="100%" px="3" py="2"
                bg="transparent"
                _hover={{ bg: "rgba(255,255,255,0.08)" }}
                cursor="pointer"
                textAlign="left"
                onClick={() => { onSelect(acct); setOpen(false) }}
                role="menuitemradio"
                aria-checked={isSel}
              >
                <Flex align="center" gap="2.5">
                  <Box
                    w="22px" h="22px" borderRadius="full"
                    bg={isSel ? "rgba(139,227,196,0.15)" : "rgba(255,255,255,0.06)"}
                    display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                  >
                    <Text fontSize="9px" fontFamily="mono" color={isSel ? "var(--teal)" : "var(--text-2)"} fontWeight="600">
                      #{acct}
                    </Text>
                  </Box>
                  <Text flex="1" fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1">
                    {t('account', { index: acct })}
                  </Text>
                  {isSel && <Box as={FaCheck} color="var(--teal)" fontSize="10px" flexShrink={0} />}
                </Flex>
              </Box>
            )
          })}
          <Box borderTop="1px solid rgba(255,255,255,0.06)" mt="1" pt="1">
            <Box
              as="button"
              w="100%" px="3" py="2"
              bg="transparent"
              _hover={{ bg: "rgba(255,255,255,0.08)" }}
              cursor={adding ? "wait" : "pointer"}
              opacity={adding ? 0.5 : 1}
              textAlign="left"
              onClick={() => { if (!adding) { onAddAccount(); setOpen(false) } }}
              aria-disabled={adding}
            >
              <Flex align="center" gap="2.5">
                <Box
                  w="22px" h="22px" borderRadius="full" bg="rgba(139,227,196,0.10)"
                  display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                >
                  <Box as={FaPlus} fontSize="9px" color="var(--teal)" />
                </Box>
                <Text fontSize="12px" fontWeight="500" color="var(--teal)">
                  Add account
                </Text>
              </Flex>
            </Box>
          </Box>
        </Box>
      )}
    </Box>

    {/* Script-type dropdown (chains with multiple address types, e.g. LTC) */}
    {scripts && activeScript && onSelectScript && (
      <Box ref={scriptRef} position="relative" display="inline-block">
        <Box
          as="button"
          onClick={() => { setScriptOpen(o => !o); setOpen(false) }}
          className="v3-glass-pill electrobun-webkit-app-region-no-drag"
          display="flex"
          alignItems="center"
          gap="2"
          px="3"
          py="1.5"
          minW="150px"
          cursor="pointer"
          transition="all 0.15s"
          _hover={{ bg: "rgba(255,255,255,0.06)" }}
          aria-haspopup="menu"
          aria-expanded={scriptOpen}
        >
          <Box flex="1" textAlign="left" minW="0">
            <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1" truncate>
              {activeScript.label}
            </Text>
            <Text fontSize="10px" fontFamily="mono" color="var(--text-3)" lineHeight="1.2" truncate>
              {activeScript.prefix}…
            </Text>
          </Box>
          <Box as={FaChevronDown} fontSize="9px" color="var(--text-3)" flexShrink={0} />
        </Box>

        {scriptOpen && (
          <Box
            position="absolute"
            top="calc(100% + 6px)"
            left="0"
            minW="220px"
            zIndex={9999}
            className="v3-glass-card-overlay electrobun-webkit-app-region-no-drag"
            py="1.5"
          >
            {scripts.map(st => {
              const isSel = st.scriptType === selectedScript
              return (
                <Box
                  key={st.scriptType}
                  as="button"
                  w="100%" px="3" py="2"
                  bg="transparent"
                  _hover={{ bg: "rgba(255,255,255,0.08)" }}
                  cursor="pointer"
                  textAlign="left"
                  onClick={() => { onSelectScript(st.scriptType); setScriptOpen(false) }}
                  role="menuitemradio"
                  aria-checked={isSel}
                >
                  <Flex align="center" gap="2.5">
                    <Box flex="1" minW="0">
                      <Text fontSize="12px" fontWeight="600" color="var(--text-0)" lineHeight="1.1">
                        {st.label}
                      </Text>
                      <Text fontSize="10px" fontFamily="mono" color="var(--text-2)" lineHeight="1.2" mt="0.5">
                        {st.prefix}…
                      </Text>
                    </Box>
                    {isSel && <Box as={FaCheck} color="var(--teal)" fontSize="10px" flexShrink={0} />}
                  </Flex>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )}
    </Flex>
  )
}
