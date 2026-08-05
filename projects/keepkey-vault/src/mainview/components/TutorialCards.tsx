/**
 * TutorialCards — Pre and Post setup tutorial pages for the OOB wizard.
 *
 * Pre-tutorial: PIN, Recovery Phrase, Recovery Cipher (before device setup)
 * Post-tutorial: Verify on Device, REST API, Passphrase (after setup)
 */
import { Box, Text, VStack, HStack, Flex, Button, Spinner } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import { DOCS_LINKS } from '../../shared/docs-links'
import { DocsLink } from './DocsLink'
import {
  FaLock, FaEyeSlash, FaKey, FaPen, FaShieldAlt, FaKeyboard,
  FaCheckCircle, FaDesktop, FaPlug, FaCog, FaUserSecret,
  FaExclamationTriangle, FaArrowRight, FaChevronRight,
} from 'react-icons/fa'

// ── Shared card animations ────────────────────────────────────────────
// Also used by SecurityStepPage and CreateWalletBriefing so the whole
// create-wallet ceremony animates like the tutorial cards.
export const CARD_CSS = `
  @keyframes tutorialFadeIn {
    0% { opacity: 0; transform: translateY(12px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes tutorialPulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.08); }
  }
`

// ── Visual components ─────────────────────────────────────────────────

/** 3x3 scrambled PIN grid */
function PinGrid() {
  const nums = [7, 4, 1, 8, 2, 6, 3, 9, 5] // scrambled
  return (
    <Box bg="rgba(233,196,106,0.1)" border="1px solid rgba(233,196,106,0.3)" borderRadius="lg" p={3}>
      <Flex wrap="wrap" w="96px" gap="2px" justify="center">
        {nums.map((n, i) => (
          <Flex key={i} w="30px" h="30px" bg="rgba(233,196,106,0.15)" borderRadius="md"
            align="center" justify="center" border="1px solid rgba(233,196,106,0.2)">
            <Text fontSize="xs" fontWeight="700" color="var(--gold)">{n}</Text>
          </Flex>
        ))}
      </Flex>
    </Box>
  )
}

/** Word slot visualization — 12 small rectangles */
function WordSlots() {
  return (
    <Flex wrap="wrap" gap="3px" justify="center" maxW="180px">
      {Array.from({ length: 12 }, (_, i) => (
        <Box key={i} w="40px" h="16px" bg="rgba(252,129,129,0.15)" borderRadius="sm"
          border="1px solid rgba(252,129,129,0.3)" position="relative">
          <Text fontSize="7px" color="rgba(252,129,129,0.5)" position="absolute" left="2px" top="1px">{i + 1}</Text>
        </Box>
      ))}
    </Flex>
  )
}

/** Scrambled letter grid */
function CipherGrid() {
  const letters = 'QWFPGJLUYARSTDHNEIOZXCVBKM'.split('')
  return (
    <Box bg="rgba(35,220,200,0.08)" border="1px solid rgba(35,220,200,0.2)" borderRadius="lg" p={2}>
      <Flex wrap="wrap" w="130px" gap="1px" justify="center">
        {letters.slice(0, 18).map((l, i) => (
          <Flex key={i} w="20px" h="20px" bg="rgba(35,220,200,0.1)" borderRadius="sm"
            align="center" justify="center" border="1px solid rgba(35,220,200,0.15)">
            <Text fontSize="8px" fontWeight="600" color="var(--teal)">{l}</Text>
          </Flex>
        ))}
      </Flex>
    </Box>
  )
}

/** Toggle switch in OFF position */
function ToggleOff() {
  return (
    <Box w="48px" h="26px" bg="rgba(99,99,99,0.4)" borderRadius="full" position="relative"
      border="1px solid rgba(255,255,255,0.1)">
      <Box w="20px" h="20px" bg="rgba(255,255,255,0.3)" borderRadius="full"
        position="absolute" left="2px" top="2px" />
    </Box>
  )
}

/** Two wallet icons — visible and hidden */
function DualWallets() {
  const { t } = useTranslation('setup')

  return (
    <HStack gap={3}>
      <VStack gap={0.5}>
        <Box w="36px" h="28px" bg="rgba(139,92,246,0.15)" borderRadius="md"
          border="1px solid rgba(139,92,246,0.3)" display="flex" alignItems="center" justifyContent="center">
          <Text fontSize="xs" color="#8B5CF6">A</Text>
        </Box>
        <Text fontSize="7px" color="gray.500">{t('tutorial.walletLabels.visible')}</Text>
      </VStack>
      <FaArrowRight size={10} color="rgba(139,92,246,0.4)" />
      <VStack gap={0.5}>
        <Box w="36px" h="28px" bg="rgba(139,92,246,0.08)" borderRadius="md"
          border="1px dashed rgba(139,92,246,0.3)" display="flex" alignItems="center" justifyContent="center">
          <Text fontSize="xs" color="rgba(139,92,246,0.5)">?</Text>
        </Box>
        <Text fontSize="7px" color="gray.500">{t('tutorial.walletLabels.hidden')}</Text>
      </VStack>
    </HStack>
  )
}

/** Device outline with checkmark */
function DeviceCheck() {
  return (
    <Box w="48px" h="72px" bg="rgba(72,187,120,0.08)" borderRadius="lg"
      border="2px solid rgba(72,187,120,0.3)" display="flex" alignItems="center" justifyContent="center"
      position="relative">
      <FaCheckCircle color="var(--teal)" size={18} />
      <Box position="absolute" bottom="-2px" left="50%" transform="translateX(-50%)"
        w="20px" h="4px" bg="rgba(72,187,120,0.2)" borderRadius="full" />
    </Box>
  )
}

// ── Card definitions ──────────────────────────────────────────────────

interface TutorialCard {
  titleKey: string
  bodyKey: string
  accent: string
  icon1: React.ReactNode
  icon2: React.ReactNode
  icon3: React.ReactNode
  // Renders an inline opt-in toggle (currently only the passphrase card) so the
  // user can act on the explanation right here instead of hunting in Settings.
  interactive?: 'passphrase'
  // Hides the Skip button — the user must make a choice and continue. Skipping
  // earlier cards routes here (see OobSetupWizard) so this card can't be bypassed.
  nonSkippable?: boolean
  // docs.keepkey.com article for this card. The page quotes this card's copy
  // verbatim, so the user recognises where they came from.
  helpUrl?: string
}

const PRE_CARDS: TutorialCard[] = [
  {
    titleKey: 'tutorial.cards.pin.title',
    helpUrl: DOCS_LINKS.pinScrambled,
    bodyKey: 'tutorial.cards.pin.body',
    accent: 'var(--gold)',
    icon1: <FaLock size={28} color="var(--gold)" />,
    icon2: <PinGrid />,
    icon3: <FaEyeSlash size={22} color="rgba(233,196,106,0.6)" />,
  },
  {
    titleKey: 'tutorial.cards.words.title',
    helpUrl: DOCS_LINKS.recoveryWords,
    bodyKey: 'tutorial.cards.words.body',
    accent: '#FC8181',
    icon1: <FaKey size={28} color="var(--rose)" />,
    icon2: <WordSlots />,
    icon3: <FaPen size={22} color="rgba(252,129,129,0.6)" />,
  },
  {
    titleKey: 'tutorial.cards.recovery.title',
    helpUrl: DOCS_LINKS.cipherRecovery,
    bodyKey: 'tutorial.cards.recovery.body',
    accent: '#23DCC8',
    icon1: <FaShieldAlt size={28} color="var(--teal)" />,
    icon2: <CipherGrid />,
    icon3: <FaKeyboard size={22} color="rgba(35,220,200,0.6)" />,
  },
]

const POST_CARDS: TutorialCard[] = [
  {
    titleKey: 'tutorial.cards.deviceScreen.title',
    helpUrl: DOCS_LINKS.deviceScreen,
    bodyKey: 'tutorial.cards.deviceScreen.body',
    accent: '#48BB78',
    icon1: <FaCheckCircle size={28} color="var(--teal)" />,
    icon2: <DeviceCheck />,
    icon3: <Box position="relative" display="inline-flex">
      <FaDesktop size={22} color="rgba(72,187,120,0.5)" />
      <Box position="absolute" top="-4px" right="-6px">
        <FaExclamationTriangle size={10} color="#ECC94B" />
      </Box>
    </Box>,
  },
  {
    titleKey: 'tutorial.cards.appConnections.title',
    helpUrl: DOCS_LINKS.appConnections,
    bodyKey: 'tutorial.cards.appConnections.body',
    accent: '#627EEA',
    icon1: <FaPlug size={28} color="#627EEA" />,
    icon2: <ToggleOff />,
    icon3: <FaCog size={22} color="rgba(98,126,234,0.6)" />,
  },
  {
    titleKey: 'tutorial.cards.hiddenWallets.title',
    helpUrl: DOCS_LINKS.hiddenWallets,
    bodyKey: 'tutorial.cards.hiddenWallets.body',
    accent: '#8B5CF6',
    icon1: <FaUserSecret size={28} color="#8B5CF6" />,
    icon2: <DualWallets />,
    icon3: <FaExclamationTriangle size={22} color="rgba(139,92,246,0.6)" />,
    interactive: 'passphrase',
    nonSkippable: true,
  },
]

/** Interactive on/off switch for the in-card passphrase opt-in. */
function CardToggle({ checked, onChange, accent, disabled }: { checked: boolean; onChange: (v: boolean) => void; accent: string; disabled?: boolean }) {
  return (
    <Box
      as="button"
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      w="44px" h="24px" borderRadius="full" flexShrink={0} position="relative"
      bg={checked ? accent : 'rgba(255,255,255,0.18)'}
      transition="background 0.2s"
      cursor={disabled ? 'not-allowed' : 'pointer'}
      opacity={disabled ? 0.5 : 1}
    >
      <Box position="absolute" top="2px" left={checked ? '22px' : '2px'} w="20px" h="20px"
        borderRadius="full" bg="white" transition="left 0.2s" boxShadow="0 1px 3px rgba(0,0,0,0.4)" />
    </Box>
  )
}

// ── Render ────────────────────────────────────────────────────────────

interface TutorialPageProps {
  type: 'pre' | 'post'
  cardIndex: number
  onNext: () => void
  onSkip: () => void
  // Opt-in state for the interactive 'passphrase' card. Owned by the wizard so
  // the choice can be applied (applySettings) when the user clicks Continue.
  passphraseEnabled?: boolean
  onPassphraseToggle?: (enabled: boolean) => void
  // Shows a spinner / disables the Next button while the choice is being applied.
  nextPending?: boolean
}

export function TutorialPage({ type, cardIndex, onNext, onSkip, passphraseEnabled = false, onPassphraseToggle, nextPending = false }: TutorialPageProps) {
  const { t } = useTranslation('setup')
  const cards = type === 'pre' ? PRE_CARDS : POST_CARDS
  const card = cards[cardIndex]
  if (!card) return null
  const isLast = cardIndex === cards.length - 1
  const isPassphrase = card.interactive === 'passphrase'
  const showSkip = !card.nonSkippable
  const nextLabel = isLast
    ? t(type === 'pre' ? 'tutorial.actions.getStarted' : 'tutorial.actions.startUsing')
    : t('footer.next')
  const skipLabel = t(type === 'pre' ? 'tutorial.actions.skipIntro' : 'tutorial.actions.skipTips')

  return (
    <VStack gap={4} w="100%" maxW="400px" mx="auto" css={{ animation: 'tutorialFadeIn 0.3s ease-out' }}>
      <style>{CARD_CSS}</style>

      {/* Progress dots */}
      <HStack gap={2}>
        {cards.map((_, i) => (
          <Box key={i} w={i === cardIndex ? '24px' : '8px'} h="8px"
            borderRadius="full" transition="all 0.3s"
            bg={i === cardIndex ? card.accent : 'rgba(255,255,255,0.15)'} />
        ))}
      </HStack>

      {/* Card */}
      <Box w="100%" bg="rgba(255,255,255,0.03)" border="1px solid" borderColor={`${card.accent}33`}
        borderRadius="2xl" p={6} position="relative" overflow="hidden">

        {/* Subtle accent glow */}
        <Box position="absolute" top="-50px" right="-50px" w="150px" h="150px"
          borderRadius="full" bg={`${card.accent}08`} filter="blur(40px)" />

        <VStack gap={4}>
          {/* Icon trio */}
          <HStack gap={6} justify="center" align="center">
            <Box opacity={0.7}>{card.icon3}</Box>
            <Box css={{ animation: 'tutorialPulse 2s ease-in-out infinite' }}>{card.icon1}</Box>
            <Box>{card.icon2}</Box>
          </HStack>

          {/* Title */}
          <Text fontSize="xl" fontWeight="800" color="white" textAlign="center" letterSpacing="-0.02em">
            {t(card.titleKey)}
          </Text>

          {/* Body */}
          <Text fontSize="sm" color="gray.400" textAlign="center" lineHeight="1.6" maxW="340px">
            {t(card.bodyKey)}
          </Text>

          {/* Inline passphrase opt-in (interactive card only) */}
          {isPassphrase && (
            <VStack gap={2} w="100%" pt={1}>
              <Flex w="100%" align="center" justify="space-between" gap={3}
                bg="rgba(255,255,255,0.04)" border="1px solid" borderColor={`${card.accent}33`}
                borderRadius="xl" px={4} py={3}>
                <Text fontSize="sm" fontWeight="600" color="white" textAlign="left">
                  {t('tutorial.cards.hiddenWallets.toggleLabel', { defaultValue: 'Enable passphrase protection' })}
                </Text>
                <CardToggle
                  checked={passphraseEnabled}
                  onChange={(v) => onPassphraseToggle?.(v)}
                  accent={card.accent}
                  disabled={nextPending}
                />
              </Flex>
              <Text fontSize="xs" color="gray.500" textAlign="center" maxW="340px">
                {t('tutorial.cards.hiddenWallets.settingsHint', { defaultValue: 'You can turn this on or off anytime in Settings.' })}
              </Text>
            </VStack>
          )}
        </VStack>
      </Box>

      {/* Actions */}
      <VStack gap={2} w="100%">
        <Button w="100%" size="md" bg={card.accent} color="black" fontWeight="700"
          _hover={{ opacity: 0.9, transform: 'translateY(-1px)', boxShadow: `0 4px 16px ${card.accent}40` }}
          _active={{ transform: 'scale(0.98)' }} transition="all 0.15s ease"
          onClick={onNext} disabled={nextPending}
        >
          <HStack gap={2} justify="center">
            {nextPending && <Spinner size="sm" />}
            <Text>{nextLabel}</Text>
            {!nextPending && <FaChevronRight size={10} />}
          </HStack>
        </Button>
        {showSkip && (
          <Button w="100%" size="sm" variant="ghost" color="gray.500" fontWeight="500"
            _hover={{ color: 'gray.300', bg: 'rgba(255,255,255,0.04)' }}
            transition="all 0.15s ease" onClick={onSkip}
          >
            {skipLabel}
          </Button>
        )}
      </VStack>

      {/* Step counter + docs link for this card */}
      <HStack gap={3} align="center">
        <Text fontSize="2xs" color="gray.600">
          {t('tutorial.stepCounter', { current: cardIndex + 1, total: cards.length })}
        </Text>
        {card.helpUrl && <DocsLink href={card.helpUrl} color="gray.600" />}
      </HStack>
    </VStack>
  )
}
