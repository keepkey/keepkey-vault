import { Flex, Box, Text } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useFiat } from '../lib/fiat-context'
import { FIAT_CURRENCIES } from '../../shared/fiat'
import { validNumberLocale } from '../../shared/locale'

const NUMBER_LOCALES = [...new Set([
  ...FIAT_CURRENCIES.map(c => c.locale), 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pl-PL', 'th-TH', 'tr-TR', 'vi-VN',
])]

export function CurrencySelector() {
  const { t } = useTranslation('common')
  const { locale, setLocale } = useFiat()
  const [open, setOpen] = useState(false)
  const options = NUMBER_LOCALES.includes(locale) ? NUMBER_LOCALES : [locale, ...NUMBER_LOCALES]
  const sample = (value: string) => new Intl.NumberFormat(validNumberLocale(value), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.56)

  return <Box>
    <Flex justify="space-between" py="1">
      <Text fontSize="xs" color="kk.textSecondary">{t('currency')}</Text>
      <Text fontSize="xs" color="kk.textPrimary">USD</Text>
    </Flex>
    <Text fontSize="11px" color="kk.textMuted" mb="2">{t('usdValues')}</Text>
    <Flex as="button" align="center" justify="space-between" w="100%" cursor="pointer" py="2"
      aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Text fontSize="xs" color="kk.textSecondary">{t('numberFormat')}</Text>
      <Text fontSize="xs" color="kk.textPrimary">{sample(locale)} · {locale} {open ? '▴' : '▾'}</Text>
    </Flex>
    {open && <Flex flexWrap="wrap" gap="1" mt="1.5">
      {options.map(value => <Box as="button" key={value} px="2" py="1" borderRadius="md" fontSize="11px"
        aria-pressed={locale === value} bg={locale === value ? 'kk.gold' : 'whiteAlpha.100'}
        color={locale === value ? 'black' : 'kk.textPrimary'} cursor="pointer"
        onClick={() => setLocale(value)}>
        {sample(value)} · {value}
      </Box>)}
    </Flex>}
  </Box>
}
