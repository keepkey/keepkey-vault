import { useState, useEffect, useCallback, useRef } from 'react'
import { Box, Text, VStack, HStack, Flex, Button, Spinner, Input } from '@chakra-ui/react'
import {
  FaDownload,
  FaWallet,
  FaKey,
  FaCheckCircle,
  FaExclamationTriangle,
  FaPlus,
} from 'react-icons/fa'
import { useFirmwareUpdate } from '../hooks/useFirmwareUpdate'
import { useDeviceState } from '../hooks/useDeviceState'
import { rpcRequest } from '../lib/rpc'

// ── Design tokens matching keepkey-bitcoin-only ─────────────────────────────
const HIGHLIGHT = 'orange.500'

// ── Animations ──────────────────────────────────────────────────────────────
const ANIMATIONS_CSS = `
  @keyframes kkConfettiFall {
    0%   { transform: translateY(-100vh) rotate(0deg); opacity: 1; }
    100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
  }
  @keyframes kkPulse {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.1); }
    100% { transform: scale(1); }
  }
`

// ── Step definitions ────────────────────────────────────────────────────────

type WizardStep =
  | 'welcome'
  | 'bootloader'
  | 'firmware'
  | 'init-choose'
  | 'init-progress'
  | 'init-label'
  | 'complete'

const STEP_SEQUENCE: WizardStep[] = [
  'welcome',
  'bootloader',
  'firmware',
  'init-choose',
  'init-progress',
  'init-label',
  'complete',
]

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  'welcome': 'Welcome to KeepKey',
  'bootloader': 'Verify and update bootloader',
  'firmware': 'Verify and update firmware',
  'init-choose': 'Choose your setup method',
  'init-progress': 'Setting up your wallet',
  'init-label': 'Name your device',
  'complete': 'Setup complete!',
}

// 3 visible progress steps
const VISIBLE_STEPS = [
  { id: 'bootloader', label: 'Bootloader', number: 1 },
  { id: 'firmware', label: 'Firmware', number: 2 },
  { id: 'init-choose', label: 'Setup', number: 3 },
]

// Map wizard steps → their visible step group
const stepToVisibleId: Record<WizardStep, string | null> = {
  'welcome': null,
  'bootloader': 'bootloader',
  'firmware': 'firmware',
  'init-choose': 'init-choose',
  'init-progress': 'init-choose',
  'init-label': 'init-choose',
  'complete': null,
}

// ── Props ───────────────────────────────────────────────────────────────────

interface OobSetupWizardProps {
  onComplete: () => void
}

// ── Confetti pieces ─────────────────────────────────────────────────────────
const CONFETTI_COLORS = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899']
const confettiPieces = Array.from({ length: 50 }, (_, i) => ({
  id: i,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  left: `${Math.random() * 100}%`,
  delay: `${Math.random() * 3}s`,
  duration: `${3 + Math.random() * 2}s`,
}))

// ── Main Wizard ─────────────────────────────────────────────────────────────

export function OobSetupWizard({ onComplete }: OobSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>('welcome')
  const [setupType, setSetupType] = useState<'create' | 'recover' | null>(null)
  const [deviceLabel, setDeviceLabel] = useState('')
  const [setupError, setSetupError] = useState<string | null>(null)
  const [, setSetupLoading] = useState(false)

  // Bootloader state
  const [waitingForBootloader, setWaitingForBootloader] = useState(false)
  const bootloaderPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Hooks — use Electrobun RPC-based hooks
  const deviceStatus = useDeviceState()
  const {
    state: updateState,
    progress: updateProgress,
    error: updateError,
    startFirmwareUpdate,
    startBootloaderUpdate,
    reset: resetUpdate,
  } = useFirmwareUpdate()

  // Device flags — derived from the unified device state
  const needsBootloader = deviceStatus.needsBootloaderUpdate
  const needsFirmware = deviceStatus.needsFirmwareUpdate
  const needsInit = deviceStatus.needsInit
  const inBootloader = deviceStatus.bootloaderMode
  const isOobDevice = deviceStatus.isOob

  // ── Progress calculation ────────────────────────────────────────────────

  const visibleId = stepToVisibleId[step]
  const visibleIndex = visibleId ? VISIBLE_STEPS.findIndex(s => s.id === visibleId) : -1

  let progressPercent = 0
  if (visibleIndex >= 0) {
    progressPercent = ((visibleIndex + 1) / VISIBLE_STEPS.length) * 100
  } else if (step !== 'welcome') {
    progressPercent = 100
  }

  const isVisibleStepCompleted = (vsId: string) => {
    const vsIndex = VISIBLE_STEPS.findIndex(s => s.id === vsId)
    if (step === 'complete' || step === 'init-label' || step === 'init-progress') return true
    const curVsIndex = visibleIndex
    return vsIndex < curVsIndex
  }

  const isVisibleStepCurrent = (vsId: string) => visibleId === vsId

  // ── Welcome → first real step ──────────────────────────────────────────

  useEffect(() => {
    if (step !== 'welcome') return
    if (deviceStatus.state === 'disconnected') return // Wait for device
    const timer = setTimeout(() => {
      handleGetStarted()
    }, 1500)
    return () => clearTimeout(timer)
  }, [step, deviceStatus.state, needsBootloader, needsFirmware, needsInit])

  const handleGetStarted = () => {
    if (needsBootloader) {
      setStep('bootloader')
    } else if (needsFirmware) {
      setStep('firmware')
    } else if (needsInit) {
      setStep('init-choose')
    } else {
      onComplete()
    }
  }

  // ── Bootloader step ────────────────────────────────────────────────────

  const handleEnterBootloaderMode = () => {
    setWaitingForBootloader(true)
    // Poll device state for bootloader mode detection
    bootloaderPollRef.current = setInterval(async () => {
      try {
        const state = await rpcRequest('getDeviceState')
        if (state.bootloaderMode) {
          setWaitingForBootloader(false)
          if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
          await startBootloaderUpdate()
        }
      } catch {
        // Device may be disconnecting/reconnecting
      }
    }, 2000)
  }

  // Event-driven bootloader detection via device state pushes
  useEffect(() => {
    if (!waitingForBootloader) return
    if (updateState === 'updating') return

    if (deviceStatus.bootloaderMode) {
      setWaitingForBootloader(false)
      if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
      startBootloaderUpdate()
    }
  }, [waitingForBootloader, deviceStatus.bootloaderMode, updateState, startBootloaderUpdate])

  useEffect(() => {
    if (step !== 'bootloader') return
    if (updateState === 'complete') {
      resetUpdate()
      setTimeout(() => {
        if (needsFirmware) {
          setStep('firmware')
        } else {
          setStep('init-choose')
        }
      }, 5000)
    }
  }, [updateState, step, needsFirmware, resetUpdate])

  // Event-driven: detect device reconnection after bootloader update
  useEffect(() => {
    if (step !== 'bootloader') return
    if (updateState !== 'complete') return
    if (deviceStatus.state !== 'disconnected' && !deviceStatus.bootloaderMode) {
      resetUpdate()
      if (needsFirmware) {
        setStep('firmware')
      } else {
        setStep('init-choose')
      }
    }
  }, [step, updateState, deviceStatus.state, deviceStatus.bootloaderMode, needsFirmware, resetUpdate])

  useEffect(() => {
    return () => {
      if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
    }
  }, [])

  // ── Firmware step ──────────────────────────────────────────────────────

  const handleStartFirmwareUpdate = async () => {
    await startFirmwareUpdate(deviceStatus.latestFirmware || undefined)
  }

  useEffect(() => {
    if (step !== 'firmware') return
    if (updateState === 'complete') {
      resetUpdate()
      setTimeout(() => {
        if (needsInit) {
          setStep('init-choose')
        } else {
          setStep('complete')
        }
      }, 5000)
    }
  }, [updateState, step, needsInit, resetUpdate])

  // Event-driven: detect device reconnection after firmware update
  useEffect(() => {
    if (step !== 'firmware') return
    if (updateState !== 'complete') return
    if (deviceStatus.state !== 'disconnected' && !deviceStatus.bootloaderMode) {
      resetUpdate()
      if (needsInit) {
        setStep('init-choose')
      } else {
        setStep('complete')
      }
    }
  }, [step, updateState, deviceStatus.state, deviceStatus.bootloaderMode, needsInit, resetUpdate])

  const handleSkipFirmware = () => {
    if (needsInit) {
      setStep('init-choose')
    } else {
      setStep('complete')
    }
  }

  // ── Init: Create / Recover ─────────────────────────────────────────────

  // Device-interactive ops need 10 min timeout — user enters seed words on device
  const DEVICE_INTERACTION_TIMEOUT = 600000

  const handleCreateWallet = async () => {
    setSetupType('create')
    setStep('init-progress')
    setSetupLoading(true)
    setSetupError(null)
    try {
      await rpcRequest('resetDevice', {
        wordCount: 12,
        pin: true,
        passphrase: false,
      }, DEVICE_INTERACTION_TIMEOUT)
      setStep('init-label')
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to create wallet')
      setStep('init-choose')
    } finally {
      setSetupLoading(false)
    }
  }

  const handleRecoverWallet = async () => {
    setSetupType('recover')
    setStep('init-progress')
    setSetupLoading(true)
    setSetupError(null)
    try {
      await rpcRequest('recoverDevice', {
        wordCount: 12,
        pin: true,
        passphrase: false,
      }, DEVICE_INTERACTION_TIMEOUT)
      setStep('init-label')
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to recover wallet')
      setStep('init-choose')
    } finally {
      setSetupLoading(false)
    }
  }

  const handleApplyLabel = async () => {
    if (deviceLabel.trim()) {
      try {
        await rpcRequest('applySettings', { label: deviceLabel.trim() })
      } catch {
        // Label is optional
      }
    }
    setStep('complete')
  }

  // ── Complete: auto-advance after 5s ────────────────────────────────────

  useEffect(() => {
    if (step !== 'complete') return
    const timer = setTimeout(() => onComplete(), 5000)
    return () => clearTimeout(timer)
  }, [step, onComplete])

  // ── Navigation ─────────────────────────────────────────────────────────

  const handlePrevious = useCallback(() => {
    const idx = STEP_SEQUENCE.indexOf(step)
    if (idx > 0) setStep(STEP_SEQUENCE[idx - 1])
  }, [step])

  const handleNext = useCallback(() => {
    const idx = STEP_SEQUENCE.indexOf(step)
    if (idx < STEP_SEQUENCE.length - 1) {
      setStep(STEP_SEQUENCE[idx + 1])
    } else {
      onComplete()
    }
  }, [step, onComplete])

  const showPrevious = !['welcome', 'complete'].includes(step)
  const showNext =
    !['bootloader', 'init-choose', 'init-progress', 'init-label', 'complete'].includes(step) &&
    !(step === 'firmware' && (updateState === 'updating' || updateState === 'complete'))

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Flex
      position="fixed"
      top={0}
      left={0}
      w="100vw"
      h="100vh"
      bg="transparent"
      align="center"
      justify="center"
      zIndex={1000}
    >
      <style>{ANIMATIONS_CSS}</style>

      <Box
        w={{ base: '100vw', md: '90vw', lg: '80vw' }}
        maxW="1200px"
        minH={{ base: '100vh', md: 'auto' }}
        bg="gray.800"
        borderRadius={{ base: 'none', md: 'xl' }}
        boxShadow={{ base: 'none', md: '0 8px 32px rgba(0,0,0,0.5)' }}
        borderWidth={{ base: '0', md: '1px' }}
        borderColor="gray.700"
        overflow="visible"
        display="flex"
        flexDirection="column"
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <Box p={6} borderBottomWidth="1px" borderColor="gray.700">
          <VStack gap={2}>
            <Text fontSize="2xl" fontWeight="bold" color={HIGHLIGHT}>
              KeepKey Setup
            </Text>
            <Text fontSize="md" color="gray.400">
              {STEP_DESCRIPTIONS[step]}
            </Text>
          </VStack>
        </Box>

        {/* ── Progress bar ───────────────────────────────────────────── */}
        <Box px={6} py={2}>
          <Box h="4px" bg="gray.700" borderRadius="full" overflow="hidden">
            <Box
              h="100%"
              bg={progressPercent > 0 ? 'green.500' : HIGHLIGHT}
              borderRadius="full"
              transition="width 0.3s, background-color 0.3s"
              w={`${progressPercent}%`}
            />
          </Box>
        </Box>

        {/* ── Step indicators ────────────────────────────────────────── */}
        <Box px={4} py={3} overflowX="auto">
          <HStack gap={{ base: 2, md: 3 }} justify="center" minW="fit-content">
            {VISIBLE_STEPS.map((vs, idx) => {
              const completed = isVisibleStepCompleted(vs.id)
              const current = isVisibleStepCurrent(vs.id)

              return (
                <Flex key={vs.id} align="center" flexShrink={0}>
                  {/* Circle */}
                  <Box
                    w={{ base: 8, md: 10 }}
                    h={{ base: 8, md: 10 }}
                    borderRadius="full"
                    bg={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.600'}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    transition="all 0.3s"
                    flexShrink={0}
                    transform={current ? 'scale(1.1)' : 'scale(1)'}
                    boxShadow={current ? '0 0 0 4px rgba(251, 146, 60, 0.25)' : 'none'}
                  >
                    {completed ? (
                      <FaCheckCircle color="white" size={16} />
                    ) : (
                      <Text color="white" fontSize={{ base: 'sm', md: 'md' }} fontWeight="bold">
                        {vs.number}
                      </Text>
                    )}
                  </Box>
                  {/* Label (hidden on small) */}
                  <Text
                    ml={2}
                    fontSize={{ base: 'xs', md: 'sm' }}
                    fontWeight={current ? 'bold' : 'normal'}
                    color={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.400'}
                    display={{ base: 'none', lg: 'block' }}
                    whiteSpace="nowrap"
                  >
                    {vs.label}
                  </Text>
                  {/* Connector line */}
                  {idx < VISIBLE_STEPS.length - 1 && (
                    <Box
                      w={{ base: 6, md: 10, lg: 12 }}
                      h="2px"
                      bg={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.600'}
                      ml={2}
                    />
                  )}
                </Flex>
              )
            })}
          </HStack>
        </Box>

        {/* ── Content ────────────────────────────────────────────────── */}
        <Box
          flex={1}
          p={{ base: 4, md: 6, lg: 8 }}
          minH={{ base: '50vh', md: '400px' }}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="100%"
        >
          <Box w="100%" maxW="900px">
            {/* ═══════════════ WELCOME ═══════════════════════════════ */}
            {step === 'welcome' && (
              <VStack gap={6} textAlign="center" w="100%">
                <Box>
                  <FaWallet
                    color="#F59E0B"
                    size={80}
                    style={{ animation: 'kkPulse 2s ease-in-out infinite' }}
                  />
                </Box>
                <VStack gap={3}>
                  <Text fontSize="3xl" fontWeight="bold" color="white">
                    Welcome to KeepKey
                  </Text>
                  <Text fontSize="xl" color={HIGHLIGHT}>
                    Secure Multi-Chain Hardware Wallet
                  </Text>
                  <Text fontSize="md" color="gray.400" maxW="400px">
                    {isOobDevice
                      ? "Let's update your firmware and set up your wallet."
                      : "Let's get your hardware wallet set up."}
                  </Text>
                </VStack>
                <HStack gap={2}>
                  <Spinner size="sm" color="gray.500" />
                  <Text fontSize="sm" color="gray.500">
                    {deviceStatus.state !== 'disconnected' ? 'Starting setup...' : 'Detecting device status...'}
                  </Text>
                </HStack>
              </VStack>
            )}

            {/* ═══════════════ BOOTLOADER ════════════════════════════ */}
            {step === 'bootloader' && (
              <VStack gap={5} w="100%" maxW="500px" mx="auto">
                <FaExclamationTriangle color="#ECC94B" size={48} />
                <VStack gap={2}>
                  <Text fontSize="2xl" fontWeight="bold" color="white" textAlign="center">
                    Bootloader Update
                  </Text>
                  <Text fontSize="sm" color="gray.400" textAlign="center">
                    Your bootloader needs to be updated for security and compatibility.
                  </Text>
                </VStack>

                {/* Version info */}
                {deviceStatus.latestBootloader && (
                  <Box w="100%" p={4} bg="gray.700" borderRadius="lg">
                    <HStack justify="space-between">
                      <VStack gap={1} align="start">
                        <Text fontSize="xs" color="gray.400" textTransform="uppercase">Current</Text>
                        <Text fontSize="md" color="orange.400" fontWeight="bold">
                          {(deviceStatus.bootloaderVersion && !deviceStatus.bootloaderVersion.startsWith('hash:'))
                            ? `v${deviceStatus.bootloaderVersion}`
                            : inBootloader
                              ? `v${deviceStatus.firmwareVersion}`
                              : 'Outdated'}
                        </Text>
                      </VStack>
                      <Text color="gray.500" fontSize="lg">&rarr;</Text>
                      <VStack gap={1} align="end">
                        <Text fontSize="xs" color="gray.400" textTransform="uppercase">Latest</Text>
                        <Text fontSize="md" color="green.400" fontWeight="bold">
                          v{deviceStatus.latestBootloader}
                        </Text>
                      </VStack>
                    </HStack>
                  </Box>
                )}

                {/* Updating */}
                {updateState === 'updating' && (
                  <VStack gap={3} w="100%">
                    <Spinner size="lg" color="blue.400" />
                    <Text fontSize="sm" color="gray.300">
                      {updateProgress?.message || 'Updating bootloader...'}
                    </Text>
                    <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                      <HStack gap={2}>
                        <FaExclamationTriangle color="#FC8181" />
                        <Text fontSize="xs" color="red.200">
                          Do NOT unplug your device. Interrupting can brick the device.
                        </Text>
                      </HStack>
                    </Box>
                  </VStack>
                )}

                {/* Error */}
                {updateState === 'error' && (
                  <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <VStack gap={2} align="start">
                      <Text fontSize="sm" color="red.300" fontWeight="bold">Update Failed</Text>
                      <Text fontSize="xs" color="red.200">{updateError}</Text>
                    </VStack>
                    <Button
                      mt={3}
                      size="sm"
                      variant="outline"
                      borderColor="red.400"
                      color="red.300"
                      onClick={() => { resetUpdate(); setWaitingForBootloader(false) }}
                    >
                      Try Again
                    </Button>
                  </Box>
                )}

                {/* Instructions */}
                {updateState !== 'updating' && updateState !== 'error' && (
                  <Box w="100%" p={4} bg="gray.700" borderRadius="lg" borderWidth="2px" borderColor="yellow.600">
                    <VStack align="start" gap={2}>
                      <HStack gap={2}>
                        <FaExclamationTriangle color="#ECC94B" size={18} />
                        <Text fontSize="sm" fontWeight="bold" color="yellow.300">
                          Enter Firmware Update Mode
                        </Text>
                      </HStack>
                      <VStack align="start" gap={1} pl={6}>
                        <Text fontSize="sm" color="gray.200">1. Unplug your KeepKey</Text>
                        <Text fontSize="sm" color="gray.200">2. Hold down the button on the device</Text>
                        <Text fontSize="sm" color="gray.200">3. While holding, plug in the USB cable</Text>
                        <Text fontSize="sm" color="gray.200">4. Release when the bootloader screen appears</Text>
                      </VStack>
                    </VStack>
                  </Box>
                )}

                {/* Waiting indicator */}
                {waitingForBootloader && updateState !== 'updating' && (
                  <HStack gap={3} w="100%" justify="center" py={2}>
                    <Spinner size="sm" color="yellow.400" />
                    <Text fontSize="sm" color="yellow.300">
                      Listening for device in bootloader mode...
                    </Text>
                  </HStack>
                )}

                {/* Action buttons — idle only */}
                {updateState !== 'updating' && updateState !== 'error' && !waitingForBootloader && (
                  <>
                    <Button
                      w="100%"
                      size="lg"
                      bg={HIGHLIGHT}
                      color="white"
                      _hover={{ bg: 'orange.600' }}
                      onClick={handleEnterBootloaderMode}
                    >
                      I'm Ready — Detect Bootloader
                    </Button>

                    <Button
                      w="100%"
                      variant="ghost"
                      color="gray.400"
                      _hover={{ color: 'white', bg: 'gray.700' }}
                      onClick={() => {
                        if (needsFirmware) setStep('firmware')
                        else setStep('init-choose')
                      }}
                    >
                      Skip Bootloader Update
                    </Button>
                  </>
                )}
              </VStack>
            )}

            {/* ═══════════════ FIRMWARE ══════════════════════════════ */}
            {step === 'firmware' && (
              <VStack gap={5} w="100%" maxW="500px" mx="auto">
                <FaDownload color="#F59E0B" size={48} />
                <VStack gap={2}>
                  <Text fontSize="2xl" fontWeight="bold" color="white" textAlign="center">
                    Firmware Update
                  </Text>
                  <Text fontSize="sm" color="gray.400" textAlign="center">
                    {isOobDevice
                      ? 'Your device has factory firmware. A critical update is required.'
                      : 'A firmware update is available for your device.'}
                  </Text>
                </VStack>

                {/* Version comparison */}
                <Box w="100%" p={4} bg="gray.700" borderRadius="lg">
                  <HStack justify="space-between">
                    <VStack gap={1} align="start">
                      <Text fontSize="xs" color="gray.400" textTransform="uppercase">
                        {inBootloader ? 'Firmware' : 'Current'}
                      </Text>
                      <Text
                        fontSize="md"
                        color={isOobDevice ? 'red.400' : 'white'}
                        fontWeight="bold"
                      >
                        {inBootloader ? 'Not installed' : `v${deviceStatus.firmwareVersion || '?'}`}
                      </Text>
                    </VStack>
                    <Text color="gray.500" fontSize="lg">&rarr;</Text>
                    <VStack gap={1} align="end">
                      <Text fontSize="xs" color="gray.400" textTransform="uppercase">Latest</Text>
                      <Text fontSize="md" color="green.400" fontWeight="bold">
                        v{deviceStatus.latestFirmware || '?'}
                      </Text>
                    </VStack>
                  </HStack>
                </Box>

                {/* Important instructions */}
                <Box w="100%" p={4} bg="gray.700" borderRadius="lg" borderWidth="2px" borderColor={HIGHLIGHT}>
                  <VStack gap={2} align="start">
                    <Text color="orange.400" fontWeight="bold" fontSize="sm">
                      Important:
                    </Text>
                    <Text fontSize="xs" color="gray.300">Do not disconnect your device during the update</Text>
                    <Text fontSize="xs" color="gray.300">You may need to confirm on the device screen</Text>
                    <Text fontSize="xs" color="gray.300">Your funds and settings will remain safe</Text>
                  </VStack>
                </Box>

                {/* Update in progress */}
                {updateState === 'updating' && (
                  <VStack gap={3} w="100%">
                    <Spinner size="lg" color={HIGHLIGHT} />
                    <Text fontSize="sm" color="gray.300">
                      {updateProgress?.message || 'Updating firmware...'}
                    </Text>
                    <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                      <HStack gap={2}>
                        <FaExclamationTriangle color="#FC8181" />
                        <Text fontSize="xs" color="red.200">Do NOT unplug your device.</Text>
                      </HStack>
                    </Box>
                  </VStack>
                )}

                {/* Waiting for reboot */}
                {updateState === 'complete' && (
                  <Box w="100%" p={4} bg="blue.900" borderRadius="md" borderWidth="2px" borderColor="blue.500">
                    <VStack gap={2} align="start">
                      <HStack gap={2}>
                        <Spinner size="sm" color="blue.300" />
                        <Text fontSize="sm" color="blue.300" fontWeight="bold">
                          Device is rebooting...
                        </Text>
                      </HStack>
                      <Text fontSize="xs" color="blue.200">
                        Your KeepKey is restarting with the new firmware. Please wait...
                      </Text>
                      {deviceStatus.firmwareVerified !== undefined && (
                        <HStack gap={2} mt={1}>
                          {deviceStatus.firmwareVerified ? (
                            <>
                              <FaCheckCircle color="#48BB78" size={14} />
                              <Text fontSize="xs" color="green.300" fontWeight="bold">
                                Firmware verified as official release
                              </Text>
                            </>
                          ) : (
                            <>
                              <FaExclamationTriangle color="#FB923C" size={14} />
                              <Text fontSize="xs" color="orange.300" fontWeight="bold">
                                Firmware hash not found in manifest
                              </Text>
                            </>
                          )}
                        </HStack>
                      )}
                    </VStack>
                  </Box>
                )}

                {/* Error */}
                {updateState === 'error' && (
                  <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <VStack gap={2} align="start">
                      <Text fontSize="sm" color="red.300" fontWeight="bold">Update Failed</Text>
                      <Text fontSize="xs" color="red.200">{updateError}</Text>
                    </VStack>
                    <Button mt={3} size="sm" variant="outline" borderColor="red.400" color="red.300" onClick={resetUpdate}>
                      Try Again
                    </Button>
                  </Box>
                )}

                {/* Actions — idle */}
                {updateState === 'idle' && (
                  <VStack gap={3} w="100%">
                    <Button
                      w="100%"
                      size="lg"
                      bg={HIGHLIGHT}
                      color="white"
                      _hover={{ bg: 'orange.600' }}
                      onClick={handleStartFirmwareUpdate}
                    >
                      Update Firmware to v{deviceStatus.latestFirmware || '?'}
                    </Button>
                    {!isOobDevice && (
                      <Button
                        w="100%"
                        variant="outline"
                        borderColor="gray.600"
                        color="gray.300"
                        _hover={{ bg: 'gray.700' }}
                        onClick={handleSkipFirmware}
                      >
                        Skip Update
                      </Button>
                    )}
                  </VStack>
                )}
              </VStack>
            )}

            {/* ═══════════════ INIT: CHOOSE ═════════════════════════ */}
            {step === 'init-choose' && (
              <VStack gap={{ base: 4, md: 6, lg: 8 }} w="100%">
                <VStack gap={2}>
                  <Text fontSize={{ base: 'xl', md: '2xl' }} fontWeight="bold" color="white" textAlign="center">
                    Set Up Your Wallet
                  </Text>
                  <Text fontSize={{ base: 'sm', md: 'md' }} color="gray.400" textAlign="center">
                    Choose how you'd like to set up your KeepKey
                  </Text>
                </VStack>

                {setupError && (
                  <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <Text fontSize="sm" color="red.300">{setupError}</Text>
                  </Box>
                )}

                <HStack
                  gap={{ base: 4, md: 6 }}
                  w="100%"
                  flexDirection={{ base: 'column', md: 'row' }}
                  align="stretch"
                >
                  {/* Create New Wallet */}
                  <Box
                    flex={{ base: 'none', md: 1 }}
                    w={{ base: '100%', md: 'auto' }}
                    maxW={{ base: '400px', md: 'none' }}
                    mx={{ base: 'auto', md: 0 }}
                    p={{ base: 4, md: 6 }}
                    borderRadius="lg"
                    borderWidth="2px"
                    borderColor="transparent"
                    bg="gray.700"
                    cursor="pointer"
                    transition="all 0.2s"
                    _hover={{
                      borderColor: 'orange.500',
                      transform: 'translateY(-2px)',
                    }}
                    onClick={handleCreateWallet}
                  >
                    <VStack gap={4}>
                      <Box p={{ base: 3, md: 4 }} borderRadius="full" bg="orange.500" color="white">
                        <FaPlus size={32} />
                      </Box>
                      <VStack gap={2}>
                        <Text fontSize={{ base: 'lg', md: 'xl' }} fontWeight="bold" color="white">
                          Create New Wallet
                        </Text>
                        <Text fontSize={{ base: 'xs', md: 'sm' }} color="gray.400" textAlign="center">
                          Generate a new seed phrase on your device
                        </Text>
                      </VStack>
                      <Button
                        w="100%"
                        size={{ base: 'md', md: 'lg' }}
                        bg={HIGHLIGHT}
                        color="white"
                        _hover={{ bg: 'orange.600' }}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation()
                          handleCreateWallet()
                        }}
                      >
                        Create Wallet
                      </Button>
                    </VStack>
                  </Box>

                  {/* Recover Existing Wallet */}
                  <Box
                    flex={{ base: 'none', md: 1 }}
                    w={{ base: '100%', md: 'auto' }}
                    maxW={{ base: '400px', md: 'none' }}
                    mx={{ base: 'auto', md: 0 }}
                    p={{ base: 4, md: 6 }}
                    borderRadius="lg"
                    borderWidth="2px"
                    borderColor="transparent"
                    bg="gray.700"
                    cursor="pointer"
                    transition="all 0.2s"
                    _hover={{
                      borderColor: 'blue.500',
                      transform: 'translateY(-2px)',
                    }}
                    onClick={handleRecoverWallet}
                  >
                    <VStack gap={4}>
                      <Box p={{ base: 3, md: 4 }} borderRadius="full" bg="blue.500" color="white">
                        <FaKey size={32} />
                      </Box>
                      <VStack gap={2}>
                        <Text fontSize={{ base: 'lg', md: 'xl' }} fontWeight="bold" color="white">
                          Recover Existing Wallet
                        </Text>
                        <Text fontSize={{ base: 'xs', md: 'sm' }} color="gray.400" textAlign="center">
                          Enter your recovery seed phrase on the device
                        </Text>
                      </VStack>
                      <Button
                        w="100%"
                        size={{ base: 'md', md: 'lg' }}
                        bg="blue.500"
                        color="white"
                        _hover={{ bg: 'blue.600' }}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation()
                          handleRecoverWallet()
                        }}
                      >
                        Recover Wallet
                      </Button>
                    </VStack>
                  </Box>
                </HStack>
              </VStack>
            )}

            {/* ═══════════════ INIT: IN PROGRESS ═══════════════════ */}
            {step === 'init-progress' && (
              <VStack gap={6} textAlign="center" w="100%" maxW="500px" mx="auto">
                <Spinner
                  size="xl"
                  color={HIGHLIGHT}
                  borderWidth="4px"
                />
                <VStack gap={3}>
                  <Text fontSize="xl" fontWeight="bold" color="white">
                    {setupType === 'create' ? 'Creating Wallet...' : 'Recovering Wallet...'}
                  </Text>
                  <Text fontSize="sm" color="gray.400" maxW="360px">
                    Follow the prompts on your KeepKey device screen.
                    {setupType === 'create' && ' Write down the seed words carefully — they are your backup.'}
                    {setupType === 'recover' && ' Enter your recovery seed phrase using the device.'}
                  </Text>
                </VStack>

                <Box w="100%" p={4} bg="orange.900" borderRadius="lg" borderWidth="2px" borderColor={HIGHLIGHT}>
                  <HStack gap={2} justify="center">
                    <FaExclamationTriangle color="#F59E0B" />
                    <Text fontSize="sm" color="orange.200" fontWeight="bold">
                      Look at your KeepKey device and follow the on-screen instructions.
                    </Text>
                  </HStack>
                </Box>
              </VStack>
            )}

            {/* ═══════════════ INIT: LABEL ══════════════════════════ */}
            {step === 'init-label' && (
              <VStack gap={6} w="100%" maxW="400px" mx="auto">
                <VStack gap={2}>
                  <FaCheckCircle color="#48BB78" size={48} />
                  <Text fontSize="2xl" fontWeight="bold" color="white" textAlign="center">
                    {setupType === 'create' ? 'Wallet Created!' : 'Wallet Recovered!'}
                  </Text>
                  <Text fontSize="md" color="gray.400" textAlign="center">
                    Give your KeepKey a friendly name to identify it easily
                  </Text>
                </VStack>

                <Box w="100%">
                  <Input
                    placeholder="My KeepKey"
                    value={deviceLabel}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeviceLabel(e.target.value)}
                    bg="gray.700"
                    borderColor="gray.600"
                    color="white"
                    size="lg"
                    _hover={{ borderColor: 'gray.500' }}
                    _focus={{ borderColor: 'orange.500', boxShadow: '0 0 0 1px orange.500' }}
                    onKeyDown={(e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' && deviceLabel.trim()) {
                        handleApplyLabel()
                      }
                    }}
                  />
                </Box>

                <VStack gap={3} w="100%">
                  <Button
                    w="100%"
                    size="lg"
                    bg={HIGHLIGHT}
                    color="white"
                    _hover={{ bg: 'orange.600' }}
                    onClick={handleApplyLabel}
                    disabled={!deviceLabel.trim()}
                  >
                    Set Device Name
                  </Button>
                  <Button
                    w="100%"
                    variant="ghost"
                    color="gray.400"
                    _hover={{ color: 'white', bg: 'gray.700' }}
                    onClick={handleApplyLabel}
                  >
                    Skip for Now
                  </Button>
                </VStack>
              </VStack>
            )}

            {/* ═══════════════ COMPLETE ═════════════════════════════ */}
            {step === 'complete' && (
              <Box position="relative" w="100%" overflow="hidden">
                {/* Confetti */}
                {confettiPieces.map(piece => (
                  <Box
                    key={piece.id}
                    position="absolute"
                    w="10px"
                    h="10px"
                    bg={piece.color}
                    left={piece.left}
                    top="-10px"
                    borderRadius="2px"
                    transform="rotate(45deg)"
                    style={{
                      animation: `kkConfettiFall ${piece.duration} linear ${piece.delay} infinite`,
                    }}
                  />
                ))}

                <VStack gap={6} textAlign="center" w="100%" position="relative" zIndex={1}>
                  <Box>
                    <FaCheckCircle
                      color="#48BB78"
                      size={80}
                      style={{ animation: 'kkPulse 2s ease-in-out infinite' }}
                    />
                  </Box>
                  <VStack gap={3}>
                    <Text fontSize="3xl" fontWeight="bold" color="white">
                      {setupType === 'recover' ? 'Wallet Recovered!' : 'Wallet Created!'}
                    </Text>
                    <Text fontSize="lg" color="gray.300">
                      Your KeepKey{deviceLabel.trim() ? ` "${deviceLabel.trim()}"` : ''} is ready
                    </Text>
                    <Text fontSize="md" color="gray.400" maxW="400px">
                      {setupType === 'recover'
                        ? 'Your wallet has been successfully restored from your recovery phrase'
                        : 'Your new wallet is now secure and ready to use'}
                    </Text>
                  </VStack>
                  <Button
                    size="lg"
                    bg="green.500"
                    color="white"
                    _hover={{ bg: 'green.600', transform: 'scale(1.05)' }}
                    transition="all 0.2s"
                    onClick={onComplete}
                  >
                    Start Using KeepKey
                  </Button>
                </VStack>
              </Box>
            )}
          </Box>
        </Box>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <Box p={6} borderTopWidth="1px" borderColor="gray.700">
          <HStack justify="space-between">
            <Text fontSize="sm" color="gray.400">
              {visibleIndex >= 0
                ? `Step ${visibleIndex + 1} of ${VISIBLE_STEPS.length}`
                : step === 'welcome'
                  ? ''
                  : 'Setting up wallet...'}
            </Text>
            <HStack gap={4}>
              {showPrevious && (
                <Button
                  variant="outline"
                  onClick={handlePrevious}
                  borderColor="gray.600"
                  color="gray.300"
                  _hover={{ bg: 'gray.700' }}
                >
                  Previous
                </Button>
              )}
              {showNext && (
                <Button
                  size="lg"
                  bg={HIGHLIGHT}
                  color="white"
                  _hover={{ bg: 'orange.600' }}
                  onClick={handleNext}
                >
                  Next
                </Button>
              )}
            </HStack>
          </HStack>
        </Box>
      </Box>
    </Flex>
  )
}
