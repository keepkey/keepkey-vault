import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import { HttpError } from './auth'
import type { SigningRequestInfo, ApiLogEntry, EIP712DecodedInfo } from '../shared/types'
import { decodeEIP712 } from './eip712-decoder'
import { decodeCalldata, firmwareClearSigns } from './calldata-decoder'
import { CHAINS, isChainSupported, hiveRolePath } from '../shared/chains'
import { isBitcoinOnlyVariant } from '../shared/flags'
import {
  initializeOrchardFromDevice, scanOrchardNotes, getShieldedBalance,
  buildShieldedTx, finalizeShieldedTx, broadcastShieldedTx,
  ensureFvkLoaded, displayOrchardAddressOnDevice, sendShielded,
} from './txbuilder/zcash-shielded'
import { isSidecarReady, getCachedFvk } from './zcash-sidecar'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as S from './schemas'
import { parseRequest, validateResponse } from './validate'
import { SIGNING_ROUTES, requiredSigningFields } from './signing-routes'
import { handleV2DataRoute } from './rest-pioneer'
import { handleSwapRoute } from './rest-swap'
import { handleSweepRoute } from './rest-sweep'
import { handleLedgerRoute } from './rest-ledger'
import { getSetting, findApiLogs, getApiLogById, getRecentActivityFromLog, getSwapHistory, getSwapHistoryByTxid, getSwapHistoryStats, getCachedBalances, getCachedPubkeys, getAllTokenVisibility, getTokensByVisibility, setTokenVisibility, removeTokenVisibility } from './db'
import { detectSpamToken, categorizeTokens } from '../shared/spamFilter'
import { rebuildActivityHistory, type ActivityHistoryRebuildOptions } from './activity-history'
import type { SwapTrackingStatus } from '../shared/types'
import { parseSolanaTx, SolanaTxParseError } from './solana-tx'
import { signSolanaWireTransaction } from './solana-signing'
import { buildSolanaDecodedInfo } from './solana-clearsign'
import { buildSolanaMessageDecodedInfo } from './solana-message-preview'
import { requiresSolanaBlindSigningConsent } from './solana-consent'
import { createRpcAltFetcher, DEFAULT_SOLANA_RPC_ENDPOINT } from './solana-alt'
import {
  buildTonTransfer,
  assembleTonSignedBoc,
  computeTonBodyHash,
  getTonSeqno,
  getTonWalletState,
  broadcastTonBoc,
  type TonBuildResult,
} from './txbuilder/ton'
import { usb } from 'usb'
import { handleMcpRequest } from './mcp'
import { onBexOpen, onBexClose, onBexMessage } from './bex-bridge'

export interface EmuSigningDetails {
  operation: string
  /** Human label override for the operation header (e.g. "Token Approval"). */
  opLabel?: string
  chain?: string
  to?: string
  /** Label for the `to` row — "To" (default), "Spender", "Contract", "Validator". */
  toLabel?: string
  value?: string
  fee?: string
  memo?: string
}

export interface SigningApprovalDecision {
  approved: boolean
  /** Explicit Vault UI consent for this request only. */
  allowBlindSigning?: boolean
}

export interface RestApiCallbacks {
  onApiLog: (entry: ApiLogEntry) => void
  onSigningRequest: (info: SigningRequestInfo) => Promise<SigningApprovalDecision>
  onSigningDismissed?: (id: string) => void
  onPairRequest: (info: { name: string; url: string; imageUrl: string }) => void
  onPairDismissed?: () => void
  getVersion: () => string
  /** Wrap a signing/display op for the emulator (pre-writes confirmations, interactive approve) */
  emuSigningOp?: (fn: () => Promise<any>, details: EmuSigningDetails) => Promise<any>
  /** Read the latest SwapDialog UI state mirror (set by /api/v2/swap/state) */
  getSwapUiState?: () => { state: import('../shared/types').SwapUiState; updatedAt: number }
  /** Firmware-filtered swap asset list — mirrors the RPC getSwapAssets so REST
   *  clients never see assets the connected device's firmware can't sign. */
  getDeviceSwapAssets?: () => Promise<import('../shared/types').SwapAsset[]>
  /** Push a swap-cmd to the WebView (used by /api/v2/swap/{open,set,requote,close}) */
  sendSwapCmd?: (cmd: import('../shared/types').SwapUiCommand) => void
  /** Headless swap quote (BEX swap epic) — same engine as the dialog, no GUI.
   *  Wraps getSwapQuote + reserve/net-amount re-quote. Used by POST /api/v2/swap/quote. */
  getSwapQuoteHeadless?: (params: import('../shared/types').SwapQuoteParams) => Promise<import('../shared/types').SwapQuote>
  /** Headless swap execute — signs on the device, broadcasts, registers tracking.
   *  Used by POST /api/v2/swap/execute. Device still gates the signature. */
  executeSwapHeadless?: (params: import('../shared/types').ExecuteSwapParams) => Promise<import('../shared/types').SwapResult>
  /** Fail-closed pre-send preflight for the headless Zcash send/shield/deshield
   *  paths. Mirrors the RPC flow: prove the cached Orchard FVK belongs to the
   *  CONNECTED device (purges stale sidecar state + re-derives on mismatch) and
   *  refresh the note set to chain tip. Throws to abort BEFORE signing, so a
   *  stale-DB / device-swap can never build from old notes and fail late. */
  zcashPreSendGate?: (account: number) => Promise<void>
  /** Fail-closed Zcash wallet identity check for read-only balance paths.
   *  Proves the cached Orchard FVK belongs to the connected device before
   *  exposing any shielded balance from the local sidecar database. */
  zcashVerifyWallet?: (account: number) => Promise<void>
  /** Schedule delayed post-tx Orchard rescans (shield/deshield/z2z) so the
   *  local note DB reconciles with the chain without user action. */
  zcashSchedulePostTxRescans?: () => void
  /** Returns initialized Pioneer client (for debug endpoints) */
  getPioneer?: () => Promise<any>
  /** Returns the active Pioneer API base URL */
  getPioneerApiBase?: () => string
  /** Set Pioneer API base URL (empty string = reset to default) */
  setPioneerApiBase?: (url: string) => Promise<any>
}

function corsHeaders(_req?: Request): Record<string, string> {
  // Use '*' — bearer-token auth model (not cookie-based), so wildcard is safe
  // and prevents browsers from ever sending credentials via CORS.
  // Private-Network-Access headers required for https → localhost (WKWebView, Chrome 104+).
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Access-Control-Request-Private-Network',
    'Access-Control-Allow-Private-Network': 'true',
  }
}

function requireWallet(engine: EngineController) {
  if (!engine.wallet) throw new HttpError(503, 'No device connected')
  return engine.wallet
}

const KEEPKEY_VENDOR_ID = 0x2B24

function usbIdHex(value: number | null | undefined): string | null {
  if (typeof value !== 'number') return null
  return `0x${value.toString(16).padStart(4, '0')}`
}

function listUsbDevicesForAdmin() {
  return usb.getDeviceList().map((device: any) => {
    const descriptor = device.deviceDescriptor || {}
    const vendorId = typeof descriptor.idVendor === 'number' ? descriptor.idVendor : null
    const productId = typeof descriptor.idProduct === 'number' ? descriptor.idProduct : null
    return {
      busNumber: typeof device.busNumber === 'number' ? device.busNumber : null,
      deviceAddress: typeof device.deviceAddress === 'number' ? device.deviceAddress : null,
      portNumbers: Array.isArray(device.portNumbers) ? device.portNumbers : [],
      vendorId,
      vendorIdHex: usbIdHex(vendorId),
      productId,
      productIdHex: usbIdHex(productId),
      deviceClass: typeof descriptor.bDeviceClass === 'number' ? descriptor.bDeviceClass : null,
      deviceSubClass: typeof descriptor.bDeviceSubClass === 'number' ? descriptor.bDeviceSubClass : null,
      deviceProtocol: typeof descriptor.bDeviceProtocol === 'number' ? descriptor.bDeviceProtocol : null,
      usbVersion: typeof descriptor.bcdUSB === 'number' ? usbIdHex(descriptor.bcdUSB) : null,
      deviceVersion: typeof descriptor.bcdDevice === 'number' ? usbIdHex(descriptor.bcdDevice) : null,
      manufacturerIndex: typeof descriptor.iManufacturer === 'number' ? descriptor.iManufacturer : null,
      productIndex: typeof descriptor.iProduct === 'number' ? descriptor.iProduct : null,
      serialNumberIndex: typeof descriptor.iSerialNumber === 'number' ? descriptor.iSerialNumber : null,
      isKeepKey: vendorId === KEEPKEY_VENDOR_ID,
    }
  })
}

/**
 * Parse a hex string into a Buffer with explicit validation.
 *
 * `Buffer.from(str, 'hex')` silently truncates on the first non-hex char
 * or odd length, which surfaces downstream as "wrong-length signature"
 * errors that don't point at the actual bug. This helper rejects bad
 * input up front with a clear 400.
 */
function parseHex(input: string, label: string, expectedBytes?: number): Buffer {
  const stripped = input.replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]*$/.test(stripped)) {
    throw new HttpError(400, `${label}: invalid hex (non-hex characters)`)
  }
  if (stripped.length % 2 !== 0) {
    throw new HttpError(400, `${label}: invalid hex (odd-length string, must be even)`)
  }
  if (expectedBytes !== undefined && stripped.length !== expectedBytes * 2) {
    throw new HttpError(400, `${label}: expected ${expectedBytes} bytes, got ${stripped.length / 2}`)
  }
  return Buffer.from(stripped, 'hex')
}

/** Decode a `message` body field per `is_text` (default UTF-8, false = hex bytes). */
function decodeMessageBody(message: string, isText: boolean | undefined, label: string): Buffer {
  return isText === false ? parseHex(message, `${label}.message (is_text=false)`) : Buffer.from(message, 'utf8')
}

/** Single-shot Uint8Array → hex serializer used by every signing handler. */
function toHex(value: Uint8Array | string): string {
  return value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value
}

/** SLIP44 coin type → KeepKey firmware coin name (must match firmware coin table) */
const SLIP44_TO_COIN: Record<number, string> = {
  0: 'Bitcoin', 2: 'Litecoin', 3: 'Dogecoin', 5: 'Dash',
  20: 'DigiByte', 60: 'Ethereum', 118: 'Cosmos', 144: 'Ripple',
  145: 'BitcoinCash', 195: 'Tron', 501: 'Solana', 607: 'Ton', 931: 'Rune',
}

/** Ticker/symbol → firmware coin name. Callers may send 'BTC' but firmware needs 'Bitcoin'. */
const TICKER_TO_COIN: Record<string, string> = {
  BTC: 'Bitcoin', LTC: 'Litecoin', DOGE: 'Dogecoin', DASH: 'Dash',
  DGB: 'DigiByte', ETH: 'Ethereum', ATOM: 'Cosmos', XRP: 'Ripple',
  BCH: 'BitcoinCash', TRX: 'Tron', SOL: 'Solana', TON: 'Ton', RUNE: 'Rune',
}

const DEFAULT_SOLANA_ADDRESS_N = [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]

function pickAddressNList(body: any, fallback: number[]): number[] {
  return Array.isArray(body?.addressNList)
    ? body.addressNList
    : Array.isArray(body?.address_n)
      ? body.address_n
      : fallback
}

function formatAddressNPath(addressNList: number[]): string {
  return 'm/' + addressNList.map((n) => {
    const hardened = n >= 0x80000000
    return `${hardened ? n - 0x80000000 : n}${hardened ? "'" : ''}`
  }).join('/')
}

/**
 * True when a decoded string is human-readable enough to show as the message
 * in the approval overlay. Empty strings and ones dominated by control
 * characters (NUL, etc.) return false so the UI falls back to the raw-hex view
 * + "not readable" warning instead of rendering a blank/ambiguous message.
 * Common whitespace (\n, \r, \t) is allowed.
 */
function isMostlyPrintable(text: string): boolean {
  if (!text) return false
  let printable = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) printable++
  }
  return printable / [...text].length >= 0.8
}

// ── Features cache (10s TTL, matches keepkey-desktop) ──────────────────
let featuresCache: { timestamp: number; data: any } | null = null
const FEATURES_TTL_MS = 10_000

async function getCachedFeatures(wallet: any): Promise<any> {
  const now = Date.now()
  if (featuresCache && (now - featuresCache.timestamp) < FEATURES_TTL_MS) {
    return featuresCache.data
  }
  const features = await wallet.getFeatures()
  featuresCache = { timestamp: now, data: features }
  return features
}

/** Clear features cache (call on device disconnect) */
export function clearFeaturesCache() {
  featuresCache = null
}

/**
 * Convert raw hdwallet features (camelCase) to keepkey-desktop REST format (snake_case).
 * Matches the types.Features schema from keepkey-sdk-server swagger spec.
 */
function formatFeatures(f: any): any {
  const decodeB64 = (x: any): string | undefined => {
    if (x === undefined || x === null) return undefined
    if (x instanceof Uint8Array || Buffer.isBuffer(x)) return Buffer.from(x).toString('hex')
    if (typeof x === 'string') {
      if (/^[0-9a-fA-F]+$/.test(x)) return x.toLowerCase()
      return Buffer.from(x, 'base64').toString('hex')
    }
    return undefined
  }

  return {
    vendor: f.vendor,
    major_version: f.majorVersion,
    minor_version: f.minorVersion,
    patch_version: f.patchVersion,
    bootloader_mode: f.bootloaderMode ?? false,
    device_id: f.deviceId,
    pin_protection: f.pinProtection,
    passphrase_protection: f.passphraseProtection,
    language: f.language,
    label: f.label,
    initialized: f.initialized,
    revision: decodeB64(f.revision),
    bootloader_hash: decodeB64(f.bootloaderHash),
    imported: f.imported,
    pin_cached: f.pinCached,
    passphrase_cached: f.passphraseCached,
    policies: Array.isArray(f.policiesList) ? f.policiesList.map((p: any) => ({
      policy_name: p.policyName ?? p.policy_name,
      enabled: p.enabled,
    })) : f.policies,
    model: f.model,
    firmware_variant: f.firmwareVariant,
    firmware_hash: decodeB64(f.firmwareHash),
    no_backup: f.noBackup,
    wipe_code_protection: f.wipeCodeProtection,
    auto_lock_delay_ms: f.autoLockDelayMs,
  }
}

// ── Public key cache (capped) ─────────────────────────────────────────
const MAX_CACHE_SIZE = 500
const pubkeyCache = new Map<string, any>()

// ── Address cache (capped) ────────────────────────────────────────────
const addressCache = new Map<string, string>()

/** Evict oldest entries from a Map (uses insertion-order iteration). */
function evictOldest<K, V>(cache: Map<K, V>, count: number) {
  let removed = 0
  for (const key of cache.keys()) {
    if (removed >= count) break
    cache.delete(key)
    removed++
  }
}

/** Cache key scoped by device_id — prevents cross-device pubkey leakage.
 *  deviceId is read at call time from engine; if no device is connected,
 *  we still prefix with `none:` so orphan entries can be flushed together. */
function scopedKey(engine: EngineController, prefix: string, body: unknown): string {
  const deviceId = engine.getDeviceState().deviceId || 'none'
  return `${deviceId}:${prefix}:${JSON.stringify(body)}`
}

/** Clear every pubkey cache entry. Call on device disconnect / device swap. */
export function clearPubkeyCache() {
  pubkeyCache.clear()
}

/** Clear every address cache entry. Call on device disconnect / device swap. */
export function clearAddressCache() {
  addressCache.clear()
}

// ── UI lifecycle signal ────────────────────────────────────────────────
// The WebView signals `setUiActive(true)` on mount and `setUiActive(false)`
// on unload. We use the active→inactive transition to flush caches so a
// later re-open cannot serve entries the user might assume were re-derived.
// Note: access control for these endpoints is handled by `auth.requireAuth`
// (paired-app API key) plus per-device cache scoping via `scopedKey`; we do
// NOT gate on UI visibility, because paired apps (e.g. the browser extension)
// must be able to refresh pubkeys after a device reconnect even when the
// Vault window is closed.
let uiActive = false

/** Called from RPC handler when the WebView signals its state. */
export function setUiActive(active: boolean, _viewDeviceId: string | null = null) {
  const wasActive = uiActive
  uiActive = active
  if (!active && wasActive) {
    // UI just closed — flush caches so next session can't serve stale pubkeys.
    clearPubkeyCache()
    clearAddressCache()
    clearFeaturesCache()
  }
}

/** Called from RPC handler on periodic heartbeat from the WebView.
 *  Retained as a no-op so the RPC contract with the frontend stays stable;
 *  cache lifecycle is driven entirely by `setUiActive` transitions now. */
export function uiHeartbeat(_viewDeviceId: string | null = null) {
  // intentionally empty
}

// ── Cosmos-family amino signing helper ─────────────────────────────────
async function cosmosAminoSign(
  wallet: any,
  auth: AuthStore,
  body: any,
  walletMethod: string,
  defaultDenom: string,
  defaultFeeAmount: string,
  defaultGas: string,
  wrapper?: (fn: () => Promise<any>) => Promise<any>,
): Promise<any> {
  const { signDoc, signerAddress } = body

  // Default fee if not provided
  if (!signDoc.fee || !signDoc.fee.amount || signDoc.fee.amount.length === 0) {
    signDoc.fee = {
      amount: [{ denom: defaultDenom, amount: defaultFeeAmount }],
      gas: defaultGas,
    }
  }

  const msgs = signDoc.msgs || signDoc.msg || []
  if (!Array.isArray(msgs) || msgs.length === 0) throw new HttpError(400, 'signDoc must contain at least one message (msgs or msg)')

  const tx = {
    account_number: String(signDoc.account_number),
    chain_id: signDoc.chain_id,
    fee: signDoc.fee,
    memo: signDoc.memo || '',
    msg: msgs,
    signatures: [],
    sequence: signDoc.sequence,
  }

  const { addressNList } = auth.getAccount(signerAddress)

  const input = {
    tx,
    addressNList,
    chain_id: tx.chain_id,
    account_number: tx.account_number,
    sequence: tx.sequence,
  }

  const callFn = () => (wallet as any)[walletMethod](input)
  const response = wrapper ? await wrapper(callFn) : await callFn()

  return {
    signature: response?.signatures?.[0] ?? response?.signature,
    serialized: response?.serialized,
    signed: signDoc,
  }
}

// ── ETH account scanning (scan first 5 accounts) ──────────────────────
async function findEthAddressNList(
  wallet: any,
  auth: AuthStore,
  fromAddress: string,
): Promise<number[]> {
  const lower = fromAddress.toLowerCase()

  // Check cache first
  try {
    return auth.getAccount(lower).addressNList
  } catch { /* not cached */ }

  // Scan first 5 account indices
  for (let i = 0; i < 5; i++) {
    const addressNList = [0x8000002C, 0x8000003C, 0x80000000 + i, 0, 0]
    const result = await wallet.ethGetAddress({ addressNList, showDisplay: false })
    const addr = (typeof result === 'string' ? result : result?.address || '').toLowerCase()
    if (addr) {
      auth.saveAccount(addr, addressNList)
      if (addr === lower) return addressNList
    }
  }
  throw new HttpError(400, `Could not find addressNList for ${fromAddress} (scanned 5 accounts)`)
}

// ── Load swagger.json once ─────────────────────────────────────────────
let swaggerContent: string | null = null
function getSwagger(): string {
  if (!swaggerContent) {
    try {
      swaggerContent = readFileSync(join(__dirname, 'swagger.json'), 'utf-8')
    } catch {
      swaggerContent = JSON.stringify({ error: 'swagger.json not found' })
    }
  }
  return swaggerContent
}

// ── Branded Swagger UI HTML ───────────────────────────────────────────
function getSwaggerUiHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>KeepKey Vault &mdash; Developer Center</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#0d1117;color:#e0e0e0;font-family:system-ui,-apple-system,sans-serif}

    .kk-header{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-bottom:2px solid #C0A860;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
    .kk-header-left{display:flex;align-items:center;gap:12px}
    .kk-header h1{margin:0;color:#C0A860;font-size:20px;font-weight:700}
    .kk-header .sub{color:#8a8a9a;font-size:13px}
    .kk-status{display:flex;align-items:center;gap:8px}
    .kk-status .dot{width:8px;height:8px;border-radius:50%;background:#555}
    .kk-status span{color:#8a8a9a;font-size:12px}
    .kk-status .key-badge{background:rgba(34,197,94,.15);color:#22c55e;padding:2px 8px;border-radius:4px;font-size:11px;font-family:'SF Mono',Menlo,monospace}

    .kk-tabs{display:flex;gap:0;background:#161b22;border-bottom:1px solid #30363d;padding:0 24px;flex-wrap:wrap}
    .kk-tab{padding:12px 20px;cursor:pointer;font-size:14px;font-weight:500;color:#8a8a9a;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;user-select:none}
    .kk-tab:hover{color:#e0e0e0}
    .kk-tab.active{color:#C0A860;border-bottom-color:#C0A860}
    .kk-tab.locked{opacity:.4;cursor:default;pointer-events:none}

    .kk-panel{display:none}
    .kk-panel.active{display:block}

    /* ── Guide ──────────────────────────────── */
    .guide{max-width:820px;margin:0 auto;padding:32px 24px;line-height:1.7}
    .guide h2{color:#C0A860;font-size:22px;margin:32px 0 12px;font-weight:600;border-bottom:1px solid #30363d;padding-bottom:8px}
    .guide h2:first-child{margin-top:0}
    .guide h3{color:#e0e0e0;font-size:16px;margin:24px 0 8px}
    .guide p{color:#b0b0c0;margin:8px 0}
    .guide code{background:#161b22;padding:2px 6px;border-radius:4px;font-family:'SF Mono',Menlo,monospace;font-size:13px;color:#C0A860}
    .guide pre{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;overflow-x:auto;margin:12px 0;position:relative}
    .guide pre code{background:none;padding:0;color:#e0e0e0;display:block;white-space:pre}
    .kw{color:#ff7b72}.str{color:#a5d6ff}.cmt{color:#8b949e}.fn{color:#d2a8ff}.num{color:#79c0ff}
    .steps{display:grid;grid-template-columns:40px 1fr;gap:12px;margin:16px 0}
    .sn{width:32px;height:32px;border-radius:50%;background:rgba(192,168,96,.15);color:#C0A860;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0}
    .sc{padding-top:4px}
    .chains{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:12px 0}
    .chip{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 12px;font-size:13px;text-align:center}
    .chip .cl{color:#e0e0e0;font-weight:500}.chip .cs{color:#8a8a9a;font-size:11px}
    .note{background:rgba(192,168,96,.08);border-left:3px solid #C0A860;padding:12px 16px;border-radius:0 6px 6px 0;margin:16px 0}
    .note strong{color:#C0A860}
    .note.warn{border-left-color:#eab308;background:rgba(234,179,8,.08)}
    .note.warn strong{color:#eab308}
    .guide table{width:100%;border-collapse:collapse;margin:12px 0}
    .guide th{text-align:left;color:#8a8a9a;font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding:8px 12px;border-bottom:1px solid #30363d}
    .guide td{padding:8px 12px;border-bottom:1px solid #1c2128;color:#b0b0c0;font-size:13px}
    .guide td code{font-size:12px}

    /* ── Pair panel ─────────────────────────── */
    .pair-wrap{max-width:500px;margin:40px auto;padding:0 24px}
    .pair-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px}
    .pair-card h2{color:#C0A860;margin:0 0 4px;font-size:18px}
    .pair-card .desc{color:#8a8a9a;font-size:13px;margin-bottom:20px}
    .pair-card label{display:block;color:#b0b0c0;font-size:13px;margin-bottom:6px;font-weight:500}
    .pair-card input{width:100%;padding:10px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e0e0e0;font-size:14px;margin-bottom:16px;outline:none}
    .pair-card input:focus{border-color:#C0A860}
    .pair-btn{width:100%;padding:12px;background:#C0A860;color:#0d1117;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
    .pair-btn:hover{background:#d4bc6a}
    .pair-btn:disabled{opacity:.5;cursor:not-allowed}
    .pair-result{margin-top:16px;padding:12px;border-radius:6px;font-size:13px;font-family:'SF Mono',Menlo,monospace;word-break:break-all}
    .pair-result.ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:#22c55e}
    .pair-result.err{background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.3);color:#f85149}
    .pair-sep{margin-top:20px;padding-top:20px;border-top:1px solid #30363d}
    .pair-row{display:flex;gap:8px}
    .pair-row input{margin-bottom:0;flex:1}
    .vfy-btn{padding:10px 16px;background:transparent;border:1px solid #30363d;border-radius:6px;color:#C0A860;font-size:13px;cursor:pointer;white-space:nowrap}
    .vfy-btn:hover{border-color:#C0A860}
    .paired-banner{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:8px;padding:16px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between}
    .paired-banner .left{display:flex;align-items:center;gap:10px}
    .paired-banner .dot{width:8px;height:8px;border-radius:50%;background:#22c55e}
    .paired-banner .info{font-size:13px;color:#22c55e}
    .paired-banner .info .key{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#8a8a9a;margin-top:2px}
    .unpair-btn{background:transparent;border:1px solid rgba(248,81,73,.3);color:#f85149;padding:6px 12px;border-radius:4px;font-size:12px;cursor:pointer}
    .unpair-btn:hover{background:rgba(248,81,73,.1)}

    /* ── Locked gate ────────────────────────── */
    .lock-gate{max-width:500px;margin:60px auto;text-align:center;padding:0 24px}
    .lock-gate h2{color:#C0A860;font-size:20px;margin-bottom:8px}
    .lock-gate p{color:#8a8a9a;font-size:14px;margin-bottom:20px}
    .lock-gate .go-pair{display:inline-block;padding:10px 24px;background:#C0A860;color:#0d1117;border-radius:6px;font-weight:600;cursor:pointer;font-size:14px;text-decoration:none;border:none}
    .lock-gate .go-pair:hover{background:#d4bc6a}

    /* ── Swagger overrides ──────────────────── */
    .swagger-ui{background:#0d1117}
    .swagger-ui .topbar{display:none}
    .swagger-ui .scheme-container{background:#0d1117;box-shadow:none}
    .swagger-ui .btn.authorize,.swagger-ui .authorization__btn{display:none !important}
    .swagger-ui .info .title{color:#e0e0e0}
    .swagger-ui .info p,.swagger-ui .info li{color:#b0b0c0}
    .swagger-ui .opblock-tag{color:#e0e0e0 !important;border-bottom-color:#30363d !important}
    .swagger-ui .opblock{border-color:#30363d;background:rgba(255,255,255,.02)}
    .swagger-ui .opblock .opblock-summary{border-color:#30363d}
    .swagger-ui .opblock .opblock-summary-description{color:#b0b0c0}
    .swagger-ui .opblock .opblock-summary-method{font-weight:700}
    .swagger-ui .opblock.opblock-get .opblock-summary-method{background:#2563EB}
    .swagger-ui .opblock.opblock-post .opblock-summary-method{background:#C0A860;color:#000}
    .swagger-ui .opblock.opblock-get{background:rgba(37,99,235,.06);border-color:rgba(37,99,235,.25)}
    .swagger-ui .opblock.opblock-post{background:rgba(192,168,96,.06);border-color:rgba(192,168,96,.25)}
    .swagger-ui .btn{border-radius:4px}
    .swagger-ui .btn.execute{background:#C0A860;color:#000;border:none}
    .swagger-ui .btn.execute:hover{background:#d4bc6a}
    .swagger-ui .model-box,.swagger-ui .models{background:rgba(255,255,255,.02)}
    .swagger-ui .model{color:#b0b0c0}
    .swagger-ui table thead tr th{color:#b0b0c0;border-bottom-color:#30363d}
    .swagger-ui table tbody tr td{color:#e0e0e0;border-bottom-color:#1c2128}
    .swagger-ui .parameter__name{color:#e0e0e0}
    .swagger-ui .parameter__type{color:#C0A860}
    .swagger-ui input[type=text],.swagger-ui textarea,.swagger-ui select{background:#0d1117;color:#e0e0e0;border-color:#30363d}
    .swagger-ui .loading-container .loading::after{color:#C0A860}
    .swagger-ui section.models{border-color:#30363d}
    .swagger-ui section.models h4{color:#e0e0e0}
    .swagger-ui .response-col_status{color:#e0e0e0}
    .swagger-ui .response-col_description{color:#b0b0c0}
    .swagger-ui .responses-inner h4,.swagger-ui .responses-inner h5{color:#e0e0e0}
    .swagger-ui .opblock-description-wrapper p{color:#b0b0c0}
    .swagger-ui .opblock-section-header{background:rgba(255,255,255,.02)}
    .swagger-ui .opblock-section-header h4{color:#e0e0e0}
    .swagger-ui .highlight-code{background:#161b22}
    .swagger-ui .microlight{background:#161b22 !important;color:#e0e0e0 !important}
  </style>
</head>
<body>

  <div class="kk-header">
    <div class="kk-header-left">
      <svg width="32" height="32" viewBox="0 0 100 100" fill="none">
        <rect width="100" height="100" rx="16" fill="#C0A860"/>
        <path d="M30 70V30h10v15l15-15h14L52 47l18 23H56L43 53l-3 3v14H30z" fill="#1a1a2e"/>
      </svg>
      <div>
        <h1>KeepKey Vault &mdash; Developer Center</h1>
        <span class="sub">Build on the KeepKey hardware wallet</span>
      </div>
    </div>
    <div class="kk-status">
      <div class="dot" id="sd"></div>
      <span id="st">checking&hellip;</span>
      <span class="key-badge" id="kb" style="display:none"></span>
    </div>
  </div>

  <div class="kk-tabs" id="tabs">
    <div class="kk-tab" data-tab="pair">Pair App</div>
    <div class="kk-tab" data-tab="guide">Getting Started</div>
    <div class="kk-tab" data-tab="examples">Examples</div>
    <div class="kk-tab" data-tab="explorer">API Explorer</div>
  </div>

  <!-- ═══ Pair App (default) ═══ -->
  <div class="kk-panel" id="panel-pair">
    <div class="pair-wrap">
      <div class="pair-card">
        <div id="paired-banner" style="display:none" class="paired-banner">
          <div class="left"><div class="dot"></div><div class="info">Paired<div class="key" id="paired-key"></div></div></div>
          <button class="unpair-btn" onclick="doUnpair()">Disconnect</button>
        </div>
        <h2 id="pair-title">Pair a New App</h2>
        <p class="desc" id="pair-desc">Register your application with the vault. Approve the pairing on your KeepKey device.</p>

        <div id="pair-form">
          <label for="pn">App Name</label>
          <input id="pn" placeholder="My Trading Bot" />
          <label for="pi">Icon URL <span style="color:#8a8a9a">(optional)</span></label>
          <input id="pi" placeholder="https://example.com/icon.png" />
          <button class="pair-btn" id="pb" onclick="doPair()">Pair App</button>
          <div id="pr"></div>

          <div class="pair-sep">
            <label for="ek">Already have a key?</label>
            <div class="pair-row">
              <input id="ek" placeholder="Paste API key&hellip;" />
              <button class="vfy-btn" onclick="doVerify()">Use Key</button>
            </div>
            <div id="vr"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ Getting Started ═══ -->
  <div class="kk-panel" id="panel-guide">
    <div class="guide">
      <h2>Quick Start</h2>
      <p>The KeepKey Vault exposes a local REST API on <code>localhost:1646</code>.
         Any app &mdash; web, mobile, CLI, or bot &mdash; can pair and interact
         with the hardware wallet.</p>
      <div class="steps">
        <div class="sn">1</div><div class="sc"><strong>Enable the API bridge</strong><p>Vault &rarr; Settings &rarr; toggle <em>API Bridge</em> on.</p></div>
        <div class="sn">2</div><div class="sc"><strong>Pair your app</strong><p><code>POST /auth/pair</code> with your app name. Approve on device. Get a bearer token.</p></div>
        <div class="sn">3</div><div class="sc"><strong>Make API calls</strong><p>Include the token in the <code>Authorization: Bearer ...</code> header.</p></div>
      </div>

      <h2>SDK Quick Start</h2>
<pre><code><span class="kw">import</span> { KeepKeySdk } <span class="kw">from</span> <span class="str">'@keepkey/keepkey-sdk'</span>

<span class="cmt">// Auto-pairs if no key saved</span>
<span class="kw">const</span> sdk = <span class="kw">await</span> KeepKeySdk.<span class="fn">create</span>({
  <span class="str">serviceName</span>: <span class="str">'My App'</span>,
  <span class="str">serviceImageUrl</span>: <span class="str">'https://example.com/icon.png'</span>,
})

<span class="cmt">// Get ETH address</span>
<span class="kw">const</span> { address } = <span class="kw">await</span> sdk.address.<span class="fn">ethGetAddress</span>({
  <span class="str">address_n</span>: [<span class="num">0x8000002C</span>, <span class="num">0x8000003C</span>, <span class="num">0x80000000</span>, <span class="num">0</span>, <span class="num">0</span>],
  <span class="str">show_display</span>: <span class="kw">true</span>,
})</code></pre>

      <h2>Supported Chains</h2>
      <div class="chains">
        <div class="chip"><div class="cl">Bitcoin</div><div class="cs">P2PKH / P2SH / SegWit</div></div>
        <div class="chip"><div class="cl">Ethereum</div><div class="cs">EIP-1559 / EIP-712</div></div>
        <div class="chip"><div class="cl">Cosmos</div><div class="cs">Amino + Protobuf</div></div>
        <div class="chip"><div class="cl">THORChain</div><div class="cs">Swap / Deposit</div></div>
        <div class="chip"><div class="cl">Mayachain</div><div class="cs">Swap / Deposit</div></div>
        <div class="chip"><div class="cl">Osmosis</div><div class="cs">LP / IBC / Swap</div></div>
        <div class="chip"><div class="cl">Solana</div><div class="cs">SPL tokens</div></div>
        <div class="chip"><div class="cl">XRP</div><div class="cs">Payments</div></div>
        <div class="chip"><div class="cl">TRON</div><div class="cs">TRC-20</div></div>
        <div class="chip"><div class="cl">TON</div><div class="cs">Jettons</div></div>
        <div class="chip"><div class="cl">Zcash</div><div class="cs">Shielded (Orchard)</div></div>
        <div class="chip"><div class="cl">EVM Chains</div><div class="cs">Polygon, Arb, OP, &hellip;</div></div>
      </div>

      <h2>Authentication</h2>
      <p>All endpoints except health, ping, docs, and spec require a bearer token:</p>
<pre><code><span class="kw">curl</span> http://localhost:1646/api/device/features \\
  -H <span class="str">"Authorization: Bearer YOUR_API_KEY"</span></code></pre>
      <div class="note">
        <strong>Device approval required</strong> &mdash; signing operations
        block until the user confirms or rejects on the KeepKey.
      </div>

      <h2>AI Agents (MCP)</h2>
      <p>AI agents connect over the Model Context Protocol at
         <code>POST /mcp</code> (JSON-RPC, not REST) to inspect wallet state and
         drive the KeepKey browser extension. Same pairing key as the REST API:</p>
<pre><code><span class="kw">claude</span> mcp add --transport http keepkey http://localhost:1646/mcp \\
  --header <span class="str">"Authorization: Bearer YOUR_API_KEY"</span></code></pre>
      <p>The tool catalog is served live from the extension &mdash; call
         <code>tools/list</code> for the source of truth. Full docs:
         <a href="https://docs.keepkey.com/docs/bex/mcp">docs.keepkey.com/docs/bex/mcp</a></p>

      <h2>Clear Signing</h2>
      <p>EVM contract calls are decoded on-device in human-readable form:</p>
      <table>
        <thead><tr><th>Type</th><th>Device display</th></tr></thead>
        <tbody>
          <tr><td>ERC-20 transfer</td><td>Token, amount, recipient</td></tr>
          <tr><td>ERC-20 approve</td><td>Token, spender, allowance</td></tr>
          <tr><td>DEX swaps</td><td>Input/output tokens, amounts</td></tr>
          <tr><td>EIP-712 typed data</td><td>Domain, message fields</td></tr>
          <tr><td>Unknown calldata</td><td>Raw hex + 4-byte selector</td></tr>
        </tbody>
      </table>

      <h2>Key Endpoints</h2>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th><th>Timeout</th></tr></thead>
        <tbody>
          <tr><td><code>GET</code></td><td><code>/api/health</code></td><td>Health &amp; version</td><td>5s</td></tr>
          <tr><td><code>POST</code></td><td><code>/auth/pair</code></td><td>Pair app (device approval)</td><td>600s</td></tr>
          <tr><td><code>POST</code></td><td><code>/system/info/get-features</code></td><td>Device info, firmware</td><td>30s</td></tr>
          <tr><td><code>POST</code></td><td><code>/addresses/eth</code></td><td>Derive ETH address</td><td>30s</td></tr>
          <tr><td><code>POST</code></td><td><code>/eth/sign-transaction</code></td><td>Sign EVM transaction</td><td>600s</td></tr>
          <tr><td><code>POST</code></td><td><code>/eth/sign-typed-data</code></td><td>Sign EIP-712</td><td>600s</td></tr>
          <tr><td><code>POST</code></td><td><code>/utxo/sign-transaction</code></td><td>Sign Bitcoin/UTXO tx</td><td>600s</td></tr>
          <tr><td><code>POST</code></td><td><code>/cosmos/sign-amino</code></td><td>Sign Cosmos amino</td><td>600s</td></tr>
          <tr><td><code>POST</code></td><td><code>/solana/sign-transaction</code></td><td>Sign Solana tx</td><td>600s</td></tr>
          <tr><td><code>POST</code></td><td><code>/api/zcash/shielded/display-address</code></td><td>Display device-derived Orchard UA</td><td>600s</td></tr>
          <tr><td><code>POST</code></td><td><code>/api/pubkeys/batch</code></td><td>Batch public keys</td><td>30s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/activity/recent</code></td><td>Wallet-facing recent activity (auth) — rebuilt tx history + swaps, current wallet scope only</td><td>5s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/activity</code></td><td>Raw signing/API audit log (auth) — filter by route/txid/chain/activityType/since/until</td><td>5s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/activity/:id</code></td><td>Single audit entry with full request/response bodies (auth)</td><td>5s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/swaps</code></td><td>Swap history (auth) — filter by status/asset/fromDate/toDate/limit/offset</td><td>5s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/swaps/stats</code></td><td>Aggregate counts: total/completed/failed/refunded/pending (auth)</td><td>5s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/swaps/:txid</code></td><td>Single swap record with full fee + memo + status detail (auth)</td><td>5s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/swap/availability/:caip</code></td><td>Picker classification for one CAIP-19 (debug) — assessment + provider list + reason (auth)</td><td>5s</td></tr>
          <tr><td><code>GET</code></td><td><code>/api/v1/swap/discovery</code></td><td>Search the unified asset universe (~30k); filter by ?q=&amp;status=&amp;limit= (auth)</td><td>5s</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- ═══ Examples ═══ -->
  <div class="kk-panel" id="panel-examples">
    <div class="guide">
      <div id="examples-gate" class="lock-gate" style="display:none">
        <h2>Pair First</h2>
        <p>You need an API key to try the examples. Pair your app to get started.</p>
        <button class="go-pair" onclick="switchTab('pair')">Go to Pair App</button>
      </div>
      <div id="examples-content">
        <h2>ETH &mdash; Simple Transfer</h2>
<pre><code><span class="cmt">// POST /eth/sign-transaction</span>
{
  <span class="str">"addressNList"</span>: [<span class="num">2147483692</span>, <span class="num">2147483708</span>, <span class="num">2147483648</span>, <span class="num">0</span>, <span class="num">0</span>],
  <span class="str">"nonce"</span>: <span class="str">"0x01"</span>,
  <span class="str">"gasLimit"</span>: <span class="str">"0x5208"</span>,
  <span class="str">"maxFeePerGas"</span>: <span class="str">"0x1dcd65000"</span>,
  <span class="str">"maxPriorityFeePerGas"</span>: <span class="str">"0x540ae480"</span>,
  <span class="str">"value"</span>: <span class="str">"0x2c68af0bb14000"</span>,
  <span class="str">"to"</span>: <span class="str">"0x12eC06288EDD7Ae2CC41A843fE089237fC7354F0"</span>,
  <span class="str">"chainId"</span>: <span class="num">1</span>,
  <span class="str">"data"</span>: <span class="str">""</span>
}</code></pre>
        <button class="pair-btn" style="max-width:200px;margin:8px 0 24px" onclick="tryExample('eth/sign-transaction',{addressNList:[2147483692,2147483708,2147483648,0,0],nonce:'0x01',gasLimit:'0x5208',maxFeePerGas:'0x1dcd65000',maxPriorityFeePerGas:'0x540ae480',value:'0x2c68af0bb14000',to:'0x12eC06288EDD7Ae2CC41A843fE089237fC7354F0',chainId:1,data:''})">Try it</button>

        <h2>ETH &mdash; ERC-20 Transfer</h2>
<pre><code><span class="cmt">// POST /eth/sign-transaction</span>
{
  <span class="str">"addressNList"</span>: [<span class="num">2147483692</span>, <span class="num">2147483708</span>, <span class="num">2147483648</span>, <span class="num">0</span>, <span class="num">0</span>],
  <span class="str">"nonce"</span>: <span class="str">"0x01"</span>,
  <span class="str">"gasLimit"</span>: <span class="str">"0x14"</span>,
  <span class="str">"gasPrice"</span>: <span class="str">"0x14"</span>,
  <span class="str">"value"</span>: <span class="str">"0x00"</span>,
  <span class="str">"to"</span>: <span class="str">"0x41e5560054824ea6b0732e656e3ad64e20e94e45"</span>,  <span class="cmt">// token contract</span>
  <span class="str">"chainId"</span>: <span class="num">1</span>,
  <span class="str">"data"</span>: <span class="str">"0xa9059cbb0000000000000000000000001d8ce9022f6284c3a5c317f8f34620107d727445000000000000000000000000000000000000000000000000000000000bebc200"</span>
}</code></pre>
        <button class="pair-btn" style="max-width:200px;margin:8px 0 24px" onclick="tryExample('eth/sign-transaction',{addressNList:[2147483692,2147483708,2147483648,0,0],nonce:'0x01',gasLimit:'0x14',gasPrice:'0x14',value:'0x00',to:'0x41e5560054824ea6b0732e656e3ad64e20e94e45',chainId:1,data:'0xa9059cbb0000000000000000000000001d8ce9022f6284c3a5c317f8f34620107d727445000000000000000000000000000000000000000000000000000000000bebc200'})">Try it</button>

        <h2>ETH &mdash; Sign Message</h2>
<pre><code><span class="cmt">// POST /eth/sign</span>
{
  <span class="str">"address"</span>: <span class="str">"0x3f2329C9ADFbcCd9A84f52c906E936A42dA18CB8"</span>,
  <span class="str">"message"</span>: <span class="str">"0x48656c6c6f20576f726c64"</span>  <span class="cmt">// "Hello World"</span>
}</code></pre>
        <button class="pair-btn" style="max-width:200px;margin:8px 0 24px" onclick="tryExample('eth/sign',{address:'0x3f2329C9ADFbcCd9A84f52c906E936A42dA18CB8',message:'0x48656c6c6f20576f726c64'})">Try it</button>

        <h2>ETH &mdash; Get Address</h2>
<pre><code><span class="cmt">// POST /addresses/eth</span>
{
  <span class="str">"address_n"</span>: [<span class="num">2147483692</span>, <span class="num">2147483708</span>, <span class="num">2147483648</span>, <span class="num">0</span>, <span class="num">0</span>],
  <span class="str">"show_display"</span>: <span class="kw">true</span>
}</code></pre>
        <button class="pair-btn" style="max-width:200px;margin:8px 0 24px" onclick="tryExample('addresses/eth',{address_n:[2147483692,2147483708,2147483648,0,0],show_display:true})">Try it</button>

        <h2>Cosmos &mdash; Transfer</h2>
<pre><code><span class="cmt">// POST /cosmos/sign-amino</span>
{
  <span class="str">"signerAddress"</span>: <span class="str">"cosmos15cenya0tr7nm3tz2wn3h3zwkht2rxrq7q7h3dj"</span>,
  <span class="str">"signDoc"</span>: {
    <span class="str">"chain_id"</span>: <span class="str">"cosmoshub-4"</span>,
    <span class="str">"account_number"</span>: <span class="str">"16359"</span>,
    <span class="str">"sequence"</span>: <span class="str">"17"</span>,
    <span class="str">"fee"</span>: { <span class="str">"amount"</span>: [{ <span class="str">"amount"</span>: <span class="str">"100"</span>, <span class="str">"denom"</span>: <span class="str">"uatom"</span> }], <span class="str">"gas"</span>: <span class="str">"100000"</span> },
    <span class="str">"memo"</span>: <span class="str">""</span>,
    <span class="str">"msgs"</span>: [{
      <span class="str">"type"</span>: <span class="str">"cosmos-sdk/MsgSend"</span>,
      <span class="str">"value"</span>: {
        <span class="str">"amount"</span>: [{ <span class="str">"amount"</span>: <span class="str">"1000"</span>, <span class="str">"denom"</span>: <span class="str">"uatom"</span> }],
        <span class="str">"from_address"</span>: <span class="str">"cosmos15cenya0tr7nm3tz2wn3h3zwkht2rxrq7q7h3dj"</span>,
        <span class="str">"to_address"</span>: <span class="str">"cosmos1qjwdyn56ecagk8rjf7crrzwcyz6775cj89njn3"</span>
      }
    }]
  }
}</code></pre>
        <button class="pair-btn" style="max-width:200px;margin:8px 0 24px" onclick="tryExample('cosmos/sign-amino',{signerAddress:'cosmos15cenya0tr7nm3tz2wn3h3zwkht2rxrq7q7h3dj',signDoc:{chain_id:'cosmoshub-4',account_number:'16359',sequence:'17',fee:{amount:[{amount:'100',denom:'uatom'}],gas:'100000'},memo:'',msgs:[{type:'cosmos-sdk/MsgSend',value:{amount:[{amount:'1000',denom:'uatom'}],from_address:'cosmos15cenya0tr7nm3tz2wn3h3zwkht2rxrq7q7h3dj',to_address:'cosmos1qjwdyn56ecagk8rjf7crrzwcyz6775cj89njn3'}}]}})">Try it</button>

        <h2>THORChain &mdash; Transfer</h2>
<pre><code><span class="cmt">// POST /thorchain/sign-amino-transfer</span>
{
  <span class="str">"signerAddress"</span>: <span class="str">"thor1ls33ayg26kmltw7jjy55p32ghjna09zp74t4az"</span>,
  <span class="str">"signDoc"</span>: {
    <span class="str">"chain_id"</span>: <span class="str">"thorchain-mainnet-v1"</span>,
    <span class="str">"account_number"</span>: <span class="str">"17"</span>,
    <span class="str">"sequence"</span>: <span class="str">"2"</span>,
    <span class="str">"fee"</span>: { <span class="str">"amount"</span>: [{ <span class="str">"amount"</span>: <span class="str">"3000"</span>, <span class="str">"denom"</span>: <span class="str">"rune"</span> }], <span class="str">"gas"</span>: <span class="str">"200000"</span> },
    <span class="str">"memo"</span>: <span class="str">""</span>,
    <span class="str">"msgs"</span>: [{
      <span class="str">"type"</span>: <span class="str">"thorchain/MsgSend"</span>,
      <span class="str">"value"</span>: {
        <span class="str">"amount"</span>: [{ <span class="str">"amount"</span>: <span class="str">"100"</span>, <span class="str">"denom"</span>: <span class="str">"rune"</span> }],
        <span class="str">"from_address"</span>: <span class="str">"thor1ls33ayg26kmltw7jjy55p32ghjna09zp74t4az"</span>,
        <span class="str">"to_address"</span>: <span class="str">"thor1wy58774wagy4hkljz9mchhqtgk949zdwwe80d5"</span>
      }
    }]
  }
}</code></pre>
        <button class="pair-btn" style="max-width:200px;margin:8px 0 24px" onclick="tryExample('thorchain/sign-amino-transfer',{signerAddress:'thor1ls33ayg26kmltw7jjy55p32ghjna09zp74t4az',signDoc:{chain_id:'thorchain-mainnet-v1',account_number:'17',sequence:'2',fee:{amount:[{amount:'3000',denom:'rune'}],gas:'200000'},memo:'',msgs:[{type:'thorchain/MsgSend',value:{amount:[{amount:'100',denom:'rune'}],from_address:'thor1ls33ayg26kmltw7jjy55p32ghjna09zp74t4az',to_address:'thor1wy58774wagy4hkljz9mchhqtgk949zdwwe80d5'}}]}})">Try it</button>

        <h2>Device &mdash; Get Features</h2>
<pre><code><span class="cmt">// POST /system/info/get-features</span>
<span class="cmt">// (no body required)</span></code></pre>
        <button class="pair-btn" style="max-width:200px;margin:8px 0 24px" onclick="tryExample('system/info/get-features',{})">Try it</button>

        <!-- Result display -->
        <div id="try-result" style="display:none">
          <h3 style="color:#C0A860">Response</h3>
          <pre><code id="try-result-body"></code></pre>
        </div>
      </div>
    </div>
  </div>

  <!-- ═══ API Explorer ═══ -->
  <div class="kk-panel" id="panel-explorer">
    <div id="explorer-gate" class="lock-gate" style="display:none">
      <h2>Pair First</h2>
      <p>Pair your app to unlock the interactive API explorer with your bearer token pre-filled.</p>
      <button class="go-pair" onclick="switchTab('pair')">Go to Pair App</button>
    </div>
    <div id="swagger-ui"></div>
  </div>

  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    var STORAGE_KEY='kk_dev_apikey'
    var swaggerLoaded=false

    function getKey(){return localStorage.getItem(STORAGE_KEY)||''}
    function setKey(key){
      if(key)localStorage.setItem(STORAGE_KEY,key);else localStorage.removeItem(STORAGE_KEY)
      swaggerLoaded=false
      document.getElementById('swagger-ui').innerHTML=''
      refreshUI()
    }

    /* ── Timeout helper (AbortSignal.timeout fallback) ── */
    function timeoutSignal(ms){
      if(typeof AbortSignal.timeout==='function')return AbortSignal.timeout(ms)
      var c=new AbortController()
      setTimeout(function(){c.abort()},ms)
      return c.signal
    }

    /* ── Tab switching ───────────────────────── */
    function switchTab(name){
      document.querySelectorAll('.kk-tab').forEach(function(x){x.classList.remove('active')})
      document.querySelectorAll('.kk-panel').forEach(function(x){x.classList.remove('active')})
      var tab=document.querySelector('[data-tab="'+name+'"]')
      if(tab)tab.classList.add('active')
      document.getElementById('panel-'+name).classList.add('active')
      if(name==='explorer')loadSwagger()
    }
    document.querySelectorAll('.kk-tab').forEach(function(t){
      t.addEventListener('click',function(){
        if(t.classList.contains('locked'))return
        switchTab(t.dataset.tab)
      })
    })

    /* ── Load Swagger with live key lookup ────── */
    function loadSwagger(){
      var key=getKey()
      if(!key){
        document.getElementById('explorer-gate').style.display='block'
        document.getElementById('swagger-ui').style.display='none'
        return
      }
      document.getElementById('explorer-gate').style.display='none'
      document.getElementById('swagger-ui').style.display='block'
      if(swaggerLoaded)return
      swaggerLoaded=true
      SwaggerUIBundle({
        url:'/spec/swagger.json',
        dom_id:'#swagger-ui',
        deepLinking:true,
        presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout:'BaseLayout',
        requestInterceptor:function(req){
          var live=getKey()
          if(live)req.headers['Authorization']='Bearer '+live
          return req
        }
      })
    }

    /* ── Health status polling ────────────────── */
    function checkHealth(){
      fetch('/api/health',{signal:timeoutSignal(3000)})
        .then(function(r){return r.json()})
        .then(function(d){
          document.getElementById('sd').style.background=d.connected?'#22c55e':'#eab308'
          document.getElementById('st').textContent=d.connected
            ?'device connected \u2014 v'+(d.version||'')
            :'no device'
        })
        .catch(function(){
          document.getElementById('sd').style.background='#f85149'
          document.getElementById('st').textContent='offline'
        })
    }
    checkHealth();setInterval(checkHealth,10000)

    /* ── UI refresh based on key state ───────── */
    function refreshUI(){
      var key=getKey()
      var kb=document.getElementById('kb')
      var banner=document.getElementById('paired-banner')
      var form=document.getElementById('pair-form')
      var title=document.getElementById('pair-title')
      var desc=document.getElementById('pair-desc')
      var exGate=document.getElementById('examples-gate')
      var exContent=document.getElementById('examples-content')
      var lockedTabs=document.querySelectorAll('[data-tab="examples"],[data-tab="explorer"]')
      if(key){
        kb.style.display='inline';kb.textContent='paired'
        banner.style.display='flex'
        document.getElementById('paired-key').textContent=key.slice(0,8)+'...'
        form.style.display='none'
        title.textContent='Connected'
        desc.textContent='Your app is paired. Use the Examples and API Explorer tabs.'
        if(exGate){exGate.style.display='none';exContent.style.display='block'}
        lockedTabs.forEach(function(t){t.classList.remove('locked')})
      }else{
        kb.style.display='none'
        banner.style.display='none'
        form.style.display='block'
        title.textContent='Pair a New App'
        desc.textContent='Register your application with the vault. Approve the pairing on your KeepKey device.'
        if(exGate){exGate.style.display='block';exContent.style.display='none'}
        lockedTabs.forEach(function(t){t.classList.add('locked')})
      }
    }

    /* ── Pair ─────────────────────────────────── */
    function doPair(){
      var name=document.getElementById('pn').value.trim()
      if(!name)return
      var btn=document.getElementById('pb'),res=document.getElementById('pr')
      btn.disabled=true;btn.textContent='Approve on device\u2026'
      res.className='pair-result';res.textContent=''
      fetch('/auth/pair',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:name,imageUrl:document.getElementById('pi').value.trim()||undefined})
      })
      .then(function(r){return r.json()})
      .then(function(d){
        if(d.apiKey){
          res.className='pair-result ok';res.textContent='Paired! Key: '+d.apiKey
          setKey(d.apiKey)
        }else{
          res.className='pair-result err';res.textContent=d.error||'Pairing rejected'
        }
      })
      .catch(function(e){res.className='pair-result err';res.textContent='Error: '+e.message})
      .finally(function(){btn.disabled=false;btn.textContent='Pair App'})
    }

    function doVerify(){
      var key=document.getElementById('ek').value.trim()
      if(!key)return
      var res=document.getElementById('vr')
      fetch('/auth/pair',{headers:{'Authorization':'Bearer '+key}})
        .then(function(r){return r.json()})
        .then(function(d){
          res.style.marginTop='12px'
          if(d.paired){
            res.className='pair-result ok'
            res.textContent='Valid \u2014 paired as "'+(d.name||'unknown')+'"'
            setKey(key)
          }else{
            res.className='pair-result err'
            res.textContent='Invalid or expired key'
          }
        })
        .catch(function(e){
          res.className='pair-result err';res.textContent='Error: '+e.message
          res.style.marginTop='12px'
        })
    }

    function doUnpair(){
      setKey('')
      switchTab('pair')
    }

    /* ── Try examples ────────────────────────── */
    function tryExample(endpoint,body){
      var key=getKey()
      if(!key){switchTab('pair');return}
      var rd=document.getElementById('try-result')
      var rb=document.getElementById('try-result-body')
      rd.style.display='block'
      rb.textContent='Sending... (approve on device if prompted)'
      fetch('/'+endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
        body:JSON.stringify(body),
        signal:timeoutSignal(120000)
      })
      .then(function(r){
        if(!r.ok)return r.text().then(function(t){
          try{return JSON.parse(t)}catch(e){throw new Error(r.status+': '+t.slice(0,200))}
        })
        return r.json()
      })
      .then(function(d){rb.textContent=JSON.stringify(d,null,2)})
      .catch(function(e){rb.textContent='Error: '+e.message})
      rd.scrollIntoView({behavior:'smooth'})
    }

    /* ── Init ─────────────────────────────────── */
    refreshUI()
    if(getKey()){switchTab('guide')}else{switchTab('pair')}
  </script>
</body>
</html>`
}

/** Convert addressNList to BIP32 string, e.g. [0x8000002C, 0x80000000, 0x80000000] → "m/44'/0'/0'" */
function addressNListToBIP32(addressNList: number[]): string {
  return 'm/' + addressNList.map(n => n >= 0x80000000 ? `${n - 0x80000000}'` : String(n)).join('/')
}

/** Start time for uptime calculation */
const startTime = Date.now()

/** Route prefix → chain symbol for activity tracking */
const ROUTE_TO_CHAIN: Record<string, string> = {
  eth: 'ETH', utxo: 'BTC', cosmos: 'ATOM', osmosis: 'OSMO',
  thorchain: 'RUNE', mayachain: 'CACAO', xrp: 'XRP',
  solana: 'SOL', tron: 'TRX', ton: 'TON', hive: 'HIVE',
}

export function startRestApi(engine: EngineController, auth: AuthStore, port = 1646, callbacks?: RestApiCallbacks) {
  const getWalletDbScope = (): { deviceId: string; walletId: string } | null => {
    const deviceId = engine.getDeviceState().deviceId
    if (!deviceId) return null
    const seedId = engine.currentSeedEthAddress?.toLowerCase()
    if (!seedId) return null
    return { deviceId, walletId: `${deviceId}:${seedId}` }
  }

  // Device-swap detection: if deviceId changes between two `ready` states,
  // pubkey/address caches must be flushed or the old device's xpubs will
  // leak. (lastDeviceId is also flushed on disconnect so a re-connect of the
  // SAME device will repopulate from scratch.)
  let lastDeviceId: string | null = null
  engine.on('state-change', (state) => {
    const nextId = state.deviceId ?? null
    if (state.state === 'disconnected') {
      clearFeaturesCache()
      clearPubkeyCache()
      clearAddressCache()
      lastDeviceId = null
      return
    }
    if (nextId && lastDeviceId && nextId !== lastDeviceId) {
      clearFeaturesCache()
      clearPubkeyCache()
      clearAddressCache()
    }
    if (nextId) lastDeviceId = nextId
  })

  /**
   * Wrap a device operation for emulator safety.
   * When the emulator is active, signing/display ops trigger firmware's
   * confirm_helper() — a blocking C loop inside kkemu_poll(). Without the
   * wrapper, the JS event loop freezes permanently (83% CPU spin).
   */
  function emuWrap<T>(fn: () => Promise<T>, details: EmuSigningDetails, condition = true): Promise<T> {
    if (condition && engine.isEmulator && callbacks?.emuSigningOp) {
      return callbacks.emuSigningOp(fn, details) as Promise<T>
    }
    return fn()
  }

  /** Non-Bitcoin address-derivation endpoints. Bitcoin-only firmware can't
   *  derive any of these — Pioneer still polls them during portfolio sync, so
   *  we short-circuit them (below) instead of hitting the device, which would
   *  return "Unknown message" and flood the log. `/addresses/utxo` is BTC. */
  const NON_BTC_ADDRESS_PATHS = new Set([
    '/addresses/cosmos', '/addresses/osmosis', '/addresses/eth', '/addresses/tendermint',
    '/addresses/thorchain', '/addresses/mayachain', '/addresses/xrp', '/addresses/solana',
    '/addresses/tron', '/addresses/ton', '/addresses/hive',
  ])

  /** True when the connected device runs bitcoin-only firmware. */
  function deviceIsBitcoinOnly(): boolean {
    return isBitcoinOnlyVariant(engine.getDeviceState().firmwareVariant)
  }

  /** Return 501 if firmware doesn't meet the chain's minFirmware requirement. */
  /** Normalize showDisplay to boolean (undefined → false). */
  function showDisplay(requested: boolean | undefined): boolean {
    return requested ?? false
  }

  const server = Bun.serve({
    port,
    maxRequestBodySize: 1024 * 1024, // 1 MB max (addresses/signing payloads are small)
    // Keep Bun's default idle timeout for the server as a whole (so idle/
    // unauthenticated connections still get reaped) — but lift it per-request
    // for human-gated device operations below, where the response legitimately
    // blocks while the user confirms on the device. Without that, Bun closes
    // the socket mid-confirm ("other side closed" → the device cancels the
    // confirm and returns home), which killed the second consecutive sign.
    async fetch(req, server) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method
      const requestStart = Date.now()

      // Human-gated device ops (signing + the clear-sign trust confirm) block
      // the socket while the user presses the physical button. Disable the idle
      // timeout for just these requests, not the whole server.
      if (method === 'POST' && (SIGNING_ROUTES.has(path) || path === '/eth/clearsign/load-signer')) {
        server.timeout(req, 0)
      }

      // Bitcoin-only firmware can't derive any non-Bitcoin chain. Pioneer still
      // polls these address endpoints during portfolio sync — short-circuit with
      // 501 before touching the device, which would otherwise reject the message
      // ("Unknown message") and flood the log with multi-chain spam.
      if (method === 'POST' && NON_BTC_ADDRESS_PATHS.has(path) && deviceIsBitcoinOnly()) {
        return new Response(JSON.stringify({ error: 'not available on bitcoin-only firmware' }),
          { status: 501, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } })
      }

      // Resolve app info from bearer token (or 'public')
      const resolveAppInfo = (): { appName: string; imageUrl: string } => {
        const token = auth.extractBearerToken(req)
        if (!token) return { appName: 'public', imageUrl: '' }
        const entry = auth.validate(token)
        return { appName: entry?.info?.name || 'paired', imageUrl: entry?.info?.imageUrl || '' }
      }

      // Request-scoped body capture (set by POST handlers before json() is called)
      let reqBody: any = undefined

      // Per-request response helpers (capture req for CORS origin check)
      const json = (data: unknown, status = 200, activity?: { txid?: string; chain?: string; activityType?: string }) => {
        const resp = new Response(JSON.stringify(data), {
          status, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
        })
        // Auto-detect activity type from route if not explicitly provided
        let resolvedActivity = activity
        if (!resolvedActivity && method === 'POST' && SIGNING_ROUTES.has(path) && status >= 200 && status < 300) {
          const chainForRoute = ROUTE_TO_CHAIN[path.split('/')[1]]
          if (chainForRoute) resolvedActivity = { chain: chainForRoute, activityType: 'sign' }
        }
        // Log the request with body + response + duration.
        // Sanitize: strip sensitive fields from signing payloads to prevent
        // leaking signatures, transaction data, or typed-data content to audit log.
        //
        // The audit-log read endpoints don't get logged — otherwise each read
        // would persist the full prior history into a new row, recursively
        // ballooning response_body across repeated reads.
        const skipAuditLog = path.startsWith('/api/v1/activity') || path.startsWith('/api/v1/ledger') || path === '/docs' || path === '/admin/info' || path === '/auth/pair'
        if (callbacks?.onApiLog && !skipAuditLog) {
          const { appName, imageUrl } = resolveAppInfo()
          // Audit logs are stored locally (SQLite) on the user's own machine,
          // so the signing *inputs* (message, typedData, calldata, etc.) must
          // be preserved verbatim — they're the exact thing a user needs to
          // replay when debugging "what did I just sign?". Redacting them
          // would defeat the audit log's primary purpose.
          //
          // The signed *outputs* (signature blob, serialized tx) are already
          // returned to the dApp in the response body and don't add debug
          // value when duplicated in the log, so we still trim those to keep
          // log rows compact.
          // Note: 'signature' is intentionally NOT trimmed — at ~130 chars it's small,
          // and the audit log is the only place to retrieve a prior signature for
          // regression debugging (recover-and-compare) without re-issuing the sign.
          const SENSITIVE_OUTPUT_KEYS = new Set([
            'apiKey', 'serialized', 'serializedTx', 'signedTx', 'signed', 'signedPayload',
          ])
          const trimOutputs = (obj: any, depth = 0): any => {
            if (!obj || typeof obj !== 'object' || depth > 8) return obj
            if (Array.isArray(obj)) {
              if (obj.length > 50) return `[trimmed ${obj.length} items]`
              return obj.map(v => trimOutputs(v, depth + 1))
            }
            const out: any = {}
            for (const [k, v] of Object.entries(obj)) {
              if (SENSITIVE_OUTPUT_KEYS.has(k)) { out[k] = '[trimmed]'; continue }
              out[k] = (v && typeof v === 'object') ? trimOutputs(v, depth + 1) : v
            }
            return out
          }
          callbacks.onApiLog({
            method, route: path, timestamp: requestStart,
            durationMs: Date.now() - requestStart,
            status, appName, imageUrl: imageUrl || undefined,
            // Request body kept as-is so the user can see what they signed.
            requestBody: reqBody,
            // Response body trims large or sensitive output blobs but leaves compact
            // fields intact for local debugging.
            responseBody: trimOutputs(data),
            ...resolvedActivity,
          })
        }
        return resp
      }

      // Firmware gate for chain routes. Lives INSIDE the request scope because
      // it returns via the per-request json() helper (CORS + audit logging) —
      // defined at server scope it threw "json is not defined" the moment the
      // gate actually fired (observed on POST /addresses/hive).
      function requireChainSupport(chainId: string): Response | null {
        const chain = CHAINS.find(c => c.id === chainId)
        if (!chain?.minFirmware) return null
        const fw = engine.getDeviceState().firmwareVersion
        if (!fw || !isChainSupported(chain, fw)) {
          return json({ error: `${chain.symbol} requires firmware ≥ ${chain.minFirmware} (device has ${fw ?? 'unknown'})` }, 501)
        }
        return null
      }

      // ── MCP agent bridge (EPIC_mcp_agent_bridge.md, keepkey-client) ──
      // LOOPBACK + LOCAL-AGENT ONLY, handled BEFORE the shared CORS/OPTIONS
      // path below so /mcp owns its own preflight and never inherits the
      // permissive wildcard CORS the rest of the (bearer-authed) API uses.
      //
      // A loopback peer IP is NOT a trust boundary against web pages: a
      // fetch() from ANY site the user visits has peer 127.0.0.1 because the
      // browser runs locally. /mcp carries no bearer token (so `claude mcp
      // add` stays zero-config), so browsers are excluded two other ways:
      //   1. reject any non-local Origin — the MCP Streamable-HTTP
      //      DNS-rebinding defense. A local CLI agent sends no Origin; every
      //      browser request (incl. a DNS-rebound public page pointing at
      //      127.0.0.1) carries one.
      //   2. never emit ACAO:* / Allow-Private-Network on /mcp — without them
      //      a browser can neither read the response nor clear Chrome's PNA
      //      preflight. The BEX Agent-mode toggle is a second gate, not the only one.
      // /bex-bridge stays token-gated (the extension is a chrome-extension://
      // origin needing a valid pairing key; https→ws://localhost is
      // mixed-content-blocked for web pages regardless).
      if (path === '/mcp' || path === '/bex-bridge') {
        const ip = server.requestIP(req)?.address
        const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
        if (!isLoopback) {
          return new Response(JSON.stringify({ error: 'loopback only' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } })
        }

        if (path === '/bex-bridge') {
          // BEX authenticates with its existing pairing key. Browser WebSocket
          // can't set an Authorization header, so the key arrives as ?token=.
          const token = url.searchParams.get('token') || auth.extractBearerToken(req)
          if (!token || !auth.validate(token)) {
            return new Response('Unauthorized', { status: 401 })
          }
          if (server.upgrade(req)) return undefined as any
          return new Response('WebSocket upgrade failed', { status: 400 })
        }

        // /mcp is BEARER-AUTHENTICATED with the same pairing API keys as the
        // rest of the REST API (see the auth.requireAuth below) AND excludes all
        // browser traffic. Both matter: a localhost-origin allowlist is not a
        // boundary because the vault serves browser content at its OWN origin
        // (the /wc dApp reverse-proxy below, the Swagger UI that loads remote JS
        // from unpkg) which runs as http://localhost:1646 — and such content may
        // even hold the user's bearer token. A browser attaches an `Origin`
        // header to every non-GET request (incl. same-origin POST) and
        // `Sec-Fetch-Site` to every request, and JS cannot strip either (both are
        // forbidden header names); a non-browser agent sends neither.
        if (req.headers.get('origin') !== null || req.headers.get('sec-fetch-site') !== null) {
          return new Response(JSON.stringify({ error: '/mcp is not reachable from a browser' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } })
        }
        if (method === 'OPTIONS') return new Response(null, { status: 204 }) // deliberately no CORS grant
        if (method === 'POST') {
          // Require a valid pairing bearer token — configure the agent with
          //   claude mcp add keepkey --transport http http://localhost:1646/mcp \
          //     --header "Authorization: Bearer <pairing-key>"
          //
          // requireAuth signals failure by THROWING HttpError, and this whole
          // /mcp block runs before the try/catch further down that turns an
          // HttpError into its status — Bun.serve has no top-level `error`
          // handler either, so an uncaught throw escapes fetch() and the agent
          // gets a dropped socket ("fetch failed") instead of 401. Catch here.
          try {
            auth.requireAuth(req)
          } catch (err: any) {
            return new Response(JSON.stringify({ error: err?.message || 'Unauthorized' }),
              { status: typeof err?.status === 'number' ? err.status : 401,
                headers: { 'Content-Type': 'application/json' } })
          }
          return handleMcpRequest(req, {})
        }
        return new Response(JSON.stringify({ error: 'POST only' }),
          { status: 405, headers: { 'Content-Type': 'application/json' } })
      }

      // CORS preflight (all other paths — bearer-token-authed API)
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(req) })
      }

      // ═══════════════════════════════════════════════════════════════
      // WC DAPP REVERSE PROXY — serves external WC dapp as same-origin
      // Avoids WKWebView mixed-content block (https iframe → http://localhost).
      //
      // All intentional proxy access goes through /wc/*.
      // Next.js emits absolute paths (/_next/, /chain-logos/, /icons/) that
      // can't be prefixed — so we Referer-gate them: only proxy when the
      // request originates from the WC panel.
      // ═══════════════════════════════════════════════════════════════
      const WC_ORIGIN = 'https://wallet-connect-dapp-ochre.vercel.app'

      // Allowlist of upstream path prefixes the proxy may serve
      const WC_ALLOWED_PREFIXES = ['/_next/', '/chain-logos/', '/icons/', '/favicon.ico']

      const rewriteWcProxyBody = (body: string): string => body
        .replace(/keepkey:\/\/launch\/wc/g, 'keepkey-vault://launch/wc')
        .replace(/keepkey:\/\/wc/g, 'keepkey-vault://wc')
        .replace(/keepkey%3A%2F%2Flaunch%2Fwc/gi, 'keepkey-vault%3A%2F%2Flaunch%2Fwc')
        .replace(/keepkey%3A%2F%2Fwc/gi, 'keepkey-vault%3A%2F%2Fwc')
        .replace(/KeepKey Desktop/g, 'KeepKey Vault')
        .replace(/Launch Desktop/g, 'Launch Vault')

      // Primary: everything under /wc/ is always proxied
      const isWcPrimaryPath = path === '/wc' || path.startsWith('/wc/')

      // Secondary: absolute paths leaked by Next.js — only proxy when
      // the Referer proves the request came from the WC panel iframe
      const referer = req.headers.get('Referer') || ''
      const isWcRefererPath = referer.includes('/wc') &&
        WC_ALLOWED_PREFIXES.some(p => path.startsWith(p) || path === p)

      if (isWcPrimaryPath || isWcRefererPath) {
        // Only allow GET — the proxy serves static assets, not API calls
        if (method !== 'GET') {
          return new Response(JSON.stringify({ error: 'Method not allowed on proxy' }), {
            status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }

        // /wc/* → strip prefix; Referer-gated paths pass through as-is
        const upstreamPath = path.startsWith('/wc/')
          ? path.slice(3) // "/wc/foo" → "/foo"
          : path === '/wc' ? '/' : path

        // Denylist: never proxy paths that look like vault API routes
        if (upstreamPath.startsWith('/api/') || upstreamPath.startsWith('/auth/') || upstreamPath.startsWith('/system/')) {
          return json({ error: 'Not found', path }, 404)
        }

        const upstreamUrl = WC_ORIGIN + upstreamPath + url.search
        const proxyStart = Date.now()
        try {
          const upstream = await fetch(upstreamUrl, {
            method: 'GET',
            headers: { 'Accept': req.headers.get('Accept') || '*/*' },
            redirect: 'follow',
          })
          // Pass through content-type, cache-control, and status
          const respHeaders: Record<string, string> = { ...corsHeaders(req) }
          const ct = upstream.headers.get('Content-Type')
          if (ct) respHeaders['Content-Type'] = ct
          const cc = upstream.headers.get('Cache-Control')
          if (cc) respHeaders['Cache-Control'] = cc

          // Audit log proxy requests
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({
              method, route: path, timestamp: proxyStart,
              durationMs: Date.now() - proxyStart,
              status: upstream.status, appName: 'wc-proxy',
            })
          }

          if (ct && /text\/html|javascript|application\/json|text\/plain/i.test(ct)) {
            const body = rewriteWcProxyBody(await upstream.text())
            return new Response(body, { status: upstream.status, headers: respHeaders })
          }

          return new Response(upstream.body, { status: upstream.status, headers: respHeaders })
        } catch {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({
              method, route: path, timestamp: proxyStart,
              durationMs: Date.now() - proxyStart,
              status: 502, appName: 'wc-proxy',
            })
          }
          return new Response(JSON.stringify({ error: 'WC proxy unavailable' }), {
            status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }
      }

      // Capture POST body for audit logging (Bun caches req.json(), so parseRequest still works)
      if (method === 'POST') {
        try { reqBody = await req.clone().json() } catch { /* not JSON or empty */ }
      }

      // Track active signing request so we can dismiss the overlay after the
      // actual handler completes (success or failure), not when the user clicks approve.
      let activeSigningId: string | undefined
      let activeSigningInfo: SigningRequestInfo | undefined
      let activeAllowBlindSigning = false

      try {
        // ═══════════════════════════════════════════════════════════════
        // SPEC (public)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/spec/swagger.json' && method === 'GET') {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({ method, route: path, timestamp: requestStart, durationMs: Date.now() - requestStart, status: 200, appName: 'public' })
          }
          return new Response(getSwagger(), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // HEALTH (public — privacy-safe, no deviceId/label)
        // ═══════════════════════════════════════════════════════════════
        if ((path === '/api/health' || path === '/api/v1/health') && method === 'GET') {
          const ds = engine.getDeviceState()
          return json({
            ready: ds.state === 'ready',
            status: 'healthy',
            syncing: engine.isSyncing,
            apiVersion: 2,
            supportedChains: CHAINS.filter(c => isChainSupported(c, ds.firmwareVersion) && (c.id !== 'hive' || getSetting('hive_enabled') === '1')).map(c => c.networkId),
            device_connected: engine.wallet !== null,
            version: callbacks?.getVersion?.() || 'unknown',
            connected: engine.wallet !== null,
            uptime: Math.floor((Date.now() - startTime) / 1000),
            // Report at least 1 when wallet is connected — signals to SDK that
            // the batch endpoint is functional and will fetch on-demand from device.
            // SDK skips batch call entirely when cached_pubkeys === 0.
            cached_pubkeys: engine.wallet ? Math.max(pubkeyCache.size, 1) : 0,
            frontload_progress: { status: 'complete', can_operate_offline: false },
          })
        }

        if (path === '/api/v1/health/fast' && method === 'GET') {
          return json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) })
        }

        // ═══════════════════════════════════════════════════════════════
        // SDK DETECTION (public — used by keepkey-website-v7 + Pioneer)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/info/ping' && method === 'GET') {
          return json({ message: 'pong' })
        }

        if (path === '/system/info/ping' && method === 'POST') {
          return json({ message: 'pong' })
        }

        if (path === '/admin/info' && method === 'GET') {
          return json({
            version: callbacks?.getVersion?.() || 'unknown',
            connected: engine.wallet !== null,
            uptime: Math.floor((Date.now() - startTime) / 1000),
          })
        }

        if (path === '/admin/usb/devices' && method === 'GET') {
          auth.requireAuth(req)
          try {
            return json(listUsbDevicesForAdmin())
          } catch (err: any) {
            return json({ error: 'Failed to list USB devices', message: err?.message || String(err) }, 500)
          }
        }

        if (path === '/admin/usb/state' && method === 'GET') {
          auth.requireAuth(req)
          try {
            const devices = listUsbDevicesForAdmin()
            const keepKeyOnBus = devices.some(device => device.isKeepKey)
            const deviceState = engine.getDeviceState()
            return json({
              connected: engine.wallet !== null,
              state: deviceState.state,
              deviceId: deviceState.deviceId || null,
              label: deviceState.label || null,
              firmwareVersion: deviceState.firmwareVersion || null,
              activeTransport: deviceState.activeTransport || null,
              keepKeyOnBus,
              usbDeviceCount: devices.length,
            })
          } catch (err: any) {
            return json({ error: 'Failed to read USB state', message: err?.message || String(err) }, 500)
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // SWAGGER UI (public — branded API docs)
        // ═══════════════════════════════════════════════════════════════
        if ((path === '/docs' || path === '/docs/') && method === 'GET') {
          if (callbacks?.onApiLog) {
            callbacks.onApiLog({ method, route: path, timestamp: requestStart, durationMs: Date.now() - requestStart, status: 200, appName: 'public' })
          }
          return new Response(getSwaggerUiHtml(), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(req) },
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // AUTH — pairing requires user approval via Electrobun UI
        // ═══════════════════════════════════════════════════════════════
        if (path === '/auth/pair') {
          if (method === 'GET') {
            // Graceful verify — SDK checks pairing status via GET /auth/pair.
            // Return { paired: false } instead of 403 so the SDK knows to re-pair.
            const token = auth.extractBearerToken(req)
            if (!token) return json({ paired: false, message: 'No bearer token provided' }, 401)
            const entry = auth.validate(token)
            if (!entry) return json({ paired: false, message: 'Token expired or invalid' }, 401)
            return json({ paired: true, ...entry.info })
          }
          if (method === 'POST') {
            const body = await parseRequest(req, S.PairRequest)
            // Notify UI about the incoming pair request
            if (callbacks?.onPairRequest) {
              callbacks.onPairRequest({ name: body.name, url: body.url || '', imageUrl: body.imageUrl || '' })
            }
            // requestPair requires user approval via UI — NOT auto-granted.
            // Idempotent: an already-paired identity reuses its key (reused:true)
            // after the user re-approves, instead of minting a duplicate.
            try {
              const { apiKey, reused } = await auth.requestPair(body)
              return json({ apiKey, reused })
            } finally {
              // Dismiss UI overlay + restore window level on approve, reject, or timeout
              callbacks?.onPairDismissed?.()
            }
          }
          if (method === 'DELETE') {
            // Revoke the caller's own key (clean reset / explicit unpair).
            const token = auth.extractBearerToken(req)
            if (!token) return json({ revoked: false, message: 'No bearer token provided' }, 401)
            const revoked = auth.revoke(token)
            return json({ revoked })
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // SIGNING APPROVAL GATE — auth required, then user must approve
        // ═══════════════════════════════════════════════════════════════
        if (method === 'POST' && SIGNING_ROUTES.has(path) && callbacks?.onSigningRequest) {
          auth.requireAuth(req)

          // Pre-approval payload validation. Some clients (and our own
          // discovery code) POST `{}` to signing endpoints to probe which
          // methods the wallet supports. Without this short-circuit every
          // probe pops an approval dialog with nothing to sign, which spams
          // the user and hides the real request. Reject empties with 400
          // before the approval flow runs.
          //
          // We look for *any* payload field that indicates this is a real
          // signing attempt. The permissive "has any of these keys" check
          // is intentional — the per-chain handlers below will run the
          // full schema validation, we just need to avoid gating on empty.
          //
          // Keys are taken from schemas.ts so the check mirrors the actual
          // wire contract each handler parses. When a new sign route is
          // added to SIGNING_ROUTES, add its required-any list here (or
          // extend the prefix match for route families that share a schema).
          let probeCheckBody: any
          try {
            probeCheckBody = await req.clone().json()
          } catch {
            probeCheckBody = null
          }
          const requiredAny = requiredSigningFields(path)
          if (requiredAny && (!probeCheckBody || typeof probeCheckBody !== 'object')) {
            console.warn(`[REST] ${path} probe rejected: body is not an object`)
            return json({ error: 'Empty or invalid signing payload' }, 400)
          }
          if (requiredAny && !requiredAny.some((k) => probeCheckBody[k] !== undefined)) {
            console.warn(
              `[REST] ${path} probe rejected: missing all of`, requiredAny,
              'keys seen:', Object.keys(probeCheckBody || {}),
            )
            return json({ error: `Missing signing payload — expected one of: ${requiredAny.join(', ')}` }, 400)
          }

          const { appName } = resolveAppInfo()
          const id = crypto.randomUUID()
          const signingInfo: SigningRequestInfo = { id, method: path, appName }

          // Try to extract useful details from the body without consuming it
          // (we'll parse body again in the handler below — Bun caches it)
          try {
            const preview = await req.clone().json() as any
            signingInfo.chain = path.split('/')[1] // e.g. "eth", "cosmos"
            signingInfo.rawRequestBody = preview    // full payload for UI transparency

            console.log(`[REST] Signing request ${path}:`, JSON.stringify(preview, null, 2))

            if (path === '/eth/sign-typed-data') {
              // EIP-712: address + typedData structure (no from/to/value/data)
              signingInfo.from = preview.address
              signingInfo.chainId = preview.typedData?.domain?.chainId ? Number(preview.typedData.domain.chainId) : undefined
              if (preview.typedData) {
                signingInfo.typedDataDecoded = decodeEIP712(preview.typedData)
              }
            } else if (path === '/eth/sign') {
              // EIP-191 personal_sign: body is { address, addressNList, message }.
              // Message arrives as a hex string per JSON-RPC spec; in practice it
              // nearly always encodes UTF-8 text (SIWE, dApp login challenges).
              // Decode to plaintext so the user sees what they're actually
              // signing — raw hex alone is useless for consent.
              signingInfo.from = preview.address
              const raw = typeof preview.message === 'string' ? preview.message : ''
              let text: string | undefined
              let isUtf8Text = false
              if (raw) {
                const hexMatch = /^0x([0-9a-fA-F]*)$/.exec(raw)
                if (hexMatch) {
                  try {
                    const buf = Buffer.from(hexMatch[1], 'hex')
                    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf)
                    text = decoded
                    isUtf8Text = true
                  } catch {
                    // Not valid UTF-8 — leave `text` undefined; UI will show hex.
                  }
                } else {
                  // Already a plaintext string (non-spec clients).
                  text = raw
                  isUtf8Text = true
                }
              }
              signingInfo.ethMessageDecoded = {
                address: preview.address,
                messageRaw: raw,
                messageText: text,
                isUtf8Text,
              }
            } else if (path === '/ton/sign-transaction') {
              // TON: field names differ from EVM (to_address, amount, raw_tx)
              signingInfo.to = preview.to_address
              signingInfo.value = preview.amount
            } else if (path === '/tron/sign-transaction') {
              // Tron: field names differ from EVM (to_address, amount, raw_tx)
              signingInfo.to = preview.to_address
              signingInfo.value = preview.amount
            } else if (path === '/solana/sign-message') {
              const raw = typeof preview.message === 'string' ? preview.message : ''
              const messageEncoding = /^[0-9a-fA-F]+$/.test(raw) ? 'hex' : 'base64'
              const addressNList = pickAddressNList(preview, DEFAULT_SOLANA_ADDRESS_N)
              const claimedSigner = typeof preview.pubkey === 'string'
                ? preview.pubkey
                : typeof preview.address === 'string'
                  ? preview.address
                  : undefined
              let actualSigner = formatAddressNPath(addressNList)
              try {
                const wallet = requireWallet(engine)
                const derived = await wallet.solanaGetAddress({ addressNList, showDisplay: false })
                const derivedSigner = typeof derived === 'string' ? derived : derived?.address
                if (derivedSigner) actualSigner = derivedSigner
                if (claimedSigner && derivedSigner && claimedSigner !== derivedSigner) {
                  throw new HttpError(400, 'Solana signer mismatch: claimed signer does not match address_n/addressNList')
                }
              } catch (e: any) {
                if (e instanceof HttpError) throw e
                console.warn('[REST] Could not derive Solana signer for preview:', e?.message || e)
              }
              signingInfo.chain = 'solana'
              signingInfo.from = actualSigner
              signingInfo.data = raw
              signingInfo.needsBlindSigning = true
              signingInfo.requiresAdvancedMode = true
              signingInfo.solanaMessageDecoded = buildSolanaMessageDecodedInfo(raw, {
                // Match hdwallet's SolanaSignMessage string coercion exactly:
                // hex strings sign hex bytes, everything else signs base64 bytes.
                encoding: messageEncoding,
                signer: actualSigner,
              })
            } else if (path === '/solana/sign-transaction') {
              // Solana clear-signing: parse v0/legacy message, resolve ALTs,
              // decode each instruction via the pioneer-discovery program
              // registry. Best-effort — a parse/ALT-RPC failure surfaces an
              // explicit warning in the UI rather than silently falling
              // back to an unflagged simple-transfer dialog.
              if (typeof preview.raw_tx === 'string') {
                try {
                  const endpoint = getSetting('solana_rpc_endpoint') || DEFAULT_SOLANA_RPC_ENDPOINT
                  signingInfo.solanaDecoded = await buildSolanaDecodedInfo(
                    preview.raw_tx,
                    createRpcAltFetcher(endpoint),
                  )
                } catch (e: any) {
                  const errName = e?.name || 'Error'
                  const errMsg = e?.message || String(e)
                  // Surface error with type prefix so the UI banner shows a
                  // useful diagnostic ("SolanaTxParseError: ..." vs "TypeError:
                  // fetch failed") instead of a bare string.
                  signingInfo.solanaDecodeError = `${errName}: ${errMsg}`
                  // Full stack + raw tx goes to the vault log so we can
                  // reproduce the failure locally — don't ship raw bytes to
                  // the UI, but *do* leave a breadcrumb in the console.
                  console.warn(
                    '[REST] Solana decode failed:', errName, errMsg,
                    '\n  raw_tx (base64):', preview.raw_tx,
                    '\n  stack:', e?.stack,
                  )
                }
              } else {
                signingInfo.solanaDecodeError = 'missing raw_tx payload'
              }
              signingInfo.requiresBlindSigningConsent = requiresSolanaBlindSigningConsent(
                signingInfo.solanaDecoded,
                preview.swapMetadata !== undefined || preview.schema !== undefined,
              )
              if (signingInfo.requiresBlindSigningConsent) {
                signingInfo.needsBlindSigning = true
              }
            } else if (
              path === '/tron/sign-message'
              || path === '/ton/sign-message'
              || path === '/solana/sign-offchain-message'
            ) {
              // Message / off-chain signing. Decode the payload to text so the
              // overlay shows what's actually being signed (mirrors /eth/sign),
              // rendered via the generic message section. is_text defaults to
              // true (UTF-8); is_text=false carries raw hex which we try to
              // decode to text, falling back to the raw hex in the UI.
              const isText = preview.is_text !== false
              const raw = typeof preview.message === 'string' ? preview.message : ''
              let messageText: string | undefined
              let isUtf8Text = false
              if (isText) {
                messageText = raw
                isUtf8Text = true
              } else {
                // is_text=false carries raw hex. Only treat it as a readable
                // message when it decodes to UTF-8 that is *mostly printable* —
                // otherwise valid-but-blank/control byte sequences (e.g. "00",
                // whitespace) render as an empty/ambiguous message while the
                // device signs real bytes. When not readable, leave messageText
                // undefined so the overlay forces the raw-hex view + warning.
                const hexBody = raw.startsWith('0x') ? raw.slice(2) : raw
                if (/^[0-9a-fA-F]*$/.test(hexBody) && hexBody.length % 2 === 0) {
                  try {
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hexBody, 'hex'))
                    if (isMostlyPrintable(text)) {
                      messageText = text
                      isUtf8Text = true
                    }
                  } catch { /* non-UTF-8 hex — UI shows the raw hex fallback */ }
                }
              }
              const defaultPath = path.startsWith('/tron')
                ? [0x8000002C, 0x800000C3, 0x80000000, 0, 0]
                : path.startsWith('/ton')
                  ? [0x8000002C, 0x8000025F, 0x80000000]
                  : DEFAULT_SOLANA_ADDRESS_N
              signingInfo.ethMessageDecoded = {
                address: formatAddressNPath(pickAddressNList(preview, defaultPath)),
                messageRaw: raw,
                messageText,
                isUtf8Text,
                standard: path.startsWith('/tron') ? 'TIP-191'
                  : path.startsWith('/ton') ? 'Ed25519'
                    : 'Solana off-chain',
              }
            } else if (path === '/tron/sign-typed-hash') {
              // TIP-712 hash mode: only the domain + message hashes reach the
              // device — there is no structured data to decode, so this is an
              // inherently blind signature. Surface the hashes and flag it so
              // the overlay shows the blind-signing warning.
              signingInfo.needsBlindSigning = true
              signingInfo.data =
                `TIP-712 hashes (blind)\n` +
                `domainSeparator: ${preview.domain_separator_hash || '(none)'}\n` +
                `message: ${preview.message_hash || '(EIP712Domain only)'}`
            } else if (path === '/api/v2/swap/execute') {
              // Headless swap. The on-chain tx is a plain send to the swap
              // router/inbound vault with an opaque memo carrying the intent —
              // the device can only render "send X to <addr>". Surface the swap
              // terms (in/out asset, amount, expected output, router, memo) in
              // the approval overlay so the user consents to the actual swap,
              // not just an opaque transfer. Flagged blind: the memo is not
              // human-verifiable on-device.
              signingInfo.chain = (preview.fromChainId || preview.fromCaip || '').toString().split('/')[0]
              signingInfo.to = preview.router || preview.inboundAddress
              signingInfo.value = `${preview.amount} (${preview.fromCaip})`
              signingInfo.needsBlindSigning = true
              const swapper = preview.swapper || preview.integration || 'swap'
              signingInfo.data =
                `Swap via ${swapper}\n` +
                `send: ${preview.amount} ${preview.fromCaip}\n` +
                `to (router/inbound): ${preview.router || preview.inboundAddress}\n` +
                `expected out: ${preview.expectedOutput} ${preview.toCaip}\n` +
                `memo: ${preview.memo || '(none)'}`
            } else {
              signingInfo.from = preview.from || preview.signerAddress
              signingInfo.to = preview.to
              signingInfo.value = preview.value
              signingInfo.chainId = preview.chainId || preview.chain_id
              signingInfo.data = preview.data   // full data — UI handles display

              // Clear-signing: decode calldata locally (vendored, no network) for
              // the UI, and gate blind-signing off what the FIRMWARE clear-signs.
              if (preview.data && preview.data.length >= 10 && preview.to) {
                const chainIdNum = typeof signingInfo.chainId === 'string'
                  ? (signingInfo.chainId.startsWith('0x') ? parseInt(signingInfo.chainId, 16) : parseInt(signingInfo.chainId, 10))
                  : signingInfo.chainId
                try {
                  signingInfo.calldataDecoded = await decodeCalldata(preview.to, preview.data, chainIdNum) ?? undefined
                  console.log(`[REST] Calldata decoded:`, JSON.stringify(signingInfo.calldataDecoded, null, 2))
                } catch (e) { console.warn('[REST] Calldata decode failed:', e) }

                // Caller supplied a runtime-signer blob directly (LoadClearsignSigner
                // flow — the /eth/sign-transaction handler below honors this at
                // priority 1). The device verifies it against the loaded signer and
                // clear-signs regardless of what the firmware natively handles.
                if (preview.txMetadata?.signedPayload) {
                  signingInfo.calldataDecoded = {
                    dappName: 'Unknown', contractName: 'Unknown', method: '(runtime signer)',
                    selector: preview.data.slice(0, 10), fields: [], source: 'none',
                    ...signingInfo.calldataDecoded,
                    signedInsightBlob: preview.txMetadata.signedPayload,
                    insightKeyId: preview.txMetadata.keyId,
                  }
                  signingInfo.needsBlindSigning = false
                  console.log(`[REST] needsBlindSigning=false (caller-provided runtime-signer blob, keyId=${preview.txMetadata.keyId})`)
                } else {
                  // Needs blind signing unless the firmware clear-signs it natively.
                  // Keyed off the device's own allowlist (firmwareClearSigns), NOT
                  // whether our decoder recognized the calldata — a contract we can
                  // decode (Uniswap/1inch) but the firmware can't still blind-signs,
                  // and forcing global AdvancedMode on a firmware-clearsignable tx
                  // re-opens the drain vector (PR #261/#303).
                  signingInfo.needsBlindSigning = !firmwareClearSigns(preview.to, preview.data, chainIdNum)
                  console.log(`[REST] needsBlindSigning=${signingInfo.needsBlindSigning} (firmwareClearSigns=${!signingInfo.needsBlindSigning}, decoder source=${signingInfo.calldataDecoded?.source})`)
                }
              }
            }
          } catch (e: any) {
            if (e instanceof HttpError) throw e
            console.warn('[REST] Signing preview extraction failed:', e?.message || e)
          }

          // Check device AdvancedMode policy before presenting to user.
          // ONLY use cached features — never call getFeatures() here because
          // if the device is PIN-locked it triggers a PIN_REQUEST that races
          // with the signing approval overlay.
          try {
            const now = Date.now()
            if (featuresCache && (now - featuresCache.timestamp) < FEATURES_TTL_MS) {
              const features = featuresCache.data
              const policies: any[] = features?.policiesList || features?.policies || []
              const advPol = policies.find((p: any) => (p.policyName || p.policy_name) === 'AdvancedMode')
              signingInfo.advancedModeEnabled = advPol?.enabled ?? false
              // Pass firmware version so UI can gate blind-signing warnings (7.14.0+)
              if (features?.majorVersion) {
                signingInfo.firmwareVersion = `${features.majorVersion}.${features.minorVersion}.${features.patchVersion}`
              }
            }
          } catch (e: any) {
            console.warn('[rest-api] Failed to read AdvancedMode policy:', e?.message || e)
          }

          // Track before waiting so rejection, timeout, or a malformed approval
          // decision still dismisses the Vault overlay in the request finally.
          activeSigningId = id
          const approval = await callbacks.onSigningRequest(signingInfo)
          if (!approval.approved) {
            return json({ error: 'Signing rejected by user' }, 403)
          }
          if (signingInfo.requiresBlindSigningConsent && !approval.allowBlindSigning) {
            return json({ error: 'One-shot blind-signing consent required' }, 403)
          }
          // Approved — retain decoded info so handlers can pass metadata to device.
          activeSigningInfo = signingInfo
          activeAllowBlindSigning =
            signingInfo.requiresBlindSigningConsent === true
            && approval.allowBlindSigning === true
        }

        // ── List paired apps (public — shows connected dApps, keys stripped) ──
        if (path === '/auth/paired-apps' && method === 'GET') {
          const apps = auth.listPairedApps().map(({ apiKey: _k, ...safe }) => safe)
          return json({ apps, total: apps.length })
        }

        // ═══════════════════════════════════════════════════════════════
        // All remaining endpoints require auth
        // ═══════════════════════════════════════════════════════════════

        // ── ADDRESSES (9 endpoints) ──────────────────────────────────
        if (path === '/addresses/utxo' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'utxo', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.btcGetAddress({
            addressNList: body.address_n,
            coin: body.coin || 'Bitcoin',
            scriptType: body.script_type,
            showDisplay: sd,
          }), { operation: 'btcGetAddress', chain: 'Bitcoin' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/cosmos' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'cosmos', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'cosmosGetAddress', chain: 'Cosmos' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/osmosis' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'osmo', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.osmosisGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'osmosisGetAddress', chain: 'Osmosis' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/eth' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'eth', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.ethGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'ethGetAddress', chain: 'Ethereum' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/tendermint' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'tendermint', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'cosmosGetAddress', chain: 'Cosmos' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/thorchain' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'thor', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.thorchainGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'thorchainGetAddress', chain: 'THORChain' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/mayachain' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'maya', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.mayachainGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'mayachainGetAddress', chain: 'Maya' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/xrp' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'xrp', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.rippleGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'xrpGetAddress', chain: 'XRP' }, sd)
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/solana' && method === 'POST') {
          auth.requireAuth(req)
          const fwBlock = requireChainSupport('solana')
          if (fwBlock) return fwBlock
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'sol', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.solanaGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'solanaGetAddress', chain: 'Solana' }, sd)
          const address = typeof result === 'string' ? result : (result as any)?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/tron' && method === 'POST') {
          auth.requireAuth(req)
          const fwBlock = requireChainSupport('tron')
          if (fwBlock) return fwBlock
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'trx', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.tronGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
          }), { operation: 'tronGetAddress', chain: 'Tron' }, sd)
          const address = typeof result === 'string' ? result : (result as any)?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/ton' && method === 'POST') {
          auth.requireAuth(req)
          const fwBlock = requireChainSupport('ton')
          if (fwBlock) return fwBlock
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'ton', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.tonGetAddress({
            addressNList: body.address_n,
            showDisplay: sd,
            bounceable: false, // UQ prefix — safe for uninitialized wallets
          }), { operation: 'tonGetAddress', chain: 'TON' }, sd)
          const address = typeof result === 'string' ? result : (result as any)?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/hive' && method === 'POST') {
          auth.requireAuth(req)
          // Gate behind the Hive feature flag (matches RPC handlers in index.ts)
          if (getSetting('hive_enabled') !== '1') return json({ error: 'Hive is disabled' }, 403)
          const fwBlock = requireChainSupport('hive')
          if (fwBlock) return fwBlock
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = scopedKey(engine, 'hive', body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => (wallet as any).hiveGetPublicKey({
            addressNList: body.address_n,
            showDisplay: sd,
            coin: 'Hive',
          }), { operation: 'hiveGetPublicKey', chain: 'HIVE' }, sd)
          const address = result?.publicKey || ''
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/hive/sign-message' && method === 'POST') {
          auth.requireAuth(req)
          // Same gates as /addresses/hive: feature flag + firmware ≥ 7.15.0
          if (getSetting('hive_enabled') !== '1') return json({ error: 'Hive is disabled' }, 403)
          const fwBlock = requireChainSupport('hive')
          if (fwBlock) return fwBlock
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.HiveSignMessageRequest)
          const messageBytes = body.is_text === false
            ? Buffer.from(body.message.replace(/^0x/, ''), 'hex')
            : Buffer.from(body.message, 'utf8')
          if (messageBytes.length === 0 || messageBytes.length > 1024) {
            throw new HttpError(400, 'Hive message must be 1–1024 bytes')
          }
          // Default to the posting role — Keychain signBuffer is overwhelmingly
          // dApp login, which verifies against the account's posting authority.
          const addressNList = body.addressNList || body.address_n || hiveRolePath('posting', 0)
          const { hiveMessagePreview } = await import('./emulator-confirm-details')
          const result = await emuWrap(() => (wallet as any).hiveSignMessage({
            addressNList,
            message: new Uint8Array(messageBytes),
          }), { operation: 'hiveSignMessage', opLabel: 'Sign Message', chain: 'Hive', memo: hiveMessagePreview(messageBytes) })
          if (!result?.signature) throw new HttpError(500, 'Hive sign-message: device returned no signature')
          const sigBytes = result.signature instanceof Uint8Array ? Buffer.from(result.signature) : Buffer.from(String(result.signature), 'hex')
          const pubBytes = result.publicKey instanceof Uint8Array ? Buffer.from(result.publicKey) : Buffer.from(String(result.publicKey), 'hex')
          // STM encoding: 'STM' + base58(pub33 || ripemd160(pub33)[0:4])
          let stm = ''
          if (pubBytes.length === 33) {
            const { ripemd160 } = await import('@noble/hashes/ripemd160')
            const bs58 = (await import('bs58')).default
            const checksum = Buffer.from(ripemd160(pubBytes)).subarray(0, 4)
            stm = 'STM' + bs58.encode(Buffer.concat([pubBytes, checksum]))
          }
          return json({
            signature: sigBytes.toString('hex'),
            public_key: stm,
          })
        }

        if (path === '/hive/sign-operations' && method === 'POST') {
          // Live-device signed on 7.15.0-rc15 (fw 23ef39c0, EmulatorZcash): the
          // phase-1/2/3 op table round-trips, including limit_order_create /
          // limit_order_cancel — see keepkey-sdk tests/hive/phase3-ops.js.
          //
          // KNOWN GATE LIMITATION: requireChainSupport('hive') only compares
          // ">=7.15.0", which every 7.15.0-rc reports. An rc predating the
          // HiveSignOperations handler (1616/1617, fw #307 / rc10) or the
          // phase-3 ops (fw #315 / rc15) therefore passes the gate and then
          // rejects the message on-device. There is no finer-grained capability
          // flag to check; the device error is the backstop.
          auth.requireAuth(req)
          if (getSetting('hive_enabled') !== '1') return json({ error: 'Hive is disabled' }, 403)
          const fwBlock = requireChainSupport('hive')
          if (fwBlock) return fwBlock
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.HiveSignOperationsRequest)

          // Header (TaPoS) from Pioneer — the exact values the device signs
          // are returned to the caller so broadcast reuses the same tx.
          const pioneerBase = (callbacks?.getPioneerApiBase?.() || 'https://api.keepkey.info').replace(/\/$/, '')
          const txParams = await fetch(`${pioneerBase}/api/v1/hive/tx-params`, {
            signal: AbortSignal.timeout(20_000),
          }).then(r => r.json()) as any
          if (!txParams?.success) throw new HttpError(502, `Hive tx-params failed: ${txParams?.error || 'unknown'}`)

          const { serializeHiveOpsTx } = await import('./txbuilder/hive-ops')
          let serialized
          try {
            serialized = serializeHiveOpsTx({
              refBlockNum: txParams.refBlockNum,
              refBlockPrefix: txParams.refBlockPrefix,
              expirationUnix: txParams.expirationUnix,
              operations: body.operations as any,
            })
          } catch (e: any) {
            throw new HttpError(400, e?.message || 'Hive ops serialization failed')
          }

          // Role from op tier unless the caller pinned a path
          const addressNList = body.addressNList || body.address_n || hiveRolePath(serialized.tier, 0)
          const { hiveConfirmDetails } = await import('./emulator-confirm-details')
          const result: any = await emuWrap(() => (wallet as any).hiveSignOperations({
            addressNList,
            chainId: txParams.chainId,
            serializedTx: new Uint8Array(serialized.serializedTx),
          }), hiveConfirmDetails('hiveSignOperations', body.operations))
          if (!result?.signature) throw new HttpError(500, 'Hive sign-operations: device returned no signature')
          const sigBytes = result.signature instanceof Uint8Array ? Buffer.from(result.signature) : Buffer.from(String(result.signature), 'hex')
          // Return the expiration derived from the SIGNED expirationUnix (the value
          // baked into the serialized header), NOT Pioneer's separate expirationIso —
          // if the two ever diverge, a caller broadcasting the ISO would reconstruct a
          // different transaction than the one the device signed (invalid signature).
          const signedExpirationIso = new Date(txParams.expirationUnix * 1000).toISOString().replace(/\.\d{3}Z$/, '')
          return json({
            signature: sigBytes.toString('hex'),
            ref_block_num: txParams.refBlockNum,
            ref_block_prefix: txParams.refBlockPrefix,
            expiration: signedExpirationIso,
            operations: body.operations,
          })
        }

        if (path === '/hive/sign-transfer' && method === 'POST') {
          auth.requireAuth(req)
          // Same gates as /addresses/hive: feature flag + firmware ≥ 7.15.0
          if (getSetting('hive_enabled') !== '1') return json({ error: 'Hive is disabled' }, 403)
          const fwBlock = requireChainSupport('hive')
          if (fwBlock) return fwBlock
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.HiveSignTransferRequest)
          const addressNList = body.addressNList || body.address_n || hiveRolePath('active', 0)
          const result = await emuWrap(() => (wallet as any).hiveSignTx({
            addressNList,
            chainId: body.chain_id,
            refBlockNum: body.ref_block_num,
            refBlockPrefix: body.ref_block_prefix,
            expiration: body.expiration,
            from: body.from,
            to: body.to,
            amount: body.amount,
            decimals: 3, // HIVE and HBD are both 3-decimal; matches the RPC path (txbuilder/hive.ts)
            assetSymbol: body.asset_symbol || 'HIVE',
            memo: body.memo,
          }), { operation: 'hiveSignTx', chain: 'HIVE', to: body.to, value: String(body.amount) })
          if (!result?.signature) throw new HttpError(500, 'Hive sign: device returned no signature')
          const toHexStr = (v: any) => v instanceof Uint8Array ? Buffer.from(v).toString('hex') : String(v)
          return json({
            signature: toHexStr(result.signature),
            serialized_tx: toHexStr(result.serializedTx),
          })
        }

        // ── ETH SIGNING (4 endpoints) ────────────────────────────────
        if (path === '/eth/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthSignTransactionRequest)

          // Resolve addressNList from body or by scanning
          let addressNList = body.addressNList || body.address_n_list
          if (!addressNList && body.from) {
            addressNList = await findEthAddressNList(wallet, auth, body.from)
          }

          // chainId: default to 1 if 0 or missing, strict validation
          let chainId = body.chainId ?? body.chain_id ?? 1
          if (typeof chainId === 'string') {
            // Reject strings that aren't pure integers (e.g. "1abc", "1.5", "")
            if (chainId.startsWith('0x')) {
              if (!/^0x[0-9a-fA-F]+$/.test(chainId)) throw new HttpError(400, `Invalid chainId: ${chainId}`)
              chainId = parseInt(chainId, 16)
            } else {
              if (!/^[0-9]+$/.test(chainId)) throw new HttpError(400, `Invalid chainId: ${chainId}`)
              chainId = parseInt(chainId, 10)
            }
          }
          if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId < 0 || chainId > 4294967295) {
            throw new HttpError(400, `Invalid chainId: ${body.chainId ?? body.chain_id}`)
          }
          if (chainId === 0) chainId = 1

          const msg: any = {
            addressNList,
            to: body.to,
            value: body.value || '0x0',
            data: body.data || '0x',
            nonce: body.nonce || '0x0',
            gasLimit: body.gas || body.gasLimit || '0x5208',
            chainId,
          }

          // EIP-1559 fields
          if (body.maxFeePerGas || body.max_fee_per_gas) {
            msg.maxFeePerGas = body.maxFeePerGas || body.max_fee_per_gas
            // Canonical RLP requires a zero priority fee to be the EMPTY string, not
            // a 0x00 byte. hdwallet does not strip the EIP-1559 fee fields, so a
            // literal '0x0' reaches the device as [0x00], which the firmware hashes
            // non-canonically → the tx recovers to the wrong signer and is
            // unbroadcastable (see keepkey-firmware eip1559-zero-priority fix). Send
            // empty for a zero/absent priority fee.
            const prio = body.maxPriorityFeePerGas || body.max_priority_fee_per_gas
            msg.maxPriorityFeePerGas = (!prio || /^0x0*$/.test(prio)) ? '0x' : prio
          } else {
            msg.gasPrice = body.gasPrice || body.gas_price || '0x0'
          }

          // ── EVM Clear-Signing: attach signed metadata blob for device OLED ──
          // Priority: 1) caller provides txMetadata in request body (test fixtures)
          //           2) Pioneer signedInsightBlob from calldata decoder
          //           3) none — device falls back to raw hex
          if (body.txMetadata && body.txMetadata.signedPayload) {
            msg.txMetadata = {
              signedPayload: body.txMetadata.signedPayload,
              keyId: body.txMetadata.keyId ?? 0,
            }
            console.log(`[REST] EVM clear-sign: using caller-provided blob (${String(body.txMetadata.signedPayload).length} chars, keyId=${msg.txMetadata.keyId})`)
          } else {
            const decoded = activeSigningInfo?.calldataDecoded
            if (decoded?.signedInsightBlob) {
              // Pioneer emits the blob as base64, but hdwallet's ethSignTx
              // arrayify()s a STRING signedPayload as hex ("0x"+s) → a base64
              // string throws "invalid hexadecimal string" before the device
              // sees anything. Hand it the raw bytes (Uint8Array branch) so the
              // encoding is unambiguous.
              msg.txMetadata = {
                signedPayload: new Uint8Array(Buffer.from(decoded.signedInsightBlob, 'base64')),
                keyId: decoded.insightKeyId,
              }
              console.log(`[REST] EVM clear-sign: using Pioneer blob (keyId=${decoded.insightKeyId}, ${msg.txMetadata.signedPayload.length} bytes)`)
            } else {
              console.log('[REST] EVM clear-sign: no metadata blob — device will show raw hex')
            }
          }

          console.log('[REST] ethSignTx hdwallet payload:', JSON.stringify(msg, null, 2))
          try {
            // Honest confirm dialog: decode msg.data so token/contract calls
            // don't show the contract as recipient or 0x0/hex-wei as amount.
            const { evmConfirmDetails } = await import('./emulator-confirm-details')
            const result = await emuWrap(() => wallet.ethSignTx(msg), evmConfirmDetails('ethSignTx', 'Ethereum', msg))
            console.log('[REST] ethSignTx result:', JSON.stringify(result))
            return json(validateResponse(result, S.EthSignTransactionResponse, path))
          } catch (err: any) {
            // Distinguish user cancellation / device rejection from actual failures
            const errMsg = String(err?.message || err || '').toLowerCase()
            if (errMsg.includes('cancel') || errMsg.includes('rejected') || errMsg.includes('denied') || errMsg.includes('action cancelled')) {
              return json({ error: 'User cancelled signing on device' }, 403)
            }
            throw err
          }
        }

        if (path === '/eth/clearsign/load-signer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.LoadClearsignSignerRequest)
          const pubkey = parseHex(body.pubkey, 'pubkey')
          if (pubkey.length !== 33) throw new HttpError(400, `pubkey must be 33 bytes, got ${pubkey.length}`)
          if (typeof (wallet as any).loadClearsignSigner !== 'function') {
            throw new HttpError(501, 'Connected device does not support LoadClearsignSigner (requires firmware 7.15.0+)')
          }
          const icon = body.icon ? parseHex(body.icon, 'icon') : undefined
          if (icon && icon.length > 384) throw new HttpError(400, `icon must be <= 384 bytes, got ${icon.length}`)
          console.log(`[REST] clearsign load-signer: slot=${body.keyId} alias="${body.alias}" pubkey=${body.pubkey}`
            + `${icon ? ` icon=${icon.length}B ${body.iconWidth}x${body.iconHeight}` : ''}${body.persist ? ' persist' : ''}`)
          try {
            // Loading a signer raises a mandatory on-device "Trust signer" confirm.
            // On the emulator that button press must be armed via emuWrap (interactive
            // approve), exactly like the signing routes — otherwise the OLED shows the
            // trust screen but no green button ever appears and the call hangs.
            // emuWrap is a transparent no-op on real hardware.
            await emuWrap(
              () => (wallet as any).loadClearsignSigner({
                keyId: body.keyId, pubkey, alias: body.alias,
                icon, iconWidth: body.iconWidth, iconHeight: body.iconHeight,
                persist: body.persist === true,
              }),
              { operation: 'loadClearsignSigner', opLabel: 'Trust Signer', chain: 'Ethereum' },
            )
            return json({ ok: true, keyId: body.keyId, alias: body.alias })
          } catch (err: any) {
            const errMsg = String(err?.message || err || '').toLowerCase()
            if (errMsg.includes('cancel') || errMsg.includes('rejected') || errMsg.includes('denied') || errMsg.includes('action cancelled')) {
              return json({ error: 'User rejected clear-sign signer on device' }, 403)
            }
            throw err
          }
        }

        if (path === '/eth/sign-typed-data' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthSignTypedDataRequest)

          // Address resolution: cache first, then scan accounts
          let addressNList: number[]
          try {
            addressNList = auth.getAccount(body.address).addressNList
          } catch {
            addressNList = await findEthAddressNList(wallet, auth, body.address)
          }

          try {
            const result = await emuWrap(() => wallet.ethSignTypedData({ addressNList, typedData: body.typedData }), { operation: 'ethSignTypedData', chain: 'Ethereum' })
            return json(result)
          } catch (err: any) {
            // Distinguish user cancellation from actual failures
            const msg = String(err?.message || err || '').toLowerCase()
            if (msg.includes('cancel') || msg.includes('rejected') || msg.includes('denied') || msg.includes('action cancelled')) {
              return json({ error: 'User cancelled signing on device' }, 403)
            }
            throw err
          }
        }

        if (path === '/eth/sign' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthSignRequest)
          const { addressNList } = auth.getAccount(body.address)
          // hdwallet expects message as a hex string (isHexString check), not Buffer
          const result = await emuWrap(() => wallet.ethSignMessage({ addressNList, message: body.message }), { operation: 'ethSignMessage', chain: 'Ethereum' })
          return json(result)
        }

        if (path === '/eth/verify' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.EthVerifyRequest)
          const msgBytes = Buffer.from(body.message.replace(/^0x/, ''), 'hex')
          const result = await wallet.ethVerifyMessage({
            address: body.address,
            message: msgBytes,
            signature: body.signature,
          })
          return json(result)
        }

        // ── EMULATOR (external test-driver support) ──────────────────
        // The RPC surface (emulatorCaptureFrame, emulatorSwitchWallet, etc.)
        // is only reachable from inside the app's own webview↔bun bridge —
        // an external script (e.g. the mainnet test suite) has no path to
        // it. Expose just the screen capture here since it's read-only and
        // safe; wallet-switching / tx-building stay RPC-only for now.
        if (path === '/emulator/capture' && method === 'POST') {
          auth.requireAuth(req)
          if (!engine.isEmulator) throw new HttpError(400, 'Screen capture is emulator-only')
          const { captureCurrentFrame } = await import('./emulator-window')
          const dataUrl = await captureCurrentFrame()
          return json({ dataUrl })
        }

        // ── UTXO SIGNING (1 endpoint) ────────────────────────────────
        if (path === '/utxo/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.UtxoSignTransactionRequest)
          const coin = body.coin || 'Bitcoin'

          // BCH: prepend bitcoincash: prefix to output addresses
          if (coin === 'BitcoinCash' && body.outputs) {
            for (const out of body.outputs) {
              if (out.address && !out.address.startsWith('bitcoincash:')) {
                out.address = 'bitcoincash:' + out.address
              }
            }
          }

          const result = await emuWrap(() => wallet.btcSignTx({
            coin,
            inputs: body.inputs,
            outputs: body.outputs,
            version: body.version ?? 1,
            locktime: body.locktime ?? 0,
            ...(body.overwintered !== undefined ? { overwintered: body.overwintered } : {}),
            ...(body.expiry !== undefined ? { expiry: body.expiry } : {}),
            ...(body.versionGroupId !== undefined ? { versionGroupId: body.versionGroupId } : {}),
            ...(body.branchId !== undefined ? { branchId: body.branchId } : {}),
          }), { operation: 'btcSignTx', chain: coin })
          // Explicit chain for UTXO — auto-detect defaults to BTC but could be LTC/DOGE/etc
          const coinSymbol = coin === 'Bitcoin' ? 'BTC' : coin === 'Litecoin' ? 'LTC' : coin === 'Dogecoin' ? 'DOGE' : coin === 'Dash' ? 'DASH' : coin === 'BitcoinCash' ? 'BCH' : coin
          return json(validateResponse(result, S.UtxoSignTransactionResponse, path), 200, { chain: coinSymbol, activityType: 'sign' })
        }

        // ── COSMOS SIGNING (6 endpoints) ──────────────────────────────
        if (path === '/cosmos/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000', (fn) => emuWrap(fn, { operation: 'cosmosSignTx', chain: 'Cosmos' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000', (fn) => emuWrap(fn, { operation: 'cosmosSignTx', chain: 'Cosmos' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000', (fn) => emuWrap(fn, { operation: 'cosmosSignTx', chain: 'Cosmos' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000', (fn) => emuWrap(fn, { operation: 'cosmosSignTx', chain: 'Cosmos' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000', (fn) => emuWrap(fn, { operation: 'cosmosSignTx', chain: 'Cosmos' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000', (fn) => emuWrap(fn, { operation: 'cosmosSignTx', chain: 'Cosmos' })), S.CosmosAminoSignResponse, path))
        }

        // ── OSMOSIS SIGNING (9 endpoints) ────────────────────────────
        if (path === '/osmosis/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-lp-remove' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-lp-add' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-swap' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000', (fn) => emuWrap(fn, { operation: 'osmosisSignTx', chain: 'Osmosis' })), S.CosmosAminoSignResponse, path))
        }

        // ── THORCHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/thorchain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000', (fn) => emuWrap(fn, { operation: 'thorchainSignTx', chain: 'THORChain' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/thorchain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000', (fn) => emuWrap(fn, { operation: 'thorchainSignTx', chain: 'THORChain' })), S.CosmosAminoSignResponse, path))
        }

        // ── MAYACHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/mayachain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000', (fn) => emuWrap(fn, { operation: 'mayachainSignTx', chain: 'Maya' })), S.CosmosAminoSignResponse, path))
        }
        if (path === '/mayachain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000', (fn) => emuWrap(fn, { operation: 'mayachainSignTx', chain: 'Maya' })), S.CosmosAminoSignResponse, path))
        }

        // ── XRP SIGNING (1 endpoint) ─────────────────────────────────
        if (path === '/xrp/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.XrpSignRequest)
          const result = await emuWrap(() => wallet.rippleSignTx(body), { operation: 'rippleSignTx', chain: 'XRP' })
          return json(result)
        }

        // ── SOLANA SIGNING (1 endpoint) ────────────────────────────────
        if (path === '/solana/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SolanaSignRequest)
          const addressNList = pickAddressNList(body, DEFAULT_SOLANA_ADDRESS_N)

          // Validate the serialized wrapper here so malformed client input is a
          // 400 rather than a generic device/route failure.
          const fullTx = Buffer.from(body.raw_tx, 'base64')
          try {
            parseSolanaTx(fullTx)
          } catch (err) {
            if (err instanceof SolanaTxParseError) throw new HttpError(400, err.message)
            throw err
          }

          // Both legacy and v0 messages use SolanaSignTx. The helper removes
          // the signature wrapper, forwards the transaction-bound KKSOLSW1
          // descriptor unchanged, or adds a one-shot opaque fallback only when
          // the Vault UI returned explicit consent, then splices
          // the returned signature back into the original wire transaction.
          const result = await signSolanaWireTransaction(
            {
              addressNList,
              rawTx: body.raw_tx,
              swapMetadata: body.swapMetadata,
              // Reusable KKSOLSC1 instruction schema — signed once per
              // program+instruction, so the device can decode this call
              // without a per-transaction attestation.
              schema: body.schema,
              allowBlindSigning: activeAllowBlindSigning,
            },
            (request) => emuWrap(
              () => wallet.solanaSignTx(request),
              { operation: 'solanaSignTx', chain: 'Solana' },
            ),
            async (signerPath) => {
              const derived = await wallet.solanaGetAddress({
                addressNList: signerPath,
                showDisplay: false,
              })
              const address = typeof derived === 'string' ? derived : derived?.address
              if (!address) throw new Error('Device returned no Solana signer address')
              return address
            },
            'rest:solanaSignTx',
          )
          if (!result?.signature) return json(result)
          return json({
            signature: Buffer.from(result.signature).toString('base64'),
            serializedTx: result.serializedTx,
          })
        }

        // ── SOLANA MESSAGE SIGNING (firmware type 754) ──────────────────
        if (path === '/solana/sign-message' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SolanaSignMessageRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]
          const result = await emuWrap(() => wallet.solanaSignMessage({
            addressNList,
            message: body.message,
            showDisplay: body.show_display !== false,
          }), { operation: 'solanaSignMessage', chain: 'Solana' })
          // result: { publicKey: Uint8Array, signature: Uint8Array }
          return json({
            signature: result.signature instanceof Uint8Array
              ? Buffer.from(result.signature).toString('base64')
              : result.signature,
            publicKey: result.publicKey instanceof Uint8Array
              ? Buffer.from(result.publicKey).toString('base64')
              : result.publicKey,
          })
        }

        // ── TRON SIGNING (1 endpoint) ──────────────────────────────────
        if (path === '/tron/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.TronSignRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800000C3, 0x80000000, 0, 0]
          const result = await emuWrap(() => wallet.tronSignTx({
            addressNList,
            rawTx: body.raw_tx,
            toAddress: body.to_address,
            amount: body.amount,
          }), { operation: 'tronSignTx', chain: 'Tron' })
          return json({
            signature: result?.signature instanceof Uint8Array
              ? Buffer.from(result.signature).toString('hex')
              : result?.signature,
          })
        }

        // ── TON SIGNING (1 endpoint) ──────────────────────────────────
        if (path === '/ton/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.TonSignRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x8000025F, 0x80000000]
          const result = await emuWrap(() => wallet.tonSignTx({
            addressNList,
            rawTx: body.raw_tx,
            toAddress: body.to_address,
            amount: body.amount,
          }), { operation: 'tonSignTx', chain: 'TON' })
          if (!result) throw new HttpError(500, 'tonSignTx returned no result')
          return json(result)
        }

        // ── MESSAGE SIGNING (firmware 7.14.1+) ────────────────────────
        // TIP-191 personal_sign for TRON.
        // hash = keccak256("\x19TRON Signed Message:\n" + len + msg)
        if (path === '/tron/sign-message' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.TronSignMessageRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800000C3, 0x80000000, 0, 0]
          const message = decodeMessageBody(body.message, body.is_text, 'tronSignMessage')
          const result = await emuWrap(() => wallet.tronSignMessage({
            addressNList,
            message,
            showDisplay: body.show_display,
          }), { operation: 'tronSignMessage', chain: 'Tron' })
          if (!result) throw new HttpError(500, 'tronSignMessage returned no result')
          return json({ address: result.address, signature: toHex(result.signature) })
        }

        // TIP-191 verify — recovers signer pubkey from sig + checks claimed address.
        if (path === '/tron/verify-message' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.TronVerifyMessageRequest)
          // signature is regex-validated to 65 bytes hex by zod; parseHex is belt-and-braces.
          const sig = parseHex(body.signature, 'tronVerifyMessage.signature', 65)
          const message = decodeMessageBody(body.message, body.is_text, 'tronVerifyMessage')
          const ok = await emuWrap(() => wallet.tronVerifyMessage({
            address: body.address,
            signature: sig,
            message,
          }), { operation: 'tronVerifyMessage', chain: 'Tron' })
          return json({ verified: !!ok })
        }

        // TIP-712 typed-data signing (hash mode). Host pre-computes the
        // domainSeparator + message hashes per the TIP-712 spec; device
        // assembles keccak256("\x19\x01" || ds_hash || msg_hash) and signs.
        if (path === '/tron/sign-typed-hash' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.TronSignTypedHashRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800000C3, 0x80000000, 0, 0]
          // Both hashes are regex-validated to 32 bytes hex by zod; parseHex
          // re-checks length defensively in case the schema constraint loosens.
          const dsHash = parseHex(body.domain_separator_hash, 'tronSignTypedHash.domain_separator_hash', 32)
          const msgHash = body.message_hash
            ? parseHex(body.message_hash, 'tronSignTypedHash.message_hash', 32)
            : undefined
          const result = await emuWrap(() => wallet.tronSignTypedHash({
            addressNList,
            domainSeparatorHash: dsHash,
            messageHash: msgHash,
          }), { operation: 'tronSignTypedHash', chain: 'Tron' })
          if (!result) throw new HttpError(500, 'tronSignTypedHash returned no result')
          return json({ address: result.address, signature: toHex(result.signature) })
        }

        // Bare Ed25519 SignMessage for TON. Firmware fences this behind
        // the AdvancedMode policy — without it, expect Failure.
        if (path === '/ton/sign-message' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.TonSignMessageRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x8000025F, 0x80000000]
          const message = decodeMessageBody(body.message, body.is_text, 'tonSignMessage')
          const result = await emuWrap(() => wallet.tonSignMessage({
            addressNList,
            message,
            showDisplay: body.show_display,
          }), { operation: 'tonSignMessage', chain: 'TON' })
          if (!result) throw new HttpError(500, 'tonSignMessage returned no result')
          return json({ publicKey: toHex(result.publicKey), signature: toHex(result.signature) })
        }

        // Domain-separated Solana off-chain message. Firmware constructs
        //   "\xff" || "solana offchain" || version || format || length || msg
        // and Ed25519-signs the envelope.
        if (path === '/solana/sign-offchain-message' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SolanaSignOffchainMessageRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]
          const message = decodeMessageBody(body.message, body.is_text, 'solanaSignOffchainMessage')
          // Off-chain spec: 1212-byte ceiling for formats 0/1. Firmware
          // rejects above this anyway; enforcing here surfaces the error
          // pre-USB-roundtrip with a clearer source.
          if (message.length > 1212) {
            throw new HttpError(400, `solanaSignOffchainMessage.message: exceeds 1212-byte off-chain spec ceiling (got ${message.length})`)
          }
          const result = await emuWrap(() => wallet.solanaSignOffchainMessage({
            addressNList,
            version: body.version,
            messageFormat: body.message_format,
            message,
            showDisplay: body.show_display,
          }), { operation: 'solanaSignOffchainMessage', chain: 'Solana' })
          if (!result) throw new HttpError(500, 'solanaSignOffchainMessage returned no result')
          return json({ publicKey: toHex(result.publicKey), signature: toHex(result.signature) })
        }

        // ── TON BUILD + FINALIZE (2 endpoints) ────────────────────────
        // Exposes the local v4R2 BOC builder so thin clients (browser
        // extension, mobile) don't have to embed a TON lib + toncenter
        // plumbing just to construct a transfer. The existing desktop
        // flow in txbuilder/index.ts already uses the same helpers —
        // these endpoints are a thin REST shell around them.
        if (path === '/ton/build-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.TonBuildTransferRequest)

          // Memo cap. Plain-text TON memos are encoded into a single cell
          // alongside the 32-bit op code; ~120 bytes UTF-8 is a safe ceiling
          // (1023-bit cell budget minus framing). Longer memos technically
          // require a continuation cell ref, which buildInternalMessage
          // doesn't emit — without this guard the user gets a cryptic
          // BitWriter overflow deep in the assembler.
          if (body.memo && Buffer.byteLength(body.memo, 'utf8') > 120) {
            throw new HttpError(400, 'memo too large (max 120 bytes UTF-8)')
          }

          // Seqno + wallet-state fetch fails independently; run in parallel
          // so the caller eats one RTT rather than two, and surface both
          // errors via a single diagnostic when the network's down.
          let seqno: number
          let walletState: { initialized: boolean; balance: string }
          try {
            ;[seqno, walletState] = await Promise.all([
              getTonSeqno(body.fromAddress),
              getTonWalletState(body.fromAddress),
            ])
          } catch (e: any) {
            throw new HttpError(502, `TON network error — cannot determine wallet state: ${e.message}`)
          }

          const needsDeploy = !walletState.initialized
          if (needsDeploy && !body.publicKeyHex) {
            // Firmware needs the pubkey to derive the v4R2 contract data
            // cell for StateInit — without it, the first-ever tx from a
            // fresh address can't be constructed. Make the failure loud
            // rather than silently producing an un-broadcastable tx.
            throw new HttpError(400, 'TON wallet not initialized — publicKeyHex required for first-time deployment')
          }

          // 5-minute validity window. The hardware wallet confirmation UI
          // can take 30s+ for a careful user, and the v4R2 wallet
          // contract rejects messages past expireAt — anything tighter
          // than ~2 min risks a "expired" failure after the user already
          // confirmed on the device. If the device-side flow (PIN +
          // passphrase + multi-step confirm) takes longer than 5 min, the
          // caller must call /ton/build-transfer again to refresh expireAt
          // before signing — we have no way to extend it post-hoc without
          // changing the bodyHash the device just signed.
          const expireAt = Math.floor(Date.now() / 1000) + 300

          const build = buildTonTransfer({
            fromAddress: body.fromAddress,
            to: body.toAddress,
            amountNano: body.amountNano,
            memo: body.memo,
            seqno,
            expireAt,
            needsDeploy,
            publicKeyHex: body.publicKeyHex,
          })

          return json({
            build,
            // Convenience fields the client would otherwise have to pluck
            // off `build` — flatten the ones most callers need.
            bodyHash: build.bodyHash,
            rawTx: build.rawTx,
            seqno: build.seqno,
            expireAt: build.expireAt,
            needsDeploy: build.needsDeploy,
            // Approximate fees for the UI. Clear-signing makes the exact
            // figure visible on-device; this is just so the send screen
            // can surface an estimate before the user commits.
            feeEstimate: needsDeploy ? '0.01' : '0.005',
          })
        }

        if (path === '/ton/finalize-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.TonFinalizeTransferRequest)

          // Signature is 64 bytes Ed25519. Hex validation in the schema
          // catches length mismatches before they bubble into the
          // assembler as a cryptic BitWriter error.
          const sigBuf = Buffer.from(body.signature, 'hex')
          if (sigBuf.length !== 64) {
            throw new HttpError(400, 'signature must decode to 64 bytes')
          }

          const buildResult = body.build as unknown as TonBuildResult
          if (!buildResult?._internal) {
            throw new HttpError(400, 'build._internal missing — pass the full object returned by /ton/build-transfer')
          }
          if (typeof buildResult.bodyHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(buildResult.bodyHash)) {
            throw new HttpError(400, 'build.bodyHash missing or not 32-byte hex')
          }

          // Detect a client that mutated _internal (amount, destination,
          // memo, seqno, expireAt) after the device already signed the
          // original bodyHash. Without this, broadcast=false would return
          // a structurally-valid BOC that carries a signature over different
          // bytes than what it now encodes — the caller can't tell the tx
          // is doomed until TonCenter rejects it (or worse, with a collision,
          // never).
          let recomputedHash: string
          try {
            recomputedHash = computeTonBodyHash(buildResult)
          } catch (e: any) {
            throw new HttpError(400, `build object malformed — cannot reconstruct unsigned body: ${e.message}`)
          }
          if (recomputedHash !== buildResult.bodyHash.toLowerCase()) {
            throw new HttpError(400, 'build tampered — _internal state does not match bodyHash')
          }

          const { boc, extMsgHash } = assembleTonSignedBoc(buildResult, sigBuf)

          // broadcast=false lets a caller handle the broadcast elsewhere
          // (offline signing, pre-flight BOC inspection, etc.). Default
          // true because the common path is build → sign → broadcast in
          // one user action.
          const broadcast = body.broadcast !== false
          if (!broadcast) {
            return json({ boc, txid: extMsgHash, broadcasted: false })
          }

          try {
            await broadcastTonBoc(boc)
          } catch (e: any) {
            // Surface the BOC and the txid even on broadcast failure so
            // the caller can retry broadcast without re-signing.
            throw new HttpError(
              502,
              `TON broadcast failed (boc preserved in error payload): ${e.message}`,
              { boc, txid: extMsgHash },
            )
          }

          return json({ boc, txid: extMsgHash, broadcasted: true })
        }

        // ── DEVICE INFO (2 endpoints — read-only) ────────────────────
        if (path === '/system/info/get-features' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const features = await getCachedFeatures(wallet)
          return json(validateResponse(formatFeatures(features), S.FeaturesResponse, path))
        }

        if (path === '/system/info/get-public-key' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.GetPublicKeyRequest)
          const cacheKey = scopedKey(engine, 'pubkey', body)
          const cached = pubkeyCache.get(cacheKey)
          if (cached) return json(cached)
          const sd = showDisplay(body.show_display)
          const result = await emuWrap(() => wallet.getPublicKeys([{
            addressNList: body.address_n,
            curve: body.ecdsa_curve_name || 'secp256k1',
            showDisplay: sd,
            coin: body.coin_name || 'Bitcoin',
            scriptType: body.script_type,
          }]), { operation: 'getPublicKeys', chain: 'Bitcoin' }, sd)
          const xpub = result?.[0]?.xpub
          const out = { xpub }
          if (pubkeyCache.size >= MAX_CACHE_SIZE) evictOldest(pubkeyCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          pubkeyCache.set(cacheKey, out)
          return json(validateResponse(out, S.GetPublicKeyResponse, path))
        }

        // ═══════════════════════════════════════════════════════════════
        // V2 DEVICE MANAGEMENT (5 endpoints — require auth, single-device mode)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/v2/devices' && method === 'GET') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          const devices = ds.deviceId ? [{
            device_id: ds.deviceId,
            is_active: true,
            state: ds.state,
            name: ds.label || 'KeepKey',
          }] : []
          return json({ devices, total: devices.length })
        }

        if (path === '/api/v2/devices/active' && method === 'GET') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          if (!ds.deviceId) return json({ error: 'No active device' }, 404)
          return json({ device_id: ds.deviceId, state: ds.state })
        }

        if (path === '/api/v2/devices/paired' && method === 'GET') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          const devices = ds.deviceId ? [{
            device_id: ds.deviceId,
            is_connected: true,
            is_active: true,
            total_frontloads: 0,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString(),
          }] : []
          return json({
            total_paired: devices.length,
            total_connected: devices.length,
            devices,
          })
        }

        if (path === '/api/v2/devices/select' && method === 'POST') {
          auth.requireAuth(req)
          const ds = engine.getDeviceState()
          return json({
            success: true,
            device_id: ds.deviceId || null,
            message: 'Single-device mode — device selected',
          })
        }

        // /api/v2/devices/:id — must come AFTER specific paths above
        if (path.startsWith('/api/v2/devices/') && method === 'GET') {
          auth.requireAuth(req)
          const id = path.split('/').pop()
          const ds = engine.getDeviceState()
          if (!ds.deviceId || ds.deviceId !== id) {
            return json({ error: 'Device not found' }, 404)
          }
          return json({ device_id: ds.deviceId, is_active: true, state: ds.state })
        }

        // ═══════════════════════════════════════════════════════════════
        // SDK-CALLED ENDPOINTS (cache, portfolio, batch pubkeys)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/cache/status' && method === 'GET') {
          return json({
            available: true,
            cached_pubkeys: pubkeyCache.size,
            cached_addresses: addressCache.size,
          })
        }

        if (path === '/api/portfolio' && method === 'GET') {
          const ds = engine.getDeviceState()
          if (!ds.deviceId) return json({ devices: [], total_value_usd: 0 })
          const cached = engine.isPassphraseWallet ? null : getCachedBalances(ds.deviceId)
          const totalUsd = cached ? cached.balances.reduce((sum, b) => sum + b.balanceUsd, 0) : 0
          return json({
            devices: [{ state: ds.state }],
            total_value_usd: totalUsd,
          })
        }

        if (path.startsWith('/api/portfolio/') && method === 'GET') {
          auth.requireAuth(req)
          const deviceId = path.split('/').pop()
          const ds = engine.getDeviceState()
          if (!ds.deviceId || ds.deviceId !== deviceId) {
            return json({ error: 'Device not found' }, 404)
          }
          const cached = engine.isPassphraseWallet ? null : getCachedBalances(ds.deviceId)
          const totalUsd = cached ? cached.balances.reduce((sum, b) => sum + b.balanceUsd, 0) : 0
          return json({
            device_id: ds.deviceId,
            state: ds.state,
            total_value_usd: totalUsd,
          })
        }

        // ── DEBUG PORTFOLIO ENDPOINTS ────────────────────────────────────
        // Verbose read-only views into cached balances, spam analysis, and
        // ── PIONEER URL MANAGEMENT ────────────────────────────────────
        if (path === '/api/pioneer/status' && method === 'GET') {
          const base = callbacks.getPioneerApiBase?.() ?? 'unknown'
          return json({ url: base, is_default: base === 'https://api.keepkey.info' || base === 'unknown' })
        }

        if (path === '/api/pioneer/url' && method === 'POST') {
          auth.requireAuth(req)
          const body = await req.json().catch(() => ({})) as any
          const url = (body.url ?? '').trim()
          if (url && !/^https?:\/\//i.test(url)) return json({ error: 'URL must start with http:// or https://' }, 400)
          await callbacks.setPioneerApiBase?.(url)
          const newBase = callbacks.getPioneerApiBase?.() ?? 'unknown'
          return json({ url: newBase, is_default: !url })
        }

        // token visibility overrides. Useful for diagnosing balance/spam issues
        // without needing to dig through the SQLite DB directly.

        if (path === '/api/debug/portfolio' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ error: 'Unavailable for passphrase wallet sessions' }, 403)
          const ds = engine.getDeviceState()
          const deviceId = ds.deviceId
          if (!deviceId) return json({ error: 'No device connected' }, 503)
          const cached = getCachedBalances(deviceId)
          if (!cached) return json({ deviceId, cached: false, balances: [] })
          const visibilityMap = getAllTokenVisibility()
          const now = Date.now()
          const ageMs = now - cached.updatedAt

          let totalUsd = 0
          let totalTokens = 0
          let confirmedSpam = 0
          let possibleSpam = 0
          let hiddenByUser = 0
          const chains = cached.balances.map(b => {
            totalUsd += b.balanceUsd
            const tokenAnalysis = (b.tokens || []).map(t => {
              totalTokens++
              const override = visibilityMap.get((t.caip || '').toLowerCase()) ?? null
              const spam = detectSpamToken(t, override)
              if (spam.isSpam && spam.level === 'confirmed') confirmedSpam++
              if (spam.isSpam && spam.level === 'possible') possibleSpam++
              if (override === 'hidden') hiddenByUser++
              return { ...t, _spam: spam, _userOverride: override }
            })
            return {
              chainId: b.chainId,
              symbol: b.symbol,
              address: b.address,
              balance: b.balance,
              balanceUsd: b.balanceUsd,
              nativeBalanceUsd: b.nativeBalanceUsd,
              tokenCount: tokenAnalysis.length,
              tokens: tokenAnalysis,
            }
          })

          return json({
            deviceId,
            cached: true,
            updatedAt: cached.updatedAt,
            ageMs,
            ageSec: Math.round(ageMs / 1000),
            summary: { totalUsd, totalChains: chains.length, totalTokens, confirmedSpam, possibleSpam, hiddenByUser },
            chains,
          })
        }

        if (path === '/api/debug/portfolio/chains' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ error: 'Unavailable for passphrase wallet sessions' }, 403)
          const ds = engine.getDeviceState()
          const deviceId = ds.deviceId
          if (!deviceId) return json({ error: 'No device connected' }, 503)
          const cached = getCachedBalances(deviceId)
          if (!cached) return json({ deviceId, cached: false, chains: [] })
          const now = Date.now()
          return json({
            deviceId,
            updatedAt: cached.updatedAt,
            ageMs: now - cached.updatedAt,
            chains: cached.balances.map(b => ({
              chainId: b.chainId,
              symbol: b.symbol,
              address: b.address,
              balance: b.balance,
              balanceUsd: b.balanceUsd,
              nativeBalanceUsd: b.nativeBalanceUsd ?? null,
              tokenCount: b.tokens?.length ?? 0,
            })),
          })
        }

        if (path === '/api/debug/portfolio/tokens' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ error: 'Unavailable for passphrase wallet sessions' }, 403)
          const ds = engine.getDeviceState()
          const deviceId = ds.deviceId
          if (!deviceId) return json({ error: 'No device connected' }, 503)
          const cached = getCachedBalances(deviceId)
          if (!cached) return json({ deviceId, cached: false, tokens: [] })
          const visibilityMap = getAllTokenVisibility()
          const tokens: any[] = []
          for (const b of cached.balances) {
            for (const t of b.tokens || []) {
              const override = visibilityMap.get((t.caip || '').toLowerCase()) ?? null
              const spam = detectSpamToken(t, override)
              tokens.push({ chain: b.chainId, ...t, _spam: spam, _userOverride: override })
            }
          }
          tokens.sort((a, b) => (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0))
          return json({ deviceId, total: tokens.length, tokens })
        }

        if (path === '/api/debug/portfolio/spam' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ error: 'Unavailable for passphrase wallet sessions' }, 403)
          const ds = engine.getDeviceState()
          const deviceId = ds.deviceId
          if (!deviceId) return json({ error: 'No device connected' }, 503)
          const cached = getCachedBalances(deviceId)
          if (!cached) return json({ deviceId, cached: false, spam: [] })
          const visibilityMap = getAllTokenVisibility()
          const showPossible = new URL(req.url).searchParams.get('level') !== 'confirmed'
          const spam: any[] = []
          for (const b of cached.balances) {
            for (const t of b.tokens || []) {
              const override = visibilityMap.get((t.caip || '').toLowerCase()) ?? null
              const result = detectSpamToken(t, override)
              if (!result.isSpam) continue
              if (!showPossible && result.level !== 'confirmed') continue
              spam.push({ chain: b.chainId, ...t, _spam: result, _userOverride: override })
            }
          }
          spam.sort((a, b) => {
            if (a._spam.level === b._spam.level) return (b.balanceUsd ?? 0) - (a.balanceUsd ?? 0)
            return a._spam.level === 'confirmed' ? -1 : 1
          })
          return json({ deviceId, total: spam.length, spam })
        }

        // ── Pioneer diagnostic: drive a full chunked portfolio call and report results ──
        if (path === '/api/debug/pioneer-audit' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ error: 'Unavailable for passphrase wallet sessions' }, 403)
          const ds = engine.getDeviceState()
          const deviceId = ds.deviceId
          if (!deviceId) return json({ error: 'No device connected' }, 503)

          // Build pubkey list from cached DB entries (avoids device round-trips)
          const cachedPks = getCachedPubkeys(deviceId)
          const pubkeys: Array<{ caip: string; pubkey: string; label: string }> = []

          // getCachedPubkeys() returns chainId but not caip — derive from the shared CHAINS registry
          // so new chains added to chains.ts are automatically covered.
          const chainIdToCaip = new Map(CHAINS.map(c => [c.id, c.caip]))

          // UTXO (xpubs) and non-EVM address-based entries
          for (const pk of cachedPks) {
            const caip = chainIdToCaip.get(pk.chainId) || ''
            if (pk.xpub) pubkeys.push({ caip, pubkey: pk.xpub, label: `${pk.chainId}:xpub` })
            else if (pk.address) pubkeys.push({ caip, pubkey: pk.address, label: `${pk.chainId}:addr` })
          }

          // EVM chains — use ETH address from cache for each supported EVM chain
          const ethCachedPk = cachedPks.find(p => p.chainId === 'ethereum' && p.address)
          if (ethCachedPk?.address) {
            const evmCaips: Array<[string, string]> = [
              ['eip155:1/slip44:60', 'ethereum'],
              ['eip155:137/slip44:966', 'polygon'],
              ['eip155:42161/slip44:60', 'arbitrum'],
              ['eip155:10/slip44:60', 'optimism'],
              ['eip155:43114/slip44:60', 'avalanche'],
              ['eip155:56/slip44:60', 'bsc'],
              ['eip155:8453/slip44:60', 'base'],
              ['eip155:100/slip44:60', 'gnosis'],
            ]
            for (const [caip, label] of evmCaips) {
              if (!pubkeys.find(p => p.caip === caip)) {
                pubkeys.push({ caip, pubkey: ethCachedPk.address, label: `${label}:evm` })
              }
            }
          }

          // Cached non-EVM addresses (cosmos, xrp, etc.)
          const cachedBalances = getCachedBalances(deviceId)
          if (cachedBalances) {
            const cosmosChains: Record<string, string> = {
              cosmos: 'cosmos:cosmoshub-4/slip44:118',
              thorchain: 'cosmos:thorchain-mainnet-v1/slip44:931',
              mayachain: 'cosmos:mayachain-mainnet-v1/slip44:931',
              osmosis: 'cosmos:osmosis-1/slip44:118',
            }
            for (const b of cachedBalances.balances) {
              const caip = cosmosChains[b.chainId]
              if (caip && b.address && !b.address.startsWith('xpub') && !b.address.startsWith('zpub') && !b.address.startsWith('ypub')) {
                if (!pubkeys.find(p => p.caip === caip)) {
                  pubkeys.push({ caip, pubkey: b.address, label: `${b.chainId}:addr` })
                }
              }
              if (b.chainId === 'ripple' && b.address) {
                const xrpCaip = 'ripple:4109c6f2045fc7eff4cde8f9905d19c2/slip44:144'
                if (!pubkeys.find(p => p.caip === xrpCaip)) {
                  pubkeys.push({ caip: xrpCaip, pubkey: b.address, label: 'ripple:addr' })
                }
              }
            }
          }

          const CHUNK_SIZE = 8
          const chunks: typeof pubkeys[] = []
          for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) chunks.push(pubkeys.slice(i, i + CHUNK_SIZE))

          // Call Pioneer for each chunk
          let pioneer: any
          try { pioneer = await callbacks.getPioneer() } catch (e: any) {
            return json({ error: `Pioneer init failed: ${e.message}`, pubkeyCount: pubkeys.length })
          }

          const chunkResults: any[] = []
          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]
            const t0 = Date.now()
            try {
              const resp = await Promise.race([
                pioneer.GetPortfolioBalances({ pubkeys: chunk.map(p => ({ caip: p.caip, pubkey: p.pubkey })) }, { forceRefresh: true }),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('60s timeout')), 60000)),
              ])
              const entries = Array.isArray(resp?.data) ? resp.data : (Array.isArray(resp?.data?.balances) ? resp.data.balances : (Array.isArray(resp) ? resp : []))
              chunkResults.push({
                chunk: i + 1,
                pubkeys: chunk.map(p => ({ caip: p.caip, label: p.label, pubkey: p.pubkey.substring(0, 20) + '...' })),
                ok: true,
                durationMs: Date.now() - t0,
                entryCount: entries.length,
                entries: entries.map((e: any) => ({
                  caip: e.caip, symbol: e.symbol, balance: e.balance, valueUsd: e.valueUsd,
                  dataSource: e.dataSource, isStale: e.isStale,
                })),
              })
            } catch (e: any) {
              chunkResults.push({
                chunk: i + 1,
                pubkeys: chunk.map(p => ({ caip: p.caip, label: p.label })),
                ok: false,
                durationMs: Date.now() - t0,
                error: e?.message || String(e),
              })
            }
          }

          const succeeded = chunkResults.filter(r => r.ok).length
          const failed = chunkResults.filter(r => !r.ok).length
          return json({
            deviceId,
            pubkeyCount: pubkeys.length,
            chunkCount: chunks.length,
            chunkSize: CHUNK_SIZE,
            succeeded,
            failed,
            pioneerUrl: callbacks.getPioneerApiBase?.() || 'unknown',
            chunks: chunkResults,
          })
        }

        if (path === '/api/debug/token-visibility' && method === 'GET') {
          auth.requireAuth(req)
          const hidden = getTokensByVisibility('hidden')
          const visible = getTokensByVisibility('visible')
          return json({
            total: hidden.length + visible.length,
            hidden: hidden.map(r => ({ caip: r.caip, updatedAt: r.updatedAt })),
            visible: visible.map(r => ({ caip: r.caip, updatedAt: r.updatedAt })),
          })
        }

        if (path.startsWith('/api/debug/token-visibility/') && method === 'PUT') {
          auth.requireAuth(req)
          const caip = decodeURIComponent(path.slice('/api/debug/token-visibility/'.length))
          if (!caip) return json({ error: 'caip required in path' }, 400)
          const body = await req.json().catch(() => ({})) as any
          const status = body?.status
          if (status !== 'visible' && status !== 'hidden') {
            return json({ error: 'body.status must be "visible" or "hidden"' }, 400)
          }
          setTokenVisibility(caip, status)
          return json({ caip, status, updated: true })
        }

        if (path.startsWith('/api/debug/token-visibility/') && method === 'DELETE') {
          auth.requireAuth(req)
          const caip = decodeURIComponent(path.slice('/api/debug/token-visibility/'.length))
          if (!caip) return json({ error: 'caip required in path' }, 400)
          removeTokenVisibility(caip)
          return json({ caip, removed: true })
        }

        if (path === '/api/pubkeys/batch' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.BatchPubkeysRequest)
          const paths = body.paths || []
          const results: any[] = []

          for (const p of paths) {
            if (!p.address_n || !Array.isArray(p.address_n)) continue

            // ── Address-type paths (non-UTXO: XRP, ETH, Cosmos, etc.) ──
            // SDK sends type='address' for chains that need actual addresses, not xpubs.
            if (p.type === 'address') {
              // Bitcoin-only firmware can't derive any non-UTXO chain — this whole
              // branch. Skip quietly (the device would reject with "Unknown message").
              if (deviceIsBitcoinOnly()) continue
              const primaryNetwork = (p.networks || [])[0] || ''
              const addrCacheKey = scopedKey(engine, 'batch-addr', { n: p.address_n, net: primaryNetwork })
              const cachedAddr = addressCache.get(addrCacheKey)
              if (cachedAddr) {
                results.push({
                  pubkey: cachedAddr,
                  address: cachedAddr,
                  path: addressNListToBIP32(p.address_n),
                  pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                  scriptType: p.script_type || 'p2pkh',
                  networks: p.networks || [],
                  type: 'address',
                  note: p.note,
                  addressNList: p.address_n,
                })
                continue
              }

              try {
                const coinType = p.address_n.length >= 2 ? (p.address_n[1] >= 0x80000000 ? p.address_n[1] - 0x80000000 : p.address_n[1]) : 0
                // Extend account-level path (3 elements) to full derivation path
                const addrNList = p.address_n.length <= 3 ? [...p.address_n, 0, 0] : p.address_n
                let address = ''

                if (coinType === 60) {
                  const r = await wallet.ethGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (coinType === 144) {
                  const r = await wallet.rippleGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (primaryNetwork.includes('thorchain')) {
                  const r = await wallet.thorchainGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (primaryNetwork.includes('maya')) {
                  const r = await wallet.mayachainGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (primaryNetwork.includes('osmosis')) {
                  const r = await wallet.osmosisGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (coinType === 118 || coinType === 931) {
                  const r = await wallet.cosmosGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : r?.address || ''
                } else if (coinType === 501) {
                  if (!requireChainSupport('solana')) {
                    const solNList = p.address_n
                    const r = await wallet.solanaGetAddress({ addressNList: solNList, showDisplay: false })
                    address = typeof r === 'string' ? r : (r as any)?.address || ''
                  }
                } else if (coinType === 195) {
                  if (!requireChainSupport('tron')) {
                    const r = await wallet.tronGetAddress({ addressNList: addrNList, showDisplay: false })
                    address = typeof r === 'string' ? r : (r as any)?.address || ''
                  }
                } else if (coinType === 607) {
                  if (!requireChainSupport('ton')) {
                    const tonNList = p.address_n
                    const r = await wallet.tonGetAddress({ addressNList: tonNList, showDisplay: false, bounceable: false })
                    address = typeof r === 'string' ? r : (r as any)?.address || ''
                  }
                }

                if (address) {
                  if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
                  addressCache.set(addrCacheKey, address)
                  auth.saveAccount(address, addrNList)
                }

                results.push({
                  pubkey: address,
                  address,
                  path: addressNListToBIP32(p.address_n),
                  pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                  scriptType: p.script_type || 'p2pkh',
                  networks: p.networks || [],
                  type: 'address',
                  note: p.note,
                  addressNList: p.address_n,
                })
              } catch (err: any) {
                console.warn(`[REST] batch address failed for path ${JSON.stringify(p.address_n)}:`, err?.message)
              }
              continue
            }

            // ── xpub/ypub/zpub-type paths (UTXO chains) ──
            const cacheKey = scopedKey(engine, 'batch-pubkey', { address_n: p.address_n, script_type: p.script_type })
            const cached = pubkeyCache.get(cacheKey)
            if (cached) {
              results.push({
                pubkey: cached.xpub || '',
                address: '',
                path: addressNListToBIP32(p.address_n),
                pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                scriptType: p.script_type || 'p2pkh',
                networks: p.networks || [],
                type: p.type || 'xpub',
                note: p.note,
                addressNList: p.address_n,
              })
              continue
            }
            const coinType = p.address_n.length >= 2 ? (p.address_n[1] >= 0x80000000 ? p.address_n[1] - 0x80000000 : p.address_n[1]) : 0
            const rawCoin = p.coin || SLIP44_TO_COIN[coinType] || 'Bitcoin'
            const coin = TICKER_TO_COIN[rawCoin] || rawCoin
            try {
              const result = await wallet.getPublicKeys([{
                addressNList: p.address_n,
                curve: 'secp256k1',
                showDisplay: false,
                coin,
                scriptType: p.script_type,
              }])
              const xpub = result?.[0]?.xpub || ''
              const out = { xpub }
              if (pubkeyCache.size >= MAX_CACHE_SIZE) evictOldest(pubkeyCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
              pubkeyCache.set(cacheKey, out)
              results.push({
                pubkey: xpub,
                address: '',
                path: addressNListToBIP32(p.address_n),
                pathMaster: addressNListToBIP32(p.address_n.slice(0, 3)),
                scriptType: p.script_type || 'p2pkh',
                networks: p.networks || [],
                type: p.type || 'xpub',
                note: p.note,
                addressNList: p.address_n,
              })
            } catch (err: any) {
              console.warn(`[REST] batch pubkey failed for path ${JSON.stringify(p.address_n)} coin=${coin} scriptType=${p.script_type}:`, err?.message)
            }
          }

          return json({
            pubkeys: results,
            cached_count: results.length,
            total_requested: paths.length,
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // SIGNING HISTORY / AUDIT LOG (auth-required — exposes payloads)
        // PRIVACY: standard-wallet history is hidden during passphrase sessions,
        // matching the RPC `getApiLogs` / `getRecentActivity` behavior.
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/v1/activity/recent' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ entries: [], count: 0 })
          const scope = getWalletDbScope()
          if (!scope) return json({ entries: [], count: 0 })
          const url = new URL(req.url)
          const q = url.searchParams
          const limitRaw = q.get('limit')
          const limit = limitRaw === null ? 50 : Number(limitRaw)
          if (!Number.isFinite(limit)) {
            throw new HttpError(400, 'Invalid limit: must be a number')
          }
          const entries = getRecentActivityFromLog(
            Math.min(Math.max(limit, 1), 500),
            q.get('chainId') || q.get('chain') || undefined,
            scope.deviceId,
            scope.walletId,
          )
          return json({ entries, count: entries.length })
        }

        if (path === '/api/v1/activity' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ entries: [], count: 0 })
          const scope = getWalletDbScope()
          if (!scope) return json({ entries: [], count: 0 })
          const url = new URL(req.url)
          const q = url.searchParams
          const parseNumParam = (name: string): number | undefined => {
            const raw = q.get(name)
            if (raw === null) return undefined
            const n = Number(raw)
            if (!Number.isFinite(n)) {
              throw new HttpError(400, `Invalid ${name}: must be a number`)
            }
            return n
          }
          const entries = findApiLogs({
            ...scope,
            route:        q.get('route')         || undefined,
            activityType: q.get('activityType')  || undefined,
            txid:         q.get('txid')          || undefined,
            chain:        q.get('chain')         || undefined,
            since:        parseNumParam('since'),
            until:        parseNumParam('until'),
            limit:        parseNumParam('limit'),
            offset:       parseNumParam('offset'),
          })
          return json({ entries, count: entries.length })
        }

        if (path === '/api/v1/activity/rebuild' && method === 'POST') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) {
            return json({ error: 'Activity rebuild is not available for passphrase-protected wallets' }, 403)
          }
          const scope = getWalletDbScope()
          if (!scope) {
            return json({ error: 'Wallet scope is not ready. Unlock the device and wait for seed identity.' }, 409)
          }
          const wallet = requireWallet(engine)
          reqBody = await req.json().catch(() => ({}))
          const body = (reqBody && typeof reqBody === 'object') ? reqBody as ActivityHistoryRebuildOptions : {}
          const chainIds = [
            ...(Array.isArray(body.chainIds) ? body.chainIds : []),
            ...(typeof body.chainId === 'string' ? [body.chainId] : []),
          ]
          const unknown = chainIds.filter(id => !CHAINS.some(c => c.id === id || c.symbol === id))
          if (unknown.length > 0) {
            return json({ error: `Unknown chain id(s): ${unknown.join(', ')}` }, 400)
          }
          const result = await rebuildActivityHistory({
            wallet,
            scope,
            chains: CHAINS,
            firmwareVersion: engine.getDeviceState().firmwareVersion,
            options: body,
          })
          return json(result)
        }

        if (path.startsWith('/api/v1/activity/') && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ error: 'Not found' }, 404)
          const scope = getWalletDbScope()
          if (!scope) return json({ error: 'Not found' }, 404)
          const tail = path.split('/').pop() || ''
          const id = Number(tail)
          if (!Number.isFinite(id) || !Number.isInteger(id)) {
            return json({ error: 'Invalid id' }, 400)
          }
          const entry = getApiLogById(id, scope.deviceId, scope.walletId)
          if (!entry) return json({ error: 'Not found' }, 404)
          return json(entry)
        }

        // ═══════════════════════════════════════════════════════════════
        // SWAP HISTORY (auth-required — reports / external tooling)
        // PRIVACY: standard-wallet history is hidden during passphrase
        // sessions, matching the RPC `getSwapHistory` behavior.
        // Read-only — the table is owned by swap-tracker / executeSwap.
        // ═══════════════════════════════════════════════════════════════
        if (path === '/api/v1/swaps/stats' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) {
            return json({ totalSwaps: 0, completed: 0, failed: 0, refunded: 0, pending: 0 })
          }
          const scope = getWalletDbScope()
          if (!scope) return json({ totalSwaps: 0, completed: 0, failed: 0, refunded: 0, pending: 0 })
          return json(getSwapHistoryStats(scope.deviceId, scope.walletId))
        }

        if (path === '/api/v1/swaps' && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ entries: [], count: 0 })
          const scope = getWalletDbScope()
          if (!scope) return json({ entries: [], count: 0 })
          const url = new URL(req.url)
          const q = url.searchParams
          const parseNumParam = (name: string): number | undefined => {
            const raw = q.get(name)
            if (raw === null) return undefined
            const n = Number(raw)
            if (!Number.isFinite(n)) throw new HttpError(400, `Invalid ${name}: must be a number`)
            return n
          }
          // Whitelist `status` so callers can't smuggle arbitrary text into the
          // query — invalid values get rejected loudly instead of silently
          // returning everything via a no-match LIKE.
          const VALID_STATUSES: ReadonlyArray<SwapTrackingStatus | 'all'> = [
            'all', 'pending', 'confirming', 'output_detected', 'output_confirming',
            'output_confirmed', 'completed', 'failed', 'refunded',
          ]
          const rawStatus = q.get('status')
          let status: SwapTrackingStatus | 'all' | undefined
          if (rawStatus !== null) {
            if (!VALID_STATUSES.includes(rawStatus as any)) {
              throw new HttpError(400, `Invalid status: ${rawStatus} (allowed: ${VALID_STATUSES.join(', ')})`)
            }
            status = rawStatus as SwapTrackingStatus | 'all'
          }
          const entries = getSwapHistory({
            ...scope,
            status,
            asset:    q.get('asset')   || undefined,
            fromDate: parseNumParam('fromDate'),
            toDate:   parseNumParam('toDate'),
            limit:    parseNumParam('limit'),
            offset:   parseNumParam('offset'),
          })
          return json({ entries, count: entries.length })
        }

        if (path.startsWith('/api/v1/swaps/') && method === 'GET') {
          auth.requireAuth(req)
          if (engine.isPassphraseWallet) return json({ error: 'Not found' }, 404)
          const scope = getWalletDbScope()
          if (!scope) return json({ error: 'Not found' }, 404)
          const tail = path.split('/').pop() || ''
          if (!tail) return json({ error: 'Invalid txid' }, 400)
          const record = getSwapHistoryByTxid(tail, scope.deviceId, scope.walletId)
          if (!record) return json({ error: 'Not found' }, 404)
          return json(record)
        }

        // ═══════════════════════════════════════════════════════════════
        // SWAP AVAILABILITY (debug — picker classification visibility)
        // Returns the same data the AssetPickerDialog uses to decide
        // whether each row is selectable. Keyed by CAIP-19. Auth-gated.
        //   GET /api/v1/swap/availability/:caip          — single asset
        //   GET /api/v1/swap/discovery?q=&limit=&status= — search + filter
        // ═══════════════════════════════════════════════════════════════
        if (path.startsWith('/api/v1/swap/availability/') && method === 'GET') {
          auth.requireAuth(req)
          // Path is "/api/v1/swap/availability/<caip>" — caip itself contains
          // ':' and '/' so we can't naively split. Slice from the prefix.
          const caip = decodeURIComponent(path.slice('/api/v1/swap/availability/'.length))
          if (!caip) return json({ error: 'Missing caip' }, 400)
          const { assessWithFirmware, networkDisplayName, chainMetaForCaip2 } = await import('../shared/swap-discovery')
          const slash = caip.indexOf('/')
          const chainCaip2 = slash >= 0 ? caip.slice(0, slash) : caip
          // Mirror the picker: gate by the connected device's firmware so e.g.
          // ZEC reports `unsupported_firmware` below 7.15.0 instead of swappable.
          return json({
            caip,
            chainCaip2,
            chainDisplayName: networkDisplayName(chainCaip2),
            chainKnownToVault: !!chainMetaForCaip2(chainCaip2),
            assessment: assessWithFirmware(caip, engine.getDeviceState().firmwareVersion),
          })
        }

        if (path === '/api/v1/swap/discovery' && method === 'GET') {
          auth.requireAuth(req)
          const url = new URL(req.url)
          const q = url.searchParams.get('q') || ''
          const statusFilter = url.searchParams.get('status')
          const limitRaw = url.searchParams.get('limit')
          const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50
          if (limitRaw && !Number.isFinite(Number(limitRaw))) {
            throw new HttpError(400, `Invalid limit: ${limitRaw}`)
          }

          const { buildAssetEntries, buildSearchIndex, searchEntries, bucketFor } = await import('../shared/swap-discovery')
          // Debug endpoint — uses the same swappable list as the picker but
          // intentionally drops balances. The classification (status, providers,
          // bucket) is what callers want to inspect; balances would skew rows
          // into bucket 0/1 and conflate UX-state with matrix correctness.
          const { getSwapAssets } = await import('./swap')
          const swappable = await getSwapAssets()
          // Mirror the picker, which firmware-gates rows — pass the device's
          // firmware so the classification matches what the UI actually shows.
          const entries = await buildAssetEntries({ swappable, balances: [], firmwareVersion: engine.getDeviceState().firmwareVersion })
          const idx = buildSearchIndex(entries)
          let results = searchEntries(idx, q)
          if (statusFilter) {
            const allowed = ['swappable', 'unknown', 'unsupported_chain', 'unsupported_token', 'unsupported_firmware']
            if (!allowed.includes(statusFilter)) {
              throw new HttpError(400, `Invalid status: ${statusFilter} (allowed: ${allowed.join(', ')})`)
            }
            results = results.filter(e => e.availability.status === statusFilter)
          }
          return json({
            query: q,
            statusFilter: statusFilter || null,
            totalUniverse: entries.length,
            matched: results.length,
            entries: results.slice(0, limit).map(e => ({
              caip: e.caip,
              chainId: e.chainId,
              symbol: e.symbol,
              name: e.name,
              isNative: e.isNative,
              hasBalance: !!e.balance,
              pioneerSwappable: !!e.swappable,
              bucket: bucketFor(e),
              availability: e.availability,
            })),
          })
        }

        // ═══════════════════════════════════════════════════════════════
        // SYSTEM MANAGEMENT (keepkey-desktop compatible — require auth)
        // ═══════════════════════════════════════════════════════════════
        if (path === '/system/info/list-coins' && method === 'POST') {
          auth.requireAuth(req)
          return json(CHAINS.map(c => ({
            coin_name: c.coin,
            coin_shortcut: c.symbol,
            chain: c.chain,
            chain_family: c.chainFamily,
            network_id: c.networkId,
            caip: c.caip,
            decimals: c.decimals,
          })))
        }

        if (path === '/system/apply-settings' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ApplySettingsRequest)
          const settings: any = {}
          if (body.label !== undefined) settings.label = body.label
          if (body.use_passphrase !== undefined) settings.usePassphrase = body.use_passphrase
          if (body.autolock_delay_ms !== undefined) settings.autoLockDelayMs = body.autolock_delay_ms
          await wallet.applySettings(settings)
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/change-pin' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ChangePinRequest).catch(() => ({} as any))
          if (body.remove) {
            await wallet.removePin()
          } else {
            await wallet.changePin()
          }
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/apply-policies' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ApplyPoliciesRequest)
          await wallet.applyPolicy(body)
          featuresCache = null
          try {
            await engine.refreshFeaturesSnapshot()
          } catch (e: any) {
            engine.invalidateFeaturesSnapshot()
            console.warn('[REST] Applied policy but failed to refresh features:', e?.message || e)
          }
          return json({ success: true })
        }

        if (path === '/system/wipe-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          await wallet.wipe()
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/clear-session' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          await wallet.clearSession()
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/initialize/reset-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ResetDeviceRequest)
          await wallet.reset({
            entropy: body.word_count ? ({ 12: 128, 18: 192, 24: 256 } as Record<number, number>)[body.word_count] || 128 : 128,
            label: body.label || 'KeepKey',
            pin: body.pin_protection ?? true,
            passphrase: body.passphrase_protection ?? false,
            autoLockDelayMs: 600000,
          })
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/initialize/recover-device' && method === 'POST') {
          const client = auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.RecoverDeviceRequest)
          // beginRecovery sets setupInProgress so syncState()/getFeatures()
          // back off the transport — a concurrent GetFeatures corrupts the
          // CharacterAck exchange (engine syncState comment). It also binds
          // this recovery to the calling client so no other paired app can
          // drive the character input.
          engine.beginRecovery(client.apiKey)
          try {
            await wallet.recover({
              entropy: body.word_count ? ({ 12: 128, 18: 192, 24: 256 } as Record<number, number>)[body.word_count] || 128 : 128,
              label: body.label || 'KeepKey',
              pin: body.pin_protection ?? true,
              passphrase: body.passphrase_protection ?? false,
              autoLockDelayMs: 600000,
            })
          } finally {
            engine.endRecovery()
          }
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/initialize/load-device' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.LoadDeviceRequest)
          await wallet.loadDevice(body)
          featuresCache = null
          return json({ success: true })
        }

        if (path === '/system/recovery/pin' && method === 'POST') {
          const client = auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SendPinRequest)
          // During an owned recovery, only the initiating client may send the
          // recovery PIN — otherwise a second paired client could inject PIN
          // acknowledgements into someone else's flow. (When no REST recovery
          // is active this is a no-op, so other PIN flows are unaffected.)
          if (!engine.canReadRecoveryState(client.apiKey)) {
            throw new HttpError(409, 'Cipher recovery is owned by a different client')
          }
          await wallet.sendPin(body.pin)
          return json({ success: true })
        }

        // Cipher-recovery character entry. The device shows a scrambled keyboard
        // on the OLED and the host relays the ciphered characters (CharacterAck).
        // Mirrors /system/recovery/pin. The recover-device call rejects with
        // "Word not found in BIP39 wordlist" when a finalized word is invalid.
        // Only the client that started recovery may drive it, and (when it
        // sends the seq it last read from /state) the send is pinned to that
        // exact CharacterRequest — a stale/reordered/foreign send is a 409, not
        // a silently corrupted word. Input goes through engine.sendCharacter*,
        // which additionally guards on setupInProgress.
        if (path === '/system/recovery/character' && method === 'POST') {
          const client = auth.requireAuth(req)
          const body = await parseRequest(req, S.SendCharacterRequest)
          // All three acks share ONE atomic, in-flight-guarded engine path, so
          // no two competing requests can race or double-send a CharacterAck.
          await engine.submitRecoveryAck(client.apiKey, 'character', { character: body.character, expectedSeq: body.seq })
          return json({ success: true })
        }

        if (path === '/system/recovery/character/delete' && method === 'POST') {
          const client = auth.requireAuth(req)
          // seq optional here (delete is corrective) — tolerate an empty body
          // rather than forcing JSON like parseRequest does.
          const body = (await req.json().catch(() => ({}))) as { seq?: unknown }
          const seq = typeof body.seq === 'number' ? body.seq : undefined
          await engine.submitRecoveryAck(client.apiKey, 'delete', { expectedSeq: seq })
          return json({ success: true })
        }

        if (path === '/system/recovery/character/done' && method === 'POST') {
          const client = auth.requireAuth(req)
          await engine.submitRecoveryAck(client.apiKey, 'done')
          return json({ success: true })
        }

        // Current cipher-recovery state. `seq` advances each time the device asks
        // for the next character, so a caller can sync sends with the device.
        // While a recovery is active, only its owning client may read live
        // positions — a second paired app must not observe the flow.
        if (path === '/system/recovery/state' && method === 'GET') {
          const client = auth.requireAuth(req)
          if (!engine.canReadRecoveryState(client.apiKey)) {
            throw new HttpError(409, 'Cipher recovery is owned by a different client')
          }
          return json(engine.getRecoveryState())
        }

        // ── Zcash Shielded (Orchard) ────────────────────────────────

        // Gate ALL zcash endpoints behind the feature flag (matches RPC handlers in index.ts)
        if (path.startsWith('/api/zcash/') && getSetting('zcash_privacy_enabled') !== '1') {
          return json({ error: 'Zcash privacy feature is disabled' }, 403)
        }

        const zcashShieldedDef = CHAINS.find(c => c.id === 'zcash-shielded')
        const zcashFwSupported = zcashShieldedDef && isChainSupported(zcashShieldedDef, engine.getDeviceState().firmwareVersion)
        const zcashFwError = `Zcash requires firmware >= ${zcashShieldedDef?.minFirmware ?? 'unknown'}`

        if (path === '/api/zcash/shielded/status' && method === 'GET') {
          if (!zcashFwSupported) return json({ ready: false, error: zcashFwError })
          return json({ ready: isSidecarReady() })
        }

        // All mutating zcash endpoints require firmware support
        if (path.startsWith('/api/zcash/shielded/') && path !== '/api/zcash/shielded/status' && !zcashFwSupported) {
          return json({ error: zcashFwError }, 503)
        }

        if (path === '/api/zcash/shielded/init' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.ZcashInitRequest)
          if (body.from_device) {
            const wallet = requireWallet(engine)
            const result = await initializeOrchardFromDevice(wallet, body.account ?? 0)
            return json(result)
          }
          // seed_hex path is dev/test only — reject in production builds
          return json({ error: 'seed_hex init disabled — use from_device: true' }, 403)
        }

        if (path === '/api/zcash/shielded/display-address' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.ZcashDisplayAddressRequest)
          const wallet = requireWallet(engine)
          // Route through emuWrap for emulator parity (AUTH-2): on the emulator this
          // raises the interactive view-on-device confirm the user must approve; on
          // real hardware it is a pure passthrough. The RPC zcashDisplayAddress
          // already does this — the REST twin must too or the emulator hangs.
          const details: EmuSigningDetails = { operation: 'zcashDisplayAddress', chain: 'Zcash' }
          return json(await emuWrap(() => displayOrchardAddressOnDevice(wallet, body.account ?? 0), details))
        }

        if (path === '/api/zcash/shielded/scan' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.ZcashScanRequest)
          const wallet = requireWallet(engine)
          // REST callers haven't necessarily gone through the Privacy tab init,
          // so the sidecar may have no FVK yet — refresh from device first
          // rather than failing with "No FVK set".
          await ensureFvkLoaded(wallet, 0)
          // Scan returns balance, so prove the cached FVK belongs to the connected
          // device before scanning — otherwise a stale/other-wallet FVK leaks a
          // phantom balance through the scan endpoint (reviewer#2). Mirrors /balance.
          if (!callbacks?.zcashVerifyWallet) throw new HttpError(503, 'Zcash wallet verification unavailable')
          await callbacks.zcashVerifyWallet(0)
          const result = await scanOrchardNotes(body.start_height, body.full_rescan)
          return json(result)
        }

        if (path === '/api/zcash/shielded/balance' && method === 'GET') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          await ensureFvkLoaded(wallet, 0)
          if (!callbacks?.zcashVerifyWallet) throw new HttpError(503, 'Zcash wallet verification unavailable')
          await callbacks.zcashVerifyWallet(0)
          const result = await getShieldedBalance()
          return json(result)
        }

        // Headless shielded send: build → device sign → finalize → broadcast.
        // ALWAYS requires a paired bearer token AND on-device/UI confirmation —
        // there is no auth or approval bypass, emulator included. On the emulator
        // emuWrap routes through emuSigningOp, which raises the interactive confirm
        // prompt the user must approve; it does NOT auto-press.
        if (path === '/api/zcash/shielded/send' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as { recipient?: string; amount?: number; memo?: string; account?: number }
          // amount is ZATOSHIS (integer) — it goes straight to the sidecar's
          // build_pczt, which parses u64. The Rust side rejects fractions, so
          // 0.01 would 400 and `1` would send 1 zatoshi, not 1 ZEC.
          // Upper-bound the amount at the Zcash money-supply cap (21M ZEC in
          // zatoshis), matching ZcashBuildRequest. Without it a near-u64::MAX value
          // reaches the sidecar's `amount + fee` add (REST-01).
          if (!body?.recipient || typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0 || body.amount > 2_100_000_000_000_000) {
            throw new HttpError(400, 'recipient (string) and amount (positive integer zatoshis, <= 21M ZEC) are required')
          }
          const account = body.account ?? 0
          // The sidecar/FVK/scan state is global (single-account). ensureFvkLoaded
          // and ensureZcashDeviceMatch key off "any FVK loaded" / "any account
          // verified", so a non-zero account would silently spend from account 0's
          // state. Reject until the Zcash state is genuinely account-scoped.
          if (account !== 0) throw new HttpError(400, 'Only account 0 is supported; multi-account shielded sends are not implemented')
          await ensureFvkLoaded(wallet, account)
          // FAIL-CLOSED preflight (device-FVK match + fresh scan) before signing.
          if (!callbacks?.zcashPreSendGate) throw new HttpError(503, 'Zcash pre-send gate unavailable')
          await callbacks.zcashPreSendGate(account)
          const details: EmuSigningDetails = {
            operation: 'zcashShieldedSend', chain: 'Zcash',
            to: body.recipient, value: String(body.amount), memo: body.memo,
          }
          const result = await sendShielded(
            wallet,
            { recipient: body.recipient, amount: body.amount, memo: body.memo, account },
            { signWrap: <T,>(fn: () => Promise<T>) => emuWrap(fn, details) },
          )
          callbacks?.zcashSchedulePostTxRescans?.()
          return json(result)
        }

        // Headless DESHIELD (z→t): spend a shielded note to a transparent addr.
        // Always requires auth + interactive confirm (no emulator bypass).
        if (path === '/api/zcash/shielded/deshield' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as { recipient?: string; amount?: number; account?: number }
          // Upper-bound the amount at the Zcash money-supply cap (21M ZEC in
          // zatoshis), matching ZcashBuildRequest. Without it a near-u64::MAX value
          // reaches the sidecar's `amount + fee` add (REST-01).
          if (!body?.recipient || typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0 || body.amount > 2_100_000_000_000_000) {
            throw new HttpError(400, 'recipient (string) and amount (positive integer zatoshis, <= 21M ZEC) are required')
          }
          const account = body.account ?? 0
          // The sidecar/FVK/scan state is global (single-account). ensureFvkLoaded
          // and ensureZcashDeviceMatch key off "any FVK loaded" / "any account
          // verified", so a non-zero account would silently spend from account 0's
          // state. Reject until the Zcash state is genuinely account-scoped.
          if (account !== 0) throw new HttpError(400, 'Only account 0 is supported; multi-account shielded sends are not implemented')
          await ensureFvkLoaded(wallet, account)
          // FAIL-CLOSED preflight (device-FVK match + fresh scan) before signing.
          if (!callbacks?.zcashPreSendGate) throw new HttpError(503, 'Zcash pre-send gate unavailable')
          await callbacks.zcashPreSendGate(account)
          const details: EmuSigningDetails = {
            operation: 'zcashDeshieldZec', chain: 'Zcash', to: body.recipient, value: String(body.amount),
          }
          const { deshieldZec } = await import('./txbuilder/zcash-deshield')
          const result = await deshieldZec(wallet, { recipient: body.recipient!, amount: body.amount!, account },
            { signWrap: <T,>(fn: () => Promise<T>) => emuWrap(fn, details) })
          callbacks?.zcashSchedulePostTxRescans?.()
          return json(result)
        }

        // Headless SHIELD (t→z): move transparent funds into a fresh shielded note.
        // Always requires auth + interactive confirm (no emulator bypass).
        if (path === '/api/zcash/shielded/shield' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await req.json() as { amount?: number; account?: number }
          if (typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0 || body.amount > 2_100_000_000_000_000) {
            throw new HttpError(400, 'amount (positive integer zatoshis, <= 21M ZEC) is required')
          }
          if (!callbacks?.getPioneer) throw new HttpError(503, 'Pioneer client unavailable')
          const account = body.account ?? 0
          // The sidecar/FVK/scan state is global (single-account). ensureFvkLoaded
          // and ensureZcashDeviceMatch key off "any FVK loaded" / "any account
          // verified", so a non-zero account would silently spend from account 0's
          // state. Reject until the Zcash state is genuinely account-scoped.
          if (account !== 0) throw new HttpError(400, 'Only account 0 is supported; multi-account shielded sends are not implemented')
          await ensureFvkLoaded(wallet, account)
          // FAIL-CLOSED preflight (device-FVK match + fresh scan) before signing.
          if (!callbacks?.zcashPreSendGate) throw new HttpError(503, 'Zcash pre-send gate unavailable')
          await callbacks.zcashPreSendGate(account)
          const details: EmuSigningDetails = {
            operation: 'zcashShieldZec', chain: 'Zcash', value: String(body.amount),
          }
          const pioneer = await callbacks.getPioneer()
          const { shieldZec } = await import('./txbuilder/zcash-shield')
          const result = await shieldZec(wallet, pioneer, { amount: body.amount!, account },
            { signWrap: <T,>(fn: () => Promise<T>) => emuWrap(fn, details) })
          callbacks?.zcashSchedulePostTxRescans?.()
          return json(result)
        }

        // Read-only diagnostic: does the cached shielded balance belong to the
        // CONNECTED device? Derives the Orchard FVK fresh from the device and
        // compares ak to the cache. Does not mutate state.
        if (path === '/api/zcash/shielded/verify-device' && method === 'GET') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          if (typeof (wallet as any).zcashGetOrchardFVK !== 'function') {
            throw new HttpError(400, 'Device firmware does not support Orchard FVK export')
          }
          const cached = getCachedFvk()
          const deviceFvk = await (wallet as any).zcashGetOrchardFVK(0)
          const deviceAk = Buffer.from(deviceFvk.ak).toString('hex')
          const cachedAk = cached?.fvk?.ak ?? null
          const match = !!cachedAk && cachedAk.toLowerCase() === deviceAk.toLowerCase()
          return json({
            match,
            deviceAk,
            cachedAk,
            cachedAddress: cached?.address ?? null,
            message: cachedAk === null
              ? 'No cached FVK — nothing to compare.'
              : match
                ? 'OK: cached shielded balance belongs to the connected device.'
                : 'MISMATCH: cached shielded balance is NOT from the connected device — stale/another wallet, not spendable here.',
          })
        }

        if (path === '/api/zcash/shielded/build' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.ZcashBuildRequest)
          // FAIL-CLOSED preflight, mirroring /send (P2-C): prove the cached Orchard
          // FVK belongs to the connected device (purges stale state on mismatch) +
          // fresh scan BEFORE building a spend, so /build can't construct a PCZT from
          // a previous wallet's notes after a device swap. Every PCZT-building entry
          // point must prove device identity. (/finalize needs device signatures, so
          // the split path isn't remotely completable regardless — but the invariant
          // must hold uniformly.)
          const account = (body as any).account ?? 0
          if (account !== 0) throw new HttpError(400, 'Only account 0 is supported; multi-account shielded sends are not implemented')
          await ensureFvkLoaded(wallet, account)
          if (!callbacks?.zcashPreSendGate) throw new HttpError(503, 'Zcash pre-send gate unavailable')
          await callbacks.zcashPreSendGate(account)
          const result = await buildShieldedTx(body)
          return json(result)
        }

        if (path === '/api/zcash/shielded/finalize' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.ZcashFinalizeRequest)
          const result = await finalizeShieldedTx(body.signatures)
          return json(result)
        }

        if (path === '/api/zcash/shielded/broadcast' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.ZcashBroadcastRequest)
          const result = await broadcastShieldedTx(body.raw_tx)
          // Broadcast marked the tx's input notes spent — schedule the same
          // reconciliation rescans the one-shot send paths get, or split-flow
          // callers see an understated balance until change notes are found.
          callbacks?.zcashSchedulePostTxRescans?.()
          return json(result)
        }

        // ── Ledger / accounting auditor routes ──────────────────────
        if (path.startsWith('/api/v1/ledger')) {
          const resp = await handleLedgerRoute(path, method, req, engine, auth, json)
          if (resp) return resp
        }

        // ── REST v2 swap routes (UI control + parsed/raw quotes + history) ──
        // Must come before handleV2DataRoute so the new /swap/* paths match
        // the dedicated handler instead of falling through to the legacy
        // pioneer-passthrough quote endpoint.
        if (path.startsWith('/api/v2/swap')) {
          const resp = await handleSwapRoute(path, method, req, auth, json, callbacks)
          if (resp) return resp
        }

        // ── REST v2 data routes (balances, market, UTXOs, etc.) ──
        if (path.startsWith('/api/v2/') && !path.startsWith('/api/v2/devices') && !path.startsWith('/api/v2/sweep/') && !path.startsWith('/api/v2/swap')) {
          const resp = await handleV2DataRoute(path, method, req, auth, json)
          if (resp) return resp
        }

        // ── BTC Sweep tool ──────────────────────────────────────────
        if (path.startsWith('/api/v2/sweep/')) {
          const resp = await handleSweepRoute(path, method, req, engine, auth, json, callbacks)
          if (resp) return resp
        }

        // ── Catch-all ────────────────────────────────────────────────
        // Sequential if/else routing is fine for ~60 localhost-only endpoints.
        // A Map-based router adds complexity with no measurable perf gain here.
        return json({ error: 'Not found', path }, 404)

      } catch (err: any) {
        // HttpError carries a typed status + optional `details` (e.g.
        // { boc, txid } on TON broadcast failure so a client can retry
        // broadcast without re-signing). Anything without a status falls
        // through to the firmware-failure extraction below as a 500.
        if (typeof err?.status === 'number') {
          const payload: Record<string, unknown> = { error: err.message }
          if (err.details && typeof err.details === 'object') payload.details = err.details
          return json(payload, err.status)
        }
        // Extract firmware Failure message if present (hdwallet wraps them)
        const fwMsg = err?.message?.message || err?.message || 'Internal error'
        const fwCode = err?.message?.code ?? err?.code
        console.error(`[REST] Error on ${method} ${path}:`, typeof fwMsg === 'string' ? fwMsg : JSON.stringify(fwMsg),
          fwCode != null ? `(code ${fwCode})` : '')
        return json({ error: typeof fwMsg === 'string' ? fwMsg : 'Internal error', code: fwCode }, 500)
      } finally {
        // Dismiss signing overlay AFTER the handler completes (success, error, or cancellation)
        if (activeSigningId && callbacks?.onSigningDismissed) {
          callbacks.onSigningDismissed(activeSigningId)
        }
        activeSigningId = undefined
        activeSigningInfo = undefined
        activeAllowBlindSigning = false
      }
    },
    // WS endpoint for the BEX agent bridge (/bex-bridge upgrade above).
    websocket: {
      open(ws) { onBexOpen(ws) },
      message(ws, data) { onBexMessage(ws, data as string | Buffer) },
      close(ws) { onBexClose(ws) },
    },
  })

  console.log(`[REST] API server listening on http://localhost:${port}`)
  return server
}
