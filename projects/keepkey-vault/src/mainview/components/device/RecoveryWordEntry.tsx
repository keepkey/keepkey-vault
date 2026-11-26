import { useUiTranslation } from "../../i18n/ui"
import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import type { ReactNode } from "react"
import { Box, Text, VStack, Flex } from "@chakra-ui/react"
import { FaCheckCircle, FaExclamationTriangle } from "react-icons/fa"
import { PreflightStyles } from "../preflight/PreflightConsole"
import { CIPHER_COLS, OledCipher, SpinningDevice } from "../v3"
import { DocsLink } from "../DocsLink"
import { DOCS_LINKS, watch } from "../../../shared/docs-links"

interface RecoveryWordEntryProps {
  wordPos: number
  characterPos: number
  totalWords: number
  onCharacter: (char: string) => void
  onDelete: () => void
  onDone: () => void
  onCancel: () => void
  onRetry?: () => void
  error?: string | null
  errorType?: string | null
}

// Same grid as the KeepKey's own cipher screen: 2 rows of 13, a–m over n–z
// (firmware app_layout.h CIPHER_ROWS / CIPHER_LETTER_BY_ROW), so the user
// finds each letter where they just saw it on the device.
const ALPHABET_ROWS = [
  "abcdefghijklm".split(""),
  "nopqrstuvwxyz".split(""),
]

const MAX_CHARS = 4
const POSITIONS = ALPHABET_ROWS.flat()

/** The same landscape surface as the setup wizard, replacing it while the
 *  cipher entry runs (no modal floating over another frame). */
function Surface({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <Flex position="fixed" inset={0} bg="rgba(11,11,14,0.94)" align="center" justify="center" zIndex={2000}>
      <PreflightStyles />
      <Box role="dialog" aria-modal="true" aria-label={label}
        w={{ base: '100vw', md: 'min(1080px, 94vw)' }} maxH={{ base: '100vh', md: '92vh' }} overflowY="auto"
        bg="var(--ink-0)"
        backgroundImage="radial-gradient(120% 80% at 0% 0%, rgba(233,196,106,.08), transparent 55%), radial-gradient(90% 70% at 100% 100%, rgba(98,126,234,.06), transparent 60%)"
        borderRadius={{ base: 'none', md: '18px' }}
        boxShadow={{ base: 'none', md: 'inset 0 0 0 1px rgba(255,255,255,.06), 0 30px 80px -30px rgba(0,0,0,.8)' }}
        px={{ base: 4, md: 8 }} py={{ base: 5, md: 7 }} fontFamily="var(--font-ui-sans)">
        {children}
      </Box>
    </Flex>
  )
}

const ANIMATIONS_CSS = `
  @keyframes kkWordAccepted {
    0%   { transform: scale(0.8); opacity: 0; }
    50%  { transform: scale(1.1); opacity: 1; }
    100% { transform: scale(1); opacity: 1; }
  }
  @keyframes kkCharPop {
    0%   { transform: scale(0.5); }
    60%  { transform: scale(1.15); }
    100% { transform: scale(1); }
  }
`

export function RecoveryWordEntry({
  wordPos,
  characterPos,
  totalWords,
  onCharacter,
  onDelete,
  onDone,
  onCancel,
  onRetry,
  error,
  errorType,
}: RecoveryWordEntryProps) {
  const uiText = useUiTranslation()

  const { t } = useTranslation("device")
  const [currentChars, setCurrentChars] = useState<string[]>([])
  const [wordAccepted, setWordAccepted] = useState(false)
  const [acceptedWord, setAcceptedWord] = useState(0)
  const [showHelp, setShowHelp] = useState(false)
  const prevWordPos = useRef(wordPos)

  // When wordPos increments, show word-accepted animation then reset
  useEffect(() => {
    if (wordPos > prevWordPos.current) {
      setAcceptedWord(prevWordPos.current + 1) // 1-indexed for display
      setWordAccepted(true)
      const timer = setTimeout(() => {
        setWordAccepted(false)
        setCurrentChars([])
      }, 800)
      prevWordPos.current = wordPos
      return () => clearTimeout(timer)
    }
    if (wordPos < prevWordPos.current) {
      // Back a word: the device dropped the word separator and is editing the
      // previous word again, letters intact. Show as many as it reports.
      setWordAccepted(false)
      setCurrentChars(Array(characterPos).fill("\u2022"))
    }
    prevWordPos.current = wordPos
  }, [wordPos])

  // Sync displayed chars with device's characterPos
  // If device says characterPos < our local count, trim (backspace was applied)
  useEffect(() => {
    if (characterPos < currentChars.length) {
      setCurrentChars((prev) => prev.slice(0, characterPos))
    }
  }, [characterPos])

  const isFinalWord = wordPos === totalWords - 1

  const handleChar = useCallback(
    (char: string) => {
      if (currentChars.length >= MAX_CHARS) return
      setCurrentChars((prev) => [...prev, char])
      onCharacter(char)
    },
    [currentChars.length, onCharacter],
  )

  // On an empty word, Backspace goes back to the previous word: the device
  // deletes the separating space (firmware recovery_delete_character, which
  // also decrements its word count) and asks for the previous word again.
  const canGoBackAWord = currentChars.length === 0 && wordPos > 0
  const handleBackspace = useCallback(() => {
    if (wordAccepted) return
    if (currentChars.length === 0) {
      if (wordPos > 0) onDelete()
      return
    }
    setCurrentChars((prev) => prev.slice(0, -1))
    onDelete()
  }, [currentChars.length, wordPos, wordAccepted, onDelete])

  const handleSubmitWord = useCallback(() => {
    if (isFinalWord) {
      onDone()
    } else {
      // Space character signals word complete to device
      onCharacter(" ")
    }
  }, [isFinalWord, onCharacter, onDone])

  // Keyboard support — disabled when error is shown or word-accepted animation playing
  useEffect(() => {
    if (error || wordAccepted) return
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (key >= "a" && key <= "z" && key.length === 1) {
        e.preventDefault()
        handleChar(key)
      } else if (e.key === "Backspace") {
        e.preventDefault()
        handleBackspace()
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault()
        handleSubmitWord()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [error, wordAccepted, handleChar, handleBackspace, handleSubmitWord])

  const progressPercent = ((wordPos + 1) / totalWords) * 100

  // Error state — recovery failed
  if (error) {
    const isPinMismatch = errorType === 'pin-mismatch'
    const isInvalidMnemonic = errorType === 'invalid-mnemonic'
    const isBadWords = errorType === 'bad-words'
    const isWordNotFound = errorType === 'word-not-found'
    const isCipherError = isInvalidMnemonic || isBadWords

    // Word-not-found: auto-retrying — show a brief warning that will auto-clear
    if (isWordNotFound) {
      return (
        <Surface label={t('recovery.wordNotFoundTitle')}>
          <VStack gap={4} textAlign="center" py={6} maxW="480px" mx="auto">
            <FaExclamationTriangle color="var(--gold)" size={40} />
            <Text fontSize="xl" fontWeight="600" color="kk.warning">{t('recovery.wordNotFoundTitle')}</Text>
            <Text color="kk.textSecondary" fontSize="sm">{t('recovery.wordNotFoundMessage')}</Text>
            <Text color="kk.textMuted" fontSize="xs">{t('recovery.wordNotFoundRestarting')}</Text>
          </VStack>
        </Surface>
      )
    }

    const title = isPinMismatch ? t('recovery.pinMismatchTitle')
      : isCipherError ? t('recovery.incorrectWordsTitle')
      : t('recovery.recoveryFailedTitle')
    const errBorderColor = isPinMismatch ? 'kk.warning' : 'kk.error'
    const iconColor = isPinMismatch ? 'var(--gold)' : 'var(--rose)'

    return (
      <Surface label={title}>
        <Box maxW="560px" mx="auto" borderTop="2px solid" borderColor={errBorderColor} pt={5}>
          <VStack gap={4} textAlign="center">
            <FaExclamationTriangle color={iconColor} size={48} />
            <Text fontSize="xl" fontWeight="bold" color={isPinMismatch ? 'kk.warning' : 'kk.error'}>
              {title}
            </Text>
            <Text color="kk.textSecondary" fontSize="sm">
              {error}
            </Text>

            {isPinMismatch && (
              <Box w="100%" p={4} bg="kk.bg" borderRadius="lg" textAlign="left">
                <Text fontSize="xs" fontWeight="bold" color="kk.warning" mb={2}>
                  {t('recovery.howPinWorks')}
                </Text>
                <VStack align="start" gap={1}>
                  <Text fontSize="xs" color="kk.textSecondary">
                    {t('recovery.pinHelp1')}
                  </Text>
                  <Text fontSize="xs" color="kk.textSecondary">
                    {t('recovery.pinHelp2')}
                  </Text>
                  <Text fontSize="xs" color="kk.textSecondary">
                    {t('recovery.pinHelp3')}
                  </Text>
                </VStack>
              </Box>
            )}

            {isCipherError && (
              <Box w="100%" p={4} bg="kk.bg" borderRadius="lg" textAlign="left">
                <Text fontSize="xs" fontWeight="bold" color="kk.error" mb={2}>
                  {t('recovery.howCipherWorksError')}
                </Text>
                <VStack align="start" gap={1}>
                  <Text fontSize="xs" color="kk.textSecondary">
                    {t('recovery.cipherHelp1')}
                  </Text>
                  <Text fontSize="xs" color="kk.textSecondary">
                    {t('recovery.cipherHelp2')}
                  </Text>
                  <Text fontSize="xs" color="kk.textSecondary">
                    {t('recovery.cipherHelp3')}
                  </Text>
                  <Text fontSize="xs" color="kk.textMuted" fontStyle="italic">
                    {t('recovery.cipherHelp4')}
                  </Text>
                </VStack>
              </Box>
            )}

            {!isPinMismatch && !isCipherError && (
              <Text color="kk.textMuted" fontSize="xs">
                {t('recovery.recoveryInterrupted')}
              </Text>
            )}

            <button type="button" className="kk-pf-go"
              style={{ borderRadius: 999, padding: '12px 24px', border: 0, fontFamily: 'var(--font-mono)', fontSize: 12.5, cursor: 'pointer' }}
              onClick={onRetry || onCancel}>
              {t('recovery.tryAgain')}
            </button>
          </VStack>
        </Box>
      </Surface>
    )
  }

  // Word accepted flash overlay
  if (wordAccepted) {
    return (
      <Surface label={t('recovery.wordAccepted', { number: acceptedWord })}>
        <style>{ANIMATIONS_CSS}</style>
        <VStack gap={4} py={10} style={{ animation: "kkWordAccepted 0.6s ease-out forwards" }}>
          <FaCheckCircle color="var(--gold)" size={56} />
          <Text fontSize="2xl" fontWeight="600" color="kk.textPrimary">
            {t('recovery.wordAccepted', { number: acceptedWord })}
          </Text>
        </VStack>
      </Surface>
    )
  }

  const pill = { borderRadius: 999, padding: '12px 20px', border: 0, fontFamily: 'var(--font-mono)', fontSize: 12.5, whiteSpace: 'nowrap' as const }
  return (
    <Surface label={t('recovery.title')}>
      <style>{ANIMATIONS_CSS}</style>
      <div className="kk-pf-kicker" style={{ marginBottom: 6 }}>{t('recovery.title')}</div>
      <Box display="grid" gridTemplateColumns={{ base: '1fr', md: 'minmax(0,0.9fr) minmax(0,1.1fr)' }} gap={{ base: 6, md: 10 }} alignItems="start">
        {/* ── Left: the device is what the user reads from ── */}
        <Flex direction="column" gap={4}>
          {/* The user reads letters off this screen: it never turns. */}
          <SpinningDevice motion="still" scale={0.9} screen={<OledCipher />} />
          <Text fontSize="14px" color="kk.textSecondary" lineHeight="1.55" maxW="34ch">
            {uiText("Find each letter on your KeepKey, then click the same position here.")}
          </Text>
          <Text fontSize="13px" color="kk.textMuted">{t('recovery.description')}</Text>
          <Box>
            <button type="button" className="kk-pf-link" style={{ color: 'var(--text-2)' }} onClick={() => setShowHelp((v) => !v)}>
              {showHelp ? t('recovery.hideHelp') : t('recovery.howCipherWorks')}
            </button>
            {showHelp && (
              <VStack align="start" gap={2} mt={3} fontSize="12px" color="kk.textSecondary">
                <Text fontWeight="600" color="kk.textPrimary">{t('recovery.cipherRecovery')}</Text>
                <Text>{t('recovery.helpParagraph1')}</Text>
                <Text>{t('recovery.helpParagraph2')}</Text>
                <Text>{t('recovery.helpParagraph3')}</Text>
                <Text color="kk.textMuted" fontStyle="italic">{t('recovery.helpParagraph4')}</Text>
                <Flex gap={4}>
                  <DocsLink href={DOCS_LINKS.cipherRecovery} color="kk.textMuted" fontSize="12px" />
                  <DocsLink href={watch('intro-more-cipher')} label={uiText("Watch video")} color="kk.textMuted" fontSize="12px" />
                </Flex>
              </VStack>
            )}
          </Box>
        </Flex>

        {/* ── Right: progress, the word being entered, the positions ── */}
        <Flex direction="column" gap={5}>
          <Box>
            <Flex justify="space-between" align="baseline">
              <Text fontSize="15px" fontWeight="600" color="kk.textPrimary">{t('recovery.wordOf', { current: wordPos + 1, total: totalWords })}</Text>
              <Text fontSize="12px" fontFamily="var(--font-mono)" color="kk.textMuted">{t('recovery.percentComplete', { percent: Math.round(progressPercent) })}</Text>
            </Flex>
            {/* One tick per word, on a hairline */}
            <Flex mt={2} gap="3px" align="center" aria-hidden="true">
              {Array.from({ length: totalWords }, (_, i) => (
                <Box key={i} flex="1" h={i === wordPos ? '3px' : '1px'}
                  bg={i < wordPos ? 'var(--gold)' : i === wordPos ? 'var(--gold-2)' : 'rgba(255,255,255,0.12)'} borderRadius="full" />
              ))}
            </Flex>
          </Box>

          {/* Letters entered: underlined slots, never boxes */}
          <Flex gap={4} aria-live="polite">
            {Array.from({ length: MAX_CHARS }, (_, i) => {
              const filled = i < currentChars.length
              const active = i === currentChars.length
              return (
                <Flex key={i} w="40px" h="40px" align="flex-end" justify="center" pb="6px"
                  borderBottom="2px solid" borderColor={active ? 'var(--gold)' : filled ? 'var(--text-1)' : 'rgba(255,255,255,0.14)'} transition="border-color 0.15s">
                  {filled && <Text fontSize="22px" lineHeight="1" color="kk.textPrimary" style={{ animation: "kkCharPop 0.2s ease-out" }}>{"\u2022"}</Text>}
                </Flex>
              )
            })}
          </Flex>

          {/* Positions, mirroring the device's 2 x 13 cipher grid: no letters,
              no per-key borders — hairlines like the PIN pad. */}
          <Box display="grid" gridTemplateColumns={`repeat(${CIPHER_COLS}, 1fr)`} borderTop="1px solid rgba(255,255,255,0.1)" borderLeft="1px solid rgba(255,255,255,0.1)">
            {POSITIONS.map((letter, i) => (
              <button key={letter} type="button" className="kk-pf-pos" onClick={() => handleChar(letter)}
                aria-label={uiText("Position {{n}}", { n: i + 1 })}
                disabled={currentChars.length >= MAX_CHARS}>
                <span />
              </button>
            ))}
          </Box>

          <Flex gap={3} align="center" flexWrap="wrap">
            <button type="button" className="kk-pf-outline" style={{ ...pill, cursor: 'pointer' }} onClick={handleBackspace}
              disabled={wordAccepted || (currentChars.length === 0 && wordPos === 0)}>
              {canGoBackAWord ? t('recovery.previousWord', { n: wordPos }) : t('recovery.backspace')}
            </button>
            <button type="button" className="kk-pf-go" style={{ ...pill, cursor: 'pointer' }} onClick={handleSubmitWord}>
              {isFinalWord ? t('recovery.completeRecovery') : t('recovery.nextWord')}
            </button>
            <button type="button" className="kk-pf-cancel" style={{ ...pill, padding: '12px 8px', cursor: 'pointer' }} onClick={onCancel}>
              {t('cancel', { ns: 'common' })}
            </button>
          </Flex>
        </Flex>
      </Box>
    </Surface>
  )
}
