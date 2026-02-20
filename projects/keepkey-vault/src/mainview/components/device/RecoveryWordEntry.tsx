import { useState, useEffect, useCallback, useRef } from "react"
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

    const title = isPinMismatch ? 'PINs Did Not Match'
      : isCipherError ? 'Incorrect Words Entered'
      : 'Recovery Failed'
    const borderColor = isPinMismatch ? 'orange.500' : 'red.600'
    const iconColor = isPinMismatch ? '#F59E0B' : '#FC8181'

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
          bg="gray.800"
          borderRadius="xl"
          border="1px solid"
          borderColor={borderColor}
          p="8"
          maxW="460px"
          w="90%"
          boxShadow="0 8px 32px rgba(0,0,0,0.6)"
          maxH="90vh"
          overflowY="auto"
        >
          <VStack gap={4} textAlign="center">
            <FaExclamationTriangle color={iconColor} size={48} />
            <Text fontSize="xl" fontWeight="bold" color={isPinMismatch ? 'orange.400' : 'red.400'}>
              {title}
            </Text>
            <Text color="gray.300" fontSize="sm">
              {error}
            </Text>

            {isPinMismatch && (
              <Box w="100%" p={4} bg="gray.700" borderRadius="lg" textAlign="left">
                <Text fontSize="xs" fontWeight="bold" color="orange.300" mb={2}>
                  How PIN entry works:
                </Text>
                <VStack align="start" gap={1}>
                  <Text fontSize="xs" color="gray.300">
                    Your KeepKey displays a scrambled number grid on its screen.
                  </Text>
                  <Text fontSize="xs" color="gray.300">
                    Tap the positions on the computer that match the numbers you want on the device.
                  </Text>
                  <Text fontSize="xs" color="gray.300">
                    Both PIN entries must use the same positions, even though the device scrambles the grid differently each time.
                  </Text>
                </VStack>
              </Box>
            )}

            {isCipherError && (
              <Box w="100%" p={4} bg="gray.700" borderRadius="lg" textAlign="left">
                <Text fontSize="xs" fontWeight="bold" color="red.300" mb={2}>
                  How cipher recovery works:
                </Text>
                <VStack align="start" gap={1}>
                  <Text fontSize="xs" color="gray.300">
                    Your KeepKey shows a scrambled alphabet on its screen. Each letter
                    on the device maps to a different letter on your keyboard.
                  </Text>
                  <Text fontSize="xs" color="gray.300">
                    To enter a word, find each letter of your seed word on the
                    device screen, then press the key at that position on your computer.
                  </Text>
                  <Text fontSize="xs" color="gray.300">
                    The scramble changes after every character, so always check the
                    device screen before pressing the next key.
                  </Text>
                  <Text fontSize="xs" color="gray.400" fontStyle="italic">
                    Make sure you are entering the correct BIP39 seed words in the
                    correct order.
                  </Text>
                </VStack>
              </Box>
            )}

            {!isPinMismatch && !isCipherError && (
              <Text color="gray.500" fontSize="xs">
                The recovery process was interrupted. You can safely try again.
              </Text>
            )}

            <Button
              w="100%"
              size="lg"
              bg="orange.500"
              color="white"
              _hover={{ bg: "orange.600" }}
              onClick={onRetry || onCancel}
            >
              Try Again
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
          <FaCheckCircle color="#48BB78" size={64} />
          <Text fontSize="2xl" fontWeight="bold" color="green.400">
            Word {acceptedWord} accepted!
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
        bg="gray.800"
        borderRadius="xl"
        border="1px solid"
        borderColor="gray.600"
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
          color="white"
        >
          Recover Your Wallet
        </Text>
        <Text color="gray.400" fontSize="sm" mb="3" textAlign="center">
          Look at the scrambled letters on your KeepKey and type the matching
          position
        </Text>

        {/* Help toggle */}
        <Flex justify="center" mb="3">
          <Button
            size="xs"
            variant="ghost"
            color="blue.400"
            _hover={{ color: "blue.300", bg: "gray.700" }}
            onClick={() => setShowHelp((v) => !v)}
          >
            {showHelp ? 'Hide help' : 'How does cipher recovery work?'}
          </Button>
        </Flex>

        {showHelp && (
          <Box p={3} mb="3" bg="gray.700" borderRadius="lg" border="1px solid" borderColor="gray.600">
            <VStack align="start" gap={2}>
              <Text fontSize="xs" fontWeight="bold" color="blue.300">
                Cipher Recovery
              </Text>
              <Text fontSize="xs" color="gray.300">
                Your KeepKey shows a scrambled alphabet on its screen. Each letter
                on the device maps to a different letter on the computer keyboard.
              </Text>
              <Text fontSize="xs" color="gray.300">
                To enter a word, find each letter of your seed word on the
                device screen, then press the letter shown at that position on
                your computer. You only need the first 3-4 characters of each word.
              </Text>
              <Text fontSize="xs" color="gray.300">
                This way, your actual seed phrase is never typed on the computer,
                protecting you from keyloggers and screen capture malware.
              </Text>
              <Text fontSize="xs" color="gray.400" fontStyle="italic">
                The scramble changes for each character, so always look at the
                device before pressing the next key.
              </Text>
            </VStack>
          </Box>
        )}

        {/* Word counter */}
        <HStack justify="space-between" mb="2">
          <Text fontSize="sm" fontWeight="semibold" color="orange.400">
            Word {wordPos + 1} of {totalWords}
          </Text>
          <Text fontSize="xs" color="gray.500">
            {Math.round(progressPercent)}% complete
          </Text>
        </HStack>

        {/* Progress bar */}
        <Box h="4px" bg="gray.700" borderRadius="full" overflow="hidden" mb="5">
          <Box
            h="100%"
            bg="orange.500"
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
                  active ? "orange.500" : filled ? "green.500" : "gray.600"
                }
                bg={filled ? "gray.700" : "gray.900"}
                display="flex"
                alignItems="center"
                justifyContent="center"
                transition="all 0.15s"
                boxShadow={active ? "0 0 0 3px rgba(251,146,60,0.25)" : "none"}
              >
                {filled && (
                  <Text
                    fontSize="xl"
                    fontWeight="bold"
                    color="orange.400"
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
                  bg="gray.700"
                  border="1px solid"
                  borderColor="gray.600"
                  color="white"
                  fontSize="md"
                  fontWeight="bold"
                  borderRadius="lg"
                  _hover={{ borderColor: "orange.500", bg: "gray.600" }}
                  _active={{ bg: "orange.500", borderColor: "orange.500" }}
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
            borderColor="gray.600"
            color="gray.300"
            _hover={{ borderColor: "orange.500", color: "white" }}
            disabled={currentChars.length === 0}
            flex={1}
          >
            Backspace
          </Button>
          <Button
            onClick={handleSubmitWord}
            size="md"
            bg={isFinalWord ? "green.500" : "orange.500"}
            color="white"
            fontWeight="semibold"
            _hover={{ bg: isFinalWord ? "green.600" : "orange.600" }}
            flex={1}
          >
            {isFinalWord ? "Complete Recovery" : "Next Word"}
          </Button>
        </Flex>

        {/* Cancel */}
        <Button
          onClick={onCancel}
          size="sm"
          variant="ghost"
          color="gray.500"
          _hover={{ color: "red.400" }}
          w="100%"
        >
          Cancel
        </Button>
      </Box>
    </Flex>
  )
}
