/**
 * Emulator test harness — loads libkkemu.dylib via FFI, provides
 * raw read/write/poll + hdwallet Transport + wallet convenience methods.
 *
 * Usage:
 *   const h = new EmuHarness()
 *   await h.boot()           // fresh flash, init firmware
 *   await h.loadSeed(mnemonic)  // loadDevice + pre-write confirm
 *   const feat = await h.getFeatures()
 *   h.shutdown()
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'
import * as core from '@keepkey/hdwallet-core'
import { Adapter, Transport, type TransportDelegate } from '@keepkey/hdwallet-keepkey'

// ── Constants ──────────────────────────────────────────────────────────

const FLASH_SIZE = 1048576
const PACKET_SIZE = 64
const POLL_MS = 5
const READ_TIMEOUT_MS = 10_000 // 10s for tests (not 120s)
const MANIFEST_PATH = resolve(__dirname, '../../../../firmware/emulators/manifest.json')

// Standard python-keepkey test mnemonic (same as tests/common.py mnemonic12)
export const TEST_MNEMONIC = 'alcohol woman abuse must during monitor noble actual mixed trade anger aisle'

// ── FFI ────────────────────────────────────────────────────────────────

interface EmuFFI {
  kkemu_init: (flash: any, size: number) => number
  kkemu_shutdown: () => void
  kkemu_write: (data: any, len: number, iface: number) => number
  kkemu_read: (buf: any, len: number, iface: number) => number
  kkemu_poll: () => number
  kkemu_is_running: () => number
}

function loadDylib(): { symbols: EmuFFI; close: () => void } {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  const entry = manifest.emulators.find(
    (e: any) => e.platform === process.platform && e.arch === process.arch
  )
  if (!entry) throw new Error(`No emulator for ${process.platform}/${process.arch}`)
  const dylibPath = resolve(MANIFEST_PATH, '..', entry.dylib)
  if (!existsSync(dylibPath)) throw new Error(`Dylib not found: ${dylibPath}`)

  return dlopen(dylibPath, {
    kkemu_init:       { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    kkemu_shutdown:   { args: [], returns: FFIType.void },
    kkemu_write:      { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_read:       { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_poll:       { args: [], returns: FFIType.i32 },
    kkemu_is_running: { args: [], returns: FFIType.i32 },
  }) as any
}

// ── Raw I/O helpers ────────────────────────────────────────────────────

function buildHidFrame(msgType: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const frame = new Uint8Array(64)
  frame[0] = 0x3F
  frame[1] = 0x23
  frame[2] = 0x23
  frame[3] = (msgType >> 8) & 0xFF
  frame[4] = msgType & 0xFF
  frame[5] = (payload.length >> 24) & 0xFF
  frame[6] = (payload.length >> 16) & 0xFF
  frame[7] = (payload.length >> 8) & 0xFF
  frame[8] = payload.length & 0xFF
  frame.set(payload, 9)
  return frame
}

const BUTTON_ACK_FRAME = buildHidFrame(27)
const DEBUG_LINK_DECISION_YES = buildHidFrame(100, new Uint8Array([0x08, 0x01]))

// ── TransportDelegate for tests ────────────────────────────────────────

class TestTransportDelegate implements TransportDelegate {
  /** Count of chunks written since last reset — used by confirmOp. */
  chunkCount = 0

  constructor(
    private ffi: { symbols: EmuFFI },
    private id: string = 'emu-test'
  ) {}

  async isOpened() { return true }
  async getDeviceID() { return this.id }
  async connect() {}
  async tryConnectDebugLink() { return true }
  async disconnect() {}

  async writeChunk(buf: Uint8Array, debugLink?: boolean): Promise<void> {
    const iface = debugLink ? 1 : 0
    const rc = this.ffi.symbols.kkemu_write(ptr(buf), buf.length, iface)
    if (rc !== 0) throw new Error(`kkemu_write failed (iface=${iface})`)
    if (!debugLink) this.chunkCount++
  }

  async readChunk(debugLink?: boolean): Promise<Uint8Array> {
    const iface = debugLink ? 1 : 0
    const deadline = Date.now() + READ_TIMEOUT_MS
    while (Date.now() < deadline) {
      const buf = new Uint8Array(64)
      const n = this.ffi.symbols.kkemu_read(ptr(buf), 64, iface)
      if (n > 0) return buf
      await new Promise(r => setTimeout(r, POLL_MS))
    }
    throw new Error(`readChunk timeout (iface=${iface})`)
  }
}

// ── Test Harness ───────────────────────────────────────────────────────

export class EmuHarness {
  private ffi: ReturnType<typeof loadDylib> | null = null
  private flash: Buffer | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private keyring: core.Keyring | null = null
  private transportDelegate: TestTransportDelegate | null = null
  wallet: (core.HDWallet & Record<string, any>) | null = null

  /** Boot the emulator with a fresh (blank) flash. */
  async boot(): Promise<void> {
    this.ffi = loadDylib()
    this.flash = Buffer.alloc(FLASH_SIZE, 0xFF)
    const rc = this.ffi.symbols.kkemu_init(ptr(this.flash), FLASH_SIZE)
    if (rc !== 0) throw new Error(`kkemu_init failed: ${rc}`)

    this.pollTimer = setInterval(() => {
      try { this.ffi?.symbols.kkemu_poll() } catch {}
    }, 16)
  }

  /** Boot the emulator from an existing flash buffer (for persistence tests). */
  async bootFromFlash(flashBuf: Buffer): Promise<void> {
    if (flashBuf.length !== FLASH_SIZE) throw new Error(`Flash buffer wrong size: ${flashBuf.length}`)
    this.ffi = loadDylib()
    this.flash = flashBuf
    const rc = this.ffi.symbols.kkemu_init(ptr(this.flash), FLASH_SIZE)
    if (rc !== 0) throw new Error(`kkemu_init failed: ${rc}`)

    this.pollTimer = setInterval(() => {
      try { this.ffi?.symbols.kkemu_poll() } catch {}
    }, 16)
  }

  /** Get a copy of the current flash buffer (for saving/restoring). */
  getFlashSnapshot(): Buffer | null {
    if (!this.flash) return null
    return Buffer.from(this.flash)
  }

  /** Shutdown emulator and release resources. */
  shutdown(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.ffi) {
      try { this.ffi.symbols.kkemu_shutdown() } catch {}
      try { this.ffi.close() } catch {}
      this.ffi = null
    }
    if (this.flash) { this.flash.fill(0); this.flash = null }
    this.wallet = null
    this.keyring = null
    this.transportDelegate = null
  }

  /** Pause the poll timer (needed before confirm ops). */
  pausePoll(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
  }

  /** Resume the poll timer. */
  resumePoll(): void {
    if (!this.pollTimer && this.ffi) {
      this.pollTimer = setInterval(() => {
        try { this.ffi?.symbols.kkemu_poll() } catch {}
      }, 16)
    }
  }

  /**
   * Execute a confirm-requiring operation on the emulator.
   *
   * The key challenge: multi-chunk messages (e.g. LoadDevice with a real
   * mnemonic) span 2+ HID packets. If BA+DLD are pre-written to rb_main_in
   * before all chunks are consumed, usb_rx_helper treats BA as a continuation
   * chunk and corrupts the message.
   *
   * Solution:
   * 1. Pause poll, start the operation (transport writes N chunks)
   * 2. Poll (N-1) times to consume all chunks except the last
   * 3. Write BA+DLD to ring buffers
   * 4. Poll once — firmware reads last chunk, assembles full message,
   *    dispatches, enters confirm_helper, finds BA+DLD → exits immediately
   * 5. Resume poll for transport to read the response
   */
  async confirmOp<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.ffi) throw new Error('Not booted')
    const delegate = this.transportDelegate
    if (!delegate) throw new Error('Not connected')

    this.pausePoll()
    delegate.chunkCount = 0

    // Start the operation (transport writes chunks to rb_main_in)
    const promise = fn()
    await new Promise(r => setTimeout(r, 30)) // let transport write all chunks

    const numChunks = delegate.chunkCount
    // Consume all chunks except the last one
    for (let i = 0; i < numChunks - 1; i++) {
      this.ffi.symbols.kkemu_poll()
    }

    // Now rb_main_in has only the last chunk. Write BA+DLD after it.
    this.ffi.symbols.kkemu_write(ptr(BUTTON_ACK_FRAME), 64, 0)
    this.ffi.symbols.kkemu_write(ptr(DEBUG_LINK_DECISION_YES), 64, 1)

    // Final poll: reads last chunk → assembles → dispatches → confirm_helper
    // → reads BA → reads DLD → exits → sends Success (or response)
    this.ffi.symbols.kkemu_poll()

    // Resume normal polling for the transport to read the response
    this.resumePoll()

    return await promise
  }

  /** Create an hdwallet wallet from the running emulator. */
  async connect(): Promise<void> {
    if (!this.ffi) throw new Error('Not booted')
    this.keyring = new core.Keyring()
    this.transportDelegate = new TestTransportDelegate(this.ffi)
    const transport = await Transport.create(this.keyring, this.transportDelegate)
    await transport.connect()
    await transport.tryConnectDebugLink()
    const keepkey = await import('@keepkey/hdwallet-keepkey')
    const wallet = keepkey.create(transport)
    this.keyring.add(wallet, 'emu-test')
    this.wallet = wallet as any
  }

  /** Send Initialize, return Features. */
  async getFeatures(): Promise<any> {
    if (!this.wallet) throw new Error('Not connected')
    return await this.wallet.initialize()
  }

  /**
   * Load a mnemonic into the emulator.
   * Uses confirmOp to wait for ButtonRequest before injecting BA+DLD,
   * avoiding the multi-chunk corruption issue.
   */
  async loadSeed(mnemonic: string = TEST_MNEMONIC): Promise<void> {
    if (!this.wallet) throw new Error('Not connected')

    await this.confirmOp(() => this.wallet!.loadDevice({
      mnemonic,
      pin: false,
      passphrase: false,
      skipChecksum: false,
    }))
  }

  /** Raw emuWrite for test inspection. */
  rawWrite(data: Uint8Array, iface: number): boolean {
    if (!this.ffi) return false
    return this.ffi.symbols.kkemu_write(ptr(data), data.length, iface) === 0
  }

  /** Raw emuRead for test inspection. */
  rawRead(iface: number): Uint8Array | null {
    if (!this.ffi) return null
    const buf = new Uint8Array(64)
    const n = this.ffi.symbols.kkemu_read(ptr(buf), 64, iface)
    return n > 0 ? buf : null
  }

  /** Run kkemu_poll() once synchronously. */
  pollOnce(): void {
    this.ffi?.symbols.kkemu_poll()
  }

  /** Drain all output ring buffers. */
  drain(): void {
    while (this.rawRead(0)) {}
    while (this.rawRead(1)) {}
  }
}
