# KISS Onboarding Plan: KeepKey Vault v11

## Architecture Overview

### What v10 Does (Tauri)
- Rust backend communicates with KeepKey via custom USB crate
- REST API on port 1646 serves device state, firmware operations, wallet init
- Tauri events bridge Rust → React for instant device connect/disconnect
- Frontend polls REST every 500ms for health + uses Tauri events for instant updates
- 5-phase state machine: splash → onboarding tutorial → device-action → loading → vault

### What v11 Will Do (Electrobun + hdwallet)
- **Bun main process** uses BOTH `@keepkey/hdwallet-keepkey-nodehid` AND `@keepkey/hdwallet-keepkey-nodewebusb` for device communication
- **Engine Controller** manages transport lifecycle and switching between HID ↔ WebUSB
- **Electrobun typed RPC** (`electrobun/bun` + `electrobun/view`) replaces both REST polling and Tauri events
- **No REST API** needed for internal UI communication (REST server added later for external apps)
- **3-phase state machine**: splash/detect → setup wizard → ready

### Key Simplification
v10 had 5 phases because it waited for: backend HTTP, tutorial state, device state, frontload services, Pioneer API, portfolio sync, cache warming. v11 eliminates all of that — the Bun process IS the backend, and there's no portfolio/pioneer/cache to wait for.

### Dual-Transport Architecture (Critical)

KeepKey devices use **different USB transports depending on mode**:

| Device Mode | PID | Transport | hdwallet Package |
|-------------|-----|-----------|-----------------|
| Normal (firmware running) | 0x0002 | WebUSB (bulk endpoints) | `@keepkey/hdwallet-keepkey-nodewebusb` |
| Bootloader (firmware update) | 0x0001 | HID | `@keepkey/hdwallet-keepkey-nodehid` |
| Legacy devices | 0x0001 | HID | `@keepkey/hdwallet-keepkey-nodehid` |
| Fallback (OS blocks USB) | any | HID | `@keepkey/hdwallet-keepkey-nodehid` |

**The Engine Controller must handle the full lifecycle:**
```
1. ENUMERATE: Try both HID and WebUSB adapters to find devices
2. IDENTIFY: Check PID to determine transport type
3. CONNECT: Use appropriate adapter (NodeWebUSB or NodeHID)
4. OPERATE: Normal wallet operations via WebUSB
5. FIRMWARE UPDATE CYCLE:
   a. Device in normal mode (WebUSB) → send "enter bootloader" command
   b. Device disconnects from WebUSB
   c. Device reconnects as HID (PID 0x0001, bootloader mode)
   d. Engine Controller detects reconnection via HID enumeration
   e. Flash firmware/bootloader via HID transport
   f. Device reboots, disconnects from HID
   g. Device reconnects as WebUSB (PID 0x0002, normal mode)
   h. Engine Controller detects reconnection via WebUSB enumeration
   i. Resume normal operations
```

This transport switching is the **most critical part of the engine controller** — it must gracefully handle the disconnect/reconnect cycle during firmware updates without losing state or confusing the UI.

---

## Phase 1: Copy Visual Assets from v10

### Assets to Copy
```
v10: projects/vault/src/assets/splash-bg.png    → v11: src/mainview/assets/splash-bg.png
v10: projects/vault/src/assets/icon.png         → v11: src/mainview/assets/icon.png
v10: projects/vault/src/assets/svg/             → v11: src/mainview/assets/svg/
  - connect-keepkey.svg
  - hold-and-release.svg
  - hold-and-connect.svg
v10: projects/vault/src/assets/onboarding/      → v11: src/mainview/assets/onboarding/
  - cipher.png
```

### UI Components to Port (adapt to v11 patterns)
1. **KeepKeyUILogo** (`logo/keepkey-ui.tsx`) — SVG logo component (57 lines, pure SVG)
2. **Logo** (`logo/logo.tsx`) — Logo wrapper with gold border, floating animation, hover effects
3. **EllipsisDots** (`util/EllipsisSpinner.tsx`) — Animated "..." loading indicator
4. **SplashScreen** — Full-viewport splash with background image, centered logo, status bar at bottom

All of these are pure React + Chakra components with zero backend dependency. Direct port.

---

## Phase 2: Engine Controller & Device State Engine (Bun Main Process)

### Dependencies to Install
```
@keepkey/hdwallet-core
@keepkey/hdwallet-keepkey
@keepkey/hdwallet-keepkey-nodehid      # HID transport (bootloader, fallback, legacy)
@keepkey/hdwallet-keepkey-nodewebusb   # WebUSB transport (normal mode, modern firmware)
node-hid                               # Native HID bindings
usb                                    # Native USB bindings (for nodewebusb)
```

Note: Both `node-hid` and `usb` have native bindings. Bun has Node.js compatibility but native addons need verification. If either fails in Bun:
- **Fallback**: Use `@keepkey/hdwallet-keepkey-tcp` pointing at a small keepkey-usb Rust binary that handles raw transport
- This is actually what keepkey-desktop does in some configurations

### Engine Controller (`src/bun/engine-controller.ts`)

The engine controller is the **central orchestrator** that manages dual-transport device lifecycle:

```typescript
class EngineController extends EventEmitter {
  // Both adapters — always available
  private hidAdapter: HIDKeepKeyAdapter
  private webUsbAdapter: WebUSBKeepKeyAdapter

  // Current active wallet (connected via whichever transport works)
  private wallet: KeepKeyHDWallet | null = null
  private activeTransport: 'hid' | 'webusb' | null = null

  // State
  state: DeviceState = 'disconnected'
  features: Features | null = null
  private pollTimer: Timer | null = null

  // Transport-aware operations
  private updatePhase: 'idle' | 'entering_bootloader' | 'flashing' | 'rebooting' = 'idle'

  // Start polling for device connection (every 2s)
  // Polls BOTH HID and WebUSB adapters
  startPolling(): void {
    this.pollTimer = setInterval(async () => {
      await this.detectDevice()
    }, 2000)
  }

  // Dual-transport device detection
  private async detectDevice(): Promise<void> {
    // 1. Try WebUSB first (normal mode, PID 0x0002)
    const webUsbDevices = await this.webUsbAdapter.getDevices()
    if (webUsbDevices.length > 0) {
      await this.connectVia('webusb', webUsbDevices[0])
      return
    }

    // 2. Try HID (bootloader mode PID 0x0001, or fallback)
    const hidDevices = await this.hidAdapter.getDevices()
    if (hidDevices.length > 0) {
      await this.connectVia('hid', hidDevices[0])
      return
    }

    // 3. No device found
    if (this.state !== 'disconnected') {
      this.state = 'disconnected'
      this.wallet = null
      this.activeTransport = null
      this.emit('state-change', this.getDeviceState())
    }
  }

  // Connect via specific transport
  private async connectVia(transport: 'hid' | 'webusb', device: any): Promise<void> {
    // Skip if already connected via this transport
    if (this.activeTransport === transport && this.wallet) return

    const adapter = transport === 'hid' ? this.hidAdapter : this.webUsbAdapter
    this.wallet = await adapter.pairDevice(device)
    this.activeTransport = transport
    this.features = await this.wallet.getFeatures()
    this.deriveState()
    this.emit('state-change', this.getDeviceState())
  }

  // Derive device state from features
  private deriveState(): void {
    if (!this.features) { this.state = 'disconnected'; return }
    if (this.features.bootloaderMode) { this.state = 'bootloader'; return }
    // Check firmware version against known latest...
    if (!this.features.initialized) { this.state = 'needs_init'; return }
    if (this.features.pinProtection && !this.features.pinCached) { this.state = 'needs_pin'; return }
    if (this.features.passphraseProtection && !this.features.passphraseCached) { this.state = 'needs_passphrase'; return }
    this.state = 'ready'
  }

  // === FIRMWARE UPDATE FLOW (transport switching) ===

  async startBootloaderUpdate(): Promise<void> {
    this.updatePhase = 'entering_bootloader'
    this.emit('firmware-progress', { percent: 0, message: 'Waiting for device in bootloader mode...' })

    // If device is already in bootloader (connected via HID), flash directly
    if (this.activeTransport === 'hid' && this.features?.bootloaderMode) {
      await this.flashFirmware()
      return
    }

    // Otherwise, user must physically enter bootloader:
    // 1. Unplug device
    // 2. Hold button + plug in
    // 3. Device reconnects as HID with PID 0x0001
    // The polling loop in detectDevice() will pick it up via HID adapter
    // When it does, and bootloaderMode=true, the UI triggers the actual flash
  }

  async flashFirmware(): Promise<void> {
    if (!this.wallet || this.activeTransport !== 'hid') {
      throw new Error('Device must be in bootloader mode (HID) to flash firmware')
    }

    this.updatePhase = 'flashing'
    this.emit('firmware-progress', { percent: 10, message: 'Erasing firmware...' })
    await this.wallet.firmwareErase()

    this.emit('firmware-progress', { percent: 30, message: 'Uploading firmware...' })
    const firmware = await this.loadFirmwareBinary()
    await this.wallet.firmwareUpload(firmware)

    this.emit('firmware-progress', { percent: 90, message: 'Rebooting device...' })
    this.updatePhase = 'rebooting'

    // Device will disconnect from HID, reboot, reconnect as WebUSB
    // detectDevice() polling will pick up the reconnection
    this.wallet = null
    this.activeTransport = null

    // Wait for reconnection (polling will handle it)
    // UI shows "rebooting..." until state changes
  }

  // Device operations (delegated to active wallet)
  async resetDevice(opts: ResetDeviceOpts): Promise<void> {
    if (!this.wallet) throw new Error('No device connected')
    await this.wallet.reset(opts)
    this.features = await this.wallet.getFeatures()
    this.deriveState()
    this.emit('state-change', this.getDeviceState())
  }

  async recoverDevice(opts: RecoverDeviceOpts): Promise<void> { /* same pattern */ }
  async applySettings(settings: ApplySettingsOpts): Promise<void> { /* same pattern */ }
  async sendPin(pin: string): Promise<void> { /* same pattern */ }
  async sendPassphrase(passphrase: string): Promise<void> { /* same pattern */ }

  getDeviceState(): DeviceStateInfo {
    return {
      state: this.state,
      activeTransport: this.activeTransport,
      updatePhase: this.updatePhase,
      deviceId: this.features?.deviceId,
      label: this.features?.label,
      firmwareVersion: /* from features */,
      bootloaderMode: this.features?.bootloaderMode ?? false,
      needsBootloaderUpdate: /* compare versions */,
      needsFirmwareUpdate: /* compare versions */,
      needsInit: !this.features?.initialized,
      initialized: this.features?.initialized ?? false,
      isOob: /* firmwareVersion === '4.0.0' */,
    }
  }
}
```

### Device State Machine
```
DISCONNECTED
  ↓ (device found via WebUSB or HID enumeration)
CONNECTED → identify transport:
  ├─ Via WebUSB (PID 0x0002, normal mode)
  │   ↓ getFeatures()
  │   ├─ NEEDS_FIRMWARE → user triggers update → device enters bootloader
  │   │   ↓ device disconnects from WebUSB
  │   │   ↓ device reconnects as HID (PID 0x0001)
  │   │   ↓ Engine Controller detects via HID adapter
  │   │   ↓ BOOTLOADER state
  │   │   ↓ flash firmware via HID
  │   │   ↓ device reboots, disconnects from HID
  │   │   ↓ device reconnects as WebUSB (PID 0x0002)
  │   │   ↓ Engine Controller detects via WebUSB adapter
  │   │   └─ back to normal flow
  │   ├─ NEEDS_INIT (initialized=false) → wallet creation/recovery
  │   ├─ NEEDS_PIN → PIN entry
  │   ├─ NEEDS_PASSPHRASE → passphrase entry
  │   └─ READY → show main app
  │
  └─ Via HID (PID 0x0001, bootloader mode or legacy)
      ↓ getFeatures()
      ├─ BOOTLOADER (bootloader_mode=true)
      │   ↓ flash bootloader/firmware
      │   ↓ device reboots → reconnects as WebUSB
      │   └─ back to normal flow
      └─ LEGACY DEVICE → operate via HID only
```

### Firmware/Bootloader Binaries
Need to bundle or fetch firmware binaries. Options:
- **Bundle**: Include latest firmware/bootloader `.bin` files in the app bundle
- **Fetch**: Download from GitHub releases on demand
- **Recommended**: Bundle the latest known-good versions, with option to check for newer

---

## Phase 3: Electrobun RPC Bridge

### How Electrobun RPC Works
Electrobun provides typed RPC between the Bun main process and WebView:
- **Bun side**: Import from `electrobun/bun` — expose handlers
- **View side**: Import from `electrobun/view` — call handlers

### RPC Schema (`src/shared/types.ts`)

```typescript
// Commands: WebView → Bun
interface DeviceCommands {
  getDeviceState(): DeviceStateInfo
  startBootloaderUpdate(): void
  startFirmwareUpdate(): void
  resetDevice(opts: { wordCount: 12|18|24, pin: boolean, passphrase: boolean }): void
  recoverDevice(opts: { wordCount: 12|18|24, pin: boolean, passphrase: boolean }): void
  applySettings(opts: { label?: string }): void
  sendPin(pin: string): void
  sendPassphrase(passphrase: string): void
}

// Events: Bun → WebView
interface DeviceEvents {
  'device-state': DeviceStateInfo
  'firmware-progress': { percent: number, message: string }
}

// Shared types
type DeviceState = 'disconnected' | 'bootloader' | 'needs_firmware' | 'needs_init' | 'needs_pin' | 'needs_passphrase' | 'ready'

interface DeviceStateInfo {
  state: DeviceState
  deviceId?: string
  label?: string
  firmwareVersion?: string
  bootloaderVersion?: string
  latestFirmware?: string
  latestBootloader?: string
  needsBootloaderUpdate: boolean
  needsFirmwareUpdate: boolean
  needsInit: boolean
  initialized: boolean
  isOob: boolean  // factory firmware (v4.0.0)
}
```

### RPC Registration (Bun side - `src/bun/index.ts`)
```typescript
import { BrowserWindow, RPC } from 'electrobun/bun'
import { DeviceManager } from './device-manager'

const dm = new DeviceManager()
dm.startPolling()

// Register RPC handlers
RPC.handle('getDeviceState', () => dm.getDeviceState())
RPC.handle('startBootloaderUpdate', () => dm.startBootloaderUpdate())
// ...etc

// Push events to WebView
dm.on('state-change', (state) => mainWindow.send('device-state', state))
dm.on('firmware-progress', (progress) => mainWindow.send('firmware-progress', progress))
```

### RPC Usage (View side - hooks)
```typescript
import { RPC } from 'electrobun/view'

// In useDeviceState hook:
const state = await RPC.call('getDeviceState')

// Listen for events:
RPC.on('device-state', (state) => setDeviceState(state))
```

**NOTE**: Electrobun's exact RPC API needs to be verified against their docs/source. The above is the expected pattern based on their documentation. If the API differs, adapt accordingly — the conceptual flow remains the same.

---

## Phase 4: Frontend Hooks (Replaces v10's 4 Hooks with 2)

### `useDeviceState()` — Single Source of Truth
Replaces: `useBackendHealth` + `useDeviceEvents` + `useDeviceStatus`

```typescript
function useDeviceState() {
  const [state, setState] = useState<DeviceStateInfo>(INITIAL_STATE)

  useEffect(() => {
    // Listen for state pushes from Bun process
    const unsub = RPC.on('device-state', setState)
    // Also fetch initial state
    RPC.call('getDeviceState').then(setState)
    return unsub
  }, [])

  return state
}
```

### `useFirmwareUpdate()` — Update Lifecycle
Simplified from v10 (no REST polling, no Tauri events, just RPC):

```typescript
function useFirmwareUpdate() {
  const [updateState, setUpdateState] = useState<'idle'|'updating'|'complete'|'error'>('idle')
  const [progress, setProgress] = useState<{percent: number, message: string} | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return RPC.on('firmware-progress', setProgress)
  }, [])

  const startBootloaderUpdate = async () => {
    setUpdateState('updating')
    try {
      await RPC.call('startBootloaderUpdate')
      setUpdateState('complete')
    } catch (e) {
      setError(e.message)
      setUpdateState('error')
    }
  }

  const startFirmwareUpdate = async () => { /* same pattern */ }
  const reset = () => { setUpdateState('idle'); setProgress(null); setError(null) }

  return { updateState, progress, error, startBootloaderUpdate, startFirmwareUpdate, reset }
}
```

---

## Phase 5: Onboarding UI (Port from v10)

### App.tsx — 3-Phase State Machine

```
Phase 1: SPLASH
  Condition: deviceState.state === 'disconnected'
  Shows: SplashScreen with "Searching for KeepKey..." message

Phase 2: SETUP
  Condition: deviceState needs bootloader/firmware/init
  Shows: OobSetupWizard (ported from v10)

Phase 3: READY
  Condition: deviceState.state === 'ready'
  Shows: Existing Dashboard with Header/Sidebar/StatusBar
```

No tutorial phase, no loading phase, no frontload phase. KISS.

### OobSetupWizard — Direct Port with RPC

Same 7-step wizard from v10, same visual design:

| Step | Visual | Action |
|------|--------|--------|
| welcome | Pulsing wallet icon, "Welcome to KeepKey" | Auto-advance after device status loads |
| bootloader | Warning icon, version comparison card, instructions | RPC: `startBootloaderUpdate()` |
| firmware | Download icon, version comparison, progress | RPC: `startFirmwareUpdate()` |
| init-choose | Two cards: Create New / Recover Existing | RPC: `resetDevice()` or `recoverDevice()` |
| init-progress | Spinner, "Follow device screen" message | Wait for device response |
| init-label | Check icon, text input for device name | RPC: `applySettings({label})` |
| complete | Confetti animation, success message | Auto-dismiss to ready state |

**Changes from v10:**
- Replace `fetch(API_BASE_URL/...)` calls → `RPC.call(...)`
- Replace `useDeviceEvents()` Tauri events → `useDeviceState()` RPC events
- Replace `useDeviceStatus()` REST polling → included in `useDeviceState()`
- Remove `useFirmwareUpdate`'s REST-based progress polling → RPC events
- Keep all visual design: animations, colors, layout, confetti, progress bar

### Visual Design Tokens (Keep v10's Design Language)

The v10 design uses:
- Background: `gray.900` (outer), `gray.800` (card)
- Accent: `orange.500` (#F59E0B) — primary actions, highlights
- Success: `green.500` (#10b981) — completed steps, success states
- Warning: `yellow.600` / `yellow.300` — bootloader warnings
- Error: `red.900` background with `red.600` border — error states
- Text: `white` (primary), `gray.400` (secondary), `gray.300` (instructions)
- Card: `gray.700` background with `lg` border radius
- Progress bar: 4px `gray.700` track, `green.500`/`orange.500` fill

v11's existing theme uses `kk.*` tokens (black/gold). For onboarding, we should use the v10 colors for the wizard (gray/orange/green feels more welcoming) and transition to the black/gold theme for the main app. OR unify them — the user should decide.

---

## Phase 6: PIN Entry (Needed for Returning Users)

When a device is already initialized but locked, the state machine hits `needs_pin`. Need a PIN entry component:

- Port v10's concept but implement as a simple numeric grid
- KeepKey uses a "scrambled" 3x3 grid — numbers displayed on the device screen, user clicks positions on the app
- RPC: `sendPin(pin)` sends the position-encoded PIN string
- Same pattern for passphrase: text input → `sendPassphrase(passphrase)`

---

## Implementation Order

### Step 1: Assets & Pure UI Components (no backend needed)
- [ ] Copy image/SVG assets from v10
- [ ] Port KeepKeyUILogo, Logo, EllipsisDots components
- [ ] Port SplashScreen component (using splash-bg.png)
- [ ] Verify they render in v11's Chakra 3.0 setup

### Step 2: Engine Controller (Bun process — dual transport)
- [ ] Install hdwallet dependencies (`hdwallet-keepkey-nodehid` + `hdwallet-keepkey-nodewebusb`)
- [ ] Verify `node-hid` AND `usb` native bindings work in Bun runtime
- [ ] Create EngineController class with BOTH HID and WebUSB adapters
- [ ] Implement dual-transport device enumeration polling (try WebUSB first, then HID)
- [ ] Implement transport-aware connection (connect via whichever adapter finds device)
- [ ] Implement getFeatures, state derivation from features
- [ ] Implement firmware update flow WITH transport switching:
  - Flash via HID when device is in bootloader mode
  - Handle disconnect/reconnect cycle (HID → reboot → WebUSB)
  - Track updatePhase to keep UI informed during transition
- [ ] Implement resetDevice, recoverDevice, applySettings
- [ ] Implement sendPin, sendPassphrase

### Step 3: Electrobun RPC Bridge
- [ ] Define shared types in `src/shared/types.ts`
- [ ] Register RPC handlers in `src/bun/index.ts`
- [ ] Set up event pushing from DeviceManager to WebView
- [ ] Verify RPC works between Bun process and WebView

### Step 4: Frontend Hooks
- [ ] Create `useDeviceState()` hook (RPC-based)
- [ ] Create `useFirmwareUpdate()` hook (RPC-based)
- [ ] Test hooks with real device connection

### Step 5: Onboarding Wizard
- [ ] Port OobSetupWizard from v10 (replace REST → RPC)
- [ ] Update App.tsx with 3-phase state machine
- [ ] Remove or defer the existing router/dashboard (it becomes Phase 3: READY)
- [ ] Test full flow: disconnected → connect → bootloader → firmware → init → ready

### Step 6: PIN/Passphrase Entry
- [ ] Create PinEntry component (3x3 grid)
- [ ] Create PassphraseEntry component (text input)
- [ ] Wire up to RPC handlers
- [ ] Test with locked device

---

## Risk Assessment

### High Risk: Native Addons in Bun (`node-hid` + `usb`)
Both transports require C++ native addons. Bun's Node.js compatibility may not fully support them:
- `node-hid` — needed for HID transport (bootloader mode, fallback)
- `usb` — needed for WebUSB transport (normal mode)
- **Fallback**: Use `@keepkey/hdwallet-keepkey-tcp` pointing at a small keepkey-usb Rust binary that handles raw USB/HID transport. The Bun process would communicate with the Rust binary via HTTP, and the Rust binary handles the actual USB. This is the same pattern keepkey-desktop uses in some configurations.
- **Validation step**: Before any other work, verify both native addons load in Bun. If they don't, pivot to the TCP transport fallback immediately.

### Medium Risk: Electrobun RPC API
The exact Electrobun RPC API hasn't been verified against their source. The current v11 scaffold doesn't use it. Need to:
- Read Electrobun's actual RPC documentation/source
- If RPC doesn't support event pushing, use a polling model from the WebView (call `getDeviceState()` every 1-2 seconds)

### Low Risk: Firmware Binary Bundling
Need to figure out where firmware binaries come from. Options:
- Bundle in the app (simplest, but requires app update for new firmware)
- Fetch from GitHub releases (requires network, but always latest)
- Start with bundled, add fetch-latest later

### Low Risk: Chakra Color Alignment
v10 uses `orange.500` / `gray.*` scheme, v11 uses `kk.*` black/gold scheme. Need to decide:
- Keep v10 colors for onboarding (warmer, more welcoming)
- Or adapt to v11's black/gold (more consistent)
- Recommendation: Use v10's gray/orange for the wizard, transition to black/gold for main app

---

## What We're NOT Building (KISS)

- No REST API server (deferred — external apps only)
- No Pioneer API integration
- No portfolio/balance tracking
- No frontload service
- No cache warming
- No tutorial/onboarding wizard (the 5-step educational thing from v10 — just the setup wizard)
- No DeviceUpdateManager (background update checks — just do it during onboarding)
- No settings dialog (deferred)
- No Apps page (deferred)
- No VaultWebview (deferred — the main app after onboarding is just the existing dashboard)

The goal is: **Connect KeepKey → Update if needed → Initialize → Ready**. That's it.
