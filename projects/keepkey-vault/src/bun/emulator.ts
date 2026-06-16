/**
 * KeepKey Emulator — in-process via FFI with Keychain-encrypted flash.
 *
 * Flash image is encrypted at rest (macOS Keychain) and decrypted only
 * into memory. Plaintext never touches disk.
 *
 * Architecture:
 *   Bun process
 *     ├─ emulator-keychain.ts  — Keychain key + AES-256-GCM encrypt/decrypt
 *     ├─ emulator.ts (this)    — flash lifecycle, FFI bridge
 *     └─ libkkemu.dylib        — firmware as shared library (loaded via bun:ffi)
 *
 * The dylib is user-installed at ~/.keepkey/emulator/libkkemu.dylib —
 * dropped onto the app via FileDropZone, or copied there by `make
 * build-emulator`. No channel/version system: one slot, one binary.
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import {
  isMacOS, isEmulatorSupported, getOrCreateKey, getPairingStatus,
  loadFlash, saveFlash, zeroFlash, listFlashImages, deleteFlash,
  type EmulatorFlash, type EmulatorPairingStatus,
} from './emulator-keychain'
import { startEmulatorWatchdog, stopEmulatorWatchdog } from './emulator-watchdog'
import type { EmulatorStatus, EmulatorProcessState } from '../shared/types'

const TAG = '[emulator]'
const FLASH_SIZE = 1048576  // 1 MB

// ── Dylib resolution (single user-installed slot) ───────────────────────

/** Directory for the user-installed emulator binary. */
function getEmulatorBinDir(): string {
  const dir = join(homedir(), '.keepkey', 'emulator')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Platform filename for the firmware shared library the vault loads via FFI. */
export function getLibFilename(): string {
  if (process.platform === 'win32') return 'libkkemu.dll'
  if (process.platform === 'linux') return 'libkkemu.so'
  return 'libkkemu.dylib'
}

/** Path to the user-installed emulator library. May not exist yet. */
export function getDylibPath(): string {
  return join(getEmulatorBinDir(), getLibFilename())
}

/** True when the user has installed a dylib. */
export function isDylibInstalled(): boolean {
  return existsSync(getDylibPath())
}

// ── FFI Handle ──────────────────────────────────────────────────────────

let ffi: ReturnType<typeof dlopen> | null = null

function loadDylib(path: string) {
  return dlopen(path, {
    kkemu_init:         { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    kkemu_shutdown:     { args: [], returns: FFIType.void },
    kkemu_write:        { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_read:         { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_poll:         { args: [], returns: FFIType.i32 },
    kkemu_is_running:   { args: [], returns: FFIType.i32 },
    kkemu_get_display:  { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    kkemu_pop_frame:    { args: [FFIType.ptr], returns: FFIType.i32 },
    // Thread-driven mode (Approach B): the dylib owns the event loop on a
    // dedicated thread so confirm_helper can block in C without freezing the
    // Bun event loop — enables screen-first confirm gating.
    kkemu_start:        { args: [], returns: FFIType.i32 },
    kkemu_stop:         { args: [], returns: FFIType.void },
    kkemu_lock:         { args: [], returns: FFIType.void },
    kkemu_unlock:       { args: [], returns: FFIType.void },
  })
}

// ── State ───────────────────────────────────────────────────────────────

let activeFlash: EmulatorFlash | null = null
let activeFlashName: string = 'default'
let emuState: EmulatorProcessState = 'stopped'
let emuError: string | undefined

/** Returns the name of the currently active flash image (for mnemonic persistence). */
export function getActiveFlashName(): string { return activeFlashName }

// ── Status ──────────────────────────────────────────────────────────────

export function getEmulatorStatus(): EmulatorStatus {
  const pairing = getPairingStatus()
  return {
    state: emuState,
    bridgeReady: emuState === 'running' && ffi !== null,
    host: ffi ? 'libkkemu' : 'not loaded',
    error: emuError,
    ...pairing,
  }
}

export { isMacOS, isEmulatorSupported, getPairingStatus }

// ── Pairing (OS key store key generation) ───────────────────────────────

export function pairEmulator(): EmulatorPairingStatus {
  if (!isEmulatorSupported()) throw new Error('Emulator requires macOS or Windows')
  getOrCreateKey()
  console.log(`${TAG} Emulator paired with Keychain`)
  return getPairingStatus()
}

// ── Flash + FFI Lifecycle ───────────────────────────────────────────────

/**
 * Initialize the emulator:
 * 1. Decrypt flash into memory (or create fresh)
 * 2. Load the user-installed libkkemu.dylib at ~/.keepkey/emulator/
 * 3. Pass flash buffer to kkemu_init() via FFI
 * 4. Start poll timer
 *
 * @param flashName - Name of the flash image to use (default: 'default')
 */
export function initEmulator(flashName = 'default'): EmulatorStatus {
  if (!isEmulatorSupported()) {
    emuError = 'Emulator requires macOS or Windows'
    return getEmulatorStatus()
  }

  if (activeFlash && ffi) {
    console.log(`${TAG} Emulator already running`)
    return getEmulatorStatus()
  }

  try {
    emuState = 'starting'
    emuError = undefined
    activeFlashName = flashName

    // 1. Locate dylib BEFORE touching flash — failing early avoids creating
    // an orphan flash file when the user hasn't installed an emulator yet.
    const dylibPath = getDylibPath()
    if (!isDylibInstalled()) {
      const lib = getLibFilename()
      const how = process.platform === 'win32' ? 'make build-emulator-windows' : 'make build-emulator'
      throw new Error(`No emulator installed. Drop a ${lib} onto the window or run: ${how}`)
    }

    // 2. Decrypt flash
    activeFlash = loadFlash(flashName)
    console.log(`${TAG} Flash loaded: ${flashName} (${activeFlash.isNew ? 'new' : 'existing'}, ${activeFlash.buffer.length} bytes)`)

    if (activeFlash.isNew) {
      saveFlash(activeFlash)
    }

    console.log(`${TAG} Loading dylib: ${dylibPath}`)
    ffi = loadDylib(dylibPath)

    // 3. Pass flash buffer to firmware
    const rc = ffi.symbols.kkemu_init(ptr(activeFlash.buffer), FLASH_SIZE)
    if (rc !== 0) {
      throw new Error(`kkemu_init returned ${rc}`)
    }

    // 4. Hand the event loop to the dylib's poll thread (Approach B). The
    // thread owns kkemu_poll from here on — the host MUST NOT poll directly
    // (kkemu_poll() no-ops while the thread runs). This is what lets the
    // firmware's confirm_helper block in C, waiting for a button decision,
    // without freezing the Bun event loop — so the vault can render and HOLD
    // the real confirm frame BEFORE the user approves (screen-first gating).
    const startRc = ffi.symbols.kkemu_start()
    if (startRc !== 0) {
      throw new Error(`kkemu_start returned ${startRc}`)
    }

    // 5. Arm the FFI liveness watchdog as a backstop. With the poll thread the
    // event loop no longer freezes on confirms, so this should never fire on a
    // slow button press anymore; it's kept only to catch a genuine dylib hang.
    startEmulatorWatchdog()

    emuState = 'running'
    console.log(`${TAG} Emulator running — flash "${flashName}"`)
    return getEmulatorStatus()
  } catch (err: any) {
    emuState = 'error'
    emuError = err.message
    console.error(`${TAG} Failed to init emulator:`, err.message)

    // Cleanup partial init — watchdog first so a half-armed heartbeat
    // doesn't outlive the init failure. kkemu_stop() is idempotent (no-op if
    // the poll thread was never started).
    stopEmulatorWatchdog()
    if (ffi) { try { ffi.symbols.kkemu_stop() } catch {} ; try { ffi.close() } catch {} ; ffi = null }
    if (activeFlash) { zeroFlash(activeFlash); activeFlash = null }

    return getEmulatorStatus()
  }
}

/**
 * Save current flash state to disk (encrypted) without stopping.
 */
export function saveEmulatorState(): void {
  if (!activeFlash) {
    console.warn(`${TAG} No active flash to save`)
    return
  }
  // Snapshot the flash buffer under the firmware lock so a concurrent
  // storage_commit() on the poll thread can't tear the encrypted image.
  // kkemu_lock no-ops when the thread isn't running.
  ffi?.symbols.kkemu_lock()
  try { saveFlash(activeFlash) }
  finally { ffi?.symbols.kkemu_unlock() }
}

/**
 * Stop the emulator:
 * 1. Call kkemu_shutdown() (flushes storage to buffer)
 * 2. Encrypt flash back to disk
 * 3. Zero flash memory
 * 4. Close dylib
 */
export function stopEmulator(): EmulatorStatus {
  if (!activeFlash && !ffi) {
    emuState = 'stopped'
    return getEmulatorStatus()
  }

  try {
    // Disarm the FFI watchdog first.
    stopEmulatorWatchdog()

    // Flush firmware storage to flash buffer. kkemu_shutdown() stops + joins
    // the poll thread internally (injecting a Cancel to unblock any pending
    // confirm) BEFORE committing storage, so nothing drives the firmware while
    // we read the flash buffer below.
    if (ffi) {
      try { ffi.symbols.kkemu_shutdown() } catch (e: any) {
        console.warn(`${TAG} kkemu_shutdown error:`, e.message)
      }
      try { ffi.close() } catch {}
      ffi = null
    }

    // Encrypt + save
    if (activeFlash) {
      saveFlash(activeFlash)
      zeroFlash(activeFlash)
      activeFlash = null
    }

    emuState = 'stopped'
    emuError = undefined
    console.log(`${TAG} Emulator stopped, flash encrypted + memory zeroed`)
  } catch (err: any) {
    emuError = err.message
    console.error(`${TAG} Error during shutdown:`, err.message)
  }

  return getEmulatorStatus()
}

// ── FFI Message I/O (for hdwallet TransportDelegate) ────────────────────

/**
 * Write a 64-byte HID report to the emulator.
 * Used by the hdwallet TransportDelegate.
 */
export function emuWrite(data: Uint8Array, iface: number): boolean {
  if (!ffi) return false
  return ffi.symbols.kkemu_write(ptr(data), data.length, iface) === 0
}

/**
 * Read a 64-byte HID report from the emulator.
 * Non-blocking — returns null if no data available.
 */
export function emuRead(iface: number): Uint8Array | null {
  if (!ffi) return null
  const buf = new Uint8Array(64)
  const n = ffi.symbols.kkemu_read(ptr(buf), 64, iface)
  return n > 0 ? buf : null
}

// ── Ring buffer flush ───────────────────────────────────────────────────

/**
 * Flush stale messages from all ring buffers.
 * Calls kkemu_poll() several times to process stale input (e.g. ButtonAck
 * left by the transport), then drains all output so the next transport
 * connection starts clean.
 */
const FLUSH_MAX_READS = 1000 // safety cap — prevent infinite drain loop

export function flushRingBuffers(): void {
  if (!ffi) return
  // The poll thread drains the INPUT rings continuously, so we only clear any
  // leftover OUTPUT here (e.g. a late Success/Failure) to keep the next
  // operation's reads clean. kkemu_read drains the lock-free output rings
  // directly — safe to call concurrently with the poll thread (SPSC).
  const buf = new Uint8Array(64)
  let reads = 0
  while (reads < FLUSH_MAX_READS && ffi.symbols.kkemu_read(ptr(buf), 64, 0) > 0) reads++
  while (reads < FLUSH_MAX_READS && ffi.symbols.kkemu_read(ptr(buf), 64, 1) > 0) reads++
  if (reads >= FLUSH_MAX_READS) {
    console.warn(`${TAG} Ring buffer flush hit safety cap (${FLUSH_MAX_READS} reads)`)
  }
  console.log(`${TAG} Ring buffers flushed (${reads} reads)`)
}

// ── Display (OLED framebuffer) ──────────────────────────────────────────

/**
 * Read the emulator's 256x64 OLED framebuffer.
 * Returns null if the dylib doesn't expose a framebuffer.
 *
 * The returned Uint8Array is a fresh copy. We use `toArrayBuffer + slice()`
 * rather than `toBuffer` because Bun's Buffer-from-pointer wrapper attempts
 * to free the underlying memory on GC — fine for malloc'd C buffers, but
 * the dylib's framebuffer is a static `.bss` page and freeing it segfaults
 * the next setInterval tick.
 */
export function emuGetDisplay(): { framebuffer: Uint8Array | null; width: number; height: number } {
  if (!ffi) return { framebuffer: null, width: 0, height: 0 }
  const widthBuf = new Int32Array(1)
  const heightBuf = new Int32Array(1)
  const fbPtr = ffi.symbols.kkemu_get_display(ptr(widthBuf), ptr(heightBuf))
  const w = widthBuf[0]
  const h = heightBuf[0]
  if (!fbPtr || w === 0 || h === 0) return { framebuffer: null, width: w, height: h }
  const byteLen = (w * h) / 8 // 2048 bytes for 256x64 1-bit
  // .slice() forces a copy into a JS-owned ArrayBuffer; the borrowed view of
  // the dylib's static memory is dropped immediately.
  const framebuffer = new Uint8Array(toArrayBuffer(fbPtr, 0, byteLen)).slice()
  return { framebuffer, width: w, height: h }
}

/**
 * Pop captured framebuffers from the dylib's display ring.
 *
 * The firmware's display_refresh() (called every kkemu_poll AND every
 * iteration of confirm_helper's busy loop) snapshots the canvas into a
 * ring buffer. This drains the ring so the host can replay confirm/init/
 * recovery screens that exist only inside synchronous C calls.
 *
 * Adjacent identical frames are deduplicated in C, so the returned list
 * contains only distinct screen states. Capped per call to avoid
 * unbounded JS work if the firmware is animating fast.
 */
const POP_BATCH_CAP = 64

export function emuPopFrames(): Uint8Array[] {
  if (!ffi) return []
  const frames: Uint8Array[] = []
  const buf = new Uint8Array(2048)
  for (let i = 0; i < POP_BATCH_CAP; i++) {
    const got = ffi.symbols.kkemu_pop_frame(ptr(buf))
    if (!got) break
    frames.push(buf.slice())
  }
  return frames
}

// ── Exports ─────────────────────────────────────────────────────────────

export { listFlashImages, deleteFlash }
