import { Flex, Box, Text } from "@chakra-ui/react"
import { useFiat } from "../lib/fiat-context"
import { FIAT_CURRENCIES, getFiatConfig } from "../../shared/fiat"
import type { FiatCurrency } from "../../shared/types"

const LOCALE_OPTIONS: { locale: string; label: string }[] = [
  { locale: 'en-US', label: '1,234.56 (US)' },
  { locale: 'de-DE', label: '1.234,56 (EU)' },
  { locale: 'fr-FR', label: '1\u202F234,56 (FR)' },
  { locale: 'en-IN', label: '1,23,456.78 (IN)' },
  { locale: 'ja-JP', label: '1,234 (JP)' },
  { locale: 'pt-BR', label: '1.234,56 (BR)' },
]

export function CurrencySelector() {
  const { currency, locale, setCurrency, setLocale } = useFiat()

  return (
    <Box>
      {/* Fiat currency grid */}
      <Text fontSize="xs" color="kk.textMuted" mb="2">Currency</Text>
      <Flex flexWrap="wrap" gap="2" mb="4">
        {FIAT_CURRENCIES.map(({ code, symbol, name }) => {
          const active = currency === code
          return (
            <Box
              key={code}
              as="button"
              px="3"
              py="1.5"
              borderRadius="full"
              fontWeight={active ? "600" : "400"}
              fontSize="xs"
              bg={active ? "kk.gold" : "transparent"}
              color={active ? "black" : "kk.textSecondary"}
              border="1px solid"
              borderColor={active ? "kk.gold" : "kk.border"}
              cursor="pointer"
              _hover={{
                bg: active ? "kk.goldHover" : "rgba(192,168,96,0.1)",
                borderColor: active ? "kk.goldHover" : "kk.textMuted",
              }}
              transition="all 0.15s"
              onClick={() => {
                setCurrency(code)
                // Auto-set locale to currency's default locale
                const cfg = getFiatConfig(code)
                setLocale(cfg.locale)
              }}
              title={name}
            >
              {symbol} {code}
            </Box>
          )
        })}
      </Flex>

      {/* Number format */}
      <Text fontSize="xs" color="kk.textMuted" mb="2">Number Format</Text>
      <Flex flexWrap="wrap" gap="2">
        {LOCALE_OPTIONS.map(({ locale: loc, label }) => {
          const active = locale === loc
          return (
            <Box
              key={loc}
              as="button"
              px="3"
              py="1.5"
              borderRadius="full"
              fontWeight={active ? "600" : "400"}
              fontSize="xs"
              bg={active ? "kk.gold" : "transparent"}
              color={active ? "black" : "kk.textSecondary"}
              border="1px solid"
              borderColor={active ? "kk.gold" : "kk.border"}
              cursor="pointer"
              _hover={{
                bg: active ? "kk.goldHover" : "rgba(192,168,96,0.1)",
                borderColor: active ? "kk.goldHover" : "kk.textMuted",
              }}
              transition="all 0.15s"
              onClick={() => setLocale(loc)}
            >
              {label}
            </Box>
          )
        })}
      </Flex>
    </Box>
  )
}
