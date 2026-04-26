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
  /** Chunk counter — reset before confirmOp, read after to know how many polls needed. */
  chunkCount = 0
  /**
   * When true, suppress ButtonAck writes from hdwallet on iface 0.
   *
   * Pre-written BA+DLD on iface 1 satisfy confirm_helper inside kkemu_poll().
   * But hdwallet still sends ButtonAck in response to ButtonRequest — this
   * orphaned BA arrives during the next TxRequest/TxAck exchange (BTC signing)
   * and causes "Unexpected message". Suppressing the write prevents this.
   */
  autoConfirm = false

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

    // Suppress ButtonAck (msg type 27) when autoConfirm is active.
    // Pre-written BA+DLD already satisfied confirm_helper; hdwallet's
    // ButtonAck response would arrive during TxRequest/TxAck and cause
    // "Unexpected message" in multi-round protocols (BTC signing).
    if (!debugLink && this.autoConfirm && isButtonAck(buf)) {
      return
    }

    const ok = emuWrite(buf, iface)
    if (!ok) {
      throw new Error(`${TAG} emuWrite failed (iface=${iface}, len=${buf.length})`)
    }
    if (!debugLink) this.chunkCount++
  }

  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const iface = debugLink ? 1 : 0
    const deadline = Date.now() + READ_TIMEOUT_MS
    let pollCount = 0

    while (Date.now() < deadline) {
      const data = emuRead(iface)
      if (data) return data
      pollCount++
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

// ── ButtonAck detection ─────────────────────────────────────────────────

/** Check if a 64-byte HID frame is a ButtonAck (msg type 27 = 0x001B). */
function isButtonAck(buf: Uint8Array): boolean {
  // First-chunk header: [0x3F][0x23][0x23][msgType_high][msgType_low]...
  return buf.length >= 5 && buf[0] === 0x3F && buf[1] === 0x23 && buf[2] === 0x23 && buf[3] === 0x00 && buf[4] === 0x1B
}

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
// It needs both ButtonAck AND DebugLinkDecision to exit (debug_decided &&
// button_request_acked). It reads messages via check_for_tiny_msg →
// usbPoll → emulatorSocketRead.
//
// CRITICAL: emulatorSocketRead ALWAYS checks iface 0 before iface 1.
// If BA is on iface 0 and DLD is on iface 1, the confirm_helper loop
// drains ALL BA from iface 0 (each iteration re-sets button_request_acked)
// before reading any DLD from iface 1. With N pre-written BA+DLD pairs,
// the first confirm eats all N BA, leaving none for subsequent confirms.
//
// FIX: Write BOTH BA and DLD to iface 1 (debug interface) in alternating
// order. Since iface 1 is a single FIFO, confirm_helper reads BA→DLD
// in order — exactly one pair per confirm. All confirms within a single
// kkemu_poll() tick work correctly.

function buildHidFrame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > 55) throw new Error(`HID frame payload too large: ${payload.length} > 55 bytes`)
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
 *
 * Both BA and DLD are written to iface 1 (debug) in alternating order so
 * they share a single FIFO. confirm_helper reads BA→DLD per iteration,
 * consuming exactly one pair per confirm. This avoids the iface-priority
 * starvation bug where emulatorSocketRead drains all of iface 0 first.
 *
 * Must be called BEFORE kkemu_poll() processes a message that triggers
 * confirm_helper() (e.g., after EntropyAck or ResetDevice).
 */
export function prewriteConfirmations(count: number): void {
  console.log(`${TAG} Pre-writing ${count} button confirmations (both on iface 1)`)
  for (let i = 0; i < count; i++) {
    emuWrite(BUTTON_ACK_FRAME, 1)
    emuWrite(DEBUG_LINK_DECISION_YES, 1)
  }
}


