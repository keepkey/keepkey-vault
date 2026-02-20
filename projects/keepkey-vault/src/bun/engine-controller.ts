import { EventEmitter } from 'events'
import * as core from '@keepkey/hdwallet-core'
import { HIDKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodehid'
import { NodeWebUSBKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodewebusb'
import { usb } from 'usb'
import type { DeviceStateInfo, ActiveTransport, UpdatePhase, DeviceState, FirmwareManifest } from '../shared/types'

const KEEPKEY_VENDOR_ID = 0x2B24 // 11044
const MANIFEST_URL = 'https://raw.githubusercontent.com/keepkey/keepkey-desktop/master/firmware/releases.json'

const FALLBACK_FIRMWARE = '7.7.0'
const FALLBACK_BOOTLOADER = '2.1.4'

// Delay before trying to pair after USB attach — device needs time to enumerate
const ATTACH_DELAY_MS = 1500

const WORD_COUNT_TO_ENTROPY: Record<number, 128 | 192 | 256> = {
  12: 128, 18: 192, 24: 256,
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

  constructor() {
    super()
    this.keyring = new core.Keyring()
    this.hidAdapter = HIDKeepKeyAdapter.useKeyring(this.keyring)
    this.webUsbAdapter = NodeWebUSBKeepKeyAdapter.useKeyring(this.keyring)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start() {
    await this.fetchFirmwareManifest()

    usb.on('attach', (device) => {
      if (device.deviceDescriptor.idVendor !== KEEPKEY_VENDOR_ID) return
      console.log('[Engine] KeepKey USB attached')

      // Immediately tell UI we see it
      this.updateState('connected_unpaired')

      // Give device time to enumerate USB interfaces before pairing
      setTimeout(() => this.syncState(), ATTACH_DELAY_MS)
    })

    usb.on('detach', (device) => {
      if (device.deviceDescriptor.idVendor !== KEEPKEY_VENDOR_ID) return
      console.log('[Engine] KeepKey USB detached')
      this.wallet = null
      this.activeTransport = null
      this.cachedFeatures = null
      this.lastError = null
      this.updateState('disconnected')
    })

    // Device may already be plugged in — try after a short delay for startup
    await this.syncState()
  }

  stop() {
    usb.removeAllListeners('attach')
    usb.removeAllListeners('detach')
  }

  private updateState(state: DeviceState) {
    this.lastState = state
    this.emit('state-change', this.getDeviceState())
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
        this.lastError = null
        try {
          this.cachedFeatures = await result.wallet.getFeatures()
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
        // Device is on USB bus but we can't pair it
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
    try {
      const webUsbDevice = await this.webUsbAdapter.getDevice().catch(() => undefined)
      if (webUsbDevice) {
        usbDetected = true
        console.log('[Engine] WebUSB device found, pairing...')
        try {
          const wallet = await this.webUsbAdapter.pairRawDevice(webUsbDevice)
          if (wallet) {
            this.activeTransport = 'webusb'
            console.log('[Engine] Paired via WebUSB')
            return { wallet, usbDetected: true, error: null }
          }
        } catch (err: any) {
          lastError = err?.message || String(err)
          console.warn('[Engine] WebUSB pair failed:', lastError)
          if (lastError.includes('LIBUSB_ERROR_ACCESS')) {
            console.warn('[Engine] Device claimed by another process, trying HID...')
          }
        }
      } else {
        console.log('[Engine] No WebUSB device found')
      }
    } catch (err: any) {
      console.warn('[Engine] WebUSB getDevice error:', err?.message || err)
    }

    // Fallback to HID (bootloader, legacy, or OS-blocked USB)
    try {
      const hidDevice = await this.hidAdapter.getDevice().catch(() => undefined)
      if (hidDevice) {
        usbDetected = true
        console.log('[Engine] HID device found, pairing...')
        try {
          const wallet = await this.hidAdapter.pairRawDevice(hidDevice)
          if (wallet) {
            this.activeTransport = 'hid'
            console.log('[Engine] Paired via HID')
            return { wallet, usbDetected: true, error: null }
          }
        } catch (err: any) {
          lastError = err?.message || String(err)
          console.warn('[Engine] HID pair failed:', lastError)
        }
      } else {
        console.log('[Engine] No HID device found')
      }
    } catch (err: any) {
      console.warn('[Engine] HID getDevice error:', err?.message || err)
    }

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
    await this.wallet.reset({
      entropy: WORD_COUNT_TO_ENTROPY[opts.wordCount],
      label: 'KeepKey',
      pin: opts.pin,
      passphrase: opts.passphrase,
    })
    this.cachedFeatures = await this.wallet.getFeatures()
    this.updateState(this.deriveState(this.cachedFeatures))
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
    this.updateState(this.deriveState(this.cachedFeatures))
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
    this.updateState(this.deriveState(this.cachedFeatures))
  }

  async sendPassphrase(passphrase: string) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.sendPassphrase(passphrase)
    this.cachedFeatures = await this.wallet.getFeatures()
    this.updateState(this.deriveState(this.cachedFeatures))
  }

  resetUpdatePhase() {
    this.updatePhase = 'idle'
    this.emit('state-change', this.getDeviceState())
  }
}
