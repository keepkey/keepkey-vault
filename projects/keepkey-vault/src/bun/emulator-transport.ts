/**
 * Emulator Transport — bridges FFI emuRead/emuWrite into hdwallet's
 * TransportDelegate interface so the engine can treat the emulator
 * exactly like a physical KeepKey device.
 *
 * Architecture:
 *   emulator.ts (FFI) → emuWrite / emuRead
 *       ↕
 *   EmulatorTransportDelegate (this file) — implements TransportDelegate
 *       ↕
 *   hdwallet Transport → KeepKeyHDWallet → engine-controller
 */
import { Adapter, type TransportDelegate, type AdapterDelegate } from '@keepkey/hdwallet-keepkey'
import { emuWrite, emuRead, getEmulatorStatus } from './emulator'

const TAG = '[emu-transport]'

// Poll interval for non-blocking emuRead (ms)
const READ_POLL_MS = 5
// Default read timeout (2 minutes — matches hdwallet DEFAULT_TIMEOUT)
const READ_TIMEOUT_MS = 120_000

export class EmulatorTransportDelegate implements TransportDelegate {
  private connected = false

  constructor(private deviceId: string = 'emulator-default') {}

  async isOpened(): Promise<boolean> {
    return this.connected
  }

  async getDeviceID(): Promise<string> {
    return this.deviceId
  }

  async connect(): Promise<void> {
    const status = getEmulatorStatus()
    if (status.state !== 'running') {
      throw new Error('Emulator is not running — call initEmulator() first')
    }
    this.connected = true
    console.log(`${TAG} Connected (device: ${this.deviceId})`)
  }

  async tryConnectDebugLink(): Promise<boolean> {
    // Debug link on interface 1 — emulator supports it natively
    console.log(`${TAG} Debug link enabled (interface 1)`)
    return true
  }

  async disconnect(): Promise<void> {
    this.connected = false
    console.log(`${TAG} Disconnected`)
  }

  async writeChunk(buf: Uint8Array, debugLink?: boolean): Promise<void> {
    const iface = debugLink ? 1 : 0
    const hdr = Array.from(buf.slice(0, 9)).map(b => b.toString(16).padStart(2, '0')).join(' ')
    console.log(`${TAG} writeChunk iface=${iface} len=${buf.length} hdr=[${hdr}]`)
    const ok = emuWrite(buf, iface)
    if (!ok) {
      throw new Error(`${TAG} emuWrite failed (iface=${iface}, len=${buf.length})`)
    }

    // NOTE: Pre-write confirmations are handled by emuConfirmOp() in the RPC
    // handlers, NOT here. This ensures all chunks are written before pre-writing.
  }

  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const iface = debugLink ? 1 : 0
    const deadline = Date.now() + READ_TIMEOUT_MS
    let pollCount = 0

    while (Date.now() < deadline) {
      const data = emuRead(iface)
      if (data) {
        const hdr = Array.from(data.slice(0, 9)).map(b => b.toString(16).padStart(2, '0')).join(' ')
        console.log(`${TAG} readChunk iface=${iface} got ${data.length}b after ${pollCount} polls hdr=[${hdr}]`)
        return data
      }
      pollCount++
      if (pollCount === 1 || pollCount % 200 === 0) {
        console.log(`${TAG} readChunk iface=${iface} polling... (${pollCount})`)
      }
      // Non-blocking read returned nothing — yield then retry
      await new Promise(r => setTimeout(r, READ_POLL_MS))
    }

    throw new Error(`${TAG} Read timeout after ${READ_TIMEOUT_MS}ms (iface=${iface}, polls=${pollCount})`)
  }
}

// ── Adapter (factory for engine-controller) ────────────────────────────

export type EmulatorDevice = { serialNumber: string }

const EmulatorAdapterDelegate: AdapterDelegate<EmulatorDevice> = {
  async inspectDevice(device: EmulatorDevice) {
    return {
      productName: 'KeepKey Emulator',
      serialNumber: device.serialNumber,
    }
  },

  async getDevice(serialNumber?: string): Promise<EmulatorDevice> {
    return { serialNumber: serialNumber || 'emulator-default' }
  },

  async getDevices(): Promise<EmulatorDevice[]> {
    const status = getEmulatorStatus()
    if (status.state === 'running') {
      return [{ serialNumber: 'emulator-default' }]
    }
    return []
  },

  async getTransportDelegate(device: EmulatorDevice) {
    return new EmulatorTransportDelegate(device.serialNumber)
  },
}

export const EmulatorKeepKeyAdapter = Adapter.fromDelegate(EmulatorAdapterDelegate)

// ── Raw DebugLinkDecision (bypasses hdwallet transport) ─────────────────
//
// The firmware's confirm_helper() requires BOTH:
//   1. ButtonAck on interface 0 (sent by hdwallet Transport automatically)
//   2. DebugLinkDecision on interface 1 (sent here)
//
// We write the raw HID frame directly via FFI because going through
// wallet.pressYes() → transport.call() has timing/lock issues.

// ── Raw HID frame helpers ───────────────────────────────────────────────
//
// The firmware's confirm_helper() is a BLOCKING C loop inside kkemu_poll().
// It waits for ButtonAck (iface 0) + DebugLinkDecision (iface 1).
// Since kkemu_poll() blocks the JS event loop, we must pre-write these
// into the ring buffer BEFORE the firmware enters the confirm loop.

function buildHidFrame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const frame = new Uint8Array(64)
  frame[0] = 0x3F  // '?' HID report marker
  frame[1] = 0x23  // '#'
  frame[2] = 0x23  // '#'
  frame[3] = (msgType >> 8) & 0xFF   // msg type high
  frame[4] = msgType & 0xFF          // msg type low
  frame[5] = (payload.length >> 24) & 0xFF
  frame[6] = (payload.length >> 16) & 0xFF
  frame[7] = (payload.length >> 8) & 0xFF
  frame[8] = payload.length & 0xFF
  frame.set(payload, 9)
  return frame
}

// ButtonAck (type 27 = 0x001B) — no payload
const BUTTON_ACK_FRAME = buildHidFrame(27)
// DebugLinkDecision (type 100 = 0x0064) — yes_no=true: protobuf field 1 varint = [0x08, 0x01]
const DEBUG_LINK_DECISION_YES = buildHidFrame(100, new Uint8Array([0x08, 0x01]))

/**
 * Pre-write N button confirmations into the emulator ring buffers.
 * Each confirmation = ButtonAck on iface 0 + DebugLinkDecision on iface 1.
 *
 * Must be called BEFORE kkemu_poll() processes a message that triggers
 * confirm_helper() (e.g., after EntropyAck or ResetDevice).
 */
export function prewriteConfirmations(count: number): void {
  console.log(`${TAG} Pre-writing ${count} button confirmations`)
  for (let i = 0; i < count; i++) {
    emuWrite(BUTTON_ACK_FRAME, 0)
    emuWrite(DEBUG_LINK_DECISION_YES, 1)
  }
}

/**
 * Send DebugLinkDecision(yes_no=true) directly to the emulator on interface 1.
 */
export function emuPressYes(): boolean {
  console.log(`${TAG} emuPressYes → writing DebugLinkDecision(yes) to iface=1`)
  return emuWrite(DEBUG_LINK_DECISION_YES, 1)
}
