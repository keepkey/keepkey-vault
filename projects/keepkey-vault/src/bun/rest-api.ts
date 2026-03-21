import type { EngineController } from './engine-controller'
import type { AuthStore } from './auth'
import { HttpError } from './auth'
import type { SigningRequestInfo, ApiLogEntry, EIP712DecodedInfo } from '../shared/types'
import { decodeEIP712 } from './eip712-decoder'
import { decodeCalldata } from './calldata-decoder'
import { CHAINS, isChainSupported } from '../shared/chains'
import {
  initializeOrchardFromDevice, scanOrchardNotes, getShieldedBalance,
  buildShieldedTx, finalizeShieldedTx, broadcastShieldedTx,
} from './txbuilder/zcash-shielded'
import { isSidecarReady } from './zcash-sidecar'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as S from './schemas'
import { parseRequest, validateResponse } from './validate'

export interface RestApiCallbacks {
  onApiLog: (entry: ApiLogEntry) => void
  onSigningRequest: (info: SigningRequestInfo) => Promise<boolean>
  onSigningDismissed?: (id: string) => void
  onPairRequest: (info: { name: string; url: string; imageUrl: string }) => void
  onPairDismissed?: () => void
  getVersion: () => string
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

/** SLIP44 coin type → KeepKey firmware coin name (must match firmware coin table) */
const SLIP44_TO_COIN: Record<number, string> = {
  0: 'Bitcoin', 2: 'Litecoin', 3: 'Dogecoin', 5: 'Dash',
  20: 'DigiByte', 60: 'Ethereum', 118: 'Cosmos', 144: 'Ripple',
  145: 'BitcoinCash', 195: 'Tron', 501: 'Solana', 607: 'Ton', 931: 'Rune',
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

// ── Cosmos-family amino signing helper ─────────────────────────────────
async function cosmosAminoSign(
  wallet: any,
  auth: AuthStore,
  body: any,
  walletMethod: string,
  defaultDenom: string,
  defaultFeeAmount: string,
  defaultGas: string,
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

  const response = await (wallet as any)[walletMethod](input)

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
    .kk-tab.locked{opacity:.4;cursor:not-allowed}

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
          <tr><td><code>POST</code></td><td><code>/api/pubkeys/batch</code></td><td>Batch public keys</td><td>30s</td></tr>
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
    var KEY='kk_dev_apikey'
    var sL=false, swaggerUI=null

    function getKey(){return localStorage.getItem(KEY)||''}
    function setKey(k){
      if(k)localStorage.setItem(KEY,k);else localStorage.removeItem(KEY)
      refreshUI()
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
        var tab=t.dataset.tab
        switchTab(tab)
      })
    })

    /* ── Load Swagger with bearer ────────────── */
    function loadSwagger(){
      var k=getKey()
      if(!k){
        document.getElementById('explorer-gate').style.display='block'
        document.getElementById('swagger-ui').style.display='none'
        return
      }
      document.getElementById('explorer-gate').style.display='none'
      document.getElementById('swagger-ui').style.display='block'
      if(sL)return
      sL=true
      swaggerUI=SwaggerUIBundle({
        url:'/spec/swagger.json',
        dom_id:'#swagger-ui',
        deepLinking:true,
        presets:[SwaggerUIBundle.presets.apis,SwaggerUIBundle.SwaggerUIStandalonePreset],
        layout:'BaseLayout',
        requestInterceptor:function(req){
          if(k)req.headers['Authorization']='Bearer '+k
          return req
        }
      })
    }

    /* ── Status ──────────────────────────────── */
    function ck(){
      fetch('/api/health',{signal:AbortSignal.timeout(3000)})
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
    ck();setInterval(ck,10000)

    /* ── UI refresh based on key state ───────── */
    function refreshUI(){
      var k=getKey()
      var kb=document.getElementById('kb')
      var banner=document.getElementById('paired-banner')
      var form=document.getElementById('pair-form')
      var title=document.getElementById('pair-title')
      var desc=document.getElementById('pair-desc')
      var eg=document.getElementById('examples-gate')
      var ec=document.getElementById('examples-content')
      if(k){
        kb.style.display='inline';kb.textContent='paired'
        banner.style.display='flex'
        document.getElementById('paired-key').textContent=k.slice(0,8)+'...'
        form.style.display='none'
        title.textContent='Connected'
        desc.textContent='Your app is paired. Use the Examples and API Explorer tabs.'
        if(eg){eg.style.display='none';ec.style.display='block'}
      }else{
        kb.style.display='none'
        banner.style.display='none'
        form.style.display='block'
        title.textContent='Pair a New App'
        desc.textContent='Register your application with the vault. Approve the pairing on your KeepKey device.'
        if(eg){eg.style.display='block';ec.style.display='none'}
      }
    }

    /* ── Pair ─────────────────────────────────── */
    function doPair(){
      var n=document.getElementById('pn').value.trim()
      if(!n)return
      var b=document.getElementById('pb'),r=document.getElementById('pr')
      b.disabled=true;b.textContent='Approve on device\u2026'
      r.className='pair-result';r.textContent=''
      fetch('/auth/pair',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:n,imageUrl:document.getElementById('pi').value.trim()||undefined})
      })
      .then(function(x){return x.json()})
      .then(function(d){
        if(d.apiKey){
          r.className='pair-result ok';r.textContent='Paired! Key: '+d.apiKey
          setKey(d.apiKey)
        }else{
          r.className='pair-result err';r.textContent=d.error||'Pairing rejected'
        }
      })
      .catch(function(e){r.className='pair-result err';r.textContent='Error: '+e.message})
      .finally(function(){b.disabled=false;b.textContent='Pair App'})
    }

    function doVerify(){
      var k=document.getElementById('ek').value.trim()
      if(!k)return
      var r=document.getElementById('vr')
      fetch('/auth/pair',{headers:{'Authorization':'Bearer '+k}})
        .then(function(x){return x.json()})
        .then(function(d){
          r.style.marginTop='12px'
          if(d.paired){
            r.className='pair-result ok'
            r.textContent='Valid \u2014 paired as "'+(d.name||'unknown')+'"'
            setKey(k)
          }else{
            r.className='pair-result err'
            r.textContent='Invalid or expired key'
          }
        })
        .catch(function(e){
          r.className='pair-result err';r.textContent='Error: '+e.message
          r.style.marginTop='12px'
        })
    }

    function doUnpair(){
      setKey('')
      sL=false;swaggerUI=null
      document.getElementById('swagger-ui').innerHTML=''
    }

    /* ── Try examples ────────────────────────── */
    function tryExample(endpoint,body){
      var k=getKey()
      if(!k){switchTab('pair');return}
      var rd=document.getElementById('try-result')
      var rb=document.getElementById('try-result-body')
      rd.style.display='block'
      rb.textContent='Sending... (approve on device if prompted)'
      fetch('/'+endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+k},
        body:JSON.stringify(body),
        signal:AbortSignal.timeout(120000)
      })
      .then(function(r){return r.json()})
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
  solana: 'SOL', tron: 'TRX', ton: 'TON',
}

/** Set of signing endpoints that require user approval */
const SIGNING_ROUTES = new Set([
  '/eth/sign-transaction', '/eth/sign-typed-data', '/eth/sign',
  '/utxo/sign-transaction', '/xrp/sign-transaction', '/solana/sign-transaction', '/solana/sign-message', '/tron/sign-transaction', '/ton/sign-transaction',
  '/cosmos/sign-amino', '/cosmos/sign-amino-delegate', '/cosmos/sign-amino-undelegate',
  '/cosmos/sign-amino-redelegate', '/cosmos/sign-amino-withdraw-delegator-rewards-all',
  '/cosmos/sign-amino-ibc-transfer',
  '/osmosis/sign-amino', '/osmosis/sign-amino-delegate', '/osmosis/sign-amino-undelegate',
  '/osmosis/sign-amino-redelegate', '/osmosis/sign-amino-withdraw-delegator-rewards-all',
  '/osmosis/sign-amino-ibc-transfer', '/osmosis/sign-amino-lp-remove',
  '/osmosis/sign-amino-lp-add', '/osmosis/sign-amino-swap',
  '/thorchain/sign-amino-transfer', '/thorchain/sign-amino-deposit',
  '/mayachain/sign-amino-transfer', '/mayachain/sign-amino-deposit',
])

export function startRestApi(engine: EngineController, auth: AuthStore, port = 1646, callbacks?: RestApiCallbacks) {
  // Invalidate features cache on device disconnect
  engine.on('state-change', (state) => {
    if (state.state === 'disconnected') clearFeaturesCache()
  })

  const server = Bun.serve({
    reusePort: true,
    port,
    maxRequestBodySize: 1024 * 1024, // 1 MB max (addresses/signing payloads are small)
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method
      const requestStart = Date.now()

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
        // Log the request with body + response + duration
        if (callbacks?.onApiLog) {
          const { appName, imageUrl } = resolveAppInfo()
          callbacks.onApiLog({
            method, route: path, timestamp: requestStart,
            durationMs: Date.now() - requestStart,
            status, appName, imageUrl: imageUrl || undefined,
            requestBody: reqBody,
            responseBody: data,
            ...resolvedActivity,
          })
        }
        return resp
      }

      // CORS preflight
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
            supportedChains: CHAINS.map(c => c.networkId),
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
            // requestPair requires user approval via UI — NOT auto-granted
            try {
              const apiKey = await auth.requestPair(body)
              return json({ apiKey })
            } finally {
              // Dismiss UI overlay + restore window level on approve, reject, or timeout
              callbacks?.onPairDismissed?.()
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════
        // SIGNING APPROVAL GATE — auth required, then user must approve
        // ═══════════════════════════════════════════════════════════════
        if (method === 'POST' && SIGNING_ROUTES.has(path) && callbacks?.onSigningRequest) {
          auth.requireAuth(req)
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
            } else if (path === '/ton/sign-transaction') {
              // TON: field names differ from EVM (to_address, amount, raw_tx)
              signingInfo.to = preview.to_address
              signingInfo.value = preview.amount
            } else if (path === '/tron/sign-transaction') {
              // Tron: field names differ from EVM (to_address, amount, raw_tx)
              signingInfo.to = preview.to_address
              signingInfo.value = preview.amount
            } else {
              signingInfo.from = preview.from || preview.signerAddress
              signingInfo.to = preview.to
              signingInfo.value = preview.value
              signingInfo.chainId = preview.chainId || preview.chain_id
              signingInfo.data = preview.data   // full data — UI handles display

              // Clear-signing: decode calldata via Pioneer descriptor API + local fallback
              if (preview.data && preview.data.length >= 10 && preview.to) {
                try {
                  const chainIdNum = typeof signingInfo.chainId === 'string'
                    ? (signingInfo.chainId.startsWith('0x') ? parseInt(signingInfo.chainId, 16) : parseInt(signingInfo.chainId, 10))
                    : signingInfo.chainId
                  signingInfo.calldataDecoded = await decodeCalldata(preview.to, preview.data, chainIdNum) ?? undefined
                  console.log(`[REST] Calldata decoded:`, JSON.stringify(signingInfo.calldataDecoded, null, 2))
                } catch (e) { console.warn('[REST] Calldata decode failed:', e) }

                // Determine if this tx needs blind signing:
                // Has calldata AND calldata is not fully decoded (source is 'none' or missing)
                const decoded = signingInfo.calldataDecoded
                signingInfo.needsBlindSigning = !decoded || decoded.source === 'none'
                console.log(`[REST] needsBlindSigning=${signingInfo.needsBlindSigning}, source=${decoded?.source}`)
              }
            }
          } catch { /* body parse failed, non-fatal */ }

          // Check device AdvancedMode policy before presenting to user.
          // Try cached features first; on failure, retry with a fresh read.
          try {
            const wallet = requireWallet(engine)
            let features: any
            try {
              features = await getCachedFeatures(wallet)
            } catch {
              // Cache miss or stale — try a fresh getFeatures() from device
              try { features = await wallet.getFeatures() } catch { /* device busy */ }
            }
            if (features) {
              const policies: any[] = features?.policiesList || features?.policies || []
              const advPol = policies.find((p: any) => (p.policyName || p.policy_name) === 'AdvancedMode')
              signingInfo.advancedModeEnabled = advPol?.enabled ?? false
            }
          } catch (e: any) {
            console.warn('[rest-api] Failed to read AdvancedMode policy:', e?.message || e)
          }

          const approved = await callbacks.onSigningRequest(signingInfo)
          if (!approved) {
            return json({ error: 'Signing rejected by user' }, 403)
          }
          // Approved — track ID so we dismiss the overlay AFTER the handler finishes
          activeSigningId = id
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
          const cacheKey = 'utxo:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.btcGetAddress({
            addressNList: body.address_n,
            coin: body.coin || 'Bitcoin',
            scriptType: body.script_type,
            showDisplay: body.show_display ?? false,
          })
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
          const cacheKey = 'cosmos:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
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
          const cacheKey = 'osmo:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.osmosisGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
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
          const cacheKey = 'eth:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.ethGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
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
          const cacheKey = 'tendermint:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.cosmosGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
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
          const cacheKey = 'thor:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.thorchainGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
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
          const cacheKey = 'maya:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.mayachainGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
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
          const cacheKey = 'xrp:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.rippleGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : result?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/solana' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = 'sol:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.solanaGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : (result as any)?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/tron' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = 'trx:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.tronGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
          })
          const address = typeof result === 'string' ? result : (result as any)?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
        }

        if (path === '/addresses/ton' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.AddressRequest)
          const cacheKey = 'ton:' + JSON.stringify(body)
          const cached = addressCache.get(cacheKey)
          if (cached) return json({ address: cached })
          const result = await wallet.tonGetAddress({
            addressNList: body.address_n,
            showDisplay: body.show_display ?? false,
            bounceable: false, // UQ prefix — safe for uninitialized wallets
          })
          const address = typeof result === 'string' ? result : (result as any)?.address || result
          if (addressCache.size >= MAX_CACHE_SIZE) evictOldest(addressCache, Math.ceil(MAX_CACHE_SIZE * 0.2))
          addressCache.set(cacheKey, address)
          auth.saveAccount(String(address), body.address_n)
          return json({ address })
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

          // chainId: default to 1 if 0 or missing
          let chainId = body.chainId ?? body.chain_id ?? 1
          if (typeof chainId === 'string') {
            chainId = chainId.startsWith('0x') ? parseInt(chainId, 16) : parseInt(chainId, 10)
          }
          if (!chainId || chainId === 0) chainId = 1

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
            msg.maxPriorityFeePerGas = body.maxPriorityFeePerGas || body.max_priority_fee_per_gas || '0x0'
          } else {
            msg.gasPrice = body.gasPrice || body.gas_price || '0x0'
          }

          console.log('[REST] ethSignTx hdwallet payload:', JSON.stringify(msg, null, 2))
          try {
            const result = await wallet.ethSignTx(msg)
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
            const result = await wallet.ethSignTypedData({ addressNList, typedData: body.typedData })
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
          const result = await wallet.ethSignMessage({ addressNList, message: body.message })
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

          const result = await wallet.btcSignTx({
            coin,
            inputs: body.inputs,
            outputs: body.outputs,
            version: body.version ?? 1,
            locktime: body.locktime ?? 0,
            ...(body.overwintered !== undefined ? { overwintered: body.overwintered } : {}),
            ...(body.expiry !== undefined ? { expiry: body.expiry } : {}),
            ...(body.versionGroupId !== undefined ? { versionGroupId: body.versionGroupId } : {}),
            ...(body.branchId !== undefined ? { branchId: body.branchId } : {}),
          })
          // Explicit chain for UTXO — auto-detect defaults to BTC but could be LTC/DOGE/etc
          const coinSymbol = coin === 'Bitcoin' ? 'BTC' : coin === 'Litecoin' ? 'LTC' : coin === 'Dogecoin' ? 'DOGE' : coin === 'Dash' ? 'DASH' : coin === 'BitcoinCash' ? 'BCH' : coin
          return json(validateResponse(result, S.UtxoSignTransactionResponse, path), 200, { chain: coinSymbol, activityType: 'sign' })
        }

        // ── COSMOS SIGNING (6 endpoints) ──────────────────────────────
        if (path === '/cosmos/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/cosmos/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'cosmosSignTx', 'uatom', '5000', '1000000'), S.CosmosAminoSignResponse, path))
        }

        // ── OSMOSIS SIGNING (9 endpoints) ────────────────────────────
        if (path === '/osmosis/sign-amino' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-delegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-undelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-redelegate' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-withdraw-delegator-rewards-all' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-ibc-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-lp-remove' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-lp-add' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/osmosis/sign-amino-swap' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'osmosisSignTx', 'uosmo', '800', '290000'), S.CosmosAminoSignResponse, path))
        }

        // ── THORCHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/thorchain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/thorchain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'thorchainSignTx', 'rune', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }

        // ── MAYACHAIN SIGNING (2 endpoints) ──────────────────────────
        if (path === '/mayachain/sign-amino-transfer' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }
        if (path === '/mayachain/sign-amino-deposit' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.CosmosAminoSignRequest)
          return json(validateResponse(await cosmosAminoSign(wallet, auth, body, 'mayachainSignTx', 'cacao', '0', '500000000'), S.CosmosAminoSignResponse, path))
        }

        // ── XRP SIGNING (1 endpoint) ─────────────────────────────────
        if (path === '/xrp/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.XrpSignRequest)
          const result = await wallet.rippleSignTx(body)
          return json(result)
        }

        // ── SOLANA SIGNING (1 endpoint) ────────────────────────────────
        if (path === '/solana/sign-transaction' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SolanaSignRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]

          // Pioneer returns full serialized tx: [compact-u16:sigCount][sig0(64)]...[sigN(64)][message]
          // Firmware expects just the message bytes. Extract message portion.
          let deviceRawTx = body.raw_tx
          const fullTx = Buffer.from(body.raw_tx, 'base64')
          let pos = 0, sigCount = 0
          if (fullTx[0] < 0x80) { sigCount = fullTx[0]; pos = 1 }
          else if (fullTx.length >= 2 && fullTx[1] < 0x80) {
            sigCount = (fullTx[0] & 0x7f) | (fullTx[1] << 7); pos = 2
          } else if (fullTx.length >= 3) {
            sigCount = (fullTx[0] & 0x7f) | ((fullTx[1] & 0x7f) << 7) | (fullTx[2] << 14); pos = 3
          }
          const messageStart = pos + sigCount * 64
          if (sigCount > 0 && messageStart < fullTx.length) {
            deviceRawTx = Buffer.from(fullTx.subarray(messageStart)).toString('base64')
          }

          const result = await wallet.solanaSignTx({
            addressNList,
            rawTx: deviceRawTx,
          })
          // Assemble signed tx: replace dummy 64-byte signature in full tx with real signature
          if (result?.signature && body.raw_tx) {
            const rawBytes = Buffer.from(body.raw_tx, 'base64')
            const sigBytes = result.signature instanceof Uint8Array
              ? result.signature
              : Buffer.from(result.signature, 'base64')
            if (rawBytes.length > 65 && sigBytes.length === 64) {
              sigBytes.forEach((b: number, i: number) => { rawBytes[1 + i] = b })
              return json({ signature: Buffer.from(sigBytes).toString('base64'), serializedTx: rawBytes.toString('base64') })
            }
          }
          return json(result)
        }

        // ── SOLANA MESSAGE SIGNING (firmware type 754) ──────────────────
        if (path === '/solana/sign-message' && method === 'POST') {
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SolanaSignMessageRequest)
          const addressNList = body.addressNList || body.address_n || [0x8000002C, 0x800001F5, 0x80000000, 0x80000000]
          const result = await wallet.solanaSignMessage({
            addressNList,
            message: body.message,
            showDisplay: body.show_display !== false,
          })
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
          const result = await wallet.tronSignTx({
            addressNList,
            rawTx: body.raw_tx,
            toAddress: body.to_address,
            amount: body.amount,
          })
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
          const result = await wallet.tonSignTx({
            addressNList,
            rawTx: body.raw_tx,
            toAddress: body.to_address,
            amount: body.amount,
          })
          if (!result) throw Object.assign(new Error('tonSignTx returned no result'), { statusCode: 500 })
          return json(result)
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
          const cacheKey = JSON.stringify(body)
          const cached = pubkeyCache.get(cacheKey)
          if (cached) return json(cached)
          const result = await wallet.getPublicKeys([{
            addressNList: body.address_n,
            curve: body.ecdsa_curve_name || 'secp256k1',
            showDisplay: body.show_display ?? false,
            coin: body.coin_name || 'Bitcoin',
            scriptType: body.script_type,
          }])
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
          return json({
            devices: ds.deviceId ? [{ state: ds.state }] : [],
            total_value_usd: 0,
            message: 'Portfolio aggregation not implemented — use Pioneer API for balances',
          })
        }

        if (path.startsWith('/api/portfolio/') && method === 'GET') {
          auth.requireAuth(req)
          const deviceId = path.split('/').pop()
          const ds = engine.getDeviceState()
          if (!ds.deviceId || ds.deviceId !== deviceId) {
            return json({ error: 'Device not found' }, 404)
          }
          return json({
            device_id: ds.deviceId,
            state: ds.state,
            total_value_usd: 0,
            message: 'Portfolio not implemented — use Pioneer API for balances',
          })
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
              const primaryNetwork = (p.networks || [])[0] || ''
              const addrCacheKey = `batch-addr:${JSON.stringify(p.address_n)}:${primaryNetwork}`
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
                  // Solana uses ed25519 with 4-element path (m/44'/501'/0'/0') — don't extend to 5
                  const solNList = p.address_n
                  const r = await wallet.solanaGetAddress({ addressNList: solNList, showDisplay: false })
                  address = typeof r === 'string' ? r : (r as any)?.address || ''
                } else if (coinType === 195) {
                  const r = await wallet.tronGetAddress({ addressNList: addrNList, showDisplay: false })
                  address = typeof r === 'string' ? r : (r as any)?.address || ''
                } else if (coinType === 607) {
                  // TON uses ed25519 with 3-element path (m/44'/607'/0') — don't extend to 5
                  const tonNList = p.address_n
                  const r = await wallet.tonGetAddress({ addressNList: tonNList, showDisplay: false, bounceable: false })
                  address = typeof r === 'string' ? r : (r as any)?.address || ''
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
            const cacheKey = JSON.stringify({ address_n: p.address_n, script_type: p.script_type })
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
            const coin = p.coin || SLIP44_TO_COIN[coinType] || 'Bitcoin'
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
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.RecoverDeviceRequest)
          await wallet.recover({
            entropy: body.word_count ? ({ 12: 128, 18: 192, 24: 256 } as Record<number, number>)[body.word_count] || 128 : 128,
            label: body.label || 'KeepKey',
            pin: body.pin_protection ?? true,
            passphrase: body.passphrase_protection ?? false,
            autoLockDelayMs: 600000,
          })
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
          auth.requireAuth(req)
          const wallet = requireWallet(engine)
          const body = await parseRequest(req, S.SendPinRequest)
          await wallet.sendPin(body.pin)
          return json({ success: true })
        }

        // ── Zcash Shielded (Orchard) ────────────────────────────────

        const zcashShieldedDef = CHAINS.find(c => c.id === 'zcash-shielded')
        const zcashFwSupported = zcashShieldedDef && isChainSupported(zcashShieldedDef, engine.state?.firmwareVersion)

        if (path === '/api/zcash/shielded/status' && method === 'GET') {
          if (!zcashFwSupported) return json({ ready: false, error: 'Zcash requires firmware >= 7.11.0' })
          return json({ ready: isSidecarReady() })
        }

        // All mutating zcash endpoints require firmware support
        if (path.startsWith('/api/zcash/shielded/') && path !== '/api/zcash/shielded/status' && !zcashFwSupported) {
          return json({ error: 'Zcash requires firmware >= 7.11.0' }, 503)
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

        if (path === '/api/zcash/shielded/scan' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.ZcashScanRequest)
          const result = await scanOrchardNotes(body.start_height)
          return json(result)
        }

        if (path === '/api/zcash/shielded/balance' && method === 'GET') {
          auth.requireAuth(req)
          const result = await getShieldedBalance()
          return json(result)
        }

        if (path === '/api/zcash/shielded/build' && method === 'POST') {
          auth.requireAuth(req)
          const body = await parseRequest(req, S.ZcashBuildRequest)
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
          return json(result)
        }

        // ── Catch-all ────────────────────────────────────────────────
        // Sequential if/else routing is fine for ~60 localhost-only endpoints.
        // A Map-based router adds complexity with no measurable perf gain here.
        return json({ error: 'Not found', path }, 404)

      } catch (err: any) {
        if (err.status) {
          return json({ error: err.message }, err.status)
        }
        console.error('[REST] Error:', err)
        return json({ error: 'Internal error' }, 500)
      } finally {
        // Dismiss signing overlay AFTER the handler completes (success, error, or cancellation)
        if (activeSigningId && callbacks?.onSigningDismissed) {
          callbacks.onSigningDismissed(activeSigningId)
        }
      }
    },
  })

  console.log(`[REST] API server listening on http://localhost:${port}`)
  return server
}
