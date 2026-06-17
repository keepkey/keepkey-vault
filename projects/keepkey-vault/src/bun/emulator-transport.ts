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
// Read timeout MUST outlive the emulator confirm prompt (CONFIRM_TIMEOUT_MS,
// 120s) plus the firmware roundtrip — fn() runs before the user is asked
// to approve, so the readChunk deadline is ticking while the user thinks.
// At 240s the user has up to 120s to decide, plus another ~120s for the
// firmware to process the approval and emit the response.
const READ_TIMEOUT_MS = 240_000

export class EmulatorTransportDelegate implements TransportDelegate {
  private connected = false
  /** Chunk counter (legacy; retained for callers that still reset it). */
  chunkCount = 0
  /**
   * Reactive confirm hook. Fires once each time the firmware emits a
   * ButtonRequest (msg type 26) on the main interface — i.e. it has rendered a
   * confirm screen and is now blocked in confirm_helper on the dylib's poll
   * thread, waiting for a decision. The confirm orchestrator (emuGatedConfirm)
   * installs this to gate the DebugLinkDecision: in interactive mode it shows
   * the held frame and waits for the user's click; in auto mode it presses
   * immediately. hdwallet still auto-sends the ButtonAck itself — we only
   * supply the simulated press (the DLD on iface 1).
   */
  onButtonRequest: (() => void) | null = null

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

    // No ButtonAck suppression: in the reactive model hdwallet's ButtonAck is
    // exactly what sets button_request_acked in confirm_helper. We add only the
    // DebugLinkDecision (the simulated press) on iface 1, gated by the user.

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
      if (data) {
        // A ButtonRequest on the main interface means the firmware just
        // rendered a confirm screen and is now parked in confirm_helper on the
        // poll thread. Notify the orchestrator so it can hold the frame and
        // gate the decision. Fire-and-forget: we still return the frame to
        // hdwallet, which then auto-sends its ButtonAck.
        if (!debugLink && this.onButtonRequest && isButtonRequest(data)) {
          try { this.onButtonRequest() } catch (e: any) {
            console.warn(`${TAG} onButtonRequest handler threw:`, e?.message)
          }
        }
        return data
      }
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

// ── ButtonRequest detection ─────────────────────────────────────────────

/** Check if a 64-byte first-frame HID report is a ButtonRequest (type 26 = 0x001A). */
function isButtonRequest(buf: Uint8Array): boolean {
  // First-chunk header: [0x3F]['#']['#'][msgType_high][msgType_low]...
  return buf.length >= 5 && buf[0] === 0x3F && buf[1] === 0x23 && buf[2] === 0x23 && buf[3] === 0x00 && buf[4] === 0x1A
}

// ── Reactive DebugLinkDecision (the simulated button press) ─────────────
//
// In thread-driven mode the firmware's confirm_helper() blocks on the dylib
// poll thread until it has read BOTH a ButtonAck (sent automatically by
// hdwallet on iface 0) AND a DebugLinkDecision (sent here on iface 1). We no
// longer pre-write anything: writeDecision() delivers exactly one DLD per
// ButtonRequest, when the user (or auto mode) decides. yes_no=true advances
// the screen; yes_no=false makes confirm_helper return false → the firmware
// aborts the operation with a Failure.

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

// DebugLinkDecision (type 100 = 0x0064), bool field 1 (yes_no): tag 0x08 then
// 0x01 (approve) or 0x00 (reject). Field is encoded explicitly in both cases.
const DEBUG_LINK_DECISION_YES = buildHidFrame(100, new Uint8Array([0x08, 0x01]))
const DEBUG_LINK_DECISION_NO = buildHidFrame(100, new Uint8Array([0x08, 0x00]))

/**
 * Deliver one button decision (the simulated press) for the confirm screen the
 * firmware is currently holding. Written to iface 1 (debug); confirm_helper —
 * already holding hdwallet's ButtonAck — reads it and either advances
 * (approved) or returns false → firmware Failure (rejected).
 */
export function writeDecision(approved: boolean): void {
  emuWrite(approved ? DEBUG_LINK_DECISION_YES : DEBUG_LINK_DECISION_NO, 1)
}


