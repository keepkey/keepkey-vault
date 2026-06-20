/**
 * Test 7: Reactive confirm gating (Approach B — thread-driven dylib).
 *
 * Unlike the other tests (which drive kkemu_poll from a JS setInterval and
 * pre-write BA+DLD before a final poll), this one runs the dylib in
 * THREAD mode (kkemu_start) and supplies the DebugLinkDecision REACTIVELY —
 * one per firmware ButtonRequest, exactly as the production reactive gate
 * (emuGatedConfirm → delegate.onButtonRequest → writeDecision) does.
 *
 * It proves the core of the screen-first confirm fix:
 *   - the poll thread keeps the firmware live while confirm_helper blocks in C
 *   - a JS-written DLD reaches the blocked confirm_helper cross-thread
 *   - hdwallet's own ButtonAck (not suppressed) satisfies button_request_acked
 *   - a confirm op (showDisplay address) returns the SAME result as the
 *     non-confirm path → the gate didn't corrupt the operation
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { describe, test, expect, afterAll } from 'bun:test'
import * as core from '@keepkey/hdwallet-core'
import { Adapter, Transport, type TransportDelegate } from '@keepkey/hdwallet-keepkey'

const DYLIB = join(homedir(), '.keepkey', 'emulator', 'libkkemu.dylib')
const TEST_MNEMONIC = 'alcohol woman abuse must during monitor noble actual mixed trade anger aisle'

function loadDylib() {
  if (!existsSync(DYLIB)) throw new Error(`Emulator dylib not installed at ${DYLIB}. Run: make build-emulator`)
  return dlopen(DYLIB, {
    kkemu_init:   { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    kkemu_shutdown: { args: [], returns: FFIType.void },
    kkemu_write:  { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_read:   { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_start:  { args: [], returns: FFIType.i32 },
    kkemu_stop:   { args: [], returns: FFIType.void },
  })
}

function hidFrame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const f = new Uint8Array(64)
  f[0] = 0x3f; f[1] = 0x23; f[2] = 0x23
  f[3] = (msgType >> 8) & 0xff; f[4] = msgType & 0xff
  f[8] = payload.length & 0xff
  f.set(payload, 9)
  return f
}
const DLD_YES = hidFrame(100, new Uint8Array([0x08, 0x01]))

let ffi: ReturnType<typeof loadDylib>
let flash: Buffer
let wallet: any
let buttonRequests = 0

// Reactive delegate: mirrors production EmulatorTransportDelegate — detects a
// ButtonRequest (type 26) on the main interface and auto-presses by writing one
// DebugLinkDecision to iface 1. No pre-writing, no poll pausing; the dylib
// thread owns the event loop.
class ReactiveDelegate implements TransportDelegate {
  async isOpened() { return true }
  async getDeviceID() { return 'emu-reactive' }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() {}
  async writeChunk(buf: Uint8Array, debugLink?: boolean) {
    if (ffi.symbols.kkemu_write(ptr(buf), buf.length, debugLink ? 1 : 0) !== 0) throw new Error('write fail')
  }
  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const iface = debugLink ? 1 : 0
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const buf = new Uint8Array(64)
      if (ffi.symbols.kkemu_read(ptr(buf), 64, iface) > 0) {
        if (!debugLink && buf[0] === 0x3f && buf[1] === 0x23 && buf[2] === 0x23 && buf[3] === 0x00 && buf[4] === 0x1a) {
          buttonRequests++
          ffi.symbols.kkemu_write(ptr(DLD_YES), 64, 1)
        }
        return buf
      }
      await new Promise(r => setTimeout(r, 5))
    }
    throw new Error(`readChunk timeout (iface=${iface})`)
  }
}

async function connectWallet() {
  const keyring = new core.Keyring()
  const delegate = new ReactiveDelegate()
  const transport = await Transport.create(keyring, delegate as any)
  await transport.connect()
  await transport.tryConnectDebugLink()
  const kk = await import('@keepkey/hdwallet-keepkey')
  const w = kk.create(transport) as any
  keyring.add(w, 'emu-reactive')
  return w
}

afterAll(() => {
  try { ffi?.symbols.kkemu_stop() } catch {}
  try { ffi?.symbols.kkemu_shutdown() } catch {}
  try { ffi?.close() } catch {}
  if (flash) flash.fill(0)
})

describe('Reactive confirm (thread-driven)', () => {
  test('boot in thread mode + loadDevice via reactive auto-press', async () => {
    ffi = loadDylib()
    flash = Buffer.alloc(1048576, 0xff)
    expect(ffi.symbols.kkemu_init(ptr(flash), 1048576)).toBe(0)
    expect(ffi.symbols.kkemu_start()).toBe(0) // dylib thread owns the poll — no JS setInterval

    wallet = await connectWallet()
    // loadDevice spans multiple HID chunks and triggers confirm screens; the
    // reactive delegate presses through them with no pre-writing.
    await wallet.loadDevice({ mnemonic: TEST_MNEMONIC, pin: false, passphrase: false, skipChecksum: false })
    const feat = await wallet.getFeatures()
    expect(feat.initialized).toBe(true)
  })

  test('btcGetAddress with showDisplay gates through confirm_helper reactively', async () => {
    const path = [0x80000000 + 44, 0x80000000 + 0, 0x80000000 + 0, 0, 0]
    // No on-screen confirm (baseline derivation).
    const silent = await wallet.btcGetAddress({ addressNList: path, coin: 'Bitcoin', scriptType: 0, showDisplay: false })
    expect(silent).toMatch(/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/)

    const before = buttonRequests
    // showDisplay:true makes the firmware render the address and BLOCK in
    // confirm_helper until a decision — the reactive gate must release it.
    const shown = await wallet.btcGetAddress({ addressNList: path, coin: 'Bitcoin', scriptType: 0, showDisplay: true })

    expect(shown).toBe(silent)                 // confirm gate didn't corrupt the op
    expect(buttonRequests).toBeGreaterThan(before) // the gate actually fired
    console.log(`  reactive confirm fired ${buttonRequests - before}x; addr=${shown}`)
  })
})
