/**
 * TutorialCards — Pre and Post setup tutorial pages for the OOB wizard.
 *
 * Pre-tutorial: PIN, Recovery Phrase, Recovery Cipher (before device setup)
 * Post-tutorial: Verify on Device, REST API, Passphrase (after setup)
 */
import { Box, Text, VStack, HStack, Flex, Button } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import {
  FaLock, FaEyeSlash, FaKey, FaPen, FaShieldAlt, FaKeyboard,
  FaCheckCircle, FaDesktop, FaPlug, FaCog, FaUserSecret,
  FaExclamationTriangle, FaArrowRight, FaChevronRight,
} from 'react-icons/fa'

// ── Shared card animations ────────────────────────────────────────────
const CARD_CSS = `
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
}

const PRE_CARDS: TutorialCard[] = [
  {
    titleKey: 'tutorial.cards.pin.title',
    bodyKey: 'tutorial.cards.pin.body',
    accent: 'var(--gold)',
    icon1: <FaLock size={28} color="var(--gold)" />,
    icon2: <PinGrid />,
    icon3: <FaEyeSlash size={22} color="rgba(233,196,106,0.6)" />,
  },
  {
    titleKey: 'tutorial.cards.words.title',
    bodyKey: 'tutorial.cards.words.body',
    accent: '#FC8181',
    icon1: <FaKey size={28} color="var(--rose)" />,
    icon2: <WordSlots />,
    icon3: <FaPen size={22} color="rgba(252,129,129,0.6)" />,
  },
  {
    titleKey: 'tutorial.cards.recovery.title',
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
    bodyKey: 'tutorial.cards.appConnections.body',
    accent: '#627EEA',
    icon1: <FaPlug size={28} color="#627EEA" />,
    icon2: <ToggleOff />,
    icon3: <FaCog size={22} color="rgba(98,126,234,0.6)" />,
  },
  {
    titleKey: 'tutorial.cards.hiddenWallets.title',
    bodyKey: 'tutorial.cards.hiddenWallets.body',
    accent: '#8B5CF6',
    icon1: <FaUserSecret size={28} color="#8B5CF6" />,
    icon2: <DualWallets />,
    icon3: <FaExclamationTriangle size={22} color="rgba(139,92,246,0.6)" />,
  },
]

// ── Render ────────────────────────────────────────────────────────────

interface TutorialPageProps {
  type: 'pre' | 'post'
  cardIndex: number
  onNext: () => void
  onSkip: () => void
}

export function TutorialPage({ type, cardIndex, onNext, onSkip }: TutorialPageProps) {
  const { t } = useTranslation('setup')
  const cards = type === 'pre' ? PRE_CARDS : POST_CARDS
  const card = cards[cardIndex]
  if (!card) return null
  const isLast = cardIndex === cards.length - 1
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
        </VStack>
      </Box>

      {/* Actions */}
      <VStack gap={2} w="100%">
        <Button w="100%" size="md" bg={card.accent} color="black" fontWeight="700"
          _hover={{ opacity: 0.9, transform: 'translateY(-1px)', boxShadow: `0 4px 16px ${card.accent}40` }}
          _active={{ transform: 'scale(0.98)' }} transition="all 0.15s ease"
          onClick={onNext}
        >
          <HStack gap={2} justify="center">
            <Text>{nextLabel}</Text>
            <FaChevronRight size={10} />
          </HStack>
        </Button>
        <Button w="100%" size="sm" variant="ghost" color="gray.500" fontWeight="500"
          _hover={{ color: 'gray.300', bg: 'rgba(255,255,255,0.04)' }}
          transition="all 0.15s ease" onClick={onSkip}
        >
          {skipLabel}
        </Button>
      </VStack>

      {/* Step counter */}
      <Text fontSize="2xs" color="gray.600">
        {t('tutorial.stepCounter', { current: cardIndex + 1, total: cards.length })}
      </Text>
    </VStack>
  )
}
