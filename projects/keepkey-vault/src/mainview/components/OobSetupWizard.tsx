import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Box, Text, VStack, HStack, Flex, Button, Spinner, Input } from '@chakra-ui/react'
import {
  FaDownload,
  FaWallet,
  FaKey,
  FaCheckCircle,
  FaExclamationTriangle,
  FaPlus,
  FaChevronDown,
  FaChevronUp,
} from 'react-icons/fa'
import holdAndConnectSvg from '../assets/svg/hold-and-connect.svg'
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
  @keyframes kkStripe {
    0%   { background-position: 0 0; }
    100% { background-position: 40px 0; }
  }
  @keyframes kkGlow {
    0%   { box-shadow: 0 0 8px rgba(251, 146, 60, 0.4); }
    50%  { box-shadow: 0 0 20px rgba(251, 146, 60, 0.7); }
    100% { box-shadow: 0 0 8px rgba(251, 146, 60, 0.4); }
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

// STEP_DESCRIPTIONS and VISIBLE_STEPS moved inside component to use t()

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
  onSetupInProgress?: (inProgress: boolean) => void
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

export function OobSetupWizard({ onComplete, onSetupInProgress }: OobSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>('welcome')
  const [setupType, setSetupType] = useState<'create' | 'recover' | null>(null)
  const [wordCount, setWordCount] = useState<12 | 18 | 24>(12)
  const [deviceLabel, setDeviceLabel] = useState('')
  const [setupError, setSetupError] = useState<string | null>(null)
  const [, setSetupLoading] = useState(false)
  const { t } = useTranslation('setup')

  const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
    'welcome': t('stepDescriptions.welcome'),
    'bootloader': t('stepDescriptions.bootloader'),
    'firmware': t('stepDescriptions.firmware'),
    'init-choose': t('stepDescriptions.initChoose'),
    'init-progress': t('stepDescriptions.initProgress'),
    'init-label': t('stepDescriptions.initLabel'),
    'complete': t('stepDescriptions.complete'),
  }

  const VISIBLE_STEPS = [
    { id: 'bootloader', label: t('visibleSteps.bootloader'), number: 1 },
    { id: 'firmware', label: t('visibleSteps.firmware'), number: 2 },
    { id: 'init-choose', label: t('visibleSteps.setup'), number: 3 },
  ]

  // Advanced seed length toggle for create wallet
  const [showCreateAdvanced, setShowCreateAdvanced] = useState(false)

  // Dev: load-device dialog
  const [devLoadOpen, setDevLoadOpen] = useState(false)
  const [devSeed, setDevSeed] = useState('')
  const [devAcknowledged, setDevAcknowledged] = useState(false)

  // Bootloader state
  const [waitingForBootloader, setWaitingForBootloader] = useState(false)
  const [waitingForBootloaderFw, setWaitingForBootloaderFw] = useState(false)
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

  // ── Signal setupInProgress for entire wizard lifecycle ─────────────────
  // Keeps wizard visible during device reboots (firmware → init-choose transition)
  useEffect(() => {
    onSetupInProgress?.(step !== 'complete')
    return () => onSetupInProgress?.(false)
  }, [step, onSetupInProgress])

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

  // Auto-start: if device is already in bootloader mode when we reach this step
  useEffect(() => {
    if (step !== 'bootloader') return
    if (updateState !== 'idle') return
    if (!inBootloader) return
    startBootloaderUpdate()
  }, [step, updateState, inBootloader, startBootloaderUpdate])

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

  const handleEnterBootloaderForFirmware = () => {
    setWaitingForBootloaderFw(true)
    bootloaderPollRef.current = setInterval(async () => {
      try {
        const state = await rpcRequest('getDeviceState')
        if (state.bootloaderMode) {
          setWaitingForBootloaderFw(false)
          if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
          await startFirmwareUpdate(deviceStatus.latestFirmware || undefined)
        }
      } catch {
        // Device may be disconnecting/reconnecting
      }
    }, 2000)
  }

  // Event-driven: detect bootloader mode for firmware step
  useEffect(() => {
    if (step !== 'firmware') return
    if (!waitingForBootloaderFw) return
    if (updateState === 'updating') return

    if (deviceStatus.bootloaderMode) {
      setWaitingForBootloaderFw(false)
      if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
      startFirmwareUpdate(deviceStatus.latestFirmware || undefined)
    }
  }, [step, waitingForBootloaderFw, deviceStatus.bootloaderMode, updateState, startFirmwareUpdate, deviceStatus.latestFirmware])

  // Auto-start firmware update if already in bootloader mode,
  // otherwise auto-start polling for bootloader entry
  useEffect(() => {
    if (step !== 'firmware') return
    if (updateState !== 'idle') return
    if (inBootloader) {
      startFirmwareUpdate(deviceStatus.latestFirmware || undefined)
    } else if (!waitingForBootloaderFw) {
      handleEnterBootloaderForFirmware()
    }
  }, [step, updateState, inBootloader])

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

  // No timeout for device-interactive ops — user can take as long as needed
  const DEVICE_INTERACTION_TIMEOUT = 0

  const handleCreateWallet = async () => {
    setSetupType('create')
    setStep('init-progress')
    setSetupLoading(true)
    setSetupError(null)
    try {
      await rpcRequest('resetDevice', {
        wordCount,
        pin: true,
        passphrase: false,
      }, DEVICE_INTERACTION_TIMEOUT)
      setStep('init-label')
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : t('initProgress.failedToCreate'))
      setStep('init-choose')
    } finally {
      setSetupLoading(false)
    }
  }

  const handleDevLoadDevice = async () => {
    const words = devSeed.trim()
    if (!words || words.split(/\s+/).length < 12) return
    setDevLoadOpen(false)
    setSetupType('create')
    setStep('init-progress')
    setSetupLoading(true)
    setSetupError(null)
    try {
      await rpcRequest('loadDevice', { mnemonic: words }, DEVICE_INTERACTION_TIMEOUT)
      setDevSeed('')
      setDevAcknowledged(false)
      setStep('init-label')
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to load device')
      setStep('init-choose')
    } finally {
      setSetupLoading(false)
    }
  }

  const handleDevLoadCancel = () => {
    setDevLoadOpen(false)
    setDevSeed('')
    setDevAcknowledged(false)
  }

  const handleRecoverWallet = async () => {
    setSetupType('recover')
    setStep('init-progress')
    setSetupLoading(true)
    setSetupError(null)
    try {
      await rpcRequest('recoverDevice', {
        wordCount,
        pin: true,
        passphrase: false,
      }, DEVICE_INTERACTION_TIMEOUT)
      setStep('init-label')
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : t('initProgress.failedToRecover'))
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
      className="electrobun-webkit-app-region-drag"
    >
      <style>{ANIMATIONS_CSS}</style>

      <Box
        w={{ base: '100vw', md: '90vw', lg: '80vw' }}
        maxW="900px"
        maxH="90vh"
        bg="gray.800"
        borderRadius={{ base: 'none', md: 'xl' }}
        boxShadow={{ base: 'none', md: '0 8px 32px rgba(0,0,0,0.5)' }}
        borderWidth={{ base: '0', md: '1px' }}
        borderColor="gray.700"
        overflow="auto"
        display="flex"
        flexDirection="column"
        onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <Box px={4} py={2} borderBottomWidth="1px" borderColor="gray.700">
          <VStack gap={0.5}>
            <Text fontSize="md" fontWeight="bold" color={HIGHLIGHT}>
              {t('title')}
            </Text>
            <Text fontSize="xs" color="gray.400">
              {STEP_DESCRIPTIONS[step]}
            </Text>
          </VStack>
        </Box>

        {/* ── Progress bar ───────────────────────────────────────────── */}
        <Box px={4} py={1}>
          <Box h="3px" bg="gray.700" borderRadius="full" overflow="hidden">
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
        <Box px={4} py={1.5} overflowX="auto">
          <HStack gap={2} justify="center" minW="fit-content">
            {VISIBLE_STEPS.map((vs, idx) => {
              const completed = isVisibleStepCompleted(vs.id)
              const current = isVisibleStepCurrent(vs.id)

              return (
                <Flex key={vs.id} align="center" flexShrink={0}>
                  <Box
                    w={7}
                    h={7}
                    borderRadius="full"
                    bg={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.600'}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    transition="all 0.3s"
                    flexShrink={0}
                    transform={current ? 'scale(1.1)' : 'scale(1)'}
                    boxShadow={current ? '0 0 0 3px rgba(251, 146, 60, 0.25)' : 'none'}
                  >
                    {completed ? (
                      <FaCheckCircle color="white" size={12} />
                    ) : (
                      <Text color="white" fontSize="xs" fontWeight="bold">
                        {vs.number}
                      </Text>
                    )}
                  </Box>
                  <Text
                    ml={1.5}
                    fontSize="xs"
                    fontWeight={current ? 'bold' : 'normal'}
                    color={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.400'}
                    whiteSpace="nowrap"
                  >
                    {vs.label}
                  </Text>
                  {idx < VISIBLE_STEPS.length - 1 && (
                    <Box
                      w={8}
                      h="2px"
                      bg={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.600'}
                      ml={1.5}
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
          p={{ base: 3, md: 4 }}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w="100%"
        >
          <Box w="100%" maxW="800px">
            {/* ═══════════════ WELCOME ═══════════════════════════════ */}
            {step === 'welcome' && (
              <VStack gap={4} textAlign="center" w="100%">
                <FaWallet
                  color="#F59E0B"
                  size={48}
                  style={{ animation: 'kkPulse 2s ease-in-out infinite' }}
                />
                <VStack gap={1}>
                  <Text fontSize="xl" fontWeight="bold" color="white">
                    {t('welcome.title')}
                  </Text>
                  <Text fontSize="sm" color={HIGHLIGHT}>
                    {t('subtitle')}
                  </Text>
                  <Text fontSize="sm" color="gray.400" maxW="360px">
                    {isOobDevice
                      ? t('welcome.oobIntro')
                      : t('welcome.intro')}
                  </Text>
                </VStack>
                <HStack gap={2}>
                  <Spinner size="sm" color="gray.500" />
                  <Text fontSize="xs" color="gray.500">
                    {deviceStatus.state !== 'disconnected' ? t('welcome.startingSetup') : t('welcome.detectingDevice')}
                  </Text>
                </HStack>
              </VStack>
            )}

            {/* ═══════════════ BOOTLOADER ════════════════════════════ */}
            {step === 'bootloader' && (
              <VStack gap={3} w="100%" maxW="460px" mx="auto">
                {!inBootloader && updateState !== 'updating' && updateState !== 'error' && (
                  <>
                    <Box maxW="100px" mx="auto" opacity={0.85}>
                      <img src={holdAndConnectSvg} alt="Hold button and connect USB" style={{ width: '100%' }} />
                    </Box>
                    <VStack gap={1}>
                      <Text fontSize="lg" fontWeight="bold" color="white" textAlign="center">
                        {t('bootloader.title')}
                      </Text>
                      <Text fontSize="xs" color="gray.400" textAlign="center">
                        {t('bootloader.description')}
                      </Text>
                    </VStack>

                    {deviceStatus.latestBootloader && (
                      <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                        <HStack justify="space-between">
                          <VStack gap={0.5} align="start">
                            <Text fontSize="2xs" color="gray.400" textTransform="uppercase">{t('bootloader.current')}</Text>
                            <Text fontSize="sm" color="orange.400" fontWeight="bold">
                              {(deviceStatus.bootloaderVersion && !deviceStatus.bootloaderVersion.startsWith('hash:'))
                                ? `v${deviceStatus.bootloaderVersion}`
                                : t('bootloader.outdated')}
                            </Text>
                          </VStack>
                          <Text color="gray.500">&rarr;</Text>
                          <VStack gap={0.5} align="end">
                            <Text fontSize="2xs" color="gray.400" textTransform="uppercase">{t('bootloader.latest')}</Text>
                            <Text fontSize="sm" color="green.400" fontWeight="bold">
                              v{deviceStatus.latestBootloader}
                            </Text>
                          </VStack>
                        </HStack>
                      </Box>
                    )}

                    <Box w="100%" p={3} bg="gray.700" borderRadius="lg" borderWidth="2px" borderColor="yellow.600">
                      <VStack align="start" gap={1}>
                        <HStack gap={2}>
                          <FaExclamationTriangle color="#ECC94B" size={14} />
                          <Text fontSize="xs" fontWeight="bold" color="yellow.300">
                            {t('bootloader.enterFirmwareUpdateMode')}
                          </Text>
                        </HStack>
                        <VStack align="start" gap={0} pl={5}>
                          <Text fontSize="xs" color="gray.200">{t('bootloader.step1Unplug')}</Text>
                          <Text fontSize="xs" color="gray.200">{t('bootloader.step2Hold')}</Text>
                          <Text fontSize="xs" color="gray.200">{t('bootloader.step3Plugin')}</Text>
                          <Text fontSize="xs" color="gray.200">{t('bootloader.step4Release')}</Text>
                        </VStack>
                      </VStack>
                    </Box>

                    {waitingForBootloader && (
                      <HStack gap={2} w="100%" justify="center">
                        <Spinner size="sm" color="yellow.400" />
                        <Text fontSize="xs" color="yellow.300">
                          {t('bootloader.listeningForBootloader')}
                        </Text>
                      </HStack>
                    )}

                    {!waitingForBootloader && (
                      <>
                        <Button
                          w="100%"
                          size="md"
                          bg={HIGHLIGHT}
                          color="white"
                          _hover={{ bg: 'orange.600' }}
                          onClick={handleEnterBootloaderMode}
                        >
                          {t('bootloader.readyDetectBootloader')}
                        </Button>
                        <Button
                          w="100%"
                          size="sm"
                          variant="ghost"
                          color="gray.400"
                          _hover={{ color: 'white', bg: 'gray.700' }}
                          onClick={() => {
                            if (needsFirmware) setStep('firmware')
                            else setStep('init-choose')
                          }}
                        >
                          {t('bootloader.skipBootloaderUpdate')}
                        </Button>
                      </>
                    )}
                  </>
                )}

                {updateState === 'updating' && (
                  <VStack gap={2} w="100%">
                    <FaDownload color="#F59E0B" size={32} />
                    <Text fontSize="lg" fontWeight="bold" color="white" textAlign="center">
                      {t('bootloader.title')}
                    </Text>
                    <Spinner size="md" color="blue.400" />
                    <Text fontSize="xs" color="gray.300">
                      {updateProgress?.message || t('bootloader.updatingBootloader')}
                    </Text>

                    {deviceStatus.latestBootloader && (
                      <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                        <HStack justify="space-between">
                          <VStack gap={0.5} align="start">
                            <Text fontSize="2xs" color="gray.400" textTransform="uppercase">{t('bootloader.current')}</Text>
                            <Text fontSize="sm" color="orange.400" fontWeight="bold">
                              v{deviceStatus.firmwareVersion || '?'}
                            </Text>
                          </VStack>
                          <Text color="gray.500">&rarr;</Text>
                          <VStack gap={0.5} align="end">
                            <Text fontSize="2xs" color="gray.400" textTransform="uppercase">{t('bootloader.latest')}</Text>
                            <Text fontSize="sm" color="green.400" fontWeight="bold">
                              v{deviceStatus.latestBootloader}
                            </Text>
                          </VStack>
                        </HStack>
                      </Box>
                    )}

                    <Box w="100%" p={2} bg="blue.900" borderRadius="md" borderWidth="1px" borderColor="blue.500">
                      <HStack gap={2} align="flex-start">
                        <Box mt="2px" flexShrink={0}>
                          <FaExclamationTriangle color="#63B3ED" size={12} />
                        </Box>
                        <Text fontSize="2xs" color="blue.200">
                          {t('bootloader.verifyBackupHint')}
                        </Text>
                      </HStack>
                    </Box>
                    <Box w="100%" p={2} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                      <HStack gap={2}>
                        <FaExclamationTriangle color="#FC8181" size={12} />
                        <Text fontSize="2xs" color="red.200">
                          {t('bootloader.doNotUnplugBrick')}
                        </Text>
                      </HStack>
                    </Box>
                  </VStack>
                )}

                {updateState === 'error' && (
                  <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <VStack gap={1} align="start">
                      <Text fontSize="sm" color="red.300" fontWeight="bold">{t('bootloader.updateFailed')}</Text>
                      <Text fontSize="xs" color="red.200">{updateError}</Text>
                    </VStack>
                    <Button
                      mt={2}
                      size="sm"
                      variant="outline"
                      borderColor="red.400"
                      color="red.300"
                      onClick={() => { resetUpdate(); setWaitingForBootloader(false) }}
                    >
                      {t('bootloader.tryAgain')}
                    </Button>
                  </Box>
                )}
              </VStack>
            )}

            {/* ═══════════════ FIRMWARE ══════════════════════════════ */}
            {step === 'firmware' && (
              <VStack gap={3} w="100%" maxW="460px" mx="auto">
                <FaDownload color="#F59E0B" size={32} />
                <VStack gap={1}>
                  <Text fontSize="lg" fontWeight="bold" color="white" textAlign="center">
                    {t('firmware.title')}
                  </Text>
                  <Text fontSize="xs" color="gray.400" textAlign="center">
                    {isOobDevice ? t('firmware.oobDescription') : t('firmware.description')}
                  </Text>
                </VStack>

                <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                  <HStack justify="space-between">
                    <VStack gap={0.5} align="start">
                      <Text fontSize="2xs" color="gray.400" textTransform="uppercase">
                        {inBootloader ? t('firmware.firmwareLabel') : t('bootloader.current')}
                      </Text>
                      <Text fontSize="sm" color={isOobDevice ? 'red.400' : 'white'} fontWeight="bold">
                        {inBootloader ? t('firmware.notInstalled') : `v${deviceStatus.firmwareVersion || '?'}`}
                      </Text>
                    </VStack>
                    <Text color="gray.500">&rarr;</Text>
                    <VStack gap={0.5} align="end">
                      <Text fontSize="2xs" color="gray.400" textTransform="uppercase">{t('bootloader.latest')}</Text>
                      <Text fontSize="sm" color="green.400" fontWeight="bold">
                        v{deviceStatus.latestFirmware || '?'}
                      </Text>
                    </VStack>
                  </HStack>
                </Box>

                {updateState === 'idle' && !inBootloader && (
                  <>
                    <Box maxW="100px" mx="auto" opacity={0.85}>
                      <img src={holdAndConnectSvg} alt="Hold button and connect USB" style={{ width: '100%' }} />
                    </Box>
                    <Box w="100%" p={2} bg="gray.700" borderRadius="lg" borderWidth="2px" borderColor="yellow.600">
                      <VStack align="start" gap={0.5}>
                        <HStack gap={2}>
                          <FaExclamationTriangle color="#ECC94B" size={12} />
                          <Text fontSize="xs" fontWeight="bold" color="yellow.300">
                            {t('bootloader.enterFirmwareUpdateMode')}
                          </Text>
                        </HStack>
                        <VStack align="start" gap={0} pl={5}>
                          <Text fontSize="2xs" color="gray.200">{t('bootloader.step1Unplug')}</Text>
                          <Text fontSize="2xs" color="gray.200">{t('bootloader.step2Hold')}</Text>
                          <Text fontSize="2xs" color="gray.200">{t('bootloader.step3Plugin')}</Text>
                          <Text fontSize="2xs" color="gray.200">{t('bootloader.step4Release')}</Text>
                        </VStack>
                      </VStack>
                    </Box>
                    <HStack gap={2} w="100%" justify="center">
                      <Spinner size="sm" color="yellow.400" />
                      <Text fontSize="xs" color="yellow.300">
                        {t('bootloader.listeningForBootloader')}
                      </Text>
                    </HStack>
                  </>
                )}

                {updateState === 'updating' && (
                  <VStack gap={2} w="100%">
                    <Box
                      w="100%"
                      p={3}
                      bg="orange.900"
                      borderRadius="lg"
                      borderWidth="2px"
                      borderColor={HIGHLIGHT}
                      style={{ animation: 'kkGlow 2s ease-in-out infinite' }}
                    >
                      <VStack gap={1}>
                        <Text fontSize="sm" fontWeight="bold" color="orange.200">
                          {t('firmware.confirmOnDevice')}
                        </Text>
                        <Text fontSize="xs" color="orange.100">
                          {t('firmware.lookAtDeviceAndPress')}
                        </Text>
                        <Text fontSize="2xs" color="orange.200" opacity={0.7}>
                          {t('firmware.verifyBackupNote')}
                        </Text>
                      </VStack>
                    </Box>

                    <Box w="100%">
                      <Box w="100%" h="8px" bg="gray.700" borderRadius="full" overflow="hidden">
                        <Box
                          h="100%"
                          borderRadius="full"
                          w={updateProgress?.percent != null ? `${updateProgress.percent}%` : '100%'}
                          transition="width 0.3s"
                          bg={HIGHLIGHT}
                          backgroundImage="linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.15) 75%, transparent 75%, transparent)"
                          backgroundSize="40px 40px"
                          style={{ animation: 'kkStripe 1s linear infinite' }}
                        />
                      </Box>
                      <HStack justify="space-between" mt={0.5}>
                        {updateProgress?.percent != null ? (
                          <Text fontSize="2xs" color="gray.400">{Math.round(updateProgress.percent)}%</Text>
                        ) : <Box />}
                        <Text fontSize="2xs" color="red.300">{t('firmware.doNotUnplug')}</Text>
                      </HStack>
                    </Box>
                  </VStack>
                )}

                {updateState === 'complete' && (
                  <Box w="100%" p={3} bg="blue.900" borderRadius="md" borderWidth="2px" borderColor="blue.500">
                    <VStack gap={1} align="start">
                      <HStack gap={2}>
                        <Spinner size="sm" color="blue.300" />
                        <Text fontSize="xs" color="blue.300" fontWeight="bold">
                          {t('firmware.deviceRebooting')}
                        </Text>
                      </HStack>
                      <Text fontSize="2xs" color="blue.200">
                        {t('firmware.rebootingMessage')}
                      </Text>
                      {deviceStatus.firmwareVerified !== undefined && (
                        <HStack gap={2}>
                          {deviceStatus.firmwareVerified ? (
                            <>
                              <FaCheckCircle color="#48BB78" size={12} />
                              <Text fontSize="2xs" color="green.300" fontWeight="bold">
                                {t('firmware.firmwareVerified')}
                              </Text>
                            </>
                          ) : (
                            <>
                              <FaExclamationTriangle color="#FB923C" size={12} />
                              <Text fontSize="2xs" color="orange.300" fontWeight="bold">
                                {t('firmware.firmwareHashNotFound')}
                              </Text>
                            </>
                          )}
                        </HStack>
                      )}
                    </VStack>
                  </Box>
                )}

                {updateState === 'error' && (
                  <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <VStack gap={1} align="start">
                      <Text fontSize="sm" color="red.300" fontWeight="bold">{t('bootloader.updateFailed')}</Text>
                      <Text fontSize="xs" color="red.200">{updateError}</Text>
                    </VStack>
                    <Button mt={2} size="sm" variant="outline" borderColor="red.400" color="red.300" onClick={resetUpdate}>
                      {t('bootloader.tryAgain')}
                    </Button>
                  </Box>
                )}

                {updateState === 'idle' && !isOobDevice && (
                  <Button
                    w="100%"
                    variant="ghost"
                    color="gray.500"
                    size="xs"
                    _hover={{ color: 'gray.300', bg: 'gray.700' }}
                    onClick={handleSkipFirmware}
                  >
                    {t('firmware.skipUpdate')}
                  </Button>
                )}
              </VStack>
            )}

            {/* ═══════════════ INIT: CHOOSE ═════════════════════════ */}
            {step === 'init-choose' && (
              <VStack gap={3} w="100%">
                <VStack gap={0.5}>
                  <Text fontSize="lg" fontWeight="bold" color="white" textAlign="center">
                    {t('initChoose.title')}
                  </Text>
                  <Text fontSize="xs" color="gray.400" textAlign="center">
                    {t('initChoose.description')}
                  </Text>
                </VStack>

                {setupError && (
                  <Box w="100%" p={2} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <Text fontSize="xs" color="red.300">{setupError}</Text>
                  </Box>
                )}

                <HStack
                  gap={3}
                  w="100%"
                  flexDirection={{ base: 'column', md: 'row' }}
                  align="stretch"
                >
                  {/* Create New Wallet */}
                  <Box
                    flex={{ base: 'none', md: 1 }}
                    w={{ base: '100%', md: 'auto' }}
                    p={4}
                    borderRadius="lg"
                    borderWidth="2px"
                    borderColor="transparent"
                    bg="gray.700"
                    transition="all 0.2s"
                    _hover={{
                      borderColor: 'orange.500',
                      transform: 'translateY(-1px)',
                    }}
                  >
                    <VStack gap={3}>
                      <Box p={2} borderRadius="full" bg="orange.500" color="white">
                        <FaPlus size={20} />
                      </Box>
                      <VStack gap={1}>
                        <Text fontSize="md" fontWeight="bold" color="white">
                          {t('initChoose.createNewWallet')}
                        </Text>
                        <Text fontSize="xs" color="gray.400" textAlign="center">
                          {t('initChoose.createDescription')}
                        </Text>
                      </VStack>

                      <Box w="100%">
                        <Flex
                          as="button"
                          align="center"
                          justify="center"
                          gap="1"
                          w="100%"
                          cursor="pointer"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation()
                            setShowCreateAdvanced(!showCreateAdvanced)
                          }}
                          _hover={{ opacity: 0.8 }}
                        >
                          <Text fontSize="2xs" color="gray.500">
                            {t('initChoose.seedLength', { defaultValue: 'Seed length' })}: {wordCount} {t('initChoose.words', { defaultValue: 'words' })}
                          </Text>
                          {showCreateAdvanced
                            ? <FaChevronUp color="#718096" size={8} />
                            : <FaChevronDown color="#718096" size={8} />
                          }
                        </Flex>
                        {showCreateAdvanced && (
                          <VStack gap="1.5" mt="1.5">
                            <Flex gap="2" justify="center" w="100%">
                              {([12, 18, 24] as const).map((wc) => (
                                <Box
                                  key={wc}
                                  as="button"
                                  px="3"
                                  py="1"
                                  borderRadius="md"
                                  fontSize="xs"
                                  fontWeight="600"
                                  cursor="pointer"
                                  bg={wordCount === wc ? HIGHLIGHT : 'gray.600'}
                                  color={wordCount === wc ? 'white' : 'gray.400'}
                                  borderWidth="1px"
                                  borderColor={wordCount === wc ? HIGHLIGHT : 'transparent'}
                                  _hover={{ bg: wordCount === wc ? 'orange.600' : 'gray.500' }}
                                  transition="all 0.15s"
                                  onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation()
                                    setWordCount(wc)
                                  }}
                                >
                                  {wc}
                                </Box>
                              ))}
                            </Flex>
                            <Text fontSize="2xs" color="gray.500" textAlign="center" lineHeight="tall" px="1">
                              {t('initChoose.entropyNote', { defaultValue: 'Added seed length does not improve overall wallet entropy.' })}{' '}
                              <Text
                                as="a"
                                href="https://keepkey.com/blog/why_does_keepkey_only_generate_12_words_"
                                target="_blank"
                                rel="noopener noreferrer"
                                color={HIGHLIGHT}
                                textDecoration="underline"
                                _hover={{ color: 'orange.300' }}
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                              >
                                {t('initChoose.learnMore', { defaultValue: 'Learn more' })}
                              </Text>
                            </Text>
                          </VStack>
                        )}
                      </Box>

                      <Button
                        w="100%"
                        size="md"
                        bg={HIGHLIGHT}
                        color="white"
                        _hover={{ bg: 'orange.600' }}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation()
                          handleCreateWallet()
                        }}
                      >
                        {t('initChoose.createWallet')}
                      </Button>
                    </VStack>
                  </Box>

                  {/* Recover Existing Wallet */}
                  <Box
                    flex={{ base: 'none', md: 1 }}
                    w={{ base: '100%', md: 'auto' }}
                    p={4}
                    borderRadius="lg"
                    borderWidth="2px"
                    borderColor="transparent"
                    bg="gray.700"
                    transition="all 0.2s"
                    _hover={{
                      borderColor: 'blue.500',
                      transform: 'translateY(-1px)',
                    }}
                  >
                    <VStack gap={3}>
                      <Box p={2} borderRadius="full" bg="blue.500" color="white">
                        <FaKey size={20} />
                      </Box>
                      <VStack gap={1}>
                        <Text fontSize="md" fontWeight="bold" color="white">
                          {t('initChoose.recoverExistingWallet')}
                        </Text>
                        <Text fontSize="xs" color="gray.400" textAlign="center">
                          {t('initChoose.recoverDescription')}
                        </Text>
                      </VStack>

                      <Box w="100%">
                        <Text fontSize="xs" color="gray.300" textAlign="center" mb="1.5" fontWeight="500">
                          {t('initChoose.howManyWords', { defaultValue: 'How many words in your seed?' })}
                        </Text>
                        <Flex gap="2" justify="center" w="100%">
                          {([12, 18, 24] as const).map((wc) => (
                            <Box
                              key={wc}
                              as="button"
                              px="4"
                              py="1.5"
                              borderRadius="md"
                              fontSize="xs"
                              fontWeight="600"
                              cursor="pointer"
                              bg={wordCount === wc ? 'blue.500' : 'gray.600'}
                              color={wordCount === wc ? 'white' : 'gray.400'}
                              borderWidth="2px"
                              borderColor={wordCount === wc ? 'blue.500' : 'transparent'}
                              _hover={{ bg: wordCount === wc ? 'blue.600' : 'gray.500' }}
                              transition="all 0.15s"
                              onClick={(e: React.MouseEvent) => {
                                e.stopPropagation()
                                setWordCount(wc)
                              }}
                            >
                              {wc} {t('initChoose.words', { defaultValue: 'words' })}
                            </Box>
                          ))}
                        </Flex>
                      </Box>

                      <Button
                        w="100%"
                        size="md"
                        bg="blue.500"
                        color="white"
                        _hover={{ bg: 'blue.600' }}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation()
                          handleRecoverWallet()
                        }}
                      >
                        {t('initChoose.recoverWallet')}
                      </Button>
                    </VStack>
                  </Box>
                </HStack>

                <Text
                  fontSize="2xs"
                  color="gray.600"
                  cursor="pointer"
                  textAlign="center"
                  _hover={{ color: 'gray.500' }}
                  onClick={() => setDevLoadOpen(true)}
                >
                  Developer: load seed
                </Text>
              </VStack>
            )}

            {/* ═══════════════ INIT: IN PROGRESS ═══════════════════ */}
            {step === 'init-progress' && (
              <VStack gap={4} textAlign="center" w="100%" maxW="400px" mx="auto">
                <Spinner
                  size="lg"
                  color={HIGHLIGHT}
                  borderWidth="3px"
                />
                <VStack gap={1}>
                  <Text fontSize="md" fontWeight="bold" color="white">
                    {setupType === 'create' ? t('initProgress.creatingWallet') : t('initProgress.recoveringWallet')}
                  </Text>
                  <Text fontSize="xs" color="gray.400" maxW="320px">
                    {setupType === 'create'
                      ? t('initProgress.followPromptsCreate')
                      : setupType === 'recover'
                        ? t('initProgress.followPromptsRecover')
                        : t('initProgress.followPrompts')}
                  </Text>
                </VStack>

                <Box w="100%" p={3} bg="orange.900" borderRadius="lg" borderWidth="2px" borderColor={HIGHLIGHT}>
                  <HStack gap={2} justify="center">
                    <FaExclamationTriangle color="#F59E0B" size={14} />
                    <Text fontSize="xs" color="orange.200" fontWeight="bold">
                      {t('initProgress.lookAtDevice')}
                    </Text>
                  </HStack>
                </Box>
              </VStack>
            )}

            {/* ═══════════════ INIT: LABEL ══════════════════════════ */}
            {step === 'init-label' && (
              <VStack gap={4} w="100%" maxW="360px" mx="auto">
                <VStack gap={1}>
                  <FaCheckCircle color="#48BB78" size={32} />
                  <Text fontSize="lg" fontWeight="bold" color="white" textAlign="center">
                    {setupType === 'create' ? t('initLabel.walletCreated') : t('initLabel.walletRecovered')}
                  </Text>
                  <Text fontSize="xs" color="gray.400" textAlign="center">
                    {t('initLabel.giveAName')}
                  </Text>
                </VStack>

                <Input
                  placeholder={t('initLabel.placeholder')}
                  value={deviceLabel}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDeviceLabel(e.target.value)}
                  bg="gray.700"
                  borderColor="gray.600"
                  color="white"
                  size="md"
                  _hover={{ borderColor: 'gray.500' }}
                  _focus={{ borderColor: 'orange.500', boxShadow: '0 0 0 1px orange.500' }}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' && deviceLabel.trim()) {
                      handleApplyLabel()
                    }
                  }}
                />

                <VStack gap={2} w="100%">
                  <Button
                    w="100%"
                    size="md"
                    bg={HIGHLIGHT}
                    color="white"
                    _hover={{ bg: 'orange.600' }}
                    onClick={handleApplyLabel}
                    disabled={!deviceLabel.trim()}
                  >
                    {t('initLabel.setDeviceName')}
                  </Button>
                  <Button
                    w="100%"
                    size="sm"
                    variant="ghost"
                    color="gray.400"
                    _hover={{ color: 'white', bg: 'gray.700' }}
                    onClick={handleApplyLabel}
                  >
                    {t('initLabel.skipForNow')}
                  </Button>
                </VStack>
              </VStack>
            )}

            {/* ═══════════════ COMPLETE ═════════════════════════════ */}
            {step === 'complete' && (
              <Box position="relative" w="100%" overflow="hidden">
                {confettiPieces.map(piece => (
                  <Box
                    key={piece.id}
                    position="absolute"
                    w="8px"
                    h="8px"
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

                <VStack gap={4} textAlign="center" w="100%" position="relative" zIndex={1}>
                  <FaCheckCircle
                    color="#48BB78"
                    size={48}
                    style={{ animation: 'kkPulse 2s ease-in-out infinite' }}
                  />
                  <VStack gap={1}>
                    <Text fontSize="xl" fontWeight="bold" color="white">
                      {setupType === 'recover' ? t('complete.walletRecovered') : t('complete.walletCreated')}
                    </Text>
                    <Text fontSize="sm" color="gray.300">
                      {t('complete.deviceReady', { label: deviceLabel.trim() ? ` "${deviceLabel.trim()}"` : '' })}
                    </Text>
                    <Text fontSize="xs" color="gray.400" maxW="360px">
                      {setupType === 'recover'
                        ? t('complete.recoveredDescription')
                        : t('complete.createdDescription')}
                    </Text>
                  </VStack>
                  <Button
                    size="md"
                    bg="green.500"
                    color="white"
                    _hover={{ bg: 'green.600', transform: 'scale(1.03)' }}
                    transition="all 0.2s"
                    onClick={onComplete}
                  >
                    {t('complete.startUsing')}
                  </Button>
                </VStack>
              </Box>
            )}
          </Box>
        </Box>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <Box px={4} py={2} borderTopWidth="1px" borderColor="gray.700">
          <HStack justify="space-between">
            <Text fontSize="xs" color="gray.400">
              {visibleIndex >= 0
                ? t('footer.stepOf', { current: visibleIndex + 1, total: VISIBLE_STEPS.length })
                : step === 'welcome'
                  ? ''
                  : t('footer.settingUpWallet')}
            </Text>
            <HStack gap={3}>
              {showPrevious && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePrevious}
                  borderColor="gray.600"
                  color="gray.300"
                  _hover={{ bg: 'gray.700' }}
                >
                  {t('footer.previous')}
                </Button>
              )}
              {showNext && (
                <Button
                  size="sm"
                  bg={HIGHLIGHT}
                  color="white"
                  _hover={{ bg: 'orange.600' }}
                  onClick={handleNext}
                >
                  {t('footer.next')}
                </Button>
              )}
            </HStack>
          </HStack>
        </Box>
      </Box>

      {/* ── Dev Load-Device Dialog ──────────────────────────────────── */}
      {devLoadOpen && (
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
          onClick={handleDevLoadCancel}
        >
          <Box
            w="100%"
            maxW="420px"
            mx={4}
            bg="gray.900"
            borderRadius="xl"
            borderWidth="1px"
            borderColor="red.700"
            boxShadow="0 8px 32px rgba(0,0,0,0.6)"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <Box px={4} py={3} borderBottomWidth="1px" borderColor="gray.700">
              <HStack gap={2}>
                <FaExclamationTriangle color="#FC8181" size={16} />
                <Text fontSize="sm" fontWeight="bold" color="red.300">
                  Developer Seed Loading
                </Text>
              </HStack>
            </Box>

            <Box px={4} py={3}>
              <Box p={4} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600" mb={4}>
                <VStack gap={3} align="start">
                  <Text fontSize="sm" color="red.200" fontWeight="bold">
                    This defeats the purpose of a hardware wallet.
                  </Text>
                  <Text fontSize="xs" color="red.300" lineHeight="tall">
                    Loading a seed phrase via software transmits it over USB in
                    plaintext. Any malware on this computer can intercept it.
                    The entire security model of your KeepKey relies on the seed
                    never leaving the device — this bypasses that protection
                    entirely.
                  </Text>
                  <Text fontSize="xs" color="red.300" lineHeight="tall">
                    Only use this for throwaway development and testing wallets.
                    Never load a seed that controls real funds.
                  </Text>
                </VStack>
              </Box>

              {/* Acknowledgment checkbox */}
              <Box
                as="label"
                display="flex"
                alignItems="flex-start"
                gap={3}
                cursor="pointer"
                mb={4}
                p={3}
                borderRadius="md"
                bg={devAcknowledged ? 'whiteAlpha.50' : 'transparent'}
                _hover={{ bg: 'whiteAlpha.50' }}
              >
                <Box
                  as="input"
                  type="checkbox"
                  checked={devAcknowledged}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDevAcknowledged(e.target.checked)}
                  mt="2px"
                  style={{ accentColor: '#E53E3E', width: '16px', height: '16px', flexShrink: 0 }}
                />
                <Text fontSize="xs" color="gray.300" lineHeight="tall">
                  I understand this is for development only and that loading a
                  seed over USB compromises device security. I will not use a
                  seed that holds real funds.
                </Text>
              </Box>

              {/* Seed input */}
              <Box mb={4}>
                <Text fontSize="xs" color="gray.400" mb={1}>BIP-39 Mnemonic (12, 18, or 24 words)</Text>
                <Box
                  as="textarea"
                  value={devSeed}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDevSeed(e.target.value)}
                  placeholder="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
                  w="100%"
                  rows={3}
                  p={3}
                  bg="gray.800"
                  color="white"
                  borderWidth="1px"
                  borderColor={devAcknowledged ? 'gray.600' : 'gray.700'}
                  borderRadius="md"
                  fontSize="sm"
                  fontFamily="mono"
                  resize="none"
                  disabled={!devAcknowledged}
                  opacity={devAcknowledged ? 1 : 0.4}
                  _hover={devAcknowledged ? { borderColor: 'gray.500' } : {}}
                  _focus={devAcknowledged ? { borderColor: 'red.500', outline: 'none' } : {}}
                />
                {devSeed.trim() && (
                  <Text fontSize="xs" color="gray.500" mt={1}>
                    {devSeed.trim().split(/\s+/).length} words
                  </Text>
                )}
              </Box>

              {/* Actions */}
              <HStack gap={3} justify="flex-end">
                <Button
                  variant="ghost"
                  color="gray.400"
                  _hover={{ color: 'white', bg: 'gray.700' }}
                  onClick={handleDevLoadCancel}
                >
                  Cancel
                </Button>
                <Button
                  bg="red.600"
                  color="white"
                  _hover={{ bg: 'red.500' }}
                  disabled={!devAcknowledged || !devSeed.trim() || devSeed.trim().split(/\s+/).length < 12}
                  onClick={handleDevLoadDevice}
                >
                  Load Device
                </Button>
              </HStack>
            </Box>
          </Box>
        </Flex>
      )}
    </Flex>
  )
}
