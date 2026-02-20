import { EventEmitter } from 'events'
import * as core from '@keepkey/hdwallet-core'
import { HIDKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodehid'
import { NodeWebUSBKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodewebusb'
import type { DeviceStateInfo, ActiveTransport, UpdatePhase, DeviceState } from '../shared/types'

// Known latest versions — these should eventually come from a remote manifest
const LATEST_FIRMWARE = '7.7.0'
const LATEST_BOOTLOADER = '2.1.4'

// Word count → entropy bits mapping
const WORD_COUNT_TO_ENTROPY: Record<number, 128 | 192 | 256> = {
  12: 128,
  18: 192,
  24: 256,
}

export class EngineController extends EventEmitter {
  private keyring: core.Keyring
  private hidAdapter: ReturnType<typeof HIDKeepKeyAdapter.useKeyring>
  private webUsbAdapter: ReturnType<typeof NodeWebUSBKeepKeyAdapter.useKeyring>
  private wallet: any | null = null
  private activeTransport: ActiveTransport = null
  private updatePhase: UpdatePhase = 'idle'
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastState: DeviceState = 'disconnected'
  private cachedFeatures: any = null

  constructor() {
    super()
    this.keyring = new core.Keyring()
    this.hidAdapter = HIDKeepKeyAdapter.useKeyring(this.keyring)
    this.webUsbAdapter = NodeWebUSBKeepKeyAdapter.useKeyring(this.keyring)
  }

  startPolling(intervalMs = 2000) {
    if (this.pollTimer) return
    this.poll() // immediate first poll
    this.pollTimer = setInterval(() => this.poll(), intervalMs)
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async poll() {
    try {
      // If we already have a wallet and it's not in a firmware update cycle, just check it's still alive
      if (this.wallet && this.updatePhase === 'idle') {
        try {
          const features = await this.wallet.getFeatures(true)
          this.cachedFeatures = features
          const newState = this.deriveState(features)
          if (newState !== this.lastState) {
            this.lastState = newState
            this.emit('state-change', this.getDeviceState())
          }
          return
        } catch {
          // Wallet disconnected
          this.wallet = null
          this.activeTransport = null
          this.cachedFeatures = null
          this.lastState = 'disconnected'
          this.emit('state-change', this.getDeviceState())
        }
      }

      // No wallet — try to discover and pair a device
      // Try WebUSB first (normal firmware mode, PID 0x0002)
      let paired = false
      try {
        const webUsbDevices = await this.webUsbAdapter.getDevices()
        if (webUsbDevices.length > 0) {
          this.wallet = await this.webUsbAdapter.pairDevice(undefined, false)
          this.activeTransport = 'webusb'
          paired = true
        }
      } catch {
        // WebUSB not available or device not in normal mode
      }

      // Try HID (bootloader PID 0x0001, legacy, or fallback)
      if (!paired) {
        try {
          const hidDevices = await this.hidAdapter.getDevices()
          if (hidDevices.length > 0) {
            this.wallet = await this.hidAdapter.pairDevice(undefined, false)
            this.activeTransport = 'hid'
            paired = true
          }
        } catch {
          // HID not available
        }
      }

      if (paired && this.wallet) {
        try {
          const features = await this.wallet.getFeatures()
          this.cachedFeatures = features
          const newState = this.deriveState(features)
          this.lastState = newState
          this.emit('state-change', this.getDeviceState())
        } catch {
          this.wallet = null
          this.activeTransport = null
        }
      } else if (this.lastState !== 'disconnected') {
        this.lastState = 'disconnected'
        this.cachedFeatures = null
        this.emit('state-change', this.getDeviceState())
      }
    } catch (err) {
      console.error('[EngineController] poll error:', err)
    }
  }

  private deriveState(features: any): DeviceState {
    if (!features) return 'disconnected'

    if (features.bootloaderMode) return 'bootloader'

    // Check firmware version — factory OOB devices ship with 4.0.0
    const fwVersion = features.majorVersion
      ? `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
      : features.firmwareVersion || '0.0.0'
    const needsFw = this.versionLessThan(fwVersion, LATEST_FIRMWARE) || fwVersion === '4.0.0'
    if (needsFw) return 'needs_firmware'

    if (!features.initialized) return 'needs_init'
    if (features.pinProtection && !features.pinCached) return 'needs_pin'
    if (features.passphraseProtection && !features.passphraseCached) return 'needs_passphrase'

    return 'ready'
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

  getDeviceState(): DeviceStateInfo {
    const features = this.cachedFeatures
    const fwVersion = features
      ? (features.majorVersion
          ? `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
          : features.firmwareVersion || undefined)
      : undefined

    const blVersion = features?.bootloaderVersion || undefined
    const bootloaderMode = features?.bootloaderMode ?? false
    const initialized = features?.initialized ?? false
    const needsFw = fwVersion ? (this.versionLessThan(fwVersion, LATEST_FIRMWARE) || fwVersion === '4.0.0') : false
    const needsBl = blVersion ? this.versionLessThan(blVersion, LATEST_BOOTLOADER) : bootloaderMode
    const isOob = bootloaderMode || fwVersion === '4.0.0'

    return {
      state: this.lastState,
      activeTransport: this.activeTransport,
      updatePhase: this.updatePhase,
      deviceId: features?.deviceId || undefined,
      label: features?.label || undefined,
      firmwareVersion: fwVersion,
      bootloaderVersion: blVersion,
      latestFirmware: LATEST_FIRMWARE,
      latestBootloader: LATEST_BOOTLOADER,
      bootloaderMode,
      needsBootloaderUpdate: needsBl,
      needsFirmwareUpdate: needsFw,
      needsInit: !initialized,
      initialized,
      isOob,
    }
  }

  // ── Firmware Update Operations ──────────────────────────────────────

  async startBootloaderUpdate() {
    if (!this.wallet) throw new Error('No device connected')
    this.updatePhase = 'flashing'
    this.emit('state-change', this.getDeviceState())
    this.emit('firmware-progress', { percent: 0, message: 'Starting bootloader update...' })

    try {
      // Fetch the latest bootloader binary from GitHub releases
      const blUrl = `https://github.com/keepkey/keepkey-firmware/releases/download/v${LATEST_BOOTLOADER}/blupdater.bin`
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
      const fwUrl = `https://github.com/keepkey/keepkey-firmware/releases/download/v${LATEST_FIRMWARE}/firmware.keepkey.bin`
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
    // Alias for startFirmwareUpdate — used when device is already in bootloader
    return this.startFirmwareUpdate()
  }

  // ── Wallet Setup Operations ─────────────────────────────────────────

  async resetDevice(opts: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.reset({
      entropy: WORD_COUNT_TO_ENTROPY[opts.wordCount],
      label: 'KeepKey',
      pin: opts.pin,
      passphrase: opts.passphrase,
    })
    // Re-fetch features after reset
    this.cachedFeatures = await this.wallet.getFeatures()
    this.lastState = this.deriveState(this.cachedFeatures)
    this.emit('state-change', this.getDeviceState())
  }

  async recoverDevice(opts: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.recover({
      entropy: WORD_COUNT_TO_ENTROPY[opts.wordCount],
      label: 'KeepKey',
      pin: opts.pin,
      passphrase: opts.passphrase,
    })
    this.cachedFeatures = await this.wallet.getFeatures()
    this.lastState = this.deriveState(this.cachedFeatures)
    this.emit('state-change', this.getDeviceState())
  }

  async applySettings(opts: { label?: string }) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.applySettings({ label: opts.label })
    this.cachedFeatures = await this.wallet.getFeatures()
    this.emit('state-change', this.getDeviceState())
  }

  async sendPin(pin: string) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.sendPin(pin)
    this.cachedFeatures = await this.wallet.getFeatures()
    this.lastState = this.deriveState(this.cachedFeatures)
    this.emit('state-change', this.getDeviceState())
  }

  async sendPassphrase(passphrase: string) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.sendPassphrase(passphrase)
    this.cachedFeatures = await this.wallet.getFeatures()
    this.lastState = this.deriveState(this.cachedFeatures)
    this.emit('state-change', this.getDeviceState())
  }

  // Reset updatePhase back to idle (called after UI acknowledges completion)
  resetUpdatePhase() {
    this.updatePhase = 'idle'
    this.emit('state-change', this.getDeviceState())
  }
}
