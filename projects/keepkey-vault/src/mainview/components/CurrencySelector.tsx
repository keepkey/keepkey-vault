import { Flex, Box, Text } from "@chakra-ui/react"
import { useFiat } from "../lib/fiat-context"
import { FIAT_CURRENCIES, getFiatConfig } from "../../shared/fiat"
import type { FiatCurrency } from "../../shared/types"
import { useState } from "react"

const LOCALE_OPTIONS: { locale: string; label: string; short: string }[] = [
  { locale: 'en-US', label: '1,234.56 (US)', short: 'US' },
  { locale: 'de-DE', label: '1.234,56 (EU)', short: 'EU' },
  { locale: 'fr-FR', label: '1\u202F234,56 (FR)', short: 'FR' },
  { locale: 'en-IN', label: '1,23,456.78 (IN)', short: 'IN' },
  { locale: 'ja-JP', label: '1,234 (JP)', short: 'JP' },
  { locale: 'pt-BR', label: '1.234,56 (BR)', short: 'BR' },
]

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s", color: "var(--chakra-colors-kk-textSecondary)" }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

export function CurrencySelector() {
  const { currency, locale, setCurrency, setLocale } = useFiat()
  const [currencyOpen, setCurrencyOpen] = useState(false)
  const [formatOpen, setFormatOpen] = useState(false)

  const currentCfg = getFiatConfig(currency)
  const currentLocale = LOCALE_OPTIONS.find(o => o.locale === locale) || LOCALE_OPTIONS[0]

  return (
    <Box>
      {/* Currency row */}
      <Flex
        as="button"
        align="center"
        justify="space-between"
        w="100%"
        cursor="pointer"
        onClick={() => setCurrencyOpen(o => !o)}
        py="1"
      >
        <Text fontSize="xs" color="kk.textMuted">Currency</Text>
        <Flex align="center" gap="1.5">
          <Text fontSize="xs" color="kk.textPrimary" fontWeight="500">
            {currentCfg.symbol} {currency}
          </Text>
          <Chevron open={currencyOpen} />
        </Flex>
      </Flex>
      {currencyOpen && (
        <Box
          display="grid"
          gridTemplateColumns="repeat(5, 1fr)"
          gap="1"
          mt="1.5"
          mb="1"
        >
          {FIAT_CURRENCIES.map(({ code, symbol }) => {
            const active = currency === code
            return (
              <Box
                key={code}
                as="button"
                py="1"
                borderRadius="md"
                fontWeight={active ? "600" : "400"}
                fontSize="10px"
                lineHeight="1.3"
                textAlign="center"
                bg={active ? "kk.gold" : "transparent"}
                color={active ? "black" : "kk.textSecondary"}
                border="1px solid"
                borderColor={active ? "kk.gold" : "kk.border"}
                cursor="pointer"
                _hover={{
                  bg: active ? "kk.goldHover" : "rgba(192,168,96,0.1)",
                  borderColor: active ? "kk.goldHover" : "kk.textMuted",
                }}
                transition="all 0.12s"
                onClick={() => {
                  setCurrency(code)
                  const cfg = getFiatConfig(code)
                  setLocale(cfg.locale)
                }}
              >
                {code}
              </Box>
            )
          })}
        </Box>
      )}

      {/* Number format row */}
      <Flex
        as="button"
        align="center"
        justify="space-between"
        w="100%"
        cursor="pointer"
        onClick={() => setFormatOpen(o => !o)}
        py="1"
        mt="1"
        borderTop="1px solid"
        borderColor="rgba(255,255,255,0.04)"
        pt="2"
      >
        <Text fontSize="xs" color="kk.textMuted">Number Format</Text>
        <Flex align="center" gap="1.5">
          <Text fontSize="xs" color="kk.textPrimary" fontWeight="500">
            {currentLocale.label}
          </Text>
          <Chevron open={formatOpen} />
        </Flex>
      </Flex>
      {formatOpen && (
        <Flex flexWrap="wrap" gap="1" mt="1.5" mb="1">
          {LOCALE_OPTIONS.map(({ locale: loc, label }) => {
            const active = locale === loc
            return (
              <Box
                key={loc}
                as="button"
                px="2"
                py="0.5"
                borderRadius="md"
                fontWeight={active ? "600" : "400"}
                fontSize="11px"
                lineHeight="1.4"
                bg={active ? "kk.gold" : "transparent"}
                color={active ? "black" : "kk.textSecondary"}
                border="1px solid"
                borderColor={active ? "kk.gold" : "kk.border"}
                cursor="pointer"
                _hover={{
                  bg: active ? "kk.goldHover" : "rgba(192,168,96,0.1)",
                  borderColor: active ? "kk.goldHover" : "kk.textMuted",
                }}
                transition="all 0.12s"
                onClick={() => setLocale(loc)}
              >
                {label}
              </Box>
            )
          })}
        </Flex>
      )}
    </Box>
  )
}
