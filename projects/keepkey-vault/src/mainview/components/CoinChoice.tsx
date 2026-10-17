/**
 * Setup's Bitcoin-only / Multi-chain choice, before the tutorial cards.
 * Shown only to devices that get the choice (wizardCoinMode). Logos come from
 * the offline icon pack bundled with the app: Bitcoin-only users may set up
 * with no network at all.
 */
import { Box, Button, Flex, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import { FaCheck, FaChevronRight, FaExclamationTriangle } from 'react-icons/fa'
import { caipToIcon } from '../../shared/assetLookup'
import { CARD_CSS } from './TutorialCards'
import type { CoinVariant } from '../../shared/firmware-install'

const GOLD = '#E9C46A'
const BTC = 'bip122:000000000019d6689c085ae165831e93/slip44:0'
const MULTI_LOGOS = [
  BTC,
  'eip155:1/slip44:60',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
  'cosmos:cosmoshub-4/slip44:118',
  'cosmos:thorchain-mainnet-v1/slip44:931',
  'bip122:00000000001a91e3dace36e2be3bf030/slip44:3',
  'bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2',
  'ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144',
]

export function CoinChoice({ coinMode, multiVersion, btcVersion, variantUnknown, factoryDevice, onChoose, onContinue }: {
  coinMode: CoinVariant | null
  multiVersion?: string
  btcVersion?: string
  variantUnknown: boolean
  factoryDevice: boolean
  onChoose: (mode: CoinVariant) => void
  onContinue: () => void
}) {
  const { t } = useTranslation('setup')
  const options = [
    {
      id: 'bitcoin-only' as const,
      accent: '#F7931A',
      title: t('coinMode.btcTitle', { defaultValue: 'Bitcoin-only' }),
      version: btcVersion,
      logo: <img src={caipToIcon(BTC)} alt="" width={64} height={64} />,
      lines: [
        t('coinMode.btcLine1', { defaultValue: 'Bitcoin only' }),
        t('coinMode.btcLine2', { defaultValue: 'Smaller code, smaller attack surface' }),
        t('coinMode.btcLine3', { defaultValue: 'Fewer moving parts' }),
      ],
    },
    {
      id: 'multi' as const,
      accent: '#8BE3C4',
      title: t('coinMode.multiTitle', { defaultValue: 'Multi-chain' }),
      version: multiVersion,
      logo: (
        <Flex>
          {MULTI_LOGOS.map((caip, i) => (
            <img key={caip} src={caipToIcon(caip)} alt="" width={40} height={40}
              style={{ marginLeft: i ? -10 : 0, borderRadius: '50%', border: '2px solid var(--ink-1)', background: 'var(--ink-1)' }} />
          ))}
        </Flex>
      ),
      lines: [
        t('coinMode.multiLine1', { defaultValue: 'Bitcoin, Ethereum, Solana and more' }),
        t('coinMode.multiLine2', { defaultValue: 'Every chain KeepKey Desktop supports' }),
        t('coinMode.multiLine3', { defaultValue: 'Swaps and dapps' }),
      ],
    },
  ]

  return (
    <VStack gap={5} w="100%" css={{ animation: 'tutorialFadeIn 0.3s ease-out' }}>
      <style>{CARD_CSS}</style>
      <VStack gap={1.5} textAlign="center">
        <Text fontSize="2xl" fontWeight="800" color="white" letterSpacing="-0.02em">
          {t('coinMode.pageTitle', { defaultValue: 'Choose your KeepKey firmware' })}
        </Text>
        <Text fontSize="sm" color="gray.400">
          {t('coinMode.pageSubtitle', { defaultValue: 'It decides which coins this KeepKey can use.' })}
        </Text>
      </VStack>

      {variantUnknown && !coinMode && (
        <Text fontSize="sm" color="yellow.300" textAlign="center">
          {t('coinMode.unknownInstalled', { defaultValue: 'KeepKey Desktop cannot tell which firmware is on this KeepKey. Choose the one you want installed.' })}
        </Text>
      )}

      <SimpleGrid columns={{ base: 1, md: 2 }} gap={4} w="100%">
        {options.map((opt) => {
          const selected = coinMode === opt.id
          return (
            <Box
              key={opt.id}
              as="button"
              aria-pressed={selected}
              onClick={() => onChoose(opt.id)}
              position="relative"
              textAlign="left"
              cursor="pointer"
              p={6}
              borderRadius="2xl"
              borderWidth="2px"
              borderColor={selected ? opt.accent : 'rgba(255,255,255,0.08)'}
              bg={selected ? `${opt.accent}14` : 'rgba(255,255,255,0.03)'}
              boxShadow={selected ? `0 0 0 4px ${opt.accent}22, 0 8px 32px ${opt.accent}26` : 'none'}
              transition="all 0.15s ease"
              _hover={{ borderColor: selected ? opt.accent : `${opt.accent}66` }}
              _focusVisible={{ outline: `2px solid ${opt.accent}`, outlineOffset: '3px' }}
            >
              {selected && (
                <Flex position="absolute" top={4} right={4} w="26px" h="26px" borderRadius="full"
                  bg={opt.accent} color="black" align="center" justify="center">
                  <FaCheck size={12} />
                </Flex>
              )}
              <VStack gap={4} align="start">
                <Flex h="64px" align="center">{opt.logo}</Flex>
                <HStack gap={2} align="baseline">
                  <Text fontSize="xl" fontWeight="800" color="white" letterSpacing="-0.02em">{opt.title}</Text>
                  {opt.version && <Text fontSize="sm" fontWeight="600" color={opt.accent}>v{opt.version}</Text>}
                </HStack>
                <VStack gap={1.5} align="start">
                  {opt.lines.map((line) => (
                    <HStack key={line} gap={2}>
                      <Box color={opt.accent} flexShrink={0}><FaCheck size={11} /></Box>
                      <Text fontSize="sm" color="gray.300">{line}</Text>
                    </HStack>
                  ))}
                </VStack>
              </VStack>
            </Box>
          )
        })}
      </SimpleGrid>

      {coinMode === 'bitcoin-only' && (
        <HStack w="100%" p={3} gap={2} borderRadius="lg" bg="rgba(237,137,54,0.12)" align="start">
          <FaExclamationTriangle color="var(--chakra-colors-yellow-400)" size={14} style={{ flexShrink: 0, marginTop: 3 }} />
          <Text fontSize="xs" color="yellow.300" lineHeight="1.5">
            {t('coinMode.warning', { defaultValue: 'This is one-way. A Bitcoin-only wallet cannot later hold ETH or other assets without wiping the device and reinstalling multi-chain firmware.' })}
            {!factoryDevice && ' ' + t('coinMode.existingWallet', { defaultValue: 'If this KeepKey already holds a wallet, it keeps working for Bitcoin. Its other coins stay on your recovery phrase, but this KeepKey cannot use them, and going back to Multi-chain firmware later can mean wiping it and restoring from the recovery phrase.' })}
          </Text>
        </HStack>
      )}

      <Button w="100%" maxW="360px" size="md" bg={GOLD} color="black" fontWeight="700"
        _hover={{ opacity: 0.9, transform: 'translateY(-1px)' }} _active={{ transform: 'scale(0.98)' }}
        transition="all 0.15s ease" disabled={!coinMode} onClick={onContinue}>
        <Flex gap={2} align="center" justify="center">
          <Text>
            {!coinMode
              ? t('coinMode.chooseFirst', { defaultValue: 'Choose Bitcoin-only or Multi-chain' })
              : t('coinMode.continueWith', {
                defaultValue: 'Continue with {{variant}}',
                variant: coinMode === 'bitcoin-only' ? t('coinMode.btcTitle', { defaultValue: 'Bitcoin-only' }) : t('coinMode.multiTitle', { defaultValue: 'Multi-chain' }),
              })}
          </Text>
          {coinMode && <FaChevronRight size={10} />}
        </Flex>
      </Button>
    </VStack>
  )
}
