/**
 * TutorialCards — Pre and Post setup tutorial pages for the OOB wizard.
 *
 * Pre-tutorial: PIN, Recovery Phrase, Recovery Cipher (before device setup)
 * Post-tutorial: Verify on Device, REST API, Passphrase (after setup)
 */
import type { ReactNode } from 'react'
import { Box, Text, Flex, Spinner } from '@chakra-ui/react'
import { useTranslation } from 'react-i18next'
import { useUiTranslation } from '../i18n/ui'
import { DOCS_LINKS } from '../../shared/docs-links'
import { DocsLink } from './DocsLink'
import { PreflightList, PreflightStyles } from './preflight/PreflightConsole'
import { OledCipher, OledPin, OledText, SpinningDevice } from './v3'

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

// ── Device screens (what the KeepKey itself shows) ────────────────────
// Every slide uses the same gold accent and layout; colour is semantic only
// where there is real risk (the "never type your words" row).

const PIN_DIGITS = [7, 4, 1, 8, 2, 6, 3, 9, 5] // scrambled

/** The word itself stays blurred: never show a real-looking word. */
function BlurredWord() {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {Array.from({ length: 7 }, (_, i) => <span key={i} style={{ width: 14, height: 18, background: 'rgba(232,230,220,0.32)', borderRadius: 2 }} />)}
    </span>
  )
}

// ── Card definitions ──────────────────────────────────────────────────

interface TutorialCard {
  titleKey: string
  bodyKey: string
  /** Short two-sentence lede replacing the long body (pre-setup cards). */
  lede?: string
  /** What the KeepKey screen shows (SpinningDevice `screen` slot). */
  screen: ReactNode
  /** The user has to read this screen: keep the device facing front. */
  readable?: boolean
  /** A real-risk line, shown as the only semantic-red row. */
  danger?: string
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
    lede: 'Your KeepKey shows the numbers. Click the same positions here.',
    screen: <OledPin digits={PIN_DIGITS} />,
    readable: true,
  },
  {
    titleKey: 'tutorial.cards.words.title',
    helpUrl: DOCS_LINKS.recoveryWords,
    bodyKey: 'tutorial.cards.words.body',
    lede: 'Write the words on paper. Anyone with them controls your funds.',
    screen: <OledText kicker="WORD 1 OF 12" headline={<BlurredWord />} />,
    readable: true,
    danger: 'Never type them into a computer, website or phone',
  },
  {
    titleKey: 'tutorial.cards.recovery.title',
    helpUrl: DOCS_LINKS.cipherRecovery,
    bodyKey: 'tutorial.cards.recovery.body',
    lede: 'You pick letters by position. A keylogger sees nothing useful.',
    screen: <OledCipher />,
    readable: true,
  },
]

const POST_CARDS: TutorialCard[] = [
  {
    titleKey: 'tutorial.cards.deviceScreen.title',
    helpUrl: DOCS_LINKS.deviceScreen,
    bodyKey: 'tutorial.cards.deviceScreen.body',
    screen: <OledText kicker="CONFIRM ON DEVICE" headline="CHECK EVERY DETAIL" />,
  },
  {
    titleKey: 'tutorial.cards.appConnections.title',
    helpUrl: DOCS_LINKS.appConnections,
    bodyKey: 'tutorial.cards.appConnections.body',
    screen: <OledText kicker="APP CONNECTIONS" headline="OFF BY DEFAULT" />,
  },
  {
    titleKey: 'tutorial.cards.hiddenWallets.title',
    helpUrl: DOCS_LINKS.hiddenWallets,
    bodyKey: 'tutorial.cards.hiddenWallets.body',
    screen: <OledText kicker="ENTER PASSPHRASE" headline="••••••••" />,
    interactive: 'passphrase',
    nonSkippable: true,
  },
]

/** Interactive on/off switch for the in-card passphrase opt-in. */
function CardToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Box
      as="button"
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      w="44px" h="24px" borderRadius="full" flexShrink={0} position="relative"
      bg={checked ? 'var(--gold)' : 'rgba(255,255,255,0.18)'}
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
  const uiText = useUiTranslation()
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
    <Box key={`${type}-${cardIndex}`} w="100%" fontFamily="var(--font-ui-sans)" css={{ animation: 'tutorialFadeIn 0.3s ease-out' }}>
      <style>{CARD_CSS}</style>
      <PreflightStyles />
      <Box display="grid" gridTemplateColumns={{ base: '1fr', md: 'minmax(0,1fr) minmax(0,1fr)' }} gap={{ base: 6, md: 10 }} alignItems="center">
        {/* Device as the hero, its app-side counterpart beside it. */}
        <Flex direction="column" gap={5} align={{ base: 'center', md: 'flex-start' }}>
          {/* Screens the user must read stay facing front; the rest sway slowly. */}
          <SpinningDevice screen={card.screen} motion={card.readable ? 'still' : 'sway'} durationSeconds={9} scale={1.05} />
        </Flex>

        <Flex direction="column" gap={4}>
          {/* Progress as text over a hairline */}
          <Box>
            <Text fontFamily="var(--font-mono)" fontSize="11px" letterSpacing="0.2em" color="kk.textMuted">
              {cardIndex + 1} / {cards.length}
            </Text>
            <Box mt={2} h="1px" bg="rgba(255,255,255,0.08)" position="relative">
              <Box position="absolute" left={0} top={0} h="1px" bg="var(--gold)" w={`${((cardIndex + 1) / cards.length) * 100}%`} transition="width 0.3s" />
            </Box>
          </Box>
          <Box>
            <h2 className="kk-pf-title">{t(card.titleKey)}</h2>
            <p className="kk-pf-sub">{card.lede ? uiText(card.lede) : t(card.bodyKey)}</p>
          </Box>
          {card.danger && <PreflightList rows={[{ key: 'danger', status: 'danger', title: uiText(card.danger) }]} />}

          {/* Inline passphrase opt-in (interactive card only) */}
          {isPassphrase && (
            <Box>
              <Flex align="center" justify="space-between" gap={3} py={3} borderTop="1px solid rgba(255,255,255,0.06)" borderBottom="1px solid rgba(255,255,255,0.06)">
                <Text fontSize="14px" fontWeight="600" color="kk.textPrimary">
                  {t('tutorial.cards.hiddenWallets.toggleLabel', { defaultValue: 'Enable passphrase protection' })}
                </Text>
                <CardToggle checked={passphraseEnabled} onChange={(v) => onPassphraseToggle?.(v)} disabled={nextPending} />
              </Flex>
              <Text mt={2} fontSize="12px" color="kk.textMuted">
                {t('tutorial.cards.hiddenWallets.settingsHint', { defaultValue: 'You can turn this on or off anytime in Settings.' })}
              </Text>
            </Box>
          )}

          <Flex align="center" gap={5} flexWrap="wrap" mt={1}>
            <button type="button" className="kk-pf-go" style={{ borderRadius: 999, padding: '12px 22px', border: 0, fontFamily: 'var(--font-mono)', fontSize: 12.5, cursor: nextPending ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
              onClick={onNext} disabled={nextPending}>
              {nextPending && <Spinner size="xs" mr={2} />}{nextLabel}
            </button>
            {showSkip && (
              <button type="button" className="kk-pf-cancel" style={{ border: 0, padding: '4px 0', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-ui-sans)' }} onClick={onSkip}>
                {skipLabel}
              </button>
            )}
            {card.helpUrl && <DocsLink href={card.helpUrl} color="kk.textMuted" fontSize="12px" />}
          </Flex>
        </Flex>
      </Box>
    </Box>
  )
}
