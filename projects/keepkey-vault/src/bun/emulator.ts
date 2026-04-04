/**
 * KeepKey Emulator — in-process via FFI with Keychain-encrypted flash.
 *
 * Flash image is encrypted at rest (macOS Keychain) and decrypted only
 * into memory. Plaintext never touches disk.
 *
 * Architecture:
 *   Bun process
 *     ├─ emulator-keychain.ts  — Keychain key + AES-256-GCM encrypt/decrypt
 *     ├─ emulator.ts (this)    — flash lifecycle, FFI bridge, version selection
 *     └─ libkkemu.dylib        — firmware as shared library (loaded via bun:ffi)
 *
 * Emulator binaries are bundled at: firmware/emulators/<version>/libkkemu.dylib
 * Manifest at: firmware/emulators/manifest.json
 */
import { dlopen, FFIType, ptr, toBuffer } from 'bun:ffi'
import { resolve, join, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import {
  isMacOS, getOrCreateKey, getPairingStatus,
  loadFlash, saveFlash, zeroFlash, listFlashImages, deleteFlash,
  type EmulatorFlash, type EmulatorPairingStatus,
} from './emulator-keychain'
import type { EmulatorStatus, EmulatorProcessState } from '../shared/types'

const TAG = '[emulator]'
const FLASH_SIZE = 1048576  // 1 MB

// ── Emulator manifest ───────────────────────────────────────────────────

interface EmulatorSource {
  repo: string
  ref: string
  type: 'branch' | 'commit'
}

interface EmulatorEntry {
  version: string
  firmwareVersion: string
  channel: string
  arch: string
  platform: string
  dylib: string
  binary: string
  debugLink: boolean
  description: string
  source: EmulatorSource
}

interface EmulatorManifest {
  emulators: EmulatorEntry[]
  default: string
}

export type EmulatorChannel = 'alpha' | 'beta' | 'release'

function getEmulatorsDir(): string {
  // firmware/emulators/ lives at the vault-v11 project root.
  // Try multiple resolution strategies (bundled app vs source vs cwd):
  const candidates = [
    // 1. Relative to import.meta.dir (works in bundled Bun — app/bun/ → ../../firmware/emulators)
    resolve(import.meta.dir, '..', '..', 'firmware', 'emulators'),
    // 2. From Electrobun app root (Resources/app/ → ../../firmware/emulators)
    resolve(import.meta.dir, '..', '..', '..', 'firmware', 'emulators'),
    // 3. From source tree (src/bun/ → ../../../../firmware/emulators)
    resolve(import.meta.dir, '..', '..', '..', '..', 'firmware', 'emulators'),
    // 4. cwd-relative (if cwd is project root)
    resolve(process.cwd(), 'firmware', 'emulators'),
    // 5. cwd relative for vault-v11 root
    resolve(process.cwd(), '..', '..', 'firmware', 'emulators'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  // Fallback to source-tree path (will fail with clear error)
  return candidates[2]
}

function loadManifest(): EmulatorManifest | null {
  const manifestPath = join(getEmulatorsDir(), 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch { return null }
}

export function getAvailableEmulators(): EmulatorEntry[] {
  const manifest = loadManifest()
  if (!manifest) return []
  return manifest.emulators.filter(e => e.platform === process.platform && e.arch === process.arch)
}

/** Get available channels with their installation status. */
export function getEmulatorChannels(): Array<{
  channel: EmulatorChannel
  version: string
  description: string
  installed: boolean
  source: EmulatorSource
}> {
  const manifest = loadManifest()
  if (!manifest) return []
  return manifest.emulators
    .filter(e => e.platform === process.platform && e.arch === process.arch)
    .map(e => ({
      channel: e.channel as EmulatorChannel,
      version: e.version,
      description: e.description,
      installed: existsSync(join(getEmulatorsDir(), e.dylib)),
      source: e.source,
    }))
}

/** Find the emulator entry for a given channel. */
function getEntryByChannel(channel: EmulatorChannel): EmulatorEntry | null {
  const manifest = loadManifest()
  if (!manifest) return null
  return manifest.emulators.find(
    e => e.channel === channel && e.platform === process.platform && e.arch === process.arch
  ) || null
}

function getDylibPath(version?: string): string | null {
  const manifest = loadManifest()
  if (!manifest) return null
  const ver = version || manifest.default
  const entry = manifest.emulators.find(e => e.version === ver)
  if (!entry) return null
  const fullPath = join(getEmulatorsDir(), entry.dylib)
  return existsSync(fullPath) ? fullPath : null
}

/** Resolve dylib path from a channel name. */
function getDylibPathByChannel(channel: EmulatorChannel): string | null {
  const entry = getEntryByChannel(channel)
  if (!entry) return null
  const fullPath = join(getEmulatorsDir(), entry.dylib)
  return existsSync(fullPath) ? fullPath : null
}

// ── FFI Handle ──────────────────────────────────────────────────────────

let ffi: ReturnType<typeof dlopen> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function loadDylib(path: string) {
  return dlopen(path, {
    kkemu_init:         { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    kkemu_shutdown:     { args: [], returns: FFIType.void },
    kkemu_write:        { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_read:         { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
    kkemu_poll:         { args: [], returns: FFIType.i32 },
    kkemu_is_running:   { args: [], returns: FFIType.i32 },
    kkemu_get_display:  { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  })
}

// ── State ───────────────────────────────────────────────────────────────

let activeFlash: EmulatorFlash | null = null
let activeFlashName: string = 'default'
let activeVersion: string | null = null
let activeChannel: EmulatorChannel | null = null
/**
 * The user's selected channel — persists across stop/start cycles.
 * Set when the user explicitly picks a channel via emulatorInit(channel).
 * Re-used by import/switch/restore flows that restart without an explicit channel.
 */
let selectedChannel: EmulatorChannel | null = null
let emuState: EmulatorProcessState = 'stopped'
let emuError: string | undefined

/** Returns the name of the currently active flash image (for mnemonic persistence). */
export function getActiveFlashName(): string { return activeFlashName }

// ── Status ──────────────────────────────────────────────────────────────

export function getEmulatorStatus(): EmulatorStatus & { channel?: EmulatorChannel } {
  const pairing = getPairingStatus()
  return {
    state: emuState,
    bridgeReady: emuState === 'running' && ffi !== null,
    host: activeVersion ? `libkkemu (${activeVersion})` : 'not loaded',
    error: emuError,
    channel: activeChannel ?? undefined,
    ...pairing,
  }
}

export { isMacOS, getPairingStatus }

// ── Pairing (Keychain key generation) ───────────────────────────────────

export function pairEmulator(): EmulatorPairingStatus {
  if (!isMacOS()) throw new Error('Emulator requires macOS (Keychain)')
  getOrCreateKey()
  console.log(`${TAG} Emulator paired with Keychain`)
  return getPairingStatus()
}

// ── Flash + FFI Lifecycle ───────────────────────────────────────────────

/**
 * Initialize the emulator:
 * 1. Decrypt flash into memory (or create fresh)
 * 2. Load libkkemu.dylib for the selected firmware version/channel
 * 3. Pass flash buffer to kkemu_init() via FFI
 * 4. Start poll timer
 *
 * @param flashName - Name of the flash image to use (default: 'default')
 * @param version   - Specific version string (e.g. '7.14.0-alpha')
 * @param channel   - Channel shorthand: 'alpha' | 'beta' | 'release'
 *                    If channel is provided, it overrides version.
 */
export function initEmulator(flashName = 'default', version?: string, channel?: EmulatorChannel): EmulatorStatus {
  if (!isMacOS()) {
    emuError = 'Emulator requires macOS'
    return getEmulatorStatus()
  }

  if (activeFlash && ffi) {
    console.log(`${TAG} Emulator already running (${activeVersion}, channel=${activeChannel})`)
    return getEmulatorStatus()
  }

  try {
    emuState = 'starting'
    emuError = undefined
    activeFlashName = flashName

    // 1. Decrypt flash
    activeFlash = loadFlash(flashName)
    console.log(`${TAG} Flash loaded: ${flashName} (${activeFlash.isNew ? 'new' : 'existing'}, ${activeFlash.buffer.length} bytes)`)

    if (activeFlash.isNew) {
      saveFlash(activeFlash)
    }

    // 2. Load dylib — resolve channel: explicit arg > sticky selection > version > manifest default
    const resolvedChannel = channel ?? selectedChannel
    let dylibPath: string | null
    if (resolvedChannel) {
      dylibPath = getDylibPathByChannel(resolvedChannel)
      if (!dylibPath) {
        const entry = getEntryByChannel(resolvedChannel)
        throw new Error(
          entry
            ? `Emulator dylib not installed for channel "${resolvedChannel}". Run: make download-emulator-${resolvedChannel}`
            : `Unknown emulator channel "${resolvedChannel}". Available: alpha, beta, release`
        )
      }
      activeChannel = resolvedChannel
      if (channel) selectedChannel = channel  // explicit pick updates sticky selection
      const entry = getEntryByChannel(resolvedChannel)!
      activeVersion = entry.version
    } else {
      dylibPath = getDylibPath(version)
      if (!dylibPath) {
        throw new Error(`No emulator dylib found for version ${version || 'default'}. Check firmware/emulators/`)
      }
      activeVersion = version || loadManifest()?.default || 'unknown'
      // Infer channel from version
      const manifest = loadManifest()
      const entry = manifest?.emulators.find(e => e.version === activeVersion)
      activeChannel = (entry?.channel as EmulatorChannel) ?? null
    }

    console.log(`${TAG} Loading dylib: ${dylibPath} (channel=${activeChannel})`)
    ffi = loadDylib(dylibPath)

    // 3. Pass flash buffer to firmware
    const rc = ffi.symbols.kkemu_init(ptr(activeFlash.buffer), FLASH_SIZE)
    if (rc !== 0) {
      throw new Error(`kkemu_init returned ${rc}`)
    }

    // 4. Start poll timer (~60fps)
    pollTimer = setInterval(() => {
      try { ffi?.symbols.kkemu_poll() } catch {}
    }, 16)

    emuState = 'running'
    console.log(`${TAG} Emulator running — firmware ${activeVersion}, channel=${activeChannel}, flash "${flashName}"`)
    return getEmulatorStatus()
  } catch (err: any) {
    emuState = 'error'
    emuError = err.message
    console.error(`${TAG} Failed to init emulator:`, err.message)

    // Cleanup partial init
    if (ffi) { try { ffi.close() } catch {} ; ffi = null }
    if (activeFlash) { zeroFlash(activeFlash); activeFlash = null }
    activeChannel = null

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
  saveFlash(activeFlash)
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
    // Stop poll timer
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }

    // Flush firmware storage to flash buffer
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

    activeVersion = null
    activeChannel = null
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
  // Process any stale messages in rb_main_in / rb_debug_in
  for (let i = 0; i < 10; i++) {
    try { ffi.symbols.kkemu_poll() } catch {}
  }
  // Drain rb_main_out and rb_debug_out (bounded to prevent spin)
  const buf = new Uint8Array(64)
  let reads = 0
  while (reads < FLUSH_MAX_READS && ffi.symbols.kkemu_read(ptr(buf), 64, 0) > 0) reads++
  while (reads < FLUSH_MAX_READS && ffi.symbols.kkemu_read(ptr(buf), 64, 1) > 0) reads++
  if (reads >= FLUSH_MAX_READS) {
    console.warn(`${TAG} Ring buffer flush hit safety cap (${FLUSH_MAX_READS} reads)`)
  }
  console.log(`${TAG} Ring buffers flushed (${reads} reads)`)
}

// ── Poll control (for pre-writing confirmations) ────────────────────────

let pollSafetyTimer: ReturnType<typeof setTimeout> | null = null
const POLL_SAFETY_MS = 30_000 // auto-resume poll after 30s to prevent permanent stall

/** Pause kkemu_poll timer — call before writing messages that trigger confirm. */
export function pausePoll(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  // Safety net: auto-resume if nothing calls resumePoll() within timeout
  if (pollSafetyTimer) clearTimeout(pollSafetyTimer)
  pollSafetyTimer = setTimeout(() => {
    pollSafetyTimer = null
    if (!pollTimer && ffi) {
      console.warn(`${TAG} Poll safety timeout — auto-resuming after ${POLL_SAFETY_MS / 1000}s`)
      resumePoll()
    }
  }, POLL_SAFETY_MS)
}

/** Run a single kkemu_poll tick synchronously. */
export function emuPollOnce(): void {
  if (ffi) {
    try { ffi.symbols.kkemu_poll() } catch {}
  }
}

/** Resume kkemu_poll timer. */
export function resumePoll(): void {
  if (pollSafetyTimer) { clearTimeout(pollSafetyTimer); pollSafetyTimer = null }
  if (!pollTimer && ffi) {
    pollTimer = setInterval(() => {
      try { ffi?.symbols.kkemu_poll() } catch {}
    }, 16)
  }
}

// ── Display (OLED framebuffer) ──────────────────────────────────────────

/**
 * Read the emulator's 256x64 OLED framebuffer.
 * Returns null if the dylib doesn't expose a framebuffer (current alpha returns NULL).
 * Call between kkemu_poll() ticks — pointer is valid until next poll.
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
  const framebuffer = new Uint8Array(toBuffer(fbPtr, 0, byteLen))
  return { framebuffer, width: w, height: h }
}

// ── Exports ─────────────────────────────────────────────────────────────

export { listFlashImages, deleteFlash }
export type { EmulatorEntry, EmulatorManifest }
