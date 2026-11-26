/**
 * Setup's Bitcoin-only / Multi-chain choice, before the tutorial cards.
 * Shown only to devices that get the choice (wizardCoinMode). Logos come from
 * the offline icon pack bundled with the app: Bitcoin-only users may set up
 * with no network at all.
 */
import { Box, Flex, Text } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import { AssetIcon } from './AssetIcon'
import { PreflightList, PreflightStyles } from './preflight/PreflightConsole'
import { CARD_CSS } from './TutorialCards'
import type { CoinVariant } from '../../shared/firmware-install'

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
      title: t('coinMode.btcTitle', { defaultValue: 'Bitcoin-only' }),
      version: btcVersion,
      logo: <AssetIcon caip={BTC} alt="BTC" size={52} />,
      lines: [
        t('coinMode.btcLine1', { defaultValue: 'Bitcoin only' }),
        t('coinMode.btcLine2', { defaultValue: 'Smaller code, smaller attack surface' }),
        t('coinMode.btcLine3', { defaultValue: 'Fewer moving parts' }),
      ],
    },
    {
      id: 'multi' as const,
      title: t('coinMode.multiTitle', { defaultValue: 'Multi-chain' }),
      version: multiVersion,
      logo: (
        <Flex>
          {MULTI_LOGOS.map((caip, i) => (
            <Box key={caip} ml={i ? '-10px' : 0} borderRadius="full" boxShadow="0 0 0 2px var(--ink-0)" bg="var(--ink-0)">
              <AssetIcon caip={caip} alt="" size={36} />
            </Box>
          ))}
        </Flex>
      ),
      lines: [
        t('coinMode.multiLine1', { defaultValue: 'Bitcoin, Ethereum, Solana and many more' }),
        t('coinMode.multiLine2', { defaultValue: 'Swaps and dapps' }),
      ],
    },
  ]

  const variantLabel = coinMode === 'bitcoin-only' ? t('coinMode.btcTitle', { defaultValue: 'Bitcoin-only' }) : t('coinMode.multiTitle', { defaultValue: 'Multi-chain' })

  return (
    <Flex direction="column" gap={6} w="100%" fontFamily="var(--font-ui-sans)" css={{ animation: 'tutorialFadeIn 0.3s ease-out' }}>
      <style>{CARD_CSS}</style>
      <PreflightStyles />
      <Box>
        <h2 className="kk-pf-title">{t('coinMode.pageTitle', { defaultValue: 'Choose your KeepKey firmware' })}</h2>
        <p className="kk-pf-sub">{t('coinMode.pageSubtitle', { defaultValue: 'It decides which coins this KeepKey can use.' })}</p>
      </Box>

      {/* Two options on one surface, split by a hairline — no bordered cards.
          Selection: a radio mark plus a gold underline and glow, in the app accent. */}
      <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1px 1fr' }} gap={{ base: 4, md: 8 }} role="radiogroup"
        aria-label={t('coinMode.pageTitle', { defaultValue: 'Choose your KeepKey firmware' })}>
        {options.map((opt, idx) => {
          const selected = coinMode === opt.id
          return [
            idx > 0 && <Box key="rule" display={{ base: 'none', md: 'block' }} bg="linear-gradient(transparent, rgba(255,255,255,.09) 15%, rgba(255,255,255,.09) 85%, transparent)" />,
            <Box
              key={opt.id}
              as="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChoose(opt.id)}
              textAlign="left"
              cursor="pointer"
              bg="transparent"
              border="0"
              p={3}
              borderRadius="14px"
              transition="background 0.15s ease"
              _hover={{ bg: 'rgba(255,255,255,0.025)' }}
              _focusVisible={{ outline: '2px solid var(--gold)', outlineOffset: '3px' }}
            >
              <Flex direction="column" gap={4} align="start">
                <Flex align="center" gap={4}>
                  {/* Radio mark */}
                  <Box w="18px" h="18px" borderRadius="full" flexShrink={0} display="grid" placeItems="center"
                    boxShadow={selected ? 'inset 0 0 0 2px var(--gold)' : 'inset 0 0 0 1.5px rgba(255,255,255,0.28)'}>
                    {selected && <Box w="8px" h="8px" borderRadius="full" bg="var(--gold)" />}
                  </Box>
                  <Box h="52px" display="flex" alignItems="center" filter={selected ? 'drop-shadow(0 0 18px rgba(233,196,106,0.35))' : 'none'} transition="filter 0.2s">
                    {opt.logo}
                  </Box>
                </Flex>
                <Flex gap={2} align="baseline" pb={1} borderBottom="2px solid" borderColor={selected ? 'var(--gold)' : 'transparent'} transition="border-color 0.2s">
                  <Text fontSize="20px" fontWeight="600" color="kk.textPrimary" letterSpacing="-0.02em">{opt.title}</Text>
                  {opt.version && <Text fontSize="12px" fontFamily="var(--font-mono)" color="kk.textMuted">v{opt.version}</Text>}
                </Flex>
                <Box as="ul" listStyleType="none" m={0} p={0} display="grid" gap={1.5}>
                  {opt.lines.map((line) => (
                    <Flex as="li" key={line} gap={2} align="baseline">
                      <Box w="4px" h="4px" borderRadius="full" bg="var(--text-2)" flexShrink={0} transform="translateY(-2px)" />
                      <Text fontSize="14px" color="kk.textSecondary">{line}</Text>
                    </Flex>
                  ))}
                </Box>
              </Flex>
            </Box>,
          ]
        })}
      </Box>

      {/* Risk stays explicit, as one preflight row each. */}
      {((variantUnknown && !coinMode) || coinMode === 'bitcoin-only') && (
        <PreflightList rows={[
          ...(variantUnknown && !coinMode ? [{ key: 'unknown', status: 'warn' as const,
            title: t('coinMode.unknownInstalled', { defaultValue: 'KeepKey Desktop cannot tell which firmware is on this KeepKey. Choose the one you want installed.' }) }] : []),
          ...(coinMode === 'bitcoin-only' ? [{ key: 'one-way', status: 'warn' as const,
            title: t('coinMode.pageWarning', { defaultValue: 'One-way: this KeepKey will only hold Bitcoin. Going back to Multi-chain means wiping it and restoring from your recovery phrase.' }),
            detail: !factoryDevice ? t('coinMode.pageExistingWallet', { defaultValue: 'Your other coins stay safe on your recovery phrase.' }) : undefined }] : []),
        ]} />
      )}

      <div className="kk-pf-actions kk-pf-wrap">
        <button type="button" className="kk-pf-go" disabled={!coinMode} onClick={onContinue} style={{ flex: '0 1 auto' }}>
          {!coinMode
            ? t('coinMode.chooseFirst', { defaultValue: 'Choose Bitcoin-only or Multi-chain' })
            : t('coinMode.continueWith', { defaultValue: 'Continue with {{variant}}', variant: variantLabel })}
        </button>
      </div>
    </Flex>
  )
}
