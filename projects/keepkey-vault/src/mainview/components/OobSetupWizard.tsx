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
  FaFolderOpen,
} from 'react-icons/fa'
import holdAndConnectRaw from '../assets/svg/hold-and-connect.svg?raw'
import { useFirmwareUpdate } from '../hooks/useFirmwareUpdate'
import { useDeviceState } from '../hooks/useDeviceState'
import { rpcRequest, onRpcMessage } from '../lib/rpc'
import type { FirmwareAnalysis, FirmwareProgress } from '../../shared/types'
import { FirmwareUpgradePreview } from './FirmwareUpgradePreview'
import { TutorialPage } from './TutorialCards'
import { LanguagePicker } from '../i18n/LanguageSelector'

// ── Design tokens ───────────────────────────────────────────────────────────
const HIGHLIGHT = 'green.500'

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
    0%   { box-shadow: 0 0 8px rgba(72, 187, 120, 0.4); }
    50%  { box-shadow: 0 0 20px rgba(72, 187, 120, 0.7); }
    100% { box-shadow: 0 0 8px rgba(72, 187, 120, 0.4); }
  }
`

// ── Step definitions ────────────────────────────────────────────────────────

type WizardStep =
  | 'intro'
  | 'welcome'
  | 'bootloader'
  | 'firmware'
  | 'init-choose'
  | 'init-progress'
  | 'init-label'
  | 'verify-seed'
  | 'security-tips'
  | 'complete'

const STEP_SEQUENCE: WizardStep[] = [
  'intro',
  'welcome',
  'bootloader',
  'firmware',
  'init-choose',
  'init-progress',
  'init-label',
  'verify-seed',
  'security-tips',
  'complete',
]

// STEP_DESCRIPTIONS and VISIBLE_STEPS moved inside component to use t()

// Map wizard steps → their visible step group
const stepToVisibleId: Record<WizardStep, string | null> = {
  'intro': null,
  'welcome': null,
  'bootloader': 'bootloader',
  'firmware': 'firmware',
  'init-choose': 'init-choose',
  'init-progress': 'init-choose',
  'init-label': 'init-choose',
  'verify-seed': 'init-choose',
  'security-tips': null,
  'complete': null,
}

// ── Props ───────────────────────────────────────────────────────────────────

interface OobSetupWizardProps {
  onComplete: () => void
  onSetupInProgress?: (inProgress: boolean) => void
  onWordCountChange?: (count: 12 | 18 | 24) => void
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

export function OobSetupWizard({ onComplete, onSetupInProgress, onWordCountChange }: OobSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>('intro')
  const [introCard, setIntroCard] = useState(0)
  const [tipCard, setTipCard] = useState(0)
  const [setupType, setSetupType] = useState<'create' | 'recover' | null>(null)
  const [wordCount, setWordCount] = useState<12 | 18 | 24>(12)
  const [deviceLabel, setDeviceLabel] = useState('')
  const [setupError, setSetupError] = useState<string | null>(null)
  // Seed verification state
  const [verifyingPhase, setVerifyingPhase] = useState<'idle' | 'verifying' | 'success' | 'failed'>('idle')
  const [verifyError, setVerifyError] = useState<string | null>(null)
  // L1 fix: removed unused setupLoading state (value was never read)
  const { t } = useTranslation('setup')
  const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
    'intro': '',
    'welcome': t('stepDescriptions.welcome'),
    'bootloader': t('stepDescriptions.bootloader'),
    'firmware': t('stepDescriptions.firmware'),
    'init-choose': t('stepDescriptions.initChoose'),
    'init-progress': t('stepDescriptions.initProgress'),
    'init-label': t('stepDescriptions.initLabel'),
    'verify-seed': t('stepDescriptions.verifySeed', { defaultValue: 'Verify your recovery phrase' }),
    'security-tips': t('stepDescriptions.securityTips', { defaultValue: 'Security tips' }),
    'complete': t('stepDescriptions.complete'),
  }

  const VISIBLE_STEPS = [
    { id: 'bootloader', label: t('visibleSteps.bootloader'), number: 1 },
    { id: 'firmware', label: t('visibleSteps.firmware'), number: 2 },
    { id: 'init-choose', label: t('visibleSteps.setup'), number: 3 },
  ]

  // Read-more toggle on welcome/bootloader
  const [showReadMore, setShowReadMore] = useState(false)
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

  // Custom firmware state (inline file picker in firmware step)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [customFwPhase, setCustomFwPhase] = useState<'idle' | 'analyzing' | 'confirm' | 'flashing' | 'error'>('idle')
  const [customFwAnalysis, setCustomFwAnalysis] = useState<FirmwareAnalysis | null>(null)
  const [customFwDataB64, setCustomFwDataB64] = useState('')
  const [customFwFileName, setCustomFwFileName] = useState('')
  const [customFwError, setCustomFwError] = useState<string | null>(null)
  const [customFwProgress, setCustomFwProgress] = useState<FirmwareProgress | null>(null)
  const [customFwAcknowledged, setCustomFwAcknowledged] = useState(false)

  // Reboot phase: after BL/FW flash, wait for device to reconnect with fresh features
  const [rebootPhase, setRebootPhase] = useState<'idle' | 'rebooting'>('idle')
  // Post-flash: firmware was just flashed, waiting for user to confirm on device
  const [firmwareJustFlashed, setFirmwareJustFlashed] = useState(false)
  // Tracks elapsed time during reboot for progressive user messaging
  const [rebootElapsedMs, setRebootElapsedMs] = useState(0)

  // Tick reboot elapsed timer while waiting for device reconnection
  useEffect(() => {
    if (rebootPhase !== 'rebooting') {
      setRebootElapsedMs(0)
      return
    }
    const timer = setInterval(() => {
      setRebootElapsedMs(prev => prev + 1000)
    }, 1000)
    return () => clearInterval(timer)
  }, [rebootPhase])

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

  // Bootloader skip is only safe on firmware >= 6.1.1.
  // In bootloader mode we don't know the FW version — never allow skip.
  const canSkipBootloader = (() => {
    if (inBootloader) return false
    const fv = deviceStatus.firmwareVersion
    if (!fv) return false
    const [maj, min, pat] = fv.split('.').map(Number)
    if (maj > 6) return true
    if (maj === 6 && min > 1) return true
    if (maj === 6 && min === 1 && pat >= 1) return true
    return false
  })()

  // ── Progress calculation ────────────────────────────────────────────────

  const visibleId = stepToVisibleId[step]
  const visibleIndex = visibleId ? VISIBLE_STEPS.findIndex(s => s.id === visibleId) : -1

  let progressPercent = 0
  if (visibleIndex >= 0) {
    progressPercent = ((visibleIndex + 1) / VISIBLE_STEPS.length) * 100
  } else if (step !== 'welcome' && step !== 'intro') {
    progressPercent = 100
  }

  const isVisibleStepCompleted = (vsId: string) => {
    const vsIndex = VISIBLE_STEPS.findIndex(s => s.id === vsId)
    if (step === 'complete' || step === 'security-tips' || step === 'verify-seed' || step === 'init-label' || step === 'init-progress') return true
    const curVsIndex = visibleIndex
    return vsIndex < curVsIndex
  }

  const isVisibleStepCurrent = (vsId: string) => visibleId === vsId

  // ── Signal setupInProgress for entire wizard lifecycle ─────────────────
  // M5 fix: Split into two effects — step changes signal the current value
  // (no cleanup that would briefly flash false between transitions), and a
  // separate unmount-only effect signals false when the wizard is removed.
  // Keep setupInProgress=true for ALL steps including 'complete' — the confetti
  // screen must hold the phase lock so Dashboard doesn't mount with forceRefresh=false
  // before onComplete() fires (5s timer or button click). App.tsx onComplete handles
  // the transition: setWizardComplete(true) + setSetupInProgress(false).
  useEffect(() => {
    onSetupInProgress?.(true)
  }, [step, onSetupInProgress])

  useEffect(() => {
    // onSetupInProgress is setSetupInProgress (stable React setter) — safe to capture
    return () => onSetupInProgress?.(false)
  }, [onSetupInProgress])

  // ── Welcome → user clicks to advance ───────────────────────────────────
  // Only enable "Get Started" when real device features are available.
  // connected_unpaired has no features yet — routing from that state would
  // see all needs* flags as false and fall through to onComplete().
  const hasFeatures = !['disconnected', 'connected_unpaired', 'error'].includes(deviceStatus.state)
  const welcomeReady = step === 'welcome' && hasFeatures

  const handleWelcomeNext = useCallback(() => {
    // Double-guard: refuse to route without real features
    if (!hasFeatures) return
    if (needsBootloader) {
      setStep('bootloader')
    } else if (needsFirmware) {
      setStep('firmware')
    } else if (needsInit) {
      setStep('init-choose')
    } else {
      onComplete()
    }
  }, [hasFeatures, needsBootloader, needsFirmware, needsInit, onComplete])

  // ── Bootloader step ────────────────────────────────────────────────────

  const handleEnterBootloaderMode = () => {
    if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current) // H1 fix
    setWaitingForBootloader(true)
    // Poll device state for bootloader mode detection (does NOT auto-start update)
    bootloaderPollRef.current = setInterval(async () => {
      try {
        const state = await rpcRequest('getDeviceState')
        if (state.bootloaderMode) {
          setWaitingForBootloader(false)
          if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
        }
      } catch {
        // Device may be disconnecting/reconnecting
      }
    }, 2000)
  }

  // Event-driven bootloader detection via device state pushes (does NOT auto-start)
  useEffect(() => {
    if (!waitingForBootloader) return
    if (updateState === 'updating') return

    if (deviceStatus.bootloaderMode) {
      setWaitingForBootloader(false)
      if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
    }
  }, [waitingForBootloader, deviceStatus.bootloaderMode, updateState])

  // Auto-skip bootloader step when BL is already up to date
  useEffect(() => {
    if (step !== 'bootloader') return
    // Don't make routing decisions without real device features (Windows disconnect gap)
    const s = deviceStatus.state
    if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return
    if (needsBootloader) return // BL actually needs updating
    if (updateState !== 'idle') return
    if (rebootPhase === 'rebooting') return
    // BL is current — skip straight to firmware or init
    if (needsFirmware) {
      setStep('firmware')
    } else if (needsInit) {
      setStep('init-choose')
    } else {
      onComplete()
    }
  }, [step, needsBootloader, needsFirmware, needsInit, updateState, rebootPhase, onComplete, deviceStatus.state])

  // Auto-start bootloader detection polling when entering bootloader step
  useEffect(() => {
    if (step !== 'bootloader') return
    const s = deviceStatus.state
    if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return
    if (inBootloader) return // Already detected
    if (waitingForBootloader) return // Already polling
    if (updateState !== 'idle') return
    if (rebootPhase === 'rebooting') return
    if (!needsBootloader) return // BL up to date, skip handled above
    handleEnterBootloaderMode()
  }, [step, inBootloader, waitingForBootloader, updateState, rebootPhase, needsBootloader, deviceStatus.state])

  // Enter reboot phase when bootloader update completes
  useEffect(() => {
    if (step !== 'bootloader') return
    if (updateState !== 'complete') return
    resetUpdate()
    setRebootPhase('rebooting')
  }, [updateState, step, resetUpdate])

  // Advance once device reconnects with fresh features after bootloader update
  useEffect(() => {
    if (step !== 'bootloader') return
    if (rebootPhase !== 'rebooting') return
    // Wait until engine has re-paired and fetched real features
    if (!deviceStatus.firmwareVersion) return
    // Ignore transitional states
    const s = deviceStatus.state
    if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return

    setRebootPhase('idle')

    // Device is back — route based on fresh state
    if (s === 'bootloader' && needsBootloader) return // stay, user can retry
    if (needsFirmware) {
      setStep('firmware')
    } else if (needsInit) {
      setStep('init-choose')
    } else {
      onComplete()
    }
  }, [step, rebootPhase, deviceStatus.firmwareVersion, deviceStatus.state, needsBootloader, needsFirmware, needsInit, onComplete])

  useEffect(() => {
    return () => {
      if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
    }
  }, [])

  // ── Firmware step ──────────────────────────────────────────────────────

  const handleEnterBootloaderForFirmware = () => {
    if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current) // H1 fix
    setWaitingForBootloaderFw(true)
    bootloaderPollRef.current = setInterval(async () => {
      try {
        const state = await rpcRequest('getDeviceState')
        if (state.bootloaderMode) {
          setWaitingForBootloaderFw(false)
          if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
        }
      } catch {
        // Device may be disconnecting/reconnecting
      }
    }, 2000)
  }

  // Event-driven: detect bootloader mode for firmware step (does NOT auto-start)
  useEffect(() => {
    if (step !== 'firmware') return
    if (!waitingForBootloaderFw) return
    if (updateState === 'updating') return

    if (deviceStatus.bootloaderMode) {
      setWaitingForBootloaderFw(false)
      if (bootloaderPollRef.current) clearInterval(bootloaderPollRef.current)
    }
  }, [step, waitingForBootloaderFw, deviceStatus.bootloaderMode, updateState])

  // Auto-start polling for bootloader entry (not the update itself)
  useEffect(() => {
    if (step !== 'firmware') return
    const s = deviceStatus.state
    if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return
    if (updateState !== 'idle') return
    if (rebootPhase === 'rebooting') return
    if (inBootloader) return // Already in BL — user will click to start
    if (!waitingForBootloaderFw) {
      handleEnterBootloaderForFirmware()
    }
  }, [step, updateState, rebootPhase, inBootloader, waitingForBootloaderFw, deviceStatus.state]) // H4 fix: added waitingForBootloaderFw

  // Enter reboot phase when firmware update completes
  useEffect(() => {
    if (step !== 'firmware') return
    if (updateState !== 'complete') return
    resetUpdate()
    setRebootPhase('rebooting')
    setFirmwareJustFlashed(true)
  }, [updateState, step, resetUpdate])

  // Advance once device reconnects with fresh features after firmware update
  useEffect(() => {
    if (step !== 'firmware') return
    if (rebootPhase !== 'rebooting') return
    if (!deviceStatus.firmwareVersion) return
    const s = deviceStatus.state
    if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error') return

    setRebootPhase('idle')

    if (s === 'bootloader') return // user can retry firmware flash
    if (needsInit) {
      setStep('init-choose')
    } else {
      setStep('complete')
    }
  }, [step, rebootPhase, deviceStatus.firmwareVersion, deviceStatus.state, needsInit])

  // Post-flash auto-advance: after firmware was just flashed and device confirms
  // (user presses button on "unofficial firmware" screen), detect ready/needs_init
  useEffect(() => {
    if (step !== 'firmware') return
    if (!firmwareJustFlashed) return
    if (rebootPhase === 'rebooting') return // still waiting for reconnect
    const s = deviceStatus.state
    if (s === 'disconnected' || s === 'connected_unpaired' || s === 'error' || s === 'bootloader') return
    // Device is now past bootloader — ready or needs init
    setFirmwareJustFlashed(false)
    if (needsInit) {
      setStep('init-choose')
    } else {
      setStep('complete')
    }
  }, [step, firmwareJustFlashed, rebootPhase, deviceStatus.state, needsInit])

  const handleSkipFirmware = () => {
    if (needsInit) {
      setStep('init-choose')
    } else {
      setStep('complete')
    }
  }

  // ── Custom firmware file handling ──────────────────────────────────────

  // Listen for firmware progress during custom flash
  useEffect(() => {
    return onRpcMessage('firmware-progress', (payload: FirmwareProgress) => {
      if (customFwPhase === 'flashing') {
        setCustomFwProgress(payload)
        if (payload.percent >= 100) {
          setCustomFwPhase('idle')
          resetUpdate()
          setRebootPhase('rebooting')
        }
      }
    })
  }, [customFwPhase, resetUpdate])

  const handleFileSelected = useCallback(async (file: File) => {
    if (!file.name.endsWith('.bin')) {
      setCustomFwError('Only .bin firmware files are supported')
      setCustomFwPhase('error')
      return
    }
    setCustomFwPhase('analyzing')
    setCustomFwFileName(file.name)
    setCustomFwError(null)
    try {
      const arrayBuf = await file.arrayBuffer()
      // M4 fix: chunked conversion avoids O(n^2) string concatenation
      const bytes = new Uint8Array(arrayBuf)
      const CHUNK = 8192
      let binary = ''
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      const b64 = btoa(binary)
      setCustomFwDataB64(b64)
      const result = await rpcRequest<FirmwareAnalysis>('analyzeFirmware', { data: b64 })
      setCustomFwAnalysis(result)
      setCustomFwPhase('confirm')
    } catch (err: any) {
      setCustomFwError(err?.message || 'Failed to analyze firmware')
      setCustomFwPhase('error')
    }
  }, [])

  const handleCustomFlash = useCallback(async () => {
    if (!customFwDataB64) return
    setCustomFwPhase('flashing')
    setCustomFwProgress({ percent: 0, message: 'Starting firmware flash...' })
    try {
      await rpcRequest('flashCustomFirmware', { data: customFwDataB64 }, 0)
    } catch (err: any) {
      setCustomFwError(err?.message || 'Firmware flash failed')
      setCustomFwPhase('error')
    }
  }, [customFwDataB64])

  const handleCustomFwReset = useCallback(() => {
    setCustomFwPhase('idle')
    setCustomFwAnalysis(null)
    setCustomFwDataB64('')
    setCustomFwFileName('')
    setCustomFwError(null)
    setCustomFwProgress(null)
    setCustomFwAcknowledged(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  // Inline drop zone handlers for firmware step
  const [showCustomFw, setShowCustomFw] = useState(false)
  const [fwDragOver, setFwDragOver] = useState(false)

  const handleFwDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setFwDragOver(true)
  }, [])

  const handleFwDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setFwDragOver(false)
  }, [])

  const handleFwDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setFwDragOver(false)
    const files = e.dataTransfer?.files
    if (files?.length) handleFileSelected(files[0])
  }, [handleFileSelected])

  // ── Init: Create / Recover ─────────────────────────────────────────────

  // No timeout for device-interactive ops — user can take as long as needed
  const DEVICE_INTERACTION_TIMEOUT = 0

  const handleCreateWallet = async () => {
    setSetupType('create')
    setStep('init-progress')

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

    }
  }

  const handleDevLoadDevice = async () => {
    const words = devSeed.trim()
    if (!words || words.split(/\s+/).length < 12) return
    setDevLoadOpen(false)
    setSetupType('create')
    setStep('init-progress')

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
    onWordCountChange?.(wordCount)

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
    // Offer seed verification for new wallets, skip straight to tips for recovered
    setStep(setupType === 'create' ? 'verify-seed' : 'security-tips')
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

  // L7 fix: prevent navigating back to already-completed steps
  const showPrevious = !['intro', 'welcome', 'complete', 'init-progress', 'verify-seed', 'security-tips'].includes(step)
  // L4 fix: hide Next on firmware step for OOB devices (firmware is required)
  const showNext =
    !['intro', 'bootloader', 'init-choose', 'init-progress', 'init-label', 'verify-seed', 'security-tips', 'complete'].includes(step) &&
    !(step === 'firmware' && (updateState === 'updating' || updateState === 'complete')) &&
    !(step === 'firmware' && isOobDevice)

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
      pointerEvents="none"
    >
      <style>{ANIMATIONS_CSS}</style>

      <Box
        w={{ base: '100vw', md: '90vw', lg: '80vw' }}
        maxW="900px"
        maxH="90vh"
        bg="gray.800"
        borderRadius={{ base: 'none', md: 'xl' }}
        boxShadow={{ base: 'none', md: '0 8px 32px rgba(0,0,0,0.5)' }}
        borderWidth={{ base: '0', md: '2px' }}
        borderColor="#C0A860"
        overflow="auto"
        display="flex"
        flexDirection="column"
        pointerEvents="auto"
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <Box px={4} py={3} borderBottomWidth="1px" borderColor="gray.700">
          <Flex align="center" justify="space-between">
            <Box flex={1} />
            <VStack gap={1} flex={2} textAlign="center">
              <Text fontSize="lg" fontWeight="700" color={HIGHLIGHT} letterSpacing="tight">
                {t('title')}
              </Text>
              <Text fontSize="sm" color="gray.400">
                {STEP_DESCRIPTIONS[step]}
              </Text>
            </VStack>
            <Flex flex={1} justify="flex-end">
              <LanguagePicker />
            </Flex>
          </Flex>
        </Box>

        {/* ── Progress bar ───────────────────────────────────────────── */}
        <Box px={4} py={1.5}>
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
        <Box px={4} py={3} overflow="visible">
          <HStack gap={2} justify="center">
            {VISIBLE_STEPS.map((vs, idx) => {
              const completed = isVisibleStepCompleted(vs.id)
              const current = isVisibleStepCurrent(vs.id)

              return (
                <Flex key={vs.id} align="center" flexShrink={1} minW={0}>
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
                    boxShadow={current ? '0 0 0 3px rgba(72, 187, 120, 0.25)' : 'none'}
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
                    fontWeight={current ? '700' : '500'}
                    color={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.400'}
                    whiteSpace="nowrap"
                    overflow="hidden"
                    textOverflow="ellipsis"
                  >
                    {vs.label}
                  </Text>
                  {idx < VISIBLE_STEPS.length - 1 && (
                    <Box
                      w={6}
                      h="2px"
                      bg={completed ? 'green.500' : current ? HIGHLIGHT : 'gray.600'}
                      ml={1.5}
                      flexShrink={0}
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
            {/* ═══════════════ INTRO (Pre-Tutorial) ═════════════════ */}
            {step === 'intro' && (
              <TutorialPage
                type="pre"
                cardIndex={introCard}
                onNext={() => {
                  if (introCard < 2) setIntroCard(prev => prev + 1)
                  else setStep('welcome')
                }}
                onSkip={() => setStep('welcome')}
              />
            )}

            {/* ═══════════════ WELCOME ═══════════════════════════════ */}
            {step === 'welcome' && (
              <VStack gap={4} textAlign="center" w="100%">
                {isOobDevice ? (
                  <>
                    <Box
                      p={3}
                      borderRadius="full"
                      bg="rgba(72, 187, 120, 0.15)"
                      border="2px solid"
                      borderColor="green.500"
                    >
                      <FaWallet
                        color="#48BB78"
                        size={40}
                        style={{ animation: 'kkPulse 2s ease-in-out infinite' }}
                      />
                    </Box>
                    <VStack gap={2}>
                      <Text fontSize="xl" fontWeight="700" color="green.400">
                        {t('welcome.oobTitle')}
                      </Text>
                      <Text fontSize="2xl" fontWeight="700" color="white">
                        {t('welcome.oobWelcome')}
                      </Text>
                      <Text fontSize="md" color="gray.300" maxW="420px" lineHeight="tall">
                        {t('welcome.oobWizardDesc')}
                      </Text>
                    </VStack>

                    {/* Read More link → opens dialog */}
                    <Text
                      as="button"
                      fontSize="xs"
                      color="green.400"
                      fontWeight="500"
                      cursor="pointer"
                      textDecoration="underline"
                      _hover={{ color: 'green.300' }}
                      onClick={() => setShowReadMore(true)}
                    >
                      {t('welcome.readMore')}
                    </Text>
                  </>
                ) : (
                  <>
                    <FaWallet
                      color="#48BB78"
                      size={48}
                      style={{ animation: 'kkPulse 2s ease-in-out infinite' }}
                    />
                    <VStack gap={1.5}>
                      <Text fontSize="2xl" fontWeight="700" color="white">
                        {t('welcome.title')}
                      </Text>
                      <Text fontSize="md" fontWeight="500" color={HIGHLIGHT}>
                        {t('subtitle')}
                      </Text>
                      <Text fontSize="md" color="gray.400" maxW="380px">
                        {t('welcome.intro')}
                      </Text>
                    </VStack>
                  </>
                )}
                {welcomeReady ? (
                  <Button
                    size="lg"
                    bg="#C0A860"
                    color="black"
                    fontWeight="700"
                    _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(192, 168, 96, 0.3)' }}
                    _active={{ transform: 'scale(0.98)' }}
                    transition="all 0.2s"
                    px={10}
                    onClick={handleWelcomeNext}
                  >
                    {t('welcome.getStarted')}
                  </Button>
                ) : (
                  <HStack gap={2}>
                    <Spinner size="sm" color="green.400" />
                    <Text fontSize="sm" color="gray.400">
                      {t('welcome.detectingDevice')}
                    </Text>
                  </HStack>
                )}
              </VStack>
            )}

            {/* ═══════════════ BOOTLOADER ════════════════════════════ */}
            {step === 'bootloader' && (
              <VStack gap={3} w="100%" maxW="460px" mx="auto">
                {/* Bootloader detected — user must click to start update */}
                {inBootloader && updateState === 'idle' && rebootPhase !== 'rebooting' && (
                  <>
                    <FaCheckCircle color="#48BB78" size={36} />
                    <VStack gap={1.5}>
                      <Text fontSize="xl" fontWeight="700" color="green.400" textAlign="center">
                        {t('bootloader.bootloaderDetected')}
                      </Text>
                      <Text fontSize="sm" color="gray.400" textAlign="center">
                        {t('bootloader.deviceReadyForUpdate')}
                      </Text>
                    </VStack>

                    {deviceStatus.latestBootloader && needsBootloader && (
                      <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                        <HStack justify="space-between">
                          <VStack gap={0.5} align="start">
                            <Text fontSize="2xs" color="gray.400" textTransform="uppercase">{t('bootloader.current')}</Text>
                            <Text fontSize="sm" color="gray.300" fontWeight="bold">
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
                    {deviceStatus.latestBootloader && !needsBootloader && (
                      <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                        <HStack justify="center" gap={2}>
                          <FaCheckCircle color="#48BB78" size={14} />
                          <Text fontSize="sm" color="green.400" fontWeight="bold">
                            v{deviceStatus.bootloaderVersion || deviceStatus.latestBootloader} — Up to date
                          </Text>
                        </HStack>
                      </Box>
                    )}

                    {needsBootloader && (
                      <Button
                        w="100%"
                        size="md"
                        bg="#C0A860"
                        color="black"
                        fontWeight="600"
                        _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(192, 168, 96, 0.3)' }}
                        _active={{ transform: 'scale(0.98)' }}
                        transition="all 0.15s ease"
                        onClick={() => startBootloaderUpdate()}
                      >
                        {t('bootloader.updateBootloaderTo', { version: deviceStatus.latestBootloader || '?' })}
                      </Button>
                    )}
                    {canSkipBootloader && (
                      <Button
                        w="100%"
                        size="sm"
                        variant="ghost"
                        color="gray.500"
                        fontWeight="500"
                        _hover={{ color: 'gray.200', bg: 'rgba(255,255,255,0.04)' }}
                        transition="all 0.15s ease"
                        onClick={() => {
                          if (needsFirmware) setStep('firmware')
                          else setStep('init-choose')
                        }}
                      >
                        {t('bootloader.skipBootloaderUpdate')}
                      </Button>
                    )}
                  </>
                )}

                {!inBootloader && updateState !== 'updating' && updateState !== 'error' && rebootPhase !== 'rebooting' && (
                  <>
                    <VStack gap={1.5}>
                      <Text fontSize="xl" fontWeight="700" color="white" textAlign="center">
                        {t('bootloader.putDeviceInBootloader')}
                      </Text>
                      <Text fontSize="md" color="gray.400" textAlign="center">
                        {t('bootloader.followStepsBelow')}
                      </Text>
                    </VStack>

                    {deviceStatus.latestBootloader && needsBootloader && (
                      <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                        <HStack justify="space-between">
                          <VStack gap={0.5} align="start">
                            <Text fontSize="2xs" color="gray.400" textTransform="uppercase">{t('bootloader.current')}</Text>
                            <Text fontSize="sm" color="gray.300" fontWeight="bold">
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
                    {deviceStatus.latestBootloader && !needsBootloader && (
                      <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                        <HStack justify="center" gap={2}>
                          <FaCheckCircle color="#48BB78" size={14} />
                          <Text fontSize="sm" color="green.400" fontWeight="bold">
                            v{deviceStatus.bootloaderVersion || deviceStatus.latestBootloader} — Up to date
                          </Text>
                        </HStack>
                      </Box>
                    )}

                    <Box w="100%" p={4} bg="gray.700" borderRadius="lg" borderWidth="1px" borderColor="gray.600">
                      <VStack align="start" gap={3}>
                        <Text fontSize="md" fontWeight="700" color="white">
                          {t('bootloader.stepsTitle')}
                        </Text>
                        <VStack align="start" gap={2} w="100%">
                          <HStack gap={3} align="start">
                            <Box w={7} h={7} borderRadius="full" bg="green.500" flexShrink={0} display="flex" alignItems="center" justifyContent="center">
                              <Text fontSize="sm" fontWeight="bold" color="white">1</Text>
                            </Box>
                            <Text fontSize="md" color="gray.200" pt="2px">{t('bootloader.step1Unplug')}</Text>
                          </HStack>
                          <HStack gap={3} align="start">
                            <Box w={7} h={7} borderRadius="full" bg="green.500" flexShrink={0} display="flex" alignItems="center" justifyContent="center">
                              <Text fontSize="sm" fontWeight="bold" color="white">2</Text>
                            </Box>
                            <Text fontSize="md" color="gray.200" pt="2px">{t('bootloader.step2Hold')}</Text>
                          </HStack>
                          <HStack gap={3} align="start">
                            <Box w={7} h={7} borderRadius="full" bg="green.500" flexShrink={0} display="flex" alignItems="center" justifyContent="center">
                              <Text fontSize="sm" fontWeight="bold" color="white">3</Text>
                            </Box>
                            <Text fontSize="md" color="gray.200" pt="2px">{t('bootloader.step3Plugin')}</Text>
                          </HStack>
                          <HStack gap={3} align="start">
                            <Box w={7} h={7} borderRadius="full" bg="green.500" flexShrink={0} display="flex" alignItems="center" justifyContent="center">
                              <Text fontSize="sm" fontWeight="bold" color="white">4</Text>
                            </Box>
                            <Text fontSize="md" color="gray.200" pt="2px">{t('bootloader.step4Release')}</Text>
                          </HStack>
                        </VStack>
                      </VStack>
                    </Box>

                    <Box w="100%" p={3} bg="green.900" borderRadius="lg" borderWidth="1px" borderColor="green.600">
                      <HStack gap={2} justify="center">
                        <Spinner size="sm" color="green.300" />
                        <Text fontSize="md" color="green.200" fontWeight="600">
                          {t('bootloader.waitingForBootloader')}
                        </Text>
                      </HStack>
                    </Box>

                    {canSkipBootloader && (
                      <Button
                        w="100%"
                        size="sm"
                        variant="ghost"
                        color="gray.500"
                        fontWeight="500"
                        _hover={{ color: 'gray.200', bg: 'rgba(255,255,255,0.04)' }}
                        transition="all 0.15s ease"
                        onClick={() => {
                          if (needsFirmware) setStep('firmware')
                          else setStep('init-choose')
                        }}
                      >
                        {t('bootloader.skipBootloaderUpdate')}
                      </Button>
                    )}
                  </>
                )}

                {rebootPhase === 'rebooting' && (
                  <VStack gap={2} w="100%">
                    <Box w="100%" p={3} bg="blue.900" borderRadius="md" borderWidth="2px" borderColor="blue.500">
                      <VStack gap={2} align="start">
                        <HStack gap={2}>
                          <Spinner size="sm" color="blue.300" />
                          <Text fontSize="sm" color="blue.300" fontWeight="bold">
                            {rebootElapsedMs < 20000
                              ? t('firmware.deviceRebooting', { defaultValue: 'Device rebooting...' })
                              : t('firmware.rebootTakingLong', { defaultValue: 'Reconnection is taking longer than usual...' })}
                          </Text>
                        </HStack>
                        <Text fontSize="xs" color="blue.200">
                          {rebootElapsedMs < 20000
                            ? t('firmware.rebootingMessage', { defaultValue: 'Waiting for device to reconnect after update.' })
                            : t('firmware.rebootTakingLongSub', { defaultValue: 'The device may need a moment to restart.' })}
                        </Text>
                      </VStack>
                    </Box>

                    {rebootElapsedMs >= 30000 && (
                      <Box w="100%" p={3} bg="blue.900" borderRadius="md" borderWidth="2px" borderColor="blue.600">
                        <VStack gap={1.5} align="start">
                          <HStack gap={2}>
                            <FaExclamationTriangle color="#63B3ED" size={14} />
                            <Text fontSize="sm" fontWeight="bold" color="blue.300">
                              {t('firmware.manualReconnectTitle', { defaultValue: 'Device not reconnecting?' })}
                            </Text>
                          </HStack>
                          <VStack align="start" gap={0.5} pl={5}>
                            <Text fontSize="xs" color="blue.200">{t('firmware.manualReconnectStep1', { defaultValue: '1. Unplug your KeepKey' })}</Text>
                            <Text fontSize="xs" color="blue.200">{t('firmware.manualReconnectStep2', { defaultValue: '2. Wait 5 seconds' })}</Text>
                            <Text fontSize="xs" color="blue.200">{t('firmware.manualReconnectStep3', { defaultValue: '3. Plug it back in' })}</Text>
                          </VStack>
                          <Text fontSize="2xs" color="blue.300" pl={5}>
                            {t('firmware.manualReconnectNote', { defaultValue: 'Setup will continue automatically when the device is detected.' })}
                          </Text>
                        </VStack>
                      </Box>
                    )}
                  </VStack>
                )}

                {updateState === 'updating' && (
                  <VStack gap={2} w="100%">
                    <FaDownload color="#48BB78" size={32} />
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
                            <Text fontSize="sm" color="gray.300" fontWeight="bold">
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
                    <Box w="100%" p={2} bg="blue.900" borderRadius="md" borderWidth="1px" borderColor="blue.600">
                      <HStack gap={2}>
                        <FaExclamationTriangle color="#63B3ED" size={12} />
                        <Text fontSize="2xs" color="blue.200">
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
                      fontWeight="500"
                      _hover={{ bg: 'rgba(252, 129, 129, 0.1)', borderColor: 'red.300' }}
                      transition="all 0.15s ease"
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
                {/* Hide title/version box when post-flash — only show "Waiting for device" */}
                {!firmwareJustFlashed && (
                  <>
                    <FaDownload color="#48BB78" size={36} />
                    <VStack gap={1.5}>
                      <Text fontSize="xl" fontWeight="700" color="white" textAlign="center">
                        {t('firmware.title')}
                      </Text>
                      <Text fontSize="sm" color="gray.400" textAlign="center">
                        {isOobDevice ? t('firmware.oobDescription') : t('firmware.description')}
                      </Text>
                    </VStack>

                    <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                      <HStack justify="space-between">
                        <VStack gap={0.5} align="start">
                          <Text fontSize="xs" color="gray.400" textTransform="uppercase" fontWeight="600">
                            {inBootloader ? t('firmware.firmwareLabel') : t('bootloader.current')}
                          </Text>
                          <Text fontSize="md" color={isOobDevice ? 'red.400' : 'white'} fontWeight="bold">
                            {inBootloader
                              ? deviceStatus.resolvedFwVersion
                                ? deviceStatus.resolvedFwVersion
                                : deviceStatus.firmwareHash
                                  ? `${deviceStatus.firmwareHash.slice(0, 10)}… (custom)`
                                  : t('firmware.notInstalled')
                              : `v${deviceStatus.firmwareVersion || '?'}`}
                          </Text>
                        </VStack>
                        <Text color="gray.500" fontSize="lg">&rarr;</Text>
                        <VStack gap={0.5} align="end">
                          <Text fontSize="xs" color="gray.400" textTransform="uppercase" fontWeight="600">{t('bootloader.latest')}</Text>
                          <Text fontSize="md" color="green.400" fontWeight="bold">
                            v{deviceStatus.latestFirmware || '?'}
                          </Text>
                        </VStack>
                      </HStack>
                    </Box>
                  </>
                )}

                {/* In bootloader — show firmware install options (user must click) */}
                {updateState === 'idle' && inBootloader && rebootPhase !== 'rebooting' && customFwPhase === 'idle' && (
                  <>
                    <FaCheckCircle color="#48BB78" size={24} />
                    <Text fontSize="sm" fontWeight="bold" color="green.400" textAlign="center">
                      {t('firmware.bootloaderReadyForFirmware')}
                    </Text>

                    {/* Upgrade preview — show new features coming with this firmware */}
                    {deviceStatus.latestFirmware && (
                      <FirmwareUpgradePreview
                        currentVersion={deviceStatus.resolvedFwVersion?.replace(/^v/, '') || deviceStatus.firmwareVersion || null}
                        targetVersion={deviceStatus.latestFirmware}
                      />
                    )}

                    <Button
                      w="100%"
                      size="md"
                      bg="#C0A860"
                      color="black"
                      fontWeight="600"
                      _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(192, 168, 96, 0.3)' }}
                      _active={{ transform: 'scale(0.98)' }}
                      transition="all 0.15s ease"
                      onClick={() => startFirmwareUpdate(deviceStatus.latestFirmware || undefined)}
                    >
                      {t('firmware.installLatestFirmware', { version: deviceStatus.latestFirmware || '?' })}
                    </Button>

                    {/* Custom firmware section — collapsible caret */}
                    <Box w="100%" mt={2}>
                      <Flex
                        align="center"
                        justify="center"
                        gap={1.5}
                        cursor="pointer"
                        userSelect="none"
                        onClick={() => setShowCustomFw((prev) => !prev)}
                        py={1}
                      >
                        <Text fontSize="xs" color="gray.500">
                          {t('firmware.orCustomFirmware')}
                        </Text>
                        {showCustomFw ? (
                          <FaChevronUp color="#718096" size={10} />
                        ) : (
                          <FaChevronDown color="#718096" size={10} />
                        )}
                      </Flex>
                      {showCustomFw && (
                        <Box
                          w="100%"
                          p={4}
                          mt={2}
                          borderRadius="lg"
                          border="2px dashed"
                          borderColor={fwDragOver ? 'green.400' : 'gray.600'}
                          bg={fwDragOver ? 'rgba(72, 187, 120, 0.05)' : 'transparent'}
                          transition="all 0.2s"
                          textAlign="center"
                          cursor="pointer"
                          onClick={() => fileInputRef.current?.click()}
                          onDragOver={handleFwDragOver}
                          onDragLeave={handleFwDragLeave}
                          onDrop={handleFwDrop}
                        >
                          <VStack gap={1.5}>
                            <FaFolderOpen color="#A0AEC0" size={20} />
                            <Text fontSize="xs" color="gray.400">
                              {t('firmware.customFirmwareHint')}
                            </Text>
                            <Button
                              size="xs"
                              variant="outline"
                              borderColor="rgba(192, 168, 96, 0.3)"
                              color="gray.300"
                              fontWeight="500"
                              _hover={{ borderColor: '#C0A860', color: 'white', bg: 'rgba(192, 168, 96, 0.08)' }}
                              transition="all 0.15s ease"
                              onClick={(e: React.MouseEvent) => {
                                e.stopPropagation()
                                fileInputRef.current?.click()
                              }}
                            >
                              {t('firmware.browseFiles')}
                            </Button>
                          </VStack>
                        </Box>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".bin"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) handleFileSelected(file)
                        }}
                      />
                    </Box>
                  </>
                )}

                {/* Custom firmware analyzing */}
                {customFwPhase === 'analyzing' && (
                  <VStack gap={2} w="100%">
                    <Spinner size="md" color={HIGHLIGHT} />
                    <Text fontSize="sm" fontWeight="bold" color="white">
                      {t('firmware.analyzingFirmware')}
                    </Text>
                    <Text fontSize="xs" color="gray.400">{customFwFileName}</Text>
                  </VStack>
                )}

                {/* Custom firmware confirmation */}
                {customFwPhase === 'confirm' && customFwAnalysis && (
                  <VStack gap={3} w="100%">
                    <Text fontSize="sm" fontWeight="bold" color="white">
                      {t('firmware.customFirmwareReady')}
                    </Text>

                    <Box w="100%" p={3} bg="gray.700" borderRadius="lg">
                      <VStack gap={2} align="stretch">
                        <HStack justify="space-between">
                          <Text fontSize="xs" color="gray.400">File</Text>
                          <Text fontSize="xs" color="white" fontFamily="mono">{customFwFileName}</Text>
                        </HStack>
                        <HStack justify="space-between">
                          <Text fontSize="xs" color="gray.400">{t('firmware.version')}</Text>
                          <Text fontSize="xs" color="white" fontFamily="mono">
                            {customFwAnalysis.detectedVersion || '?.?.?'}
                          </Text>
                        </HStack>
                        <HStack justify="space-between">
                          <Text fontSize="xs" color="gray.400">{t('firmware.size')}</Text>
                          <Text fontSize="xs" color="white" fontFamily="mono">
                            {(customFwAnalysis.fileSize / 1024).toFixed(1)} KB
                          </Text>
                        </HStack>
                        <HStack>
                          <Box
                            px={2} py={0.5} borderRadius="md" fontSize="2xs" fontWeight="bold"
                            bg={customFwAnalysis.isSigned ? 'rgba(72,187,120,0.15)' : 'rgba(237,137,54,0.15)'}
                            color={customFwAnalysis.isSigned ? 'green.400' : 'yellow.400'}
                          >
                            {customFwAnalysis.isSigned ? t('firmware.signed') : t('firmware.unsigned')}
                          </Box>
                        </HStack>
                      </VStack>
                    </Box>

                    {/* Release notes for custom firmware */}
                    {customFwAnalysis.detectedVersion && (
                      <FirmwareUpgradePreview
                        currentVersion={deviceStatus.resolvedFwVersion?.replace(/^v/, '') || deviceStatus.firmwareVersion || null}
                        targetVersion={customFwAnalysis.detectedVersion}
                      />
                    )}

                    {/* Known wipe: signed/unsigned boundary crossing (non-bootloader mode) */}
                    {customFwAnalysis.willWipeDevice && (
                      <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="2px" borderColor="red.600">
                        <HStack gap={2} mb={2}>
                          <FaExclamationTriangle color="#FC8181" size={16} />
                          <Text fontSize="sm" fontWeight="bold" color="red.300" textTransform="uppercase" letterSpacing="0.03em">
                            THIS WILL WIPE THE DEVICE
                          </Text>
                        </HStack>
                        <Text fontSize="xs" color="red.200" mb={2} lineHeight="1.5">
                          {t('firmware.willWipeWarning')}
                        </Text>
                        <Flex
                          as="label"
                          align="center"
                          gap={2}
                          cursor="pointer"
                          userSelect="none"
                          onClick={() => setCustomFwAcknowledged(!customFwAcknowledged)}
                        >
                          <Box
                            w="16px" h="16px" borderRadius="sm" border="2px solid"
                            borderColor={customFwAcknowledged ? 'red.400' : 'red.300'}
                            bg={customFwAcknowledged ? 'red.500' : 'transparent'}
                            display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                          >
                            {customFwAcknowledged && (
                              <Text fontSize="2xs" color="white" lineHeight="1">&#10003;</Text>
                            )}
                          </Box>
                          <Text fontSize="2xs" fontWeight="600" color="red.300">
                            {t('firmware.unsignedBootloaderAcknowledge')}
                          </Text>
                        </Flex>
                      </Box>
                    )}

                    {/* Bootloader mode + unsigned firmware: warn about potential wipe */}
                    {!customFwAnalysis.isSigned && !customFwAnalysis.willWipeDevice && customFwAnalysis.isBootloaderMode && (
                      <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="2px" borderColor="orange.500">
                        <HStack gap={2} mb={2}>
                          <FaExclamationTriangle color="#ED8936" size={14} />
                          <Text fontSize="xs" fontWeight="bold" color="orange.300">
                            Developer Firmware — Potential Device Wipe
                          </Text>
                        </HStack>
                        <Text fontSize="2xs" color="orange.200" mb={2} lineHeight="1.5">
                          {t('firmware.unsignedBootloaderWarning')}
                        </Text>
                        <Flex
                          as="label"
                          align="center"
                          gap={2}
                          cursor="pointer"
                          userSelect="none"
                          onClick={() => setCustomFwAcknowledged(!customFwAcknowledged)}
                        >
                          <Box
                            w="16px" h="16px" borderRadius="sm" border="2px solid"
                            borderColor={customFwAcknowledged ? 'orange.400' : 'orange.300'}
                            bg={customFwAcknowledged ? 'orange.500' : 'transparent'}
                            display="flex" alignItems="center" justifyContent="center" flexShrink={0}
                          >
                            {customFwAcknowledged && (
                              <Text fontSize="2xs" color="white" lineHeight="1">&#10003;</Text>
                            )}
                          </Box>
                          <Text fontSize="2xs" fontWeight="600" color="orange.300">
                            {t('firmware.unsignedBootloaderAcknowledge')}
                          </Text>
                        </Flex>
                      </Box>
                    )}

                    {/* Non-bootloader unsigned, no known wipe (e.g. unsigned→unsigned) */}
                    {!customFwAnalysis.isSigned && !customFwAnalysis.willWipeDevice && !customFwAnalysis.isBootloaderMode && (
                      <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                        <HStack gap={2}>
                          <FaExclamationTriangle color="#FC8181" size={12} />
                          <Text fontSize="xs" color="red.200">
                            {t('firmware.unsignedWarning')}
                          </Text>
                        </HStack>
                      </Box>
                    )}

                    <HStack gap={2} w="100%">
                      <Button
                        flex={1}
                        size="sm"
                        variant="outline"
                        borderColor="rgba(192, 168, 96, 0.3)"
                        color="gray.300"
                        fontWeight="500"
                        _hover={{ borderColor: '#C0A860', color: 'white', bg: 'rgba(192, 168, 96, 0.08)' }}
                        transition="all 0.15s ease"
                        onClick={handleCustomFwReset}
                      >
                        Cancel
                      </Button>
                      <Button
                        flex={1}
                        size="sm"
                        bg={
                          customFwAnalysis.willWipeDevice ? 'red.600'
                          : (!customFwAnalysis.isSigned && customFwAnalysis.isBootloaderMode) ? 'orange.600'
                          : '#C0A860'
                        }
                        color={customFwAnalysis.willWipeDevice || (!customFwAnalysis.isSigned && customFwAnalysis.isBootloaderMode) ? 'white' : 'black'}
                        fontWeight="600"
                        _hover={{
                          bg: customFwAnalysis.willWipeDevice ? 'red.500'
                            : (!customFwAnalysis.isSigned && customFwAnalysis.isBootloaderMode) ? 'orange.500'
                            : '#D4BC6A'
                        }}
                        _active={{ transform: 'scale(0.98)' }}
                        transition="all 0.15s ease"
                        onClick={handleCustomFlash}
                        disabled={
                          (customFwAnalysis.willWipeDevice && !customFwAcknowledged) ||
                          (!customFwAnalysis.isSigned && customFwAnalysis.isBootloaderMode && !customFwAcknowledged)
                        }
                      >
                        {customFwAnalysis.willWipeDevice ? 'Wipe & Flash' : t('firmware.flashFirmware')}
                      </Button>
                    </HStack>
                  </VStack>
                )}

                {/* Custom firmware flashing */}
                {customFwPhase === 'flashing' && (
                  <VStack gap={2} w="100%">
                    <Spinner size="md" color={HIGHLIGHT} />
                    <Text fontSize="sm" fontWeight="bold" color="white">
                      {customFwProgress?.message || t('firmware.uploadingFirmware')}
                    </Text>
                    <Box w="100%" h="8px" bg="gray.700" borderRadius="full" overflow="hidden">
                      <Box
                        h="100%"
                        borderRadius="full"
                        w={`${customFwProgress?.percent || 0}%`}
                        transition="width 0.3s"
                        bg={HIGHLIGHT}
                      />
                    </Box>
                    <Text fontSize="2xs" color="red.300">{t('firmware.doNotUnplug')}</Text>
                  </VStack>
                )}

                {/* Custom firmware error */}
                {customFwPhase === 'error' && (
                  <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <VStack gap={1} align="start">
                      <Text fontSize="sm" color="red.300" fontWeight="bold">{t('firmware.customFlashFailed')}</Text>
                      <Text fontSize="xs" color="red.200">{customFwError}</Text>
                    </VStack>
                    <Button
                      mt={2}
                      size="sm"
                      variant="outline"
                      borderColor="red.400"
                      color="red.300"
                      fontWeight="500"
                      _hover={{ bg: 'rgba(252, 129, 129, 0.1)', borderColor: 'red.300' }}
                      transition="all 0.15s ease"
                      onClick={handleCustomFwReset}
                    >
                      {t('bootloader.tryAgain')}
                    </Button>
                  </Box>
                )}

                {/* Post-flash: just show "Waiting for your device..." — no bootloader instructions */}
                {updateState === 'idle' && !inBootloader && rebootPhase !== 'rebooting' && customFwPhase === 'idle' && firmwareJustFlashed && (
                  <Box w="100%" p={3} bg="green.900" borderRadius="md" borderWidth="1px" borderColor="green.600">
                    <HStack gap={2} justify="center">
                      <Spinner size="sm" color="green.300" />
                      <Text fontSize="xs" color="green.200">
                        {t('firmware.waitingForDevice', { defaultValue: 'Waiting for your device...' })}
                      </Text>
                    </HStack>
                  </Box>
                )}

                {/* Not in bootloader, not post-flash — show instructions to enter bootloader */}
                {updateState === 'idle' && !inBootloader && rebootPhase !== 'rebooting' && customFwPhase === 'idle' && !firmwareJustFlashed && (
                  <>
                    <Box maxW="100px" mx="auto" opacity={0.85} dangerouslySetInnerHTML={{ __html: holdAndConnectRaw }} sx={{ '& svg': { width: '100%', height: '100%' } }} />
                    <Box w="100%" p={3} bg="gray.700" borderRadius="lg" borderWidth="1px" borderColor="gray.600">
                      <VStack align="start" gap={1}>
                        <Text fontSize="xs" fontWeight="bold" color="white">
                          {t('bootloader.stepsTitle')}
                        </Text>
                        <VStack align="start" gap={0} pl={1}>
                          <Text fontSize="2xs" color="gray.200">1. {t('bootloader.step1Unplug')}</Text>
                          <Text fontSize="2xs" color="gray.200">2. {t('bootloader.step2Hold')}</Text>
                          <Text fontSize="2xs" color="gray.200">3. {t('bootloader.step3Plugin')}</Text>
                          <Text fontSize="2xs" color="gray.200">4. {t('bootloader.step4Release')}</Text>
                        </VStack>
                      </VStack>
                    </Box>
                    <Box w="100%" p={2} bg="green.900" borderRadius="md" borderWidth="1px" borderColor="green.600">
                      <HStack gap={2} justify="center">
                        <Spinner size="sm" color="green.300" />
                        <Text fontSize="xs" color="green.200">
                          {t('bootloader.waitingForBootloader')}
                        </Text>
                      </HStack>
                    </Box>
                  </>
                )}

                {updateState === 'updating' && (
                  <VStack gap={2} w="100%">
                    <Box
                      w="100%"
                      p={3}
                      bg="green.900"
                      borderRadius="lg"
                      borderWidth="2px"
                      borderColor={HIGHLIGHT}
                      style={{ animation: 'kkGlow 2s ease-in-out infinite' }}
                    >
                      <VStack gap={1}>
                        <Text fontSize="sm" fontWeight="bold" color="green.200">
                          {t('firmware.confirmOnDevice')}
                        </Text>
                        <Text fontSize="xs" color="green.100">
                          {t('firmware.lookAtDeviceAndPress')}
                        </Text>
                        <Text fontSize="2xs" color="green.200" opacity={0.7}>
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

                {/* Firmware reboot: device says "Please disconnect and reconnect" — user must unplug */}
                {rebootPhase === 'rebooting' && (
                  <VStack gap={2} w="100%">
                    <Box w="100%" p={3} bg="yellow.900" borderRadius="md" borderWidth="2px" borderColor="yellow.500">
                      <VStack gap={2} align="start">
                        <HStack gap={2}>
                          <FaExclamationTriangle color="#ECC94B" size={16} />
                          <Text fontSize="sm" color="yellow.200" fontWeight="bold">
                            {t('firmware.pleaseDisconnect', { defaultValue: 'Please disconnect and reconnect your KeepKey' })}
                          </Text>
                        </HStack>
                        <Text fontSize="xs" color="yellow.300">
                          {rebootElapsedMs < 20000
                            ? t('firmware.disconnectMessage', { defaultValue: 'Your device says "Firmware Update Complete." Unplug the USB cable and plug it back in to continue.' })
                            : t('firmware.stillWaitingDisconnect', { defaultValue: 'Still waiting — make sure you unplug and re-plug the USB cable.' })}
                        </Text>
                      </VStack>
                    </Box>

                    {rebootElapsedMs >= 30000 && (
                      <Box w="100%" p={3} bg="blue.900" borderRadius="md" borderWidth="2px" borderColor="blue.600">
                        <VStack gap={1.5} align="start">
                          <HStack gap={2}>
                            <FaExclamationTriangle color="#63B3ED" size={14} />
                            <Text fontSize="sm" fontWeight="bold" color="blue.300">
                              {t('firmware.manualReconnectTitle', { defaultValue: 'Device not reconnecting?' })}
                            </Text>
                          </HStack>
                          <VStack align="start" gap={0.5} pl={5}>
                            <Text fontSize="xs" color="blue.200">{t('firmware.manualReconnectStep1', { defaultValue: '1. Unplug your KeepKey' })}</Text>
                            <Text fontSize="xs" color="blue.200">{t('firmware.manualReconnectStep2', { defaultValue: '2. Wait 5 seconds' })}</Text>
                            <Text fontSize="xs" color="blue.200">{t('firmware.manualReconnectStep3', { defaultValue: '3. Plug it back in' })}</Text>
                          </VStack>
                          <Text fontSize="2xs" color="blue.300" pl={5}>
                            {t('firmware.manualReconnectNote', { defaultValue: 'Setup will continue automatically when the device is detected.' })}
                          </Text>
                        </VStack>
                      </Box>
                    )}
                  </VStack>
                )}

                {updateState === 'error' && (
                  <Box w="100%" p={3} bg="red.900" borderRadius="md" borderWidth="1px" borderColor="red.600">
                    <VStack gap={1} align="start">
                      <Text fontSize="sm" color="red.300" fontWeight="bold">{t('bootloader.updateFailed')}</Text>
                      <Text fontSize="xs" color="red.200">{updateError}</Text>
                    </VStack>
                    <Button mt={2} size="sm" variant="outline" borderColor="red.400" color="red.300" fontWeight="500" _hover={{ bg: 'rgba(252, 129, 129, 0.1)', borderColor: 'red.300' }} transition="all 0.15s ease" onClick={resetUpdate}>
                      {t('bootloader.tryAgain')}
                    </Button>
                  </Box>
                )}

                {updateState === 'idle' && !isOobDevice && !inBootloader && rebootPhase !== 'rebooting' && !firmwareJustFlashed && (
                  <Button
                    w="100%"
                    variant="ghost"
                    color="gray.500"
                    size="sm"
                    fontWeight="500"
                    _hover={{ color: 'gray.200', bg: 'rgba(255,255,255,0.04)' }}
                    transition="all 0.15s ease"
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
                      borderColor: 'green.500',
                      transform: 'translateY(-1px)',
                    }}
                  >
                    <VStack gap={3}>
                      <Box p={2} borderRadius="full" bg="green.500" color="white">
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
                                  _hover={{ bg: wordCount === wc ? 'green.600' : 'gray.500' }}
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
                                _hover={{ color: 'green.300' }}
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
                        bg="#C0A860"
                        color="black"
                        fontWeight="600"
                        _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(192, 168, 96, 0.3)' }}
                        _active={{ transform: 'scale(0.98)' }}
                        transition="all 0.15s ease"
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
                        bg="#C0A860"
                        color="black"
                        fontWeight="600"
                        _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(192, 168, 96, 0.3)' }}
                        _active={{ transform: 'scale(0.98)' }}
                        transition="all 0.15s ease"
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

                {setupType === 'create' && (
                  <Box w="100%" p={4} bg="red.900" borderRadius="lg" borderWidth="2px" borderColor="red.400"
                    css={{ animation: 'kkGlow 2s ease-in-out infinite', boxShadow: '0 0 12px rgba(245,101,101,0.4)' }}>
                    <VStack gap={2}>
                      <HStack gap={2} justify="center">
                        <FaExclamationTriangle color="#FC8181" size={20} />
                        <Text fontSize="md" color="red.200" fontWeight="900" textTransform="uppercase" letterSpacing="wider">
                          {t('initProgress.writeDownWarning', { defaultValue: 'Write down every word!' })}
                        </Text>
                        <FaExclamationTriangle color="#FC8181" size={20} />
                      </HStack>
                      <Text fontSize="xs" color="red.300" textAlign="center" fontWeight="600">
                        {t('initProgress.writeDownDetail', { defaultValue: 'Your recovery phrase is showing on the device screen. Write each word on paper. This is your ONLY backup — you will NOT see these words again.' })}
                      </Text>
                    </VStack>
                  </Box>
                )}

                <Box w="100%" p={3} bg="green.900" borderRadius="lg" borderWidth="2px" borderColor={HIGHLIGHT}>
                  <HStack gap={2} justify="center">
                    <FaExclamationTriangle color="#48BB78" size={14} />
                    <Text fontSize="xs" color="green.200" fontWeight="bold">
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
                  _focus={{ borderColor: 'green.500', boxShadow: '0 0 0 1px green.500' }}
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
                    bg="#C0A860"
                    color="black"
                    fontWeight="600"
                    _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(192, 168, 96, 0.3)' }}
                    _active={{ transform: 'scale(0.98)' }}
                    transition="all 0.15s ease"
                    onClick={handleApplyLabel}
                    disabled={!deviceLabel.trim()}
                  >
                    {t('initLabel.setDeviceName')}
                  </Button>
                  <Button
                    w="100%"
                    size="sm"
                    variant="ghost"
                    color="gray.500"
                    fontWeight="500"
                    _hover={{ color: 'gray.200', bg: 'rgba(255,255,255,0.04)' }}
                    transition="all 0.15s ease"
                    onClick={handleApplyLabel}
                  >
                    {t('initLabel.skipForNow')}
                  </Button>
                </VStack>
              </VStack>
            )}

            {/* ═══════════════ VERIFY SEED ═══════════════════════════ */}
            {step === 'verify-seed' && (
              <VStack gap={4} textAlign="center" w="100%" maxW="400px" mx="auto">
                {verifyingPhase === 'idle' && (
                  <>
                    <FaKey color="#C0A860" size={36} />
                    <VStack gap={1}>
                      <Text fontSize="lg" fontWeight="bold" color="white">
                        {t('verifySeed.title', { defaultValue: 'Verify Your Recovery Phrase' })}
                      </Text>
                      <Text fontSize="xs" color="gray.400" maxW="320px">
                        {t('verifySeed.description', { defaultValue: 'Confirm that you wrote down your recovery phrase correctly. Your device will ask you to enter some of the words.' })}
                      </Text>
                    </VStack>
                    <Button
                      w="100%" size="md" bg="#C0A860" color="black" fontWeight="600"
                      _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 12px rgba(192, 168, 96, 0.3)' }}
                      _active={{ transform: 'scale(0.98)' }}
                      transition="all 0.15s ease"
                      onClick={async () => {
                        setVerifyingPhase('verifying')
                        setVerifyError(null)
                        onWordCountChange?.(wordCount)
                        try {
                          const result = await rpcRequest('verifySeed', { wordCount }, 0) as { success: boolean; message: string }
                          setVerifyingPhase(result.success ? 'success' : 'failed')
                          if (!result.success) setVerifyError(result.message)
                        } catch (e: any) {
                          setVerifyingPhase('failed')
                          setVerifyError(e?.message || 'Verification failed')
                        }
                      }}
                    >
                      {t('verifySeed.verifyNow', { defaultValue: 'Verify Now' })}
                    </Button>
                    <Button
                      w="100%" size="sm" variant="ghost" color="gray.500" fontWeight="500"
                      _hover={{ color: 'gray.200', bg: 'rgba(255,255,255,0.04)' }}
                      transition="all 0.15s ease"
                      onClick={() => setStep('security-tips')}
                    >
                      {t('verifySeed.skipForNow', { defaultValue: "Skip — I'll verify later in Settings" })}
                    </Button>
                  </>
                )}
                {verifyingPhase === 'verifying' && (
                  <>
                    <Spinner size="lg" color="#C0A860" borderWidth="3px" />
                    <VStack gap={1}>
                      <Text fontSize="md" fontWeight="bold" color="white">
                        {t('verifySeed.verifying', { defaultValue: 'Verifying...' })}
                      </Text>
                      <Text fontSize="xs" color="gray.400">
                        {t('verifySeed.followDevice', { defaultValue: 'Follow the prompts on your KeepKey to enter the requested words.' })}
                      </Text>
                    </VStack>
                  </>
                )}
                {verifyingPhase === 'success' && (
                  <>
                    <FaCheckCircle color="#48BB78" size={36} />
                    <VStack gap={1}>
                      <Text fontSize="lg" fontWeight="bold" color="green.400">
                        {t('verifySeed.verified', { defaultValue: 'Recovery Phrase Verified!' })}
                      </Text>
                      <Text fontSize="xs" color="gray.400">
                        {t('verifySeed.verifiedDetail', { defaultValue: 'Your backup is correct. Keep it safe — never share it with anyone.' })}
                      </Text>
                    </VStack>
                    <Button
                      w="100%" size="md" bg="#C0A860" color="black" fontWeight="600"
                      _hover={{ bg: '#D4BC6A' }} transition="all 0.15s ease"
                      onClick={() => setStep('security-tips')}
                    >
                      {t('verifySeed.continue', { defaultValue: 'Continue' })}
                    </Button>
                  </>
                )}
                {verifyingPhase === 'failed' && (
                  <>
                    <FaExclamationTriangle color="#FC8181" size={36} />
                    <VStack gap={1}>
                      <Text fontSize="lg" fontWeight="bold" color="red.400">
                        {t('verifySeed.failed', { defaultValue: 'Verification Failed' })}
                      </Text>
                      <Text fontSize="xs" color="red.300" maxW="320px">
                        {verifyError || t('verifySeed.failedDetail', { defaultValue: 'The words you entered did not match. Please try again or check your written backup.' })}
                      </Text>
                    </VStack>
                    <Button
                      w="100%" size="md" bg="#C0A860" color="black" fontWeight="600"
                      _hover={{ bg: '#D4BC6A' }} transition="all 0.15s ease"
                      onClick={() => setVerifyingPhase('idle')}
                    >
                      {t('verifySeed.tryAgain', { defaultValue: 'Try Again' })}
                    </Button>
                    <Button
                      w="100%" size="sm" variant="ghost" color="gray.500" fontWeight="500"
                      _hover={{ color: 'gray.200', bg: 'rgba(255,255,255,0.04)' }}
                      transition="all 0.15s ease"
                      onClick={() => setStep('security-tips')}
                    >
                      {t('verifySeed.skipForNow', { defaultValue: "Skip — I'll verify later in Settings" })}
                    </Button>
                  </>
                )}
              </VStack>
            )}

            {/* ═══════════════ SECURITY TIPS (Post-Tutorial) ════════ */}
            {step === 'security-tips' && (
              <TutorialPage
                type="post"
                cardIndex={tipCard}
                onNext={() => {
                  if (tipCard < 2) setTipCard(prev => prev + 1)
                  else setStep('complete')
                }}
                onSkip={() => setStep('complete')}
              />
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
                    size="lg"
                    bg="#C0A860"
                    color="black"
                    fontWeight="700"
                    px={10}
                    _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)', boxShadow: '0 4px 16px rgba(192, 168, 96, 0.35)' }}
                    _active={{ transform: 'scale(0.98)' }}
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
        <Box px={5} py={3} borderTopWidth="1px" borderColor="rgba(192, 168, 96, 0.2)">
          <HStack justify="space-between">
            <Text fontSize="sm" color="gray.400" fontWeight="500">
              {visibleIndex >= 0
                ? t('footer.stepOf', { current: visibleIndex + 1, total: VISIBLE_STEPS.length })
                : step === 'intro' || step === 'welcome'
                  ? ''
                  : step === 'security-tips'
                    ? t('footer.securityTips', { defaultValue: 'Security Tips' })
                    : t('footer.settingUpWallet')}
            </Text>
            <HStack gap={3}>
              {showPrevious && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePrevious}
                  borderColor="rgba(192, 168, 96, 0.3)"
                  color="gray.300"
                  px={5}
                  fontWeight="500"
                  _hover={{ borderColor: '#C0A860', color: 'white', bg: 'rgba(192, 168, 96, 0.08)' }}
                  transition="all 0.15s ease"
                >
                  {t('footer.previous')}
                </Button>
              )}
              {showNext && (
                <Button
                  size="sm"
                  bg="#C0A860"
                  color="black"
                  px={6}
                  fontWeight="600"
                  _hover={{ bg: '#D4BC6A', transform: 'translateY(-1px)' }}
                  _active={{ transform: 'scale(0.98)' }}
                  transition="all 0.15s ease"
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
          pointerEvents="auto"
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

      {/* ── "How does this work?" dialog ───────────────────────────── */}
      {showReadMore && (
        <Flex
          position="fixed"
          top={0}
          left={0}
          w="100vw"
          h="100vh"
          bg="blackAlpha.700"
          align="center"
          justify="center"
          zIndex={2000}
          pointerEvents="auto"
          onClick={() => setShowReadMore(false)}
        >
          <Box
            w="100%"
            maxW="480px"
            mx={4}
            bg="gray.800"
            borderRadius="xl"
            borderWidth="1px"
            borderColor="gray.600"
            boxShadow="0 12px 40px rgba(0,0,0,0.6)"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            {/* Dialog header */}
            <Flex px={5} py={3} borderBottomWidth="1px" borderColor="gray.700" align="center" justify="space-between">
              <Text fontSize="md" fontWeight="bold" color="green.400">
                {t('welcome.readMoreTitle')}
              </Text>
              <Box
                as="button"
                p={1}
                borderRadius="md"
                cursor="pointer"
                _hover={{ bg: 'whiteAlpha.100' }}
                onClick={() => setShowReadMore(false)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#A0AEC0' }}>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </Box>
            </Flex>

            {/* Dialog body */}
            <VStack gap={4} px={5} py={4} align="start">
              <VStack gap={1} align="start">
                <Text fontSize="sm" fontWeight="600" color="white">
                  {t('welcome.readMoreBootloaderTitle')}
                </Text>
                <Text fontSize="sm" color="gray.300" lineHeight="tall">
                  {t('welcome.readMoreBootloaderBody')}
                </Text>
              </VStack>

              <VStack gap={1} align="start">
                <Text fontSize="sm" fontWeight="600" color="white">
                  {t('welcome.readMoreFirmwareTitle')}
                </Text>
                <Text fontSize="sm" color="gray.300" lineHeight="tall">
                  {t('welcome.readMoreFirmwareBody')}
                </Text>
              </VStack>

              <VStack gap={1} align="start">
                <Text fontSize="sm" fontWeight="600" color="white">
                  {t('welcome.readMoreWhyTitle')}
                </Text>
                <Text fontSize="sm" color="gray.300" lineHeight="tall">
                  {t('welcome.readMoreWhyBody')}
                </Text>
              </VStack>
            </VStack>

            {/* Dialog footer */}
            <Box px={5} py={3} borderTopWidth="1px" borderColor="gray.700">
              <Button
                w="100%"
                size="sm"
                bg={HIGHLIGHT}
                color="white"
                _hover={{ bg: 'green.600' }}
                onClick={() => setShowReadMore(false)}
              >
                {t('welcome.gotIt')}
              </Button>
            </Box>
          </Box>
        </Flex>
      )}
    </Flex>
  )
}
