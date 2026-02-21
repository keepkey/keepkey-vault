import { EventEmitter } from 'events'
import * as core from '@keepkey/hdwallet-core'
import { HIDKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodehid'
import { NodeWebUSBKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodewebusb'
import { usb } from 'usb'
import type { DeviceStateInfo, ActiveTransport, UpdatePhase, DeviceState, FirmwareManifest, PinRequestType } from '../shared/types'

const KEEPKEY_VENDOR_ID = 0x2B24 // 11044
const MANIFEST_URL = 'https://raw.githubusercontent.com/keepkey/keepkey-desktop/master/firmware/releases.json'

const FALLBACK_FIRMWARE = '7.7.0'
const FALLBACK_BOOTLOADER = '2.1.4'

// Delay before trying to pair after USB attach — device needs time to enumerate
const ATTACH_DELAY_MS = 1500
// Timeout for pairRawDevice — it can hang if device is in a bad state
const PAIR_TIMEOUT_MS = 10000
// Retry interval when device is claimed by another app
const CLAIMED_RETRY_MS = 5000

const WORD_COUNT_TO_ENTROPY: Record<number, 128 | 192 | 256> = {
  12: 128, 18: 192, 24: 256,
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ])
}

export class EngineController extends EventEmitter {
  private keyring: core.Keyring
  private hidAdapter: ReturnType<typeof HIDKeepKeyAdapter.useKeyring>
  private webUsbAdapter: ReturnType<typeof NodeWebUSBKeepKeyAdapter.useKeyring>
  wallet: any | null = null
  private activeTransport: ActiveTransport = null
  private updatePhase: UpdatePhase = 'idle'
  private lastState: DeviceState = 'disconnected'
  private cachedFeatures: any = null
  private latestFirmware = FALLBACK_FIRMWARE
  private latestBootloader = FALLBACK_BOOTLOADER
  private manifest: FirmwareManifest | null = null
  private syncing = false
  private lastError: string | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  // PIN flow tracking — device sends PIN_REQUEST mid-operation
  private setupInProgress = false
  private pinRequestCount = 0

  constructor() {
    super()
    this.keyring = new core.Keyring()
    this.hidAdapter = HIDKeepKeyAdapter.useKeyring(this.keyring)
    this.webUsbAdapter = NodeWebUSBKeepKeyAdapter.useKeyring(this.keyring)
  }

  /**
   * Attach transport event listeners to catch PIN_REQUEST / BUTTON_REQUEST
   * events emitted mid-operation by the hdwallet transport layer.
   */
  private attachTransportListeners() {
    if (!this.wallet?.transport) return

    const transport = this.wallet.transport

    transport.on(String(core.Events.PIN_REQUEST), () => {
      this.pinRequestCount++
      let type: PinRequestType = 'current'
      if (this.setupInProgress) {
        type = this.pinRequestCount === 1 ? 'new-first' : 'new-second'
      }
      console.log(`[Engine] PIN_REQUEST → type=${type} (count=${this.pinRequestCount}, setup=${this.setupInProgress})`)
      this.emit('pin-request', { type })
    })

    transport.on(String(core.Events.BUTTON_REQUEST), () => {
      console.log('[Engine] BUTTON_REQUEST — confirm on device')
    })

    transport.on(String(core.Events.PASSPHRASE_REQUEST), () => {
      console.log('[Engine] PASSPHRASE_REQUEST')
    })

    // CHARACTER_REQUEST — raw numeric event (80) contains wordPos/characterPos
    // The named "CHARACTER_REQUEST" event lacks this positional data
    transport.on("80", (event: any) => {
      if (event.message) {
        const { wordPos, characterPos } = event.message
        console.log(`[Engine] CHARACTER_REQUEST → word=${wordPos} char=${characterPos}`)
        this.emit('character-request', { wordPos: wordPos ?? 0, characterPos: characterPos ?? 0 })
      }
    })
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start() {
    await this.fetchFirmwareManifest()

    usb.on('attach', (device) => {
      if (device.deviceDescriptor.idVendor !== KEEPKEY_VENDOR_ID) return
      console.log('[Engine] KeepKey USB attached')
      this.updateState('connected_unpaired')
      setTimeout(() => this.syncState(), ATTACH_DELAY_MS)
    })

    usb.on('detach', (device) => {
      if (device.deviceDescriptor.idVendor !== KEEPKEY_VENDOR_ID) return
      console.log('[Engine] KeepKey USB detached')
      this.clearRetry()
      this.wallet = null
      this.activeTransport = null
      this.cachedFeatures = null
      this.lastError = null
      this.updateState('disconnected')
    })

    // Device may already be plugged in
    await this.syncState()
  }

  stop() {
    this.clearRetry()
    usb.removeAllListeners('attach')
    usb.removeAllListeners('detach')
  }

  private updateState(state: DeviceState) {
    this.lastState = state
    console.log(`[Engine] State → ${state}`)
    this.emit('state-change', this.getDeviceState())

    // Auto-trigger PIN matrix on device OLED when state becomes needs_pin
    if (state === 'needs_pin') {
      this.promptPin().catch(err => {
        console.warn('[Engine] Auto prompt-pin failed (expected if PIN flow interrupts):', err?.message)
      })
    }
  }

  // ── Firmware Manifest ──────────────────────────────────────────────────

  private async fetchFirmwareManifest() {
    try {
      const res = await fetch(MANIFEST_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.manifest = await res.json() as FirmwareManifest
      this.latestFirmware = this.manifest.latest.firmware.version.replace(/^v/, '')
      this.latestBootloader = this.manifest.latest.bootloader.version.replace(/^v/, '')
      console.log(`[Engine] Firmware manifest: fw=${this.latestFirmware} bl=${this.latestBootloader}`)
    } catch (err) {
      console.warn('[Engine] Failed to fetch firmware manifest, using fallbacks:', err)
    }
  }

  // ── State Sync (called on USB attach + startup) ────────────────────────

  async syncState() {
    if (this.syncing) return
    this.syncing = true

    try {
      // If already paired, just refresh features
      if (this.wallet && this.updatePhase === 'idle') {
        try {
          this.cachedFeatures = await this.wallet.getFeatures(true)
          const newState = this.deriveState(this.cachedFeatures)
          if (newState !== this.lastState) {
            this.updateState(newState)
          }
          return
        } catch (err) {
          console.warn('[Engine] Lost connection to wallet:', err)
          this.wallet = null
          this.activeTransport = null
          this.cachedFeatures = null
        }
      }

      // Try to pair via WebUSB then HID
      const result = await this.initializeWallet()

      if (result.wallet) {
        this.wallet = result.wallet
        this.attachTransportListeners()
        this.lastError = null
        try {
          console.log('[Engine] Getting features...')
          this.cachedFeatures = await withTimeout(
            result.wallet.getFeatures(),
            PAIR_TIMEOUT_MS,
            'getFeatures'
          )
          console.log('[Engine] Features:', JSON.stringify({
            initialized: this.cachedFeatures?.initialized,
            firmwareVersion: this.extractVersion(this.cachedFeatures),
            bootloaderMode: this.cachedFeatures?.bootloaderMode,
            label: this.cachedFeatures?.label,
          }))
          this.updateState(this.deriveState(this.cachedFeatures))
        } catch (err) {
          console.error('[Engine] Failed to get features after pairing:', err)
          this.wallet = null
          this.activeTransport = null
          this.lastError = `Failed to read device: ${err}`
          this.updateState('error')
        }
      } else if (result.usbDetected) {
        this.lastError = result.error || 'Device detected but cannot be claimed'
        console.warn(`[Engine] Device seen but not paired: ${this.lastError}`)
        this.updateState('connected_unpaired')
      } else if (this.lastState !== 'disconnected') {
        this.lastError = null
        this.updateState('disconnected')
      }
    } catch (err) {
      console.error('[Engine] syncState error:', err)
    } finally {
      this.syncing = false
      // Auto-retry when device is claimed — other app may release it
      if (this.lastState === 'connected_unpaired' && this.lastError) {
        this.scheduleRetry()
      }
    }
  }

  private scheduleRetry() {
    this.clearRetry()
    console.log(`[Engine] Will retry pairing in ${CLAIMED_RETRY_MS / 1000}s...`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.syncState()
    }, CLAIMED_RETRY_MS)
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  // ── Dual-Transport Wallet Init (Desktop Pattern) ─────────────────────
  //
  // Uses getDevice() + pairRawDevice() instead of getDevices() + pairDevice().
  // getDevice() calls requestDevice() which scans the USB bus directly.
  // getDevices() only returns previously-granted devices (empty on first run).

  private async initializeWallet(): Promise<{
    wallet: any | undefined
    usbDetected: boolean
    error: string | null
  }> {
    let usbDetected = false
    let lastError: string | null = null

    // Try WebUSB first (modern firmware, PID 0x0002)
    console.log('[Engine] Scanning for WebUSB device...')
    try {
      const webUsbDevice = await this.webUsbAdapter.getDevice().catch((err: any) => {
        console.log('[Engine] WebUSB getDevice() returned nothing:', err?.message || 'no device')
        return undefined
      })
      if (webUsbDevice) {
        usbDetected = true
        // Tell UI we found it before the potentially-hanging pair call
        if (this.lastState === 'disconnected') {
          this.updateState('connected_unpaired')
        }
        console.log('[Engine] WebUSB device found, attempting pairRawDevice...')
        try {
          const wallet = await withTimeout(
            this.webUsbAdapter.pairRawDevice(webUsbDevice),
            PAIR_TIMEOUT_MS,
            'WebUSB pairRawDevice'
          )
          if (wallet) {
            this.activeTransport = 'webusb'
            console.log('[Engine] Paired via WebUSB')
            return { wallet, usbDetected: true, error: null }
          }
          console.warn('[Engine] WebUSB pairRawDevice returned falsy')
        } catch (err: any) {
          lastError = err?.message || String(err)
          console.warn('[Engine] WebUSB pair failed:', lastError)
          if (lastError.includes('LIBUSB_ERROR_ACCESS')) {
            console.warn('[Engine] Device claimed by another process, trying HID...')
          }
        }
      }
    } catch (err: any) {
      console.warn('[Engine] WebUSB getDevice error:', err?.message || err)
    }

    // Fallback to HID (bootloader, legacy, or OS-blocked USB)
    console.log('[Engine] Scanning for HID device...')
    try {
      const hidDevice = await this.hidAdapter.getDevice().catch((err: any) => {
        console.log('[Engine] HID getDevice() returned nothing:', err?.message || 'no device')
        return undefined
      })
      if (hidDevice) {
        usbDetected = true
        if (this.lastState === 'disconnected') {
          this.updateState('connected_unpaired')
        }
        console.log('[Engine] HID device found, attempting pairRawDevice...')
        try {
          const wallet = await withTimeout(
            this.hidAdapter.pairRawDevice(hidDevice),
            PAIR_TIMEOUT_MS,
            'HID pairRawDevice'
          )
          if (wallet) {
            this.activeTransport = 'hid'
            console.log('[Engine] Paired via HID')
            return { wallet, usbDetected: true, error: null }
          }
          console.warn('[Engine] HID pairRawDevice returned falsy')
        } catch (err: any) {
          lastError = err?.message || String(err)
          console.warn('[Engine] HID pair failed:', lastError)
        }
      }
    } catch (err: any) {
      console.warn('[Engine] HID getDevice error:', err?.message || err)
    }

    console.log(`[Engine] initializeWallet done — usbDetected=${usbDetected}, error=${lastError}`)
    return { wallet: undefined, usbDetected, error: lastError }
  }

  // ── State Derivation ───────────────────────────────────────────────────

  private deriveState(features: any): DeviceState {
    if (!features) return 'disconnected'
    if (features.bootloaderMode) return 'bootloader'

    const fwVersion = this.extractVersion(features)
    if (this.versionLessThan(fwVersion, this.latestFirmware) || fwVersion === '4.0.0') {
      return 'needs_firmware'
    }

    if (!features.initialized) return 'needs_init'
    if (features.pinProtection && !features.pinCached) return 'needs_pin'
    if (features.passphraseProtection && !features.passphraseCached) return 'needs_passphrase'

    return 'ready'
  }

  private extractVersion(features: any): string {
    if (features.majorVersion) {
      return `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
    }
    return features.firmwareVersion || '0.0.0'
  }

  private versionLessThan(current: string, target: string): boolean {
    const c = current.split('.').map(Number)
    const t = target.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if ((c[i] || 0) < (t[i] || 0)) return true
      if ((c[i] || 0) > (t[i] || 0)) return false
    }
    return false
  }

  // ── Public State ───────────────────────────────────────────────────────

  getDeviceState(): DeviceStateInfo {
    const features = this.cachedFeatures
    const fwVersion = features ? this.extractVersion(features) : undefined
    const blVersion = features?.bootloaderVersion || undefined
    const bootloaderMode = features?.bootloaderMode ?? false
    const initialized = features?.initialized ?? false
    const needsFw = fwVersion
      ? (this.versionLessThan(fwVersion, this.latestFirmware) || fwVersion === '4.0.0')
      : false
    const needsBl = blVersion
      ? this.versionLessThan(blVersion, this.latestBootloader)
      : bootloaderMode

    return {
      state: this.lastState,
      activeTransport: this.activeTransport,
      updatePhase: this.updatePhase,
      deviceId: features?.deviceId || undefined,
      label: features?.label || undefined,
      firmwareVersion: fwVersion,
      bootloaderVersion: blVersion,
      latestFirmware: this.latestFirmware,
      latestBootloader: this.latestBootloader,
      bootloaderMode,
      needsBootloaderUpdate: needsBl,
      needsFirmwareUpdate: needsFw,
      needsInit: !initialized,
      initialized,
      isOob: bootloaderMode || fwVersion === '4.0.0',
      error: this.lastError,
    }
  }

  // ── Firmware Update Operations ─────────────────────────────────────────

  async startBootloaderUpdate() {
    if (!this.wallet) throw new Error('No device connected')
    this.updatePhase = 'flashing'
    this.emit('state-change', this.getDeviceState())
    this.emit('firmware-progress', { percent: 0, message: 'Starting bootloader update...' })

    try {
      const blUrl = this.manifest
        ? new URL(this.manifest.latest.bootloader.url, MANIFEST_URL.replace('releases.json', '')).toString()
        : `https://github.com/keepkey/keepkey-firmware/releases/download/v${this.latestBootloader}/blupdater.bin`

      this.emit('firmware-progress', { percent: 10, message: 'Downloading bootloader...' })
      const response = await fetch(blUrl)
      if (!response.ok) throw new Error(`Failed to download bootloader: ${response.status}`)
      const firmware = Buffer.from(await response.arrayBuffer())

      this.emit('firmware-progress', { percent: 30, message: 'Erasing current firmware...' })
      await this.wallet.firmwareErase()

      this.emit('firmware-progress', { percent: 50, message: 'Uploading bootloader...' })
      await this.wallet.firmwareUpload(firmware)

      this.emit('firmware-progress', { percent: 90, message: 'Bootloader updated, rebooting...' })
      this.updatePhase = 'rebooting'
      this.wallet = null
      this.activeTransport = null
      this.cachedFeatures = null
      this.emit('state-change', this.getDeviceState())
      this.emit('firmware-progress', { percent: 100, message: 'Bootloader update complete' })
    } catch (err: any) {
      this.updatePhase = 'idle'
      this.emit('state-change', this.getDeviceState())
      throw err
    }
  }

  async startFirmwareUpdate() {
    if (!this.wallet) throw new Error('No device connected')
    this.updatePhase = 'flashing'
    this.emit('state-change', this.getDeviceState())
    this.emit('firmware-progress', { percent: 0, message: 'Starting firmware update...' })

    try {
      const fwUrl = this.manifest
        ? new URL(this.manifest.latest.firmware.url, MANIFEST_URL.replace('releases.json', '')).toString()
        : `https://github.com/keepkey/keepkey-firmware/releases/download/v${this.latestFirmware}/firmware.keepkey.bin`

      this.emit('firmware-progress', { percent: 10, message: 'Downloading firmware...' })
      const response = await fetch(fwUrl)
      if (!response.ok) throw new Error(`Failed to download firmware: ${response.status}`)
      const firmware = Buffer.from(await response.arrayBuffer())

      this.emit('firmware-progress', { percent: 30, message: 'Erasing current firmware...' })
      await this.wallet.firmwareErase()

      this.emit('firmware-progress', { percent: 50, message: 'Uploading firmware...' })
      await this.wallet.firmwareUpload(firmware)

      this.emit('firmware-progress', { percent: 90, message: 'Firmware updated, rebooting...' })
      this.updatePhase = 'rebooting'
      this.wallet = null
      this.activeTransport = null
      this.cachedFeatures = null
      this.emit('state-change', this.getDeviceState())
      this.emit('firmware-progress', { percent: 100, message: 'Firmware update complete' })
    } catch (err: any) {
      this.updatePhase = 'idle'
      this.emit('state-change', this.getDeviceState())
      throw err
    }
  }

  async flashFirmware() {
    return this.startFirmwareUpdate()
  }

  // ── Wallet Setup Operations ────────────────────────────────────────────

  async resetDevice(opts: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }) {
    if (!this.wallet) throw new Error('No device connected')
    this.setupInProgress = true
    this.pinRequestCount = 0
    try {
      await this.wallet.reset({
        entropy: WORD_COUNT_TO_ENTROPY[opts.wordCount],
        label: 'KeepKey',
        pin: opts.pin,
        passphrase: opts.passphrase,
        autoLockDelayMs: 600000, // 10 min — user writes down seed words on device
      })
      this.cachedFeatures = await this.wallet.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
    } finally {
      this.setupInProgress = false
      this.pinRequestCount = 0
    }
  }

  async recoverDevice(opts: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }) {
    if (!this.wallet) throw new Error('No device connected')
    this.setupInProgress = true
    this.pinRequestCount = 0
    try {
      await this.wallet.recover({
        entropy: WORD_COUNT_TO_ENTROPY[opts.wordCount],
        label: 'KeepKey',
        pin: opts.pin,
        passphrase: opts.passphrase,
        autoLockDelayMs: 600000, // 10 min — recovery requires extended user interaction
      })
      this.cachedFeatures = await this.wallet.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
    } catch (err: any) {
      // hdwallet rejects with raw protobuf FAILURE objects like:
      // { message_type: "FAILURE", message: { code: 3, message: "..." }, from_wallet: true }
      // — NOT standard Error instances. Extract the string safely.
      const rawMessage: string =
        typeof err?.message === 'string' ? err.message
        : typeof err?.message?.message === 'string' ? err.message.message
        : String(err)
      console.error('[Engine] Recovery failed:', rawMessage)

      // Classify the failure for user-friendly messaging
      let message = rawMessage
      let errorType: 'pin-mismatch' | 'invalid-mnemonic' | 'bad-words' | 'cancelled' | 'unknown' = 'unknown'
      if (rawMessage.includes('Action cancelled') && this.pinRequestCount >= 2) {
        message = 'PINs did not match. Both entries must be identical.'
        errorType = 'pin-mismatch'
      } else if (rawMessage.includes('Action cancelled')) {
        errorType = 'cancelled'
      } else if (rawMessage.includes('Invalid mnemonic')) {
        errorType = 'invalid-mnemonic'
      } else if (rawMessage.includes('Words were not entered correctly') || rawMessage.includes('substition cipher') || rawMessage.includes('substitution cipher')) {
        errorType = 'bad-words'
      }

      this.emit('recovery-error', { message, errorType })

      // Refresh device state after failure — device may now be in needs_init or needs_pin
      try {
        this.cachedFeatures = await this.wallet.getFeatures()
        this.updateState(this.deriveState(this.cachedFeatures))
      } catch {
        // Device may be unresponsive after failure, state will sync on next USB event
      }

      throw err
    } finally {
      this.setupInProgress = false
      this.pinRequestCount = 0
    }
  }

  async verifySeed(opts: { wordCount: 12 | 18 | 24 }) {
    if (!this.wallet) throw new Error('No device connected')
    if (!this.wallet.transport) throw new Error('No transport available')

    // hdwallet's recover() doesn't support dryRun, so we construct
    // the raw RecoveryDevice protobuf with dryRun=true and send via transport.
    // dryRun means the device verifies the seed WITHOUT modifying any state.
    const Messages = require('@keepkey/device-protocol/lib/messages_pb')

    this.setupInProgress = true
    this.pinRequestCount = 0

    try {
      const msg = new Messages.RecoveryDevice()
      msg.setWordCount(opts.wordCount)
      msg.setPassphraseProtection(false)
      msg.setPinProtection(false)
      msg.setLabel('KeepKey')
      msg.setLanguage('english')
      msg.setEnforceWordlist(true)
      msg.setUseCharacterCipher(true)
      msg.setDryRun(true)
      msg.setAutoLockDelayMs(600000)

      await this.wallet.transport.call(
        Messages.MessageType.MESSAGETYPE_RECOVERYDEVICE,
        msg,
        { msgTimeout: 10 * 60 * 1000 }
      )

      return { success: true, message: 'Seed verified successfully' }
    } catch (err: any) {
      const rawMessage: string =
        typeof err?.message === 'string' ? err.message
        : typeof err?.message?.message === 'string' ? err.message.message
        : String(err)
      console.error('[Engine] Seed verification failed:', rawMessage)

      let errorType: 'invalid-mnemonic' | 'bad-words' | 'cancelled' | 'unknown' = 'unknown'
      if (rawMessage.includes('Action cancelled')) {
        errorType = 'cancelled'
      } else if (rawMessage.includes('Invalid mnemonic') || rawMessage.includes('does not match')) {
        errorType = 'invalid-mnemonic'
      } else if (rawMessage.includes('Words were not entered correctly') || rawMessage.includes('substition cipher') || rawMessage.includes('substitution cipher')) {
        errorType = 'bad-words'
      }

      this.emit('recovery-error', { message: rawMessage, errorType })
      throw err
    } finally {
      this.setupInProgress = false
      this.pinRequestCount = 0
    }
  }

  async applySettings(opts: { label?: string }) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.applySettings({ label: opts.label })
    this.cachedFeatures = await this.wallet.getFeatures()
    this.emit('state-change', this.getDeviceState())
  }

  /**
   * Trigger the PIN matrix on a locked device by requesting a public key.
   * GetPublicKey accesses the seed, which requires PIN on locked devices.
   * The transport PIN_REQUEST event will fire, prompting the UI overlay.
   */
  async promptPin() {
    if (!this.wallet) throw new Error('No device connected')
    // getPublicKeys accesses the seed → triggers PinMatrixRequest on locked device
    // The transport PIN_REQUEST listener (line 70) will emit 'pin-request' to the UI
    // We intentionally don't await the result — the PIN_REQUEST event fires mid-call
    // and we need to let the UI handle it before the operation can complete
    const promise = this.wallet.getPublicKeys([{
      addressNList: [0x8000002C, 0x80000000, 0x80000000], // m/44'/0'/0'
      curve: 'secp256k1',
      showDisplay: false,
      coin: 'Bitcoin',
    }])
    // If device is already unlocked, getPublicKeys completes immediately
    // If locked, PIN_REQUEST fires and we wait for sendPin() to resolve it
    try {
      await promise
      // If we get here, device was already unlocked
      this.cachedFeatures = await this.wallet.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
      return { status: 'unlocked', message: 'Device already unlocked' }
    } catch (err: any) {
      // PIN flow interruption is expected — the UI handles PIN entry
      throw err
    }
  }

  async sendPin(pin: string) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.sendPin(pin)
    // During setup (reset/recover), don't call getFeatures — the main operation
    // is still running and the transport is locked. Features refresh happens
    // when the setup operation completes.
    if (!this.setupInProgress) {
      this.cachedFeatures = await this.wallet.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
    }
  }

  async sendPassphrase(passphrase: string) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.sendPassphrase(passphrase)
    this.cachedFeatures = await this.wallet.getFeatures()
    this.updateState(this.deriveState(this.cachedFeatures))
  }

  async sendCharacter(character: string) {
    if (!this.wallet) throw new Error('No device connected')
    if (!this.setupInProgress) return // Recovery already ended, ignore stale input
    await this.wallet.sendCharacter(character)
  }

  async sendCharacterDelete() {
    if (!this.wallet) throw new Error('No device connected')
    if (!this.setupInProgress) return
    await this.wallet.sendCharacterDelete()
  }

  async sendCharacterDone() {
    if (!this.wallet) throw new Error('No device connected')
    if (!this.setupInProgress) return
    await this.wallet.sendCharacterDone()
  }

  resetUpdatePhase() {
    this.updatePhase = 'idle'
    this.emit('state-change', this.getDeviceState())
  }
}
