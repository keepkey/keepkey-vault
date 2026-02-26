import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Box, Text, VStack, Flex, Button, HStack } from "@chakra-ui/react"
import { FaCheckCircle, FaExclamationTriangle } from "react-icons/fa"

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

const ALPHABET_ROWS = [
  ["a", "b", "c", "d", "e", "f"],
  ["g", "h", "i", "j", "k", "l"],
  ["m", "n", "o", "p", "q", "r"],
  ["s", "t", "u", "v", "w", "x"],
  ["y", "z"],
]

const MAX_CHARS = 4

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

  const handleBackspace = useCallback(() => {
    if (currentChars.length === 0) return
    setCurrentChars((prev) => prev.slice(0, -1))
    onDelete()
  }, [currentChars.length, onDelete])

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
    const isCipherError = isInvalidMnemonic || isBadWords

    const title = isPinMismatch ? t('recovery.pinMismatchTitle')
      : isCipherError ? t('recovery.incorrectWordsTitle')
      : t('recovery.recoveryFailedTitle')
    const errBorderColor = isPinMismatch ? 'kk.warning' : 'kk.error'
    const iconColor = isPinMismatch ? '#FFB300' : '#FF1744'

    return (
      <Flex
        position="fixed"
        top={0}
        left={0}
        w="100vw"
        h="100vh"
        bg="blackAlpha.800"
        align="center"
        justify="center"
        zIndex={2000}
      >
        <Box
          bg="kk.cardBg"
          borderRadius="xl"
          border="1px solid"
          borderColor={errBorderColor}
          p="8"
          maxW="460px"
          w="90%"
          boxShadow="0 8px 32px rgba(0,0,0,0.6)"
          maxH="90vh"
          overflowY="auto"
        >
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

            <Button
              w="100%"
              size="lg"
              bg="kk.gold"
              color="black"
              _hover={{ bg: "kk.goldHover" }}
              onClick={onRetry || onCancel}
            >
              {t('recovery.tryAgain')}
            </Button>
          </VStack>
        </Box>
      </Flex>
    )
  }

  // Word accepted flash overlay
  if (wordAccepted) {
    return (
      <Flex
        position="fixed"
        top={0}
        left={0}
        w="100vw"
        h="100vh"
        bg="blackAlpha.800"
        align="center"
        justify="center"
        zIndex={2000}
      >
        <VStack
          gap={4}
          style={{ animation: "kkWordAccepted 0.6s ease-out forwards" }}
        >
          <FaCheckCircle color="#00C853" size={64} />
          <Text fontSize="2xl" fontWeight="bold" color="kk.success">
            {t('recovery.wordAccepted', { number: acceptedWord })}
          </Text>
        </VStack>
      </Flex>
    )
  }

  return (
    <Flex
      position="fixed"
      top={0}
      left={0}
      w="100vw"
      h="100vh"
      bg="blackAlpha.800"
      align="center"
      justify="center"
      zIndex={2000}
    >
      <style>{ANIMATIONS_CSS}</style>

      <Box
        bg="kk.cardBg"
        borderRadius="xl"
        border="1px solid"
        borderColor="kk.border"
        p="6"
        maxW="480px"
        w="95%"
        boxShadow="0 8px 32px rgba(0,0,0,0.6)"
      >
        {/* Header */}
        <Text
          fontSize="xl"
          fontWeight="bold"
          mb="1"
          textAlign="center"
          color="kk.textPrimary"
        >
          {t('recovery.title')}
        </Text>
        <Text color="kk.textSecondary" fontSize="sm" mb="3" textAlign="center">
          {t('recovery.description')}
        </Text>

        {/* Help toggle */}
        <Flex justify="center" mb="3">
          <Button
            size="xs"
            variant="ghost"
            color="kk.gold"
            _hover={{ color: "kk.goldHover", bg: "kk.bg" }}
            onClick={() => setShowHelp((v) => !v)}
          >
            {showHelp ? t('recovery.hideHelp') : t('recovery.howCipherWorks')}
          </Button>
        </Flex>

        {showHelp && (
          <Box p={3} mb="3" bg="kk.bg" borderRadius="lg" border="1px solid" borderColor="kk.border">
            <VStack align="start" gap={2}>
              <Text fontSize="xs" fontWeight="bold" color="kk.gold">
                {t('recovery.cipherRecovery')}
              </Text>
              <Text fontSize="xs" color="kk.textSecondary">
                {t('recovery.helpParagraph1')}
              </Text>
              <Text fontSize="xs" color="kk.textSecondary">
                {t('recovery.helpParagraph2')}
              </Text>
              <Text fontSize="xs" color="kk.textSecondary">
                {t('recovery.helpParagraph3')}
              </Text>
              <Text fontSize="xs" color="kk.textMuted" fontStyle="italic">
                {t('recovery.helpParagraph4')}
              </Text>
            </VStack>
          </Box>
        )}

        {/* Word counter */}
        <HStack justify="space-between" mb="2">
          <Text fontSize="sm" fontWeight="semibold" color="kk.gold">
            {t('recovery.wordOf', { current: wordPos + 1, total: totalWords })}
          </Text>
          <Text fontSize="xs" color="kk.textMuted">
            {t('recovery.percentComplete', { percent: Math.round(progressPercent) })}
          </Text>
        </HStack>

        {/* Progress bar */}
        <Box h="4px" bg="kk.border" borderRadius="full" overflow="hidden" mb="5">
          <Box
            h="100%"
            bg="kk.gold"
            borderRadius="full"
            transition="width 0.3s"
            w={`${progressPercent}%`}
          />
        </Box>

        {/* Character slots */}
        <Flex justify="center" gap="3" mb="5">
          {Array.from({ length: MAX_CHARS }, (_, i) => {
            const filled = i < currentChars.length
            const active = i === currentChars.length
            return (
              <Box
                key={i}
                w="48px"
                h="48px"
                borderRadius="lg"
                border="2px solid"
                borderColor={
                  active ? "kk.gold" : filled ? "kk.success" : "kk.border"
                }
                bg={filled ? "kk.cardBgHover" : "kk.bg"}
                display="flex"
                alignItems="center"
                justifyContent="center"
                transition="all 0.15s"
                boxShadow={active ? "0 0 0 3px rgba(255,215,0,0.2)" : "none"}
              >
                {filled && (
                  <Text
                    fontSize="xl"
                    fontWeight="bold"
                    color="kk.gold"
                    style={{ animation: "kkCharPop 0.2s ease-out" }}
                  >
                    {"\u2022"}
                  </Text>
                )}
              </Box>
            )
          })}
        </Flex>

        {/* Letter keyboard */}
        <VStack gap="2" mb="4">
          {ALPHABET_ROWS.map((row, i) => (
            <Flex key={i} gap="2" justifyContent="center">
              {row.map((letter) => (
                <Button
                  key={letter}
                  onClick={() => handleChar(letter)}
                  w="52px"
                  h="44px"
                  bg="kk.cardBg"
                  border="1px solid"
                  borderColor="kk.border"
                  color="kk.textPrimary"
                  fontSize="md"
                  fontWeight="bold"
                  borderRadius="lg"
                  _hover={{ borderColor: "kk.gold", bg: "kk.cardBgHover" }}
                  _active={{ bg: "kk.gold", borderColor: "kk.gold", color: "black" }}
                  disabled={currentChars.length >= MAX_CHARS}
                >
                  {letter}
                </Button>
              ))}
            </Flex>
          ))}
        </VStack>

        {/* Action row */}
        <Flex gap="3" justifyContent="center" mb="3">
          <Button
            onClick={handleBackspace}
            size="md"
            variant="outline"
            borderColor="kk.border"
            color="kk.textSecondary"
            _hover={{ borderColor: "kk.gold", color: "kk.textPrimary" }}
            disabled={currentChars.length === 0}
            flex={1}
          >
            {t('recovery.backspace')}
          </Button>
          <Button
            onClick={handleSubmitWord}
            size="md"
            bg={isFinalWord ? "kk.success" : "kk.gold"}
            color={isFinalWord ? "white" : "black"}
            fontWeight="semibold"
            _hover={{ bg: isFinalWord ? "#00E676" : "kk.goldHover" }}
            flex={1}
          >
            {isFinalWord ? t('recovery.completeRecovery') : t('recovery.nextWord')}
          </Button>
        </Flex>

        {/* Cancel */}
        <Button
          onClick={onCancel}
          size="sm"
          variant="ghost"
          color="kk.textMuted"
          _hover={{ color: "kk.error" }}
          w="100%"
        >
          {t('cancel', { ns: 'common' })}
        </Button>
      </Box>
    </Flex>
  )
}
