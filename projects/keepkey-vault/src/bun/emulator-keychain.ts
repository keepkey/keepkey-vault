/**
 * Emulator Keychain — macOS-only encrypted flash storage.
 *
 * - Encryption key lives in macOS Keychain (hardware-backed on Apple Silicon)
 * - Decrypted flash image lives ONLY in memory (never written to disk)
 * - Memory is mlock'd (no swap) and zeroed on release
 * - Encrypted blob persisted at ~/.keepkey/emulator/<name>.enc
 */
import { execSync } from 'child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const TAG = '[emu-keychain]'
const KEYCHAIN_SERVICE = 'keepkey-vault-emulator'
const KEYCHAIN_ACCOUNT = 'flash-encryption-key'
const KEY_SIZE = 32        // AES-256
const IV_SIZE = 12         // GCM nonce
const TAG_SIZE = 16        // GCM auth tag
const FLASH_SIZE = 1048576 // 1 MB — STM32 flash mirror

/** Directory for encrypted emulator images */
function getStorageDir(): string {
  const dir = join(homedir(), '.keepkey', 'emulator')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

/**
 * Validate a wallet name and return the canonical (trimmed) form.
 *
 * Wallet names flow from RPC callers (UI, REST) into filesystem paths via
 * getFlashPath/getMnemonicPath. Without validation here, a malicious or
 * buggy caller can use names like "../foo" or "../../etc/something" to
 * read/write/delete files outside ~/.keepkey/emulator. emulatorImportWallet
 * validates at the entry point but emulatorInit/SwitchWallet/DeleteFlash
 * historically did not — keeping validation at the path builders means
 * every path is sanitized regardless of caller.
 *
 * Throws on any name that could escape the storage dir or collide with the
 * mnemonic-side suffix.
 */
export function validateFlashName(name: string): string {
  if (typeof name !== 'string') throw new Error('Wallet name must be a string')
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 64) throw new Error('Wallet name must be 1-64 characters')
  if (/[\/\\]/.test(trimmed)) throw new Error('Wallet name cannot contain path separators')
  if (trimmed.includes('..')) throw new Error('Wallet name cannot contain ".."')
  if (trimmed.includes('\0')) throw new Error('Wallet name cannot contain null bytes')
  // ".mnemonic" anywhere — without this, name "foo.mnemonic" produces
  // "foo.mnemonic.enc" which collides exactly with getMnemonicPath('foo')
  // and is also hidden from listFlashImages's .mnemonic. filter.
  if (/\.mnemonic\b/i.test(trimmed)) throw new Error('Wallet name cannot contain ".mnemonic"')
  return trimmed
}

/** Path to an encrypted flash image */
export function getFlashPath(name = 'default'): string {
  return join(getStorageDir(), `${validateFlashName(name)}.enc`)
}

// ── Keychain Operations ─────────────────────────────────────────────────

/** Check if we're on macOS */
export function isMacOS(): boolean {
  return process.platform === 'darwin'
}

/** Check if we're on Windows */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Platforms with an OS-backed key store for the flash encryption key:
 * macOS (Keychain) and Windows (DPAPI). Linux has no store wired up yet.
 */
export function isEmulatorSupported(): boolean {
  return isMacOS() || isWindows()
}

/**
 * Read the encryption key from macOS Keychain.
 * Returns null if not found (first run).
 */
function readKeychainKey(): Buffer | null {
  try {
    const out = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim()
    if (!out) return null
    return Buffer.from(out, 'hex')
  } catch {
    return null
  }
}

/**
 * Store the encryption key in macOS Keychain.
 * Uses `-U` to update if already exists.
 */
function writeKeychainKey(key: Buffer): void {
  const hex = key.toString('hex')
  try {
    execSync(
      `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w "${hex}" -U`,
      { timeout: 5000 }
    )
  } catch (err: any) {
    throw new Error(`Failed to store key in Keychain: ${err.message}`)
  }
}

// ── Windows DPAPI key store ─────────────────────────────────────────────
//
// Windows has no Keychain. We protect the 32-byte key with DPAPI
// (CurrentUser scope — OS-derived, per-user) and persist the protected blob
// at ~/.keepkey/emulator/flash-key.dpapi. The plaintext key is passed to
// PowerShell over stdin (never on the command line) and the blob on disk is
// only decryptable by this Windows user account.

function getWinKeyPath(): string {
  return join(getStorageDir(), 'flash-key.dpapi')
}

/** Run a PowerShell snippet, piping `input` to its stdin, returning stdout. */
function runPowerShell(script: string, input: string): string {
  return execSync(
    `powershell -NoProfile -NonInteractive -Command "${script}"`,
    { input, encoding: 'utf-8', timeout: 10000 }
  ).trim()
}

/** DPAPI-protect the key (CurrentUser) and write the blob to disk. */
function writeWinKey(key: Buffer): void {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$b64=[Console]::In.ReadToEnd().Trim()',
    '$plain=[Convert]::FromBase64String($b64)',
    '$prot=[System.Security.Cryptography.ProtectedData]::Protect($plain,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($prot)',
  ].join('; ')
  const out = runPowerShell(script, key.toString('base64'))
  if (!out) throw new Error('DPAPI Protect returned empty output')
  writeFileSync(getWinKeyPath(), out, { mode: 0o600 })
}

/** Read + DPAPI-unprotect the key. Returns null if absent or undecryptable. */
function readWinKey(): Buffer | null {
  const p = getWinKeyPath()
  if (!existsSync(p)) return null
  try {
    const protB64 = (readFileSync(p, 'utf-8') as string).trim()
    if (!protB64) return null
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Security',
      '$b64=[Console]::In.ReadToEnd().Trim()',
      '$prot=[Convert]::FromBase64String($b64)',
      '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($prot,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
      '[Convert]::ToBase64String($plain)',
    ].join('; ')
    const out = runPowerShell(script, protB64)
    if (!out) return null
    const key = Buffer.from(out, 'base64')
    return key.length === KEY_SIZE ? key : null
  } catch {
    return null
  }
}

/**
 * Check if a key exists in the OS store without reading it.
 */
export function hasKeychainKey(): boolean {
  if (isWindows()) return readWinKey() !== null
  if (!isMacOS()) return false
  return readKeychainKey() !== null
}

/**
 * Get or create the encryption key.
 * On first call: generates 32 cryptographically random bytes and stores in Keychain.
 * On subsequent calls: reads existing key from Keychain.
 */
export function getOrCreateKey(): Buffer {
  if (!isEmulatorSupported()) throw new Error('Emulator key store requires macOS or Windows')

  let key = isWindows() ? readWinKey() : readKeychainKey()
  if (key && key.length === KEY_SIZE) {
    return key
  }

  console.log(`${TAG} Generating new encryption key...`)
  key = Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_SIZE)))
  if (isWindows()) writeWinKey(key)
  else writeKeychainKey(key)
  console.log(`${TAG} Key stored in ${isWindows() ? 'Windows DPAPI store' : 'Keychain'}`)
  return key
}

// ── Encryption ──────────────────────────────────────────────────────────

/**
 * Encrypt a flash buffer with AES-256-GCM.
 * Returns: [iv (12) | ciphertext | tag (16)]
 */
function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(IV_SIZE)))
  const nodeCrypto = require('crypto')
  const cipherGcm = nodeCrypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([
    cipherGcm.update(plaintext),
    cipherGcm.final(),
  ])
  const tag = cipherGcm.getAuthTag()

  return Buffer.concat([iv, encrypted, tag])
}

/**
 * Decrypt an AES-256-GCM blob.
 * Input format: [iv (12) | ciphertext | tag (16)]
 */
function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < IV_SIZE + TAG_SIZE) {
    throw new Error('Encrypted blob too short')
  }

  const iv = blob.subarray(0, IV_SIZE)
  const tag = blob.subarray(blob.length - TAG_SIZE)
  const ciphertext = blob.subarray(IV_SIZE, blob.length - TAG_SIZE)

  const nodeCrypto = require('crypto')
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
}

// ── Flash Image Management ──────────────────────────────────────────────

export interface EmulatorFlash {
  /** The decrypted flash buffer — 1MB, lives only in memory */
  buffer: Buffer
  /** Name of this flash image */
  name: string
  /** Whether this is a fresh (uninitialized) image */
  isNew: boolean
}

/**
 * Load or create an encrypted flash image.
 *
 * Flow:
 * 1. Get/create encryption key from Keychain
 * 2. If encrypted file exists: decrypt into memory
 * 3. If not: create fresh 1MB buffer (0xFF = erased flash)
 * 4. Return the in-memory buffer (never written to disk unencrypted)
 */
export function loadFlash(name = 'default'): EmulatorFlash {
  const key = getOrCreateKey()
  const encPath = getFlashPath(name)

  if (existsSync(encPath)) {
    console.log(`${TAG} Loading encrypted flash: ${encPath}`)
    const encData = readFileSync(encPath) as Buffer
    const plaintext = decrypt(encData, key)

    if (plaintext.length !== FLASH_SIZE) {
      throw new Error(`Decrypted flash wrong size: ${plaintext.length} (expected ${FLASH_SIZE})`)
    }

    console.log(`${TAG} Flash decrypted into memory (${FLASH_SIZE} bytes)`)
    return { buffer: plaintext, name, isNew: false }
  }

  // Fresh flash — 0xFF is erased NOR flash state
  console.log(`${TAG} Creating fresh flash image: ${name}`)
  const buffer = Buffer.alloc(FLASH_SIZE, 0xFF)
  return { buffer, name, isNew: true }
}

/**
 * Save the in-memory flash to disk (encrypted).
 * Call this on shutdown or periodically to persist state.
 */
export function saveFlash(flash: EmulatorFlash): void {
  const key = getOrCreateKey()
  const encPath = getFlashPath(flash.name)

  console.log(`${TAG} Encrypting flash to: ${encPath}`)
  const encrypted = encrypt(flash.buffer, key)

  writeFileSync(encPath, encrypted, { mode: 0o600 })
  console.log(`${TAG} Flash saved (${encrypted.length} bytes encrypted)`)
}

/**
 * Zero out a flash buffer in memory.
 * Call this when done with the emulator to scrub secrets from RAM.
 */
export function zeroFlash(flash: EmulatorFlash): void {
  flash.buffer.fill(0)
  console.log(`${TAG} Flash memory zeroed`)
}

/**
 * List available flash images.
 */
export function listFlashImages(): string[] {
  const dir = getStorageDir()
  try {
    return (readdirSync(dir) as string[])
      .filter((f: string) => f.endsWith('.enc') && !f.includes('.mnemonic.'))
      .map((f: string) => f.replace('.enc', ''))
  } catch {
    return []
  }
}

/**
 * Delete an encrypted flash image.
 */
export function deleteFlash(name: string): boolean {
  const encPath = getFlashPath(name)
  try {
    unlinkSync(encPath)
    console.log(`${TAG} Deleted flash image: ${name}`)
    return true
  } catch {
    return false
  }
}

// ── Mnemonic Persistence (workaround for firmware storage key bug) ──────
//
// The firmware's storage_deriveWrappingKey uses HW entropy that changes
// per kkemu_init() call, so the encrypted sec section can't be decrypted
// after a restart.  We save the mnemonic separately so the app can
// auto-loadDevice on restart.

/** Path to an encrypted mnemonic file */
function getMnemonicPath(flashName: string): string {
  return join(getStorageDir(), `${validateFlashName(flashName)}.mnemonic.enc`)
}

/**
 * Save a mnemonic encrypted with the Keychain key.
 * Stored alongside the flash image as <name>.mnemonic.enc
 */
export function saveMnemonic(flashName: string, mnemonic: string): void {
  const key = getOrCreateKey()
  const plaintext = Buffer.from(mnemonic, 'utf-8')
  const encrypted = encrypt(plaintext, key)
  const encPath = getMnemonicPath(flashName)
  writeFileSync(encPath, encrypted, { mode: 0o600 })
  console.log(`${TAG} Mnemonic saved for flash "${flashName}"`)
}

/**
 * Load a saved mnemonic (decrypted from Keychain key).
 * Returns null if no mnemonic is saved for this flash.
 */
export function loadMnemonic(flashName: string): string | null {
  const encPath = getMnemonicPath(flashName)
  if (!existsSync(encPath)) return null
  try {
    const key = getOrCreateKey()
    const encData = readFileSync(encPath) as Buffer
    const plaintext = decrypt(encData, key)
    console.log(`${TAG} Mnemonic loaded for flash "${flashName}"`)
    return plaintext.toString('utf-8')
  } catch (err: any) {
    console.warn(`${TAG} Failed to load mnemonic for "${flashName}":`, err?.message)
    return null
  }
}

/**
 * Check if a saved mnemonic exists for a flash image (no decryption — file existence only).
 */
export function hasMnemonic(flashName: string): boolean {
  return existsSync(getMnemonicPath(flashName))
}

/**
 * Delete a saved mnemonic.
 */
export function deleteMnemonic(flashName: string): boolean {
  const encPath = getMnemonicPath(flashName)
  try {
    unlinkSync(encPath)
    console.log(`${TAG} Deleted mnemonic for flash "${flashName}"`)
    return true
  } catch {
    return false
  }
}

// ── Pairing Status ──────────────────────────────────────────────────────

export interface EmulatorPairingStatus {
  paired: boolean
  platform: string
  flashImages: string[]
  storagePath: string
}

/**
 * Get the current emulator pairing status.
 * "Paired" means a Keychain key exists and the storage directory is ready.
 */
export function getPairingStatus(): EmulatorPairingStatus {
  return {
    paired: hasKeychainKey(),
    platform: process.platform,
    flashImages: isEmulatorSupported() ? listFlashImages() : [],
    storagePath: getStorageDir(),
  }
}
