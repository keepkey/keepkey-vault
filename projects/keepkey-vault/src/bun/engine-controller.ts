import { EventEmitter } from 'events'
import * as core from '@keepkey/hdwallet-core'
import { HIDKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodehid'
import { NodeWebUSBKeepKeyAdapter } from '@keepkey/hdwallet-keepkey-nodewebusb'
import { usb } from 'usb'
import { saveDeviceSnapshot } from './db'
import type { DeviceStateInfo, ActiveTransport, UpdatePhase, DeviceState, FirmwareManifest, PinRequestType, Bip85DeriveParams, Bip85DisplayResult } from '../shared/types'
import { resolveOndeviceFirmwareVersion } from '../shared/firmware-versions'

const KEEPKEY_VENDOR_ID = 0x2B24 // 11044
const MANIFEST_URL = 'https://raw.githubusercontent.com/keepkey/keepkey-desktop/master/firmware/releases.json'

const FALLBACK_FIRMWARE = '7.10.0'
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

/** SHA-256 hex digest of a Buffer (for binary integrity checks). */
function sha256Hex(data: Buffer): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(data)
  return hasher.digest('hex')
}

/** Convert hdwallet's firmwareHash (base64 string or Uint8Array) to lowercase hex. */
function base64ToHex(value: any): string | undefined {
  if (!value) return undefined
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString('hex')
  }
  if (typeof value === 'string') {
    // Already hex?
    if (/^[0-9a-fA-F]+$/.test(value)) return value.toLowerCase()
    // Base64
    return Buffer.from(value, 'base64').toString('hex')
  }
  return undefined
}

/** Extract a string message from hdwallet errors (raw protobuf FAILURE objects or standard Errors). */
function extractErrorMessage(err: any): string {
  if (typeof err?.message === 'string') return err.message
  if (typeof err?.message?.message === 'string') return err.message.message
  return String(err)
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer!))
}

export class EngineController extends EventEmitter {
  private keyring: core.Keyring
  private hidAdapter: ReturnType<typeof HIDKeepKeyAdapter.useKeyring>
  private webUsbAdapter: ReturnType<typeof NodeWebUSBKeepKeyAdapter.useKeyring>
  // Typed as HDWallet with KeepKey-specific extensions (firmware, PIN, etc.)
  // Cast to `any` when calling KeepKey-only methods not in the HDWallet interface
  wallet: (core.HDWallet & Record<string, any>) | null = null
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
  private rebootPollTimer: ReturnType<typeof setInterval> | null = null

  // PIN flow tracking — device sends PIN_REQUEST mid-operation
  private setupInProgress = false
  private pinRequestCount = 0
  // Tracks whether promptPin() → getPublicKeys() is still awaiting resolution.
  // While active, sendPin/sendPassphrase must NOT call getFeatures — that would
  // race with the pending getPublicKeys and cause transport "Unexpected message".
  private promptPinActive = false

  get isSyncing(): boolean { return this.syncing }

  constructor() {
    super()
    this.keyring = new core.Keyring()
    this.hidAdapter = HIDKeepKeyAdapter.useKeyring(this.keyring)
    this.webUsbAdapter = NodeWebUSBKeepKeyAdapter.useKeyring(this.keyring)
  }

  /**
   * Clear the old wallet + keyring state so the next pairRawDevice starts fresh.
   * Without this, the keyring still tracks the old connection and WebUSB
   * rejects with "cannot connect an already-connected connection".
   */
  private clearWallet() {
    this.cleanupTransportListeners()
    this.wallet = null
    this.activeTransport = null
    this.cachedFeatures = null
    this.cachedFingerprint = null
    this.keyring.removeAll().catch(() => {})
  }

  /**
   * Attach transport event listeners to catch PIN_REQUEST / BUTTON_REQUEST
   * events emitted mid-operation by the hdwallet transport layer.
   */
  private cleanupTransportListeners() {
    if (!this.wallet?.transport) return
    const transport = this.wallet.transport
    transport.removeAllListeners(String(core.Events.PIN_REQUEST))
    transport.removeAllListeners(String(core.Events.BUTTON_REQUEST))
    transport.removeAllListeners(String(core.Events.PASSPHRASE_REQUEST))
    transport.removeAllListeners("80")
  }

  private attachTransportListeners() {
    if (!this.wallet?.transport) return

    // Clean up any existing listeners to prevent leaks on re-pair
    this.cleanupTransportListeners()

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
      console.log('[Engine] PASSPHRASE_REQUEST → emitting to UI')
      // Device has moved past PIN and now waits for passphrase — update derived
      // state immediately so the UI reflects what the device actually needs.
      // Without this, state stays 'needs_pin' and App.tsx's cleanup effect
      // dismisses the passphrase overlay before the user can interact with it.
      if (this.lastState !== 'needs_passphrase') {
        this.updateState('needs_passphrase')
      }
      this.emit('passphrase-request')
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
    // Register USB listeners BEFORE any await — if fetchFirmwareManifest() hangs
    // or takes time, device attach/detach events during that window would be lost.
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
      // M1 fix: During firmware reboot, device disconnects/reconnects — don't
      // clear wallet state or emit disconnected (reboot poll handles reconnection)
      if (this.updatePhase === 'rebooting') {
        console.log('[Engine] Detach during reboot phase — ignoring (reboot poll active)')
        this.clearWallet()
        return
      }
      this.clearWallet()
      this.lastError = null
      this.updateState('disconnected')
    })

    await this.fetchFirmwareManifest()

    // Device may already be plugged in
    await this.syncState()
  }

  stop() {
    this.clearRetry()
    this.stopRebootPoll()
    usb.removeAllListeners('attach')
    usb.removeAllListeners('detach')
  }

  private updateState(state: DeviceState) {
    this.lastState = state
    console.log(`[Engine] State → ${state}`)
    this.emit('state-change', this.getDeviceState())

    // Persist device snapshot for watch-only mode (fire-and-forget)
    if (state === 'ready' && this.cachedFeatures) {
      try {
        const deviceId = this.cachedFeatures.deviceId || 'unknown'
        const label = this.cachedFeatures.label || ''
        const fwVer = this.extractVersion(this.cachedFeatures)
        saveDeviceSnapshot(deviceId, label, fwVer, JSON.stringify(this.cachedFeatures))
      } catch { /* never block on cache failure */ }

      // Pre-cache wallet fingerprint so BIP-85 and other ops don't need
      // a separate btcGetAddress call (which can trigger BUTTON_REQUEST).
      if (!this.cachedFingerprint) {
        this.getWalletFingerprint()
          .then(fp => console.log('[Engine] Fingerprint pre-cached:', fp.slice(0, 12) + '...'))
          .catch(err => console.warn('[Engine] Fingerprint pre-cache failed (will retry on demand):', err?.message))
      }
    }

    // Auto-trigger PIN matrix on device OLED when state becomes needs_pin.
    // After a firmware/bootloader flash the device reboots — give the transport
    // time to stabilise before firing getPublicKeys, otherwise the device may
    // respond with Failure(7) "Invalid PIN" before the user even sees the overlay.
    if (state === 'needs_pin') {
      const delay = this.updatePhase === 'rebooting' ? 2000 : 0
      if (this.updatePhase === 'rebooting') {
        this.updatePhase = 'idle'
        this.emit('state-change', this.getDeviceState())
      }
      setTimeout(() => {
        this.promptPin().catch(err => {
          console.warn('[Engine] Auto prompt-pin failed (expected if PIN flow interrupts):', err?.message)
          // If device is still locked (wrong PIN, transport error, etc.), retry so
          // the PIN overlay re-appears.  Without this, promptPinActive stays false,
          // lastState is already 'needs_pin', and updateState won't re-fire —
          // leaving the user with no PIN overlay while the device still needs PIN.
          if (this.lastState === 'needs_pin' && !this.promptPinActive) {
            setTimeout(() => {
              if (this.lastState === 'needs_pin' && !this.promptPinActive) {
                console.log('[Engine] Retrying prompt-pin (device still locked)')
                this.promptPin().catch(err2 => {
                  console.warn('[Engine] Retry prompt-pin failed:', err2?.message)
                })
              }
            }, 3000)
          }
        })
      }, delay)
    }

    // Same for needs_passphrase — device has passphrase protection but PIN is
    // already cached (or disabled).  We must call promptPin() → getPublicKeys()
    // so the device sends PASSPHRASE_REQUEST; without it, the UI overlay shows
    // but sendPassphrase() has no pending device request to respond to.
    // Use setTimeout (like needs_pin) so the check runs after any in-flight
    // promptPin() completes and clears promptPinActive in its finally block.
    if (state === 'needs_passphrase') {
      setTimeout(() => {
        if (!this.promptPinActive) {
          this.promptPin().catch(err => {
            console.warn('[Engine] Auto prompt-passphrase failed:', err?.message)
          })
        }
      }, 0)
    }
  }

  // ── Firmware Manifest ──────────────────────────────────────────────────

  private async fetchFirmwareManifest() {
    try {
      const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.manifest = await res.json() as FirmwareManifest
      this.latestFirmware = this.manifest.latest.firmware.version.replace(/^v/, '')
      this.latestBootloader = this.manifest.latest.bootloader.version.replace(/^v/, '')
      console.log(`[Engine] Firmware manifest: fw=${this.latestFirmware} bl=${this.latestBootloader}`)
    } catch (err) {
      console.warn('[Engine] Failed to fetch firmware manifest, using fallbacks:', err)
    }
  }

  /**
   * Verify device firmware/bootloader against the manifest registry.
   *
   * Key insight from keepkey-desktop: the manifest's hashes.firmware contains
   * SHA-256 of downloadable .bin files, NOT on-device hashes. But hashes.bootloader
   * DOES contain on-device bootloader hashes. So:
   *   - Bootloader: lookup device hash in manifest.hashes.bootloader (hash-based)
   *   - Firmware: check if device version exists in manifest.hashes.firmware values (version-based)
   */
  private verifyHashes(features: any): {
    firmwareHash?: string
    bootloaderHash?: string
    firmwareVerified?: boolean
    bootloaderVerified?: boolean
  } {
    const fwHash = base64ToHex(features?.firmwareHash)
    const blHash = base64ToHex(features?.bootloaderHash)

    let firmwareVerified: boolean | undefined
    let bootloaderVerified: boolean | undefined

    if (this.manifest?.hashes) {
      // Bootloader: on-device hash matches manifest keys directly
      if (blHash) {
        bootloaderVerified = blHash in (this.manifest.hashes.bootloader || {})
      }
      // Firmware: manifest firmware hashes are .bin file hashes (different from on-device hash).
      // Verify by checking if the device's version string appears as a known release.
      const fwVersion = this.extractVersion(features)
      if (fwVersion && fwVersion !== '0.0.0') {
        const knownVersions = Object.values(this.manifest.hashes.firmware || {})
        firmwareVerified = knownVersions.includes(`v${fwVersion}`)
      }
    }

    return { firmwareHash: fwHash, bootloaderHash: blHash, firmwareVerified, bootloaderVerified }
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
          this.clearWallet()
        }
      }

      // Try to pair via WebUSB then HID
      const result = await this.initializeWallet()

      if (result.wallet) {
        this.wallet = result.wallet
        this.attachTransportListeners()
        this.lastError = null
        try {
          // Use initialize() instead of getFeatures() — getFeatures() sends
          // GetFeatures which fails in bootloader mode with "Unknown message".
          // initialize() sends Initialize → Features and works in both modes.
          console.log('[Engine] Initializing device...')
          this.cachedFeatures = await withTimeout(
            result.wallet.initialize(),
            PAIR_TIMEOUT_MS,
            'initialize'
          )
          const hashVerification = this.verifyHashes(this.cachedFeatures)
          console.log('[Engine] Features:', JSON.stringify({
            deviceId: this.cachedFeatures?.deviceId || '(empty)',
            initialized: this.cachedFeatures?.initialized ?? '(undefined)',
            firmwareVersion: this.extractVersion(this.cachedFeatures),
            bootloaderMode: this.cachedFeatures?.bootloaderMode,
            label: this.cachedFeatures?.label || '(none)',
            firmwareHash: hashVerification.firmwareHash,
            firmwareVerified: hashVerification.firmwareVerified,
            bootloaderHash: hashVerification.bootloaderHash,
            bootloaderVerified: hashVerification.bootloaderVerified,
          }))
          // Device reconnected after firmware/bootloader flash — stop polling
          if (this.updatePhase === 'rebooting') {
            console.log('[Engine] Device reconnected after reboot, clearing reboot phase')
            this.updatePhase = 'idle'
            this.stopRebootPoll()
          }
          this.updateState(this.deriveState(this.cachedFeatures))
        } catch (err) {
          console.error('[Engine] Failed to get features after pairing:', err)
          this.clearWallet()
          this.lastError = `Failed to read device: ${err}`
          this.updateState('error')
        }
      } else if (result.usbDetected) {
        this.lastError = result.error || 'Device detected but cannot be claimed'
        console.warn(`[Engine] Device seen but not paired: ${this.lastError}`)
        this.updateState('connected_unpaired')
      } else if (this.lastState !== 'disconnected') {
        // During reboot phase, device is expected to be absent — don't emit
        // 'disconnected' which would cause unnecessary state churn in the UI.
        // The detach handler already suppresses for the USB event; this covers
        // the rebootPoll → syncState() path.
        if (this.updatePhase === 'rebooting') {
          console.log('[Engine] syncState: no device during reboot phase — suppressing disconnected')
          return
        }
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

  /**
   * Start polling syncState() every 5s while updatePhase === 'rebooting'.
   * On Windows 10, usb.on('attach') may not fire after a device reboot,
   * so this ensures the device is re-detected via periodic scanning.
   * The existing `syncing` guard prevents concurrent runs.
   */
  private rebootPollCount = 0
  private static readonly MAX_REBOOT_POLLS = 60 // 60 × 5s = 5 minutes max

  private startRebootPoll() {
    this.stopRebootPoll()
    this.rebootPollCount = 0
    console.log('[Engine] Starting reboot poll (5s interval, max 5 min)')
    this.rebootPollTimer = setInterval(() => {
      if (this.updatePhase !== 'rebooting') {
        console.log('[Engine] Reboot poll: updatePhase is no longer rebooting, stopping')
        this.stopRebootPoll()
        return
      }
      this.rebootPollCount++
      if (this.rebootPollCount >= EngineController.MAX_REBOOT_POLLS) {
        console.warn('[Engine] Reboot poll: max attempts reached (5 min), stopping')
        this.updatePhase = 'idle'
        this.stopRebootPoll()
        this.updateState('disconnected')
        return
      }
      if (this.rebootPollCount % 6 === 0) console.log(`[Engine] Reboot poll ${this.rebootPollCount}/${EngineController.MAX_REBOOT_POLLS}: calling syncState()`)
      this.syncState()
    }, 5000)
  }

  private stopRebootPoll() {
    if (this.rebootPollTimer) {
      clearInterval(this.rebootPollTimer)
      this.rebootPollTimer = null
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
    // In bootloader mode, fwVersion is actually the BL version (from extractVersion).
    // Firmware always needs flashing when device is in bootloader mode.
    const needsFw = bootloaderMode
      ? true
      : fwVersion
        ? (this.versionLessThan(fwVersion, this.latestFirmware) || fwVersion === '4.0.0')
        : false

    // Bootloader version check with hash-to-version fallback.
    // Some firmware versions don't report blVersion in features, but DO report
    // blHash. Use the manifest to resolve hash → version and avoid a false
    // "needs bootloader update" that causes an infinite update loop.
    let effectiveBlVersion = blVersion
    if (!effectiveBlVersion && bootloaderMode && fwVersion) {
      // In bootloader mode, majorVersion/minorVersion/patchVersion IS the BL version.
      // extractVersion() returns it as fwVersion — use it for comparison.
      effectiveBlVersion = fwVersion
      console.log(`[Engine] Bootloader mode: using extractVersion ${fwVersion} as BL version`)
    } else if (!effectiveBlVersion && !bootloaderMode && features) {
      const blHash = base64ToHex(features.bootloaderHash)
      if (blHash && this.manifest?.hashes?.bootloader) {
        const resolved = this.manifest.hashes.bootloader[blHash]
        if (resolved) {
          effectiveBlVersion = resolved.replace(/^v/, '')
          console.log(`[Engine] Resolved BL hash ${blHash.slice(0, 8)}… → v${effectiveBlVersion}`)
        }
      }
    }
    const needsBl = effectiveBlVersion
      ? this.versionLessThan(effectiveBlVersion, this.latestBootloader)
      : bootloaderMode

    const hashes = features ? this.verifyHashes(features) : {}

    // In bootloader mode, resolve installed firmware version from on-device hash.
    // Known official hashes → version string; unknown hash → custom firmware.
    const resolvedFwVersion = bootloaderMode
      ? resolveOndeviceFirmwareVersion(hashes.firmwareHash) ?? undefined
      : undefined
    // Firmware is "present" if the on-device hash is non-empty (not all zeros)
    const firmwarePresent = !!hashes.firmwareHash && !/^0+$/.test(hashes.firmwareHash)

    return {
      state: this.lastState,
      activeTransport: this.activeTransport,
      updatePhase: this.updatePhase,
      deviceId: features?.deviceId || undefined,
      label: features?.label || undefined,
      firmwareVersion: fwVersion,
      bootloaderVersion: effectiveBlVersion || blVersion,
      latestFirmware: this.latestFirmware,
      latestBootloader: this.latestBootloader,
      bootloaderMode,
      needsBootloaderUpdate: needsBl,
      needsFirmwareUpdate: needsFw,
      needsInit: !initialized,
      initialized,
      passphraseProtection: features?.passphraseProtection ?? false,
      // In bootloader mode the device can't report `initialized` — use firmware
      // hash presence instead. If firmware bytes exist on flash, the device has
      // been set up before and entered bootloader for an update (not OOB).
      isOob: bootloaderMode ? !firmwarePresent : fwVersion === '4.0.0',
      resolvedFwVersion,
      firmwareHash: hashes.firmwareHash,
      bootloaderHash: hashes.bootloaderHash,
      firmwareVerified: hashes.firmwareVerified,
      bootloaderVerified: hashes.bootloaderVerified,
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

      // Binary integrity check — compare downloaded file hash against manifest
      if (this.manifest?.latest?.bootloader?.hash) {
        const downloadedHash = sha256Hex(firmware)
        if (downloadedHash !== this.manifest.latest.bootloader.hash) {
          throw new Error(`Bootloader binary integrity check failed: expected ${this.manifest.latest.bootloader.hash}, got ${downloadedHash}`)
        }
        console.log('[Engine] Bootloader binary integrity verified')
      }

      this.emit('firmware-progress', { percent: 30, message: 'Erasing current firmware...' })
      await this.wallet.firmwareErase()

      this.emit('firmware-progress', { percent: 50, message: 'Uploading bootloader...' })
      await this.wallet.firmwareUpload(firmware)

      this.emit('firmware-progress', { percent: 90, message: 'Bootloader updated, rebooting...' })
      this.updatePhase = 'rebooting'
      this.clearWallet()
      this.emit('state-change', this.getDeviceState())
      this.emit('firmware-progress', { percent: 100, message: 'Bootloader update complete' })
      this.startRebootPoll()
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

      // Binary integrity check — compare downloaded file hash against manifest.
      // If the binary starts with "KPKY" magic bytes, strip the 256-byte container
      // header before hashing — the manifest hash covers only the payload.
      if (this.manifest?.latest?.firmware?.hash) {
        const hasKpkyHeader = firmware.length >= 256
          && firmware[0] === 0x4B && firmware[1] === 0x50
          && firmware[2] === 0x4B && firmware[3] === 0x59 // "KPKY"
        const hashPayload = hasKpkyHeader ? firmware.subarray(256) : firmware
        const downloadedHash = sha256Hex(hashPayload)
        if (downloadedHash !== this.manifest.latest.firmware.hash) {
          throw new Error(`Firmware binary integrity check failed: expected ${this.manifest.latest.firmware.hash}, got ${downloadedHash}`)
        }
        console.log(`[Engine] Firmware binary integrity verified${hasKpkyHeader ? ' (KPKY header stripped)' : ''}`)
      }

      this.emit('firmware-progress', { percent: 30, message: 'Erasing current firmware...' })
      await this.wallet.firmwareErase()

      this.emit('firmware-progress', { percent: 50, message: 'Uploading firmware...' })
      await this.wallet.firmwareUpload(firmware)

      this.emit('firmware-progress', { percent: 90, message: 'Firmware updated, rebooting...' })
      this.updatePhase = 'rebooting'
      this.clearWallet()
      this.emit('state-change', this.getDeviceState())
      this.emit('firmware-progress', { percent: 100, message: 'Firmware update complete' })
      this.startRebootPoll()
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

  async recoverDevice(opts: { wordCount: 12 | 18 | 24; pin: boolean; passphrase: boolean }, _retryCount = 0) {
    const MAX_WORD_RETRIES = 5

    if (_retryCount === 0) {
      if (!this.wallet) throw new Error('No device connected')
      this.setupInProgress = true
      this.pinRequestCount = 0
    }

    try {
      await this.wallet!.recover({
        entropy: WORD_COUNT_TO_ENTROPY[opts.wordCount],
        label: 'KeepKey',
        pin: opts.pin,
        passphrase: opts.passphrase,
        autoLockDelayMs: 600000, // 10 min — recovery requires extended user interaction
      })
      this.cachedFeatures = await this.wallet!.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
      this.setupInProgress = false
      this.pinRequestCount = 0
    } catch (err: any) {
      const rawMessage = extractErrorMessage(err)
      console.error('[Engine] Recovery failed:', rawMessage)

      // Word not found — firmware aborts session, but we auto-restart so user can retry
      if (rawMessage.includes('Word not found') && _retryCount < MAX_WORD_RETRIES) {
        console.log(`[Engine] Word rejected, auto-retrying recovery (attempt ${_retryCount + 1}/${MAX_WORD_RETRIES})`)
        this.emit('recovery-error', {
          message: 'Word not found in BIP39 wordlist. Restarting from word 1...',
          errorType: 'word-not-found',
          autoRetrying: true,
        })
        await new Promise(r => setTimeout(r, 2000))
        return this.recoverDevice(opts, _retryCount + 1)
      }

      // Terminal error — clean up
      this.setupInProgress = false
      this.pinRequestCount = 0

      // Classify the failure for user-friendly messaging
      let message = rawMessage
      let errorType: 'pin-mismatch' | 'invalid-mnemonic' | 'bad-words' | 'word-not-found' | 'cancelled' | 'unknown' = 'unknown'
      if (rawMessage.includes('Action cancelled') && this.pinRequestCount >= 2) {
        message = 'PINs did not match. Both entries must be identical.'
        errorType = 'pin-mismatch'
      } else if (rawMessage.includes('Action cancelled')) {
        errorType = 'cancelled'
      } else if (rawMessage.includes('Invalid mnemonic')) {
        errorType = 'invalid-mnemonic'
      } else if (rawMessage.includes('Words were not entered correctly') || rawMessage.includes('substition cipher') || rawMessage.includes('substitution cipher')) {
        errorType = 'bad-words'
      } else if (rawMessage.includes('Word not found')) {
        errorType = 'word-not-found'
      }

      this.emit('recovery-error', { message, errorType })

      // Refresh device state after failure — device may now be in needs_init or needs_pin
      try {
        this.cachedFeatures = await this.wallet!.getFeatures()
        this.updateState(this.deriveState(this.cachedFeatures))
      } catch {
        // Device may be unresponsive after failure, state will sync on next USB event
      }

      throw err
    }
  }

  async verifySeed(opts: { wordCount: 12 | 18 | 24 }, _retryCount = 0): Promise<{ success: boolean; message: string }> {
    const MAX_WORD_RETRIES = 5

    if (_retryCount === 0) {
      if (!this.wallet) throw new Error('No device connected')
      if (!this.wallet.transport) throw new Error('No transport available')
      this.setupInProgress = true
      this.pinRequestCount = 0
    }

    // hdwallet's recover() doesn't support dryRun, so we construct
    // the raw RecoveryDevice protobuf with dryRun=true and send via transport.
    // dryRun means the device verifies the seed WITHOUT modifying any state.
    const Messages = await import('@keepkey/device-protocol/lib/messages_pb')

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

      this.setupInProgress = false
      this.pinRequestCount = 0
      return { success: true, message: 'Seed verified successfully' }
    } catch (err: any) {
      const rawMessage = extractErrorMessage(err)
      console.error('[Engine] Seed verification failed:', rawMessage)

      // Word not found — firmware aborts session, but we auto-restart so user can retry
      if (rawMessage.includes('Word not found') && _retryCount < MAX_WORD_RETRIES) {
        console.log(`[Engine] Word rejected, auto-retrying verification (attempt ${_retryCount + 1}/${MAX_WORD_RETRIES})`)
        this.emit('recovery-error', {
          message: 'Word not found in BIP39 wordlist. Restarting from word 1...',
          errorType: 'word-not-found',
          autoRetrying: true,
        })
        await new Promise(r => setTimeout(r, 2000))
        return this.verifySeed(opts, _retryCount + 1)
      }

      // Terminal error — clean up
      this.setupInProgress = false
      this.pinRequestCount = 0

      let errorType: 'invalid-mnemonic' | 'bad-words' | 'word-not-found' | 'cancelled' | 'unknown' = 'unknown'
      if (rawMessage.includes('Action cancelled')) {
        errorType = 'cancelled'
      } else if (rawMessage.includes('Invalid mnemonic') || rawMessage.includes('does not match')) {
        errorType = 'invalid-mnemonic'
      } else if (rawMessage.includes('Words were not entered correctly') || rawMessage.includes('substition cipher') || rawMessage.includes('substitution cipher')) {
        errorType = 'bad-words'
      } else if (rawMessage.includes('Word not found')) {
        errorType = 'word-not-found'
      }

      this.emit('recovery-error', { message: rawMessage, errorType })
      throw err
    }
  }

  async loadDevice(opts: { mnemonic: string; pin?: string; passphrase?: boolean; label?: string }) {
    if (!this.wallet) throw new Error('No device connected')
    await (this.wallet as any).loadDevice({
      mnemonic: opts.mnemonic,
      pin: opts.pin || '',
      passphrase: opts.passphrase ?? false,
      label: opts.label || 'KeepKey',
    })
    this.cachedFeatures = await this.wallet.getFeatures()
    this.updateState(this.deriveState(this.cachedFeatures))
  }

  async applySettings(opts: { label?: string; usePassphrase?: boolean; autoLockDelayMs?: number }) {
    if (!this.wallet) throw new Error('No device connected')
    const settings: any = {}
    if (opts.label !== undefined) settings.label = opts.label
    if (opts.usePassphrase !== undefined) {
      settings.usePassphrase = opts.usePassphrase
      // Toggling passphrase changes the effective seed — clear fingerprint
      this.cachedFingerprint = null
    }
    if (opts.autoLockDelayMs !== undefined) settings.autoLockDelayMs = opts.autoLockDelayMs
    await this.wallet.applySettings(settings)
    this.cachedFeatures = await this.wallet.getFeatures()
    // Route through updateState so needs_passphrase triggers promptPin() →
    // getPublicKeys() → PASSPHRASE_REQUEST.  Previously this emitted directly,
    // so enabling passphrase from settings showed the overlay but the device
    // never received the passphrase (no pending request to respond to).
    this.updateState(this.deriveState(this.cachedFeatures))
  }

  async changePin() {
    if (!this.wallet) throw new Error('No device connected')
    this.setupInProgress = true
    this.pinRequestCount = 0
    try {
      await this.wallet.changePin()
      this.cachedFeatures = await this.wallet.getFeatures()
      this.emit('state-change', this.getDeviceState())
    } finally {
      this.setupInProgress = false
      this.pinRequestCount = 0
    }
  }

  async removePin() {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.removePin()
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
    // getPublicKeys accesses the seed → triggers PinMatrixRequest on locked device.
    // It also triggers PASSPHRASE_REQUEST if passphrase protection is enabled.
    // Both are resolved via transport event handlers (sendPin/sendPassphrase).
    // While this promise is pending, sendPin/sendPassphrase must NOT call
    // getFeatures — that would race with getPublicKeys and cause FAILURE.
    this.promptPinActive = true
    const promise = this.wallet.getPublicKeys([{
      addressNList: [0x8000002C, 0x80000000, 0x80000000], // m/44'/0'/0'
      curve: 'secp256k1',
      showDisplay: false,
      coin: 'Bitcoin',
    }])
    try {
      await promise
      // getPublicKeys completed — PIN (and passphrase if needed) were provided.
      // Now it's safe to refresh features.
      this.cachedFeatures = await this.wallet.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
      return { status: 'unlocked', message: 'Device already unlocked' }
    } catch (err: any) {
      // PIN/passphrase flow interruption is expected — the UI handles input
      throw err
    } finally {
      this.promptPinActive = false
    }
  }

  async sendPin(pin: string) {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.sendPin(pin)
    // Don't call getFeatures if another operation owns the transport:
    // - setupInProgress: reset/recover is still running
    // - promptPinActive: getPublicKeys is still pending (may also need passphrase)
    // Both will refresh features themselves when they complete.
    if (!this.setupInProgress && !this.promptPinActive) {
      this.cachedFeatures = await this.wallet.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
    }
  }

  async sendPassphrase(passphrase: string) {
    if (!this.wallet) throw new Error('No device connected')
    // Passphrase changes the effective seed — clear fingerprint so it's re-derived
    this.cachedFingerprint = null
    await this.wallet.sendPassphrase(passphrase)
    // Don't call getFeatures if promptPin's getPublicKeys is still pending —
    // it owns the transport and will refresh features when it completes.
    if (!this.promptPinActive) {
      this.cachedFeatures = await this.wallet.getFeatures()
      this.updateState(this.deriveState(this.cachedFeatures))
    }
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

  // ── Custom Firmware Flash (Drag & Drop) ──────────────────────────────

  /**
   * Analyze a firmware binary to determine signed/unsigned status,
   * version info, and compare with the currently-installed firmware.
   */
  analyzeFirmware(data: Buffer): {
    isSigned: boolean
    hasKpkyHeader: boolean
    detectedVersion: string | null
    payloadHash: string
    fileSize: number
    isBootloaderMode: boolean
    currentFirmwareVersion: string | null
    deviceBootloaderVersion: string | null
    currentFirmwareVerified: boolean | undefined
    isDowngrade: boolean
    isSameVersion: boolean
    willWipeDevice: boolean
  } {
    const fileSize = data.length
    const hasKpkyHeader = data.length >= 256
      && data[0] === 0x4B && data[1] === 0x50
      && data[2] === 0x4B && data[3] === 0x59 // "KPKY"

    // Hash the payload (skip 256-byte header for KPKY firmware, full file for bootloaders)
    const payload = hasKpkyHeader ? data.subarray(256) : data
    const payloadHash = sha256Hex(payload)

    // Signed detection: KPKY header sigindex bytes at offsets 8-10.
    // sigindex1 > 0 means at least one signature slot is filled → signed.
    let headerSigned = false
    if (hasKpkyHeader) {
      headerSigned = data[8] !== 0 || data[9] !== 0 || data[10] !== 0
    }

    // Manifest lookup — provides version AND confirms official release
    let manifestSigned = false
    let manifestVersion: string | null = null

    if (this.manifest?.hashes) {
      const fwVersion = this.manifest.hashes.firmware?.[payloadHash]
      if (fwVersion) {
        manifestSigned = true
        manifestVersion = fwVersion.replace(/^v/, '')
      } else {
        // Also check full-file hash (bootloader format)
        const fullHash = sha256Hex(data)
        const blVersion = this.manifest.hashes.bootloader?.[fullHash]
        if (blVersion) {
          manifestSigned = true
          manifestVersion = blVersion.replace(/^v/, '')
        }
      }
    }

    // Combined: signed if header has signatures OR manifest recognizes the hash
    const isSigned = headerSigned || manifestSigned

    // Version detection: manifest version is authoritative.
    // Fallback: scan binary for "VERSION" marker followed by semver pattern.
    // KeepKey firmware embeds "VERSION7.10.0" (no space) as a string constant.
    let detectedVersion = manifestVersion
    if (!detectedVersion) {
      const versionPattern = /VERSION(\d+\.\d+\.\d+)/
      // Search in the payload as a string (ASCII-safe scan)
      const asStr = payload.toString('ascii')
      const match = asStr.match(versionPattern)
      if (match) {
        detectedVersion = match[1]
      }
    }

    // Device state — distinguish bootloader mode from firmware mode
    const isBootloaderMode = this.cachedFeatures?.bootloaderMode === true
    // Use resolved BL version (hash→version from manifest) when raw features lack it
    const deviceBootloaderVersion = this.getDeviceState().bootloaderVersion || this.cachedFeatures?.bootloaderVersion || null

    // In bootloader mode, extractVersion() returns the BL version (not FW).
    // The pre-existing firmware version is not available in bootloader mode.
    let currentFirmwareVersion: string | null = null
    if (this.cachedFeatures && !isBootloaderMode) {
      currentFirmwareVersion = this.extractVersion(this.cachedFeatures)
      if (currentFirmwareVersion === '0.0.0') currentFirmwareVersion = null
    }

    const currentFirmwareVerified = this.cachedFeatures && !isBootloaderMode
      ? this.verifyHashes(this.cachedFeatures).firmwareVerified : undefined

    // Version comparison (only meaningful when we know both versions)
    let isDowngrade = false
    let isSameVersion = false
    if (detectedVersion && currentFirmwareVersion) {
      isSameVersion = detectedVersion === currentFirmwareVersion
      isDowngrade = this.versionLessThan(detectedVersion, currentFirmwareVersion)
    }

    // Crossing the signed/unsigned boundary in EITHER direction wipes the device.
    // In bootloader mode we can't know the previous firmware state, so we can't determine this.
    const willWipeDevice = !isBootloaderMode && (
      (!isSigned && currentFirmwareVerified === true) ||   // signed → unsigned
      (isSigned && currentFirmwareVerified === false)      // unsigned → signed
    )

    return {
      isSigned,
      hasKpkyHeader,
      detectedVersion,
      payloadHash,
      fileSize,
      isBootloaderMode,
      currentFirmwareVersion,
      deviceBootloaderVersion,
      currentFirmwareVerified,
      isDowngrade,
      isSameVersion,
      willWipeDevice,
    }
  }

  // ── Wallet Fingerprint (0th BTC address — identifies seed+passphrase) ───

  private cachedFingerprint: string | null = null

  async getWalletFingerprint(): Promise<string> {
    if (this.cachedFingerprint) return this.cachedFingerprint
    if (!this.wallet) throw new Error('No device connected')
    const result = await (this.wallet as any).btcGetAddress({
      addressNList: [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0, 0, 0],
      coin: 'Bitcoin',
      scriptType: 'p2pkh',
      showDisplay: false,
    })
    // btcGetAddress returns string in some adapters, {address} in others
    const address = typeof result === 'string' ? result : result?.address
    if (!address) throw new Error('Failed to derive fingerprint address')
    this.cachedFingerprint = address
    return address
  }

  // ── BIP-85 Derived Seeds ────────────────────────────────────────────────

  async getBip85Mnemonic(opts: Bip85DeriveParams): Promise<Bip85DisplayResult> {
    if (!this.wallet) throw new Error('No device connected')
    if (![12, 18, 24].includes(opts.wordCount))
      throw new Error('wordCount must be 12, 18, or 24')
    if (!Number.isInteger(opts.index) || opts.index < 0 || opts.index > 2147483647)
      throw new Error('Index must be 0–2147483647')

    await (this.wallet as any).bip85GetMnemonic({
      wordCount: opts.wordCount,
      index: opts.index,
    })

    // Seed is displayed on device screen only — never returned over USB
    return {
      displayed: true,
      wordCount: opts.wordCount,
      index: opts.index,
      derivationPath: `m/83696968'/39'/0'/${opts.wordCount}'/${opts.index}'`,
    }
  }

  /**
   * Flash a custom firmware binary (from drag & drop).
   * The binary is sent as raw Buffer data from the frontend.
   */
  async flashCustomFirmware(data: Buffer) {
    if (!this.wallet) throw new Error('No device connected')
    this.updatePhase = 'flashing'
    this.emit('state-change', this.getDeviceState())
    this.emit('firmware-progress', { percent: 0, message: 'Preparing custom firmware...' })

    try {
      this.emit('firmware-progress', { percent: 20, message: 'Erasing current firmware...' })
      await this.wallet.firmwareErase()

      this.emit('firmware-progress', { percent: 50, message: 'Uploading firmware...' })
      await this.wallet.firmwareUpload(data)

      this.emit('firmware-progress', { percent: 90, message: 'Firmware uploaded, rebooting...' })
      this.updatePhase = 'rebooting'
      this.clearWallet()
      this.emit('state-change', this.getDeviceState())
      this.emit('firmware-progress', { percent: 100, message: 'Custom firmware flash complete' })
      this.startRebootPoll()
    } catch (err: any) {
      this.updatePhase = 'idle'
      this.emit('state-change', this.getDeviceState())
      throw err
    }
  }
}
