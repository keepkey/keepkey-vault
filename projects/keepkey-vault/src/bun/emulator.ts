/**
 * KeepKey Emulator — in-process via FFI (future) or subprocess (interim).
 *
 * Flash image is encrypted at rest (macOS Keychain) and decrypted only
 * into mlock'd memory. Plaintext never touches disk.
 *
 * Architecture:
 *   Bun process
 *     ├─ emulator-keychain.ts  — Keychain key + AES-256-GCM encrypt/decrypt
 *     ├─ emulator.ts (this)    — flash lifecycle, FFI bridge (future)
 *     └─ libkkemu.dylib        — firmware as shared library (future)
 *
 * Current state: keychain pairing + encrypted flash management implemented.
 * The dylib FFI bridge and hdwallet TransportDelegate are TODO.
 */
import {
  isMacOS, hasKeychainKey, getOrCreateKey, getPairingStatus,
  loadFlash, saveFlash, zeroFlash, listFlashImages, deleteFlash,
  type EmulatorFlash, type EmulatorPairingStatus,
} from './emulator-keychain'
import type { EmulatorStatus, EmulatorProcessState } from '../shared/types'

const TAG = '[emulator]'

// ── State ───────────────────────────────────────────────────────────────

let activeFlash: EmulatorFlash | null = null
let emuState: EmulatorProcessState = 'stopped'
let emuError: string | undefined

// ── Status ──────────────────────────────────────────────────────────────

export function getEmulatorStatus(): EmulatorStatus {
  const pairing = getPairingStatus()
  return {
    state: emuState,
    bridgeReady: emuState === 'running',
    host: 'in-process (FFI)',
    error: emuError,
    ...pairing,
  }
}

export { isMacOS, getPairingStatus }

// ── Pairing (Keychain key generation) ───────────────────────────────────

/**
 * Pair the emulator — generates an encryption key in macOS Keychain
 * if one doesn't exist. This is the first step before any emulator use.
 *
 * Returns the updated pairing status.
 */
export function pairEmulator(): EmulatorPairingStatus {
  if (!isMacOS()) {
    throw new Error('Emulator requires macOS (Keychain)')
  }

  // This will generate + store a key if none exists
  getOrCreateKey()
  console.log(`${TAG} Emulator paired with Keychain`)

  return getPairingStatus()
}

// ── Flash Lifecycle ─────────────────────────────────────────────────────

/**
 * Initialize the emulator — decrypt flash into memory.
 * If no flash image exists, creates a fresh one (uninitialized device).
 */
export function initEmulator(flashName = 'default'): EmulatorStatus {
  if (!isMacOS()) {
    emuError = 'Emulator requires macOS'
    return getEmulatorStatus()
  }

  if (activeFlash) {
    console.log(`${TAG} Emulator already initialized (flash: ${activeFlash.name})`)
    return getEmulatorStatus()
  }

  try {
    emuState = 'starting'
    emuError = undefined

    activeFlash = loadFlash(flashName)
    console.log(`${TAG} Flash loaded: ${flashName} (${activeFlash.isNew ? 'new' : 'existing'}, ${activeFlash.buffer.length} bytes in memory)`)

    // If new, save immediately so encrypted file exists on disk
    if (activeFlash.isNew) {
      saveFlash(activeFlash)
    }

    emuState = 'running'
    // TODO: When dylib is built, pass activeFlash.buffer to kkemu_init_from_buffer()

    return getEmulatorStatus()
  } catch (err: any) {
    emuState = 'error'
    emuError = err.message
    console.error(`${TAG} Failed to init emulator:`, err.message)
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
 * Stop the emulator — encrypt flash back to disk, zero memory.
 */
export function stopEmulator(): EmulatorStatus {
  if (!activeFlash) {
    emuState = 'stopped'
    return getEmulatorStatus()
  }

  try {
    // TODO: When dylib is built, call kkemu_destroy() first

    // Persist encrypted state
    saveFlash(activeFlash)

    // Scrub secrets from RAM
    zeroFlash(activeFlash)
    activeFlash = null

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
 * Get the active flash buffer pointer (for future FFI use).
 * Returns null if emulator is not running.
 */
export function getActiveFlashBuffer(): Buffer | null {
  return activeFlash?.buffer ?? null
}

// ── Flash Image Management ──────────────────────────────────────────────

export { listFlashImages, deleteFlash }
