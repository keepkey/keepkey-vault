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
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { resolve, join } from 'path'
import { existsSync, readFileSync } from 'fs'
import {
  isMacOS, hasKeychainKey, getOrCreateKey, getPairingStatus,
  loadFlash, saveFlash, zeroFlash, listFlashImages, deleteFlash,
  type EmulatorFlash, type EmulatorPairingStatus,
} from './emulator-keychain'
import type { EmulatorStatus, EmulatorProcessState } from '../shared/types'

const TAG = '[emulator]'
const FLASH_SIZE = 1048576  // 1 MB

// ── Emulator manifest ───────────────────────────────────────────────────

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
}

interface EmulatorManifest {
  emulators: EmulatorEntry[]
  default: string
}

function getEmulatorsDir(): string {
  // From projects/keepkey-vault/src/bun/ → firmware/emulators/
  return resolve(__dirname, '../../../../firmware/emulators')
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

function getDylibPath(version?: string): string | null {
  const manifest = loadManifest()
  if (!manifest) return null
  const ver = version || manifest.default
  const entry = manifest.emulators.find(e => e.version === ver)
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
  })
}

// ── State ───────────────────────────────────────────────────────────────

let activeFlash: EmulatorFlash | null = null
let activeVersion: string | null = null
let emuState: EmulatorProcessState = 'stopped'
let emuError: string | undefined

// ── Status ──────────────────────────────────────────────────────────────

export function getEmulatorStatus(): EmulatorStatus {
  const pairing = getPairingStatus()
  return {
    state: emuState,
    bridgeReady: emuState === 'running' && ffi !== null,
    host: activeVersion ? `libkkemu (${activeVersion})` : 'not loaded',
    error: emuError,
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
 * 2. Load libkkemu.dylib for the selected firmware version
 * 3. Pass flash buffer to kkemu_init() via FFI
 * 4. Start poll timer
 */
export function initEmulator(flashName = 'default', version?: string): EmulatorStatus {
  if (!isMacOS()) {
    emuError = 'Emulator requires macOS'
    return getEmulatorStatus()
  }

  if (activeFlash && ffi) {
    console.log(`${TAG} Emulator already running (${activeVersion})`)
    return getEmulatorStatus()
  }

  try {
    emuState = 'starting'
    emuError = undefined

    // 1. Decrypt flash
    activeFlash = loadFlash(flashName)
    console.log(`${TAG} Flash loaded: ${flashName} (${activeFlash.isNew ? 'new' : 'existing'}, ${activeFlash.buffer.length} bytes)`)

    if (activeFlash.isNew) {
      saveFlash(activeFlash)
    }

    // 2. Load dylib
    const dylibPath = getDylibPath(version)
    if (!dylibPath) {
      throw new Error(`No emulator dylib found for version ${version || 'default'}. Check firmware/emulators/`)
    }

    console.log(`${TAG} Loading dylib: ${dylibPath}`)
    ffi = loadDylib(dylibPath)
    activeVersion = version || loadManifest()?.default || 'unknown'

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
    console.log(`${TAG} Emulator running — firmware ${activeVersion}, flash "${flashName}"`)
    return getEmulatorStatus()
  } catch (err: any) {
    emuState = 'error'
    emuError = err.message
    console.error(`${TAG} Failed to init emulator:`, err.message)

    // Cleanup partial init
    if (ffi) { try { ffi.close() } catch {} ; ffi = null }
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
    emuState = 'stopped'
    emuError = undefined
    console.log(`${TAG} Emulator stopped, flash encrypted + memory zeroed`)
  } catch (err: any) {
    emuError = err.message
    console.error(`${TAG} Error during shutdown:`, err.message)
  }

  return getEmulatorStatus()
}

/**
 * Get the active flash buffer pointer (for direct FFI use).
 */
export function getActiveFlashBuffer(): Buffer | null {
  return activeFlash?.buffer ?? null
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

// ── Exports ─────────────────────────────────────────────────────────────

export { listFlashImages, deleteFlash, getAvailableEmulators }
