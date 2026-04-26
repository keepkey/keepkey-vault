/**
 * Emulator Window — a second BrowserWindow that shows a "fake KeepKey"
 * device screen and Confirm/Reject buttons for signing operations.
 *
 * Communication bypasses Electrobun's encrypted WebSocket because the
 * inline HTML loads at about:blank which has no crypto.subtle (not a
 * secure context in WKWebView).
 *
 * Transport:
 *   bun → webview:  executeJavascript → window.handlePacket(...)
 *   webview → bun:  fetch('http://localhost:EMU_BRIDGE_PORT/_emu/confirm')
 */
import { BrowserView, BrowserWindow, type RPCSchema } from 'electrobun/bun'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const TAG = '[emu-window]'

// ── Window state persistence ────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.keepkey', 'emulator')
const STATE_FILE = join(STATE_DIR, 'window-state.json')

interface WindowState { x: number; y: number; width: number; height: number }

const DEFAULT_STATE: WindowState = { x: 50, y: 50, width: 380, height: 260 }

function loadWindowState(): WindowState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
      if (data.x != null && data.y != null && data.width > 0 && data.height > 0) return data
    }
  } catch {}
  return { ...DEFAULT_STATE }
}

function saveWindowState(state: WindowState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state))
  } catch (e: any) {
    console.warn(`${TAG} Failed to save window state:`, e.message)
  }
}

// ── Confirm details ─────────────────────────────────────────────────────

export interface EmulatorConfirmDetails {
  operation: string
  chain?: string
  to?: string
  value?: string
  memo?: string
  /** Override firmware confirmation count (default: auto-detected from operation) */
  confirmCount?: number
}

// ── Bridge server (webview → bun) ───────────────────────────────────────
//
// Tiny HTTP server that the emulator webview fetches to send button clicks
// back to bun. Separate from the REST API (port 1646) to avoid auth/CORS.

let bridgeServer: ReturnType<typeof Bun.serve> | null = null
let bridgePort = 0

/** Pending confirm — resolved when the webview POSTs to the bridge */
let pendingConfirm: {
  id: string
  resolve: (approved: boolean) => void
} | null = null

/** Pending seed ack — resolved when the webview POSTs to the bridge */
let pendingSeedAck: {
  resolve: () => void
} | null = null

/**
 * True once the webview has POSTed /_emu/ready. Until then, `sendToWindow`
 * drops messages — calling executeJavascript on a not-yet-loaded WebView
 * crashes the WebContent process (EXC_BREAKPOINT in WebPageProxy launch).
 */
let viewReady = false

function startBridge(): number {
  if (bridgeServer) return bridgePort

  bridgeServer = Bun.serve({
    port: 0, // OS picks a free port
    hostname: '127.0.0.1', // localhost only — bridge carries confirm/reject decisions
    reusePort: true,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/_emu/confirm' && req.method === 'POST') {
        return req.json().then((body: any) => {
          console.log(`${TAG} Bridge: confirm id=${body.id}, approved=${body.approved}`)
          if (pendingConfirm && pendingConfirm.id === body.id) {
            pendingConfirm.resolve(body.approved)
            pendingConfirm = null
          }
          return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } })
        })
      }

      if (url.pathname === '/_emu/ready' && req.method === 'POST') {
        viewReady = true
        console.log(`${TAG} Bridge: webview signaled ready`)
        return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } })
      }

      if (url.pathname === '/_emu/seed-ack' && req.method === 'POST') {
        console.log(`${TAG} Bridge: seed acknowledged`)
        if (pendingSeedAck) {
          pendingSeedAck.resolve()
          pendingSeedAck = null
        }
        return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } })
      }

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        })
      }

      return new Response('not found', { status: 404 })
    },
  })

  bridgePort = bridgeServer.port
  console.log(`${TAG} Bridge server on port ${bridgePort}`)
  return bridgePort
}

function stopBridge(): void {
  if (bridgeServer) {
    bridgeServer.stop()
    bridgeServer = null
    bridgePort = 0
  }
}

// ── RPC Schema (still needed for BrowserWindow constructor) ─────────────

type EmulatorWindowRPC = {
  bun: RPCSchema<{ requests: {}; messages: {} }>
  webview: RPCSchema<{ requests: {}; messages: {} }>
}

const emuRpc = BrowserView.defineRPC<EmulatorWindowRPC>({
  maxRequestTime: 600_000,
  handlers: { requests: {}, messages: {} },
})

// ── Window state ────────────────────────────────────────────────────────

let emuWindow: BrowserWindow<typeof emuRpc> | null = null

// ── Window lifecycle ────────────────────────────────────────────────────

export function openEmulatorWindow(): void {
  if (emuWindow) return

  const port = startBridge()
  const saved = loadWindowState()
  console.log(`${TAG} Opening emulator window at (${saved.x}, ${saved.y}) ${saved.width}x${saved.height}`)

  emuWindow = new BrowserWindow({
    title: 'KeepKey Emulator',
    html: buildEmulatorHTML(port),
    rpc: emuRpc,
    frame: { width: saved.width, height: saved.height, x: saved.x, y: saved.y },
  })

  emuWindow.on('close', () => {
    try {
      const frame = emuWindow?.getFrame?.()
      if (frame) saveWindowState(frame)
    } catch {}

    console.log(`${TAG} Emulator window closed`)
    stopDisplayPoll()
    if (pendingConfirm) {
      pendingConfirm.resolve(false)
      pendingConfirm = null
    }
    if (pendingSeedAck) {
      pendingSeedAck.resolve()
      pendingSeedAck = null
    }
    emuWindow = null
    viewReady = false
  })

  startDisplayPoll()
}

export function closeEmulatorWindow(): void {
  if (!emuWindow) return
  stopDisplayPoll()
  try {
    const frame = emuWindow.getFrame?.()
    if (frame) saveWindowState(frame)
  } catch {}
  console.log(`${TAG} Closing emulator window`)
  if (pendingConfirm) {
    pendingConfirm.resolve(false)
    pendingConfirm = null
  }
  try { emuWindow.close() } catch {}
  emuWindow = null
  viewReady = false
  stopBridge()
}

export function isEmulatorWindowOpen(): boolean {
  return emuWindow !== null
}

// ── Send to webview (bun → webview via executeJavascript) ───────────────

function sendToWindow(messageName: string, payload: any): void {
  if (!emuWindow || !viewReady) return
  const packet = JSON.stringify({ type: 'message', id: messageName, payload })
  try {
    emuWindow.webview.executeJavascript(`window.handlePacket(${packet})`)
  } catch (err: any) {
    console.warn(`${TAG} sendToWindow ${messageName} failed:`, err?.message)
  }
}

// ── Seed word display ───────────────────────────────────────────────────

export function displaySeedWords(mnemonic: string): Promise<void> {
  return new Promise((resolve) => {
    const words = mnemonic.trim().split(/\s+/)

    if (!emuWindow) {
      console.warn(`${TAG} No emulator window — skipping seed display`)
      resolve()
      return
    }

    pendingSeedAck = { resolve }

    try {
      sendToWindow('seed-display', { words })
      sendToWindow('emu-state', { state: 'seed-display' })
    } catch (err) {
      console.error(`${TAG} Failed to send seed-display:`, err)
      pendingSeedAck = null
      resolve()
    }
  })
}

export function dismissSeedDisplay(): void {
  sendToWindow('seed-dismiss', {})
  sendToWindow('emu-state', { state: 'idle' })
}

// ── Interactive confirm ─────────────────────────────────────────────────

const CONFIRM_TIMEOUT_MS = 120_000 // 2 minutes — reject if emulator window is dead/unresponsive

async function requestUserConfirm(details: EmulatorConfirmDetails & { id: string }): Promise<boolean> {
  if (!emuWindow) {
    // Window may have been dismissed (user clicked the OS close button) but
    // the engine is still connected — re-open it so signing can proceed.
    // This can also happen on the very first sign after a fresh start when
    // the wizard's transitions raced the window's first paint.
    console.warn(`${TAG} No emulator window for confirm — re-opening`)
    openEmulatorWindow()
    // Wait briefly for the webview to handshake (/_emu/ready). Up to 2s,
    // poll every 50ms. If it never readies, fall back to fail-closed.
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !viewReady) {
      await new Promise(r => setTimeout(r, 50))
    }
    if (!emuWindow || !viewReady) {
      console.error(`${TAG} Emulator window failed to open — rejecting (fail closed)`)
      return false
    }
  }

  return new Promise((resolve) => {
    // Reject any stale pending confirm
    if (pendingConfirm) {
      pendingConfirm.resolve(false)
    }

    const timer = setTimeout(() => {
      console.error(`${TAG} Confirm timed out after ${CONFIRM_TIMEOUT_MS / 1000}s — rejecting`)
      if (pendingConfirm?.id === details.id) {
        pendingConfirm = null
      }
      resolve(false)
    }, CONFIRM_TIMEOUT_MS)

    pendingConfirm = {
      id: details.id,
      resolve: (value: boolean) => {
        clearTimeout(timer)
        resolve(value)
      },
    }

    console.log(`${TAG} Sending confirm-request: op=${details.operation}`)
    sendToWindow('confirm-request', details)
    sendToWindow('emu-state', { state: 'confirming' })
  })
}

function sendDismiss(): void {
  sendToWindow('confirm-dismiss', {})
  sendToWindow('emu-state', { state: 'idle' })
}

// ── Display polling (real OLED framebuffer) ─────────────────────────────

let displayPollTimer: ReturnType<typeof setInterval> | null = null
let cachedGetDisplay: (() => { framebuffer: Uint8Array | null; width: number; height: number }) | null = null

export function startDisplayPoll(): void {
  if (displayPollTimer) return
  import('./emulator').then(mod => {
    cachedGetDisplay = mod.emuGetDisplay
    let lastHadDisplay = false
    displayPollTimer = setInterval(() => {
      if (!emuWindow || !cachedGetDisplay) return
      const { framebuffer, width, height } = cachedGetDisplay()
      if (framebuffer && width > 0 && height > 0) {
        lastHadDisplay = true
        const b64 = Buffer.from(framebuffer).toString('base64')
        sendToWindow('display-update', { fb: b64, w: width, h: height })
      } else if (lastHadDisplay) {
        lastHadDisplay = false
        sendToWindow('display-lost', {})
      }
    }, 66) // ~15fps
  })
}

export function stopDisplayPoll(): void {
  if (displayPollTimer) { clearInterval(displayPollTimer); displayPollTimer = null }
  cachedGetDisplay = null
}

// Firmware confirmation counts by operation type.
// kkemu_poll() BLOCKS inside confirm_helper() until BA+DLD are in the ring
// buffer, so ALL confirmations must be pre-written before the final poll tick.
// Over-writing is safe — unused pairs get consumed as no-ops by subsequent polls.
const CONFIRM_COUNTS: Record<string, number> = {
  ethSignTx: 4,         // approve/transfer + data warning + fee + margin
  btcSignTx: 20,        // per-output confirm + fee + final (varies by output count, over-allocate is safe)
  cosmosSignTx: 3,
  thorchainSignTx: 7,   // router + vault + asset + amount + memo + fee + margin
  mayachainSignTx: 7,
  osmosisSignTx: 3,
  binanceSignTx: 3,
  xrpSignTx: 3,
  btcGetAddress: 2,
  ethGetAddress: 2,
  cosmosGetAddress: 2,
  thorchainGetAddress: 2,
  mayachainGetAddress: 2,
  osmosisGetAddress: 2,
  binanceGetAddress: 2,
  xrpGetAddress: 2,
  ethSignMessage: 3,
  ethSignTypedData: 3,
  ethVerifyMessage: 3,
}
const DEFAULT_CONFIRM_COUNT = 5

function getConfirmCount(details: EmulatorConfirmDetails): number {
  if (details.confirmCount) return details.confirmCount
  return CONFIRM_COUNTS[details.operation] ?? DEFAULT_CONFIRM_COUNT
}

/**
 * Interactive confirm wrapper for emulator signing/address operations.
 *
 * 1. Pause poll, start operation (chunks queue in ring buffer)
 * 2. Poll N-1 times (consume all but last chunk)
 * 3. Send confirm-request to emulator window
 * 4. Wait for user Confirm/Reject (arrives via bridge HTTP POST)
 * 5. If approved: prewriteConfirmations(N) → final poll → return result
 * 6. If rejected: throw error
 *
 * CRITICAL: kkemu_poll() blocks inside confirm_helper(). The firmware may
 * call confirm_helper() multiple times per operation (e.g. ETH: data + fee).
 * ALL confirmations must be pre-written before the poll tick or it blocks forever.
 */
export async function emuInteractiveConfirm(
  fn: () => Promise<any>,
  details: EmulatorConfirmDetails,
  engineDelegate?: { chunkCount: number; autoConfirm?: boolean } | null,
): Promise<any> {
  const { pausePoll, resumePoll, saveEmulatorState, emuPollOnce, flushRingBuffers } = await import('./emulator')
  const { prewriteConfirmations } = await import('./emulator-transport')

  const id = crypto.randomUUID()
  if (engineDelegate) engineDelegate.chunkCount = 0

  pausePoll()

  try {
    const promise = fn()
    await new Promise(r => setTimeout(r, 30))

    const numChunks = engineDelegate?.chunkCount || 1
    console.log(`${TAG} ${numChunks} chunks written, polling ${numChunks - 1} pre-polls`)

    for (let i = 0; i < numChunks - 1; i++) {
      emuPollOnce()
    }

    console.log(`${TAG} Waiting for user confirmation (id=${id.slice(0, 8)}...)`)
    const approved = await requestUserConfirm({ id, ...details })
    console.log(`${TAG} User responded: approved=${approved}`)

    if (!approved) {
      // Flush the last queued chunk + any stale data so the next background
      // kkemu_poll() doesn't enter confirm_helper and spin forever.
      flushRingBuffers()
      throw new Error('Transaction rejected by user on emulator')
    }

    const nConfirms = getConfirmCount(details)
    console.log(`${TAG} Pre-writing ${nConfirms} confirmations (op=${details.operation}) + final poll`)

    // Suppress hdwallet's ButtonAck writes — pre-written BA+DLD satisfy
    // confirm_helper, and the orphaned ButtonAck would cause "Unexpected
    // message" during BTC's multi-round TxRequest/TxAck protocol.
    if (engineDelegate) engineDelegate.autoConfirm = true

    // Pre-write all needed confirmations, then run ONE poll tick.
    // All confirms happen inside a single kkemu_poll() C call — we can't
    // inject between them. Both BA+DLD go to iface 1 (same FIFO) so
    // confirm_helper reads them in order without iface-priority starvation.
    prewriteConfirmations(nConfirms)
    emuPollOnce()

    // Resume poll BEFORE awaiting — readChunk needs kkemu_poll() running
    // to deliver the firmware response. Without this, await hangs forever.
    resumePoll()

    const result = await promise
    console.log(`${TAG} Operation complete, saving state`)

    flushRingBuffers()
    saveEmulatorState()
    return result
  } finally {
    if (engineDelegate) engineDelegate.autoConfirm = false
    resumePoll() // idempotent — ensures poll is always restored
    sendDismiss()
  }
}

// ── Inline HTML ─────────────────────────────────────────────────────────

function buildEmulatorHTML(bridgePort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KeepKey Emulator</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1a1a;
    color: #e0e0e0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    user-select: none;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .header {
    background: #2d1b00;
    border-bottom: 2px solid #e67e22;
    padding: 6px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .header .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #e67e22;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }
  .header h1 {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 2px;
    color: #e67e22;
    text-transform: uppercase;
  }
  .display-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 12px;
  }
  .oled {
    background: #000;
    border: 2px solid #333;
    border-radius: 4px;
    width: 320px;
    height: 80px;
    position: relative;
    overflow: hidden;
  }
  #oledCanvas {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    image-rendering: pixelated;
    image-rendering: -moz-crisp-edges;
  }
  .oled-content {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.4;
    text-align: center;
    word-break: break-all;
    padding: 8px 12px;
  }
  .oled-content .op-label { color: #4fc3f7; font-weight: bold; font-size: 12px; margin-bottom: 4px; }
  .oled-content .detail { color: #ccc; font-size: 10px; }
  .oled-content .addr { color: #81c784; font-size: 10px; font-family: 'Courier New', monospace; }
  .idle-text { color: #666; font-size: 12px; }
  .buttons { display: none; padding: 10px 16px 14px; gap: 12px; justify-content: center; }
  .buttons.visible { display: flex; }
  .btn {
    padding: 8px 24px; border: none; border-radius: 6px;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.15s;
  }
  .btn:active { transform: scale(0.96); }
  .btn-confirm { background: #2e7d32; color: #fff; }
  .btn-confirm:hover { background: #388e3c; }
  .btn-reject { background: #c62828; color: #fff; }
  .btn-reject:hover { background: #d32f2f; }
  .seed-section { display: none; padding: 8px 12px; }
  .seed-section.visible { display: block; }
  .seed-title {
    font-size: 11px; font-weight: 700; color: #e67e22;
    text-transform: uppercase; letter-spacing: 1px; text-align: center; margin-bottom: 6px;
  }
  .seed-grid { display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; }
  .seed-word {
    background: #2a2a2a; border: 1px solid #444; border-radius: 4px;
    padding: 2px 6px; font-size: 10px; font-family: 'Courier New', monospace;
    min-width: 70px; text-align: center;
  }
  .seed-word .num { color: #666; font-size: 9px; }
  .seed-word .word { color: #81c784; font-weight: 600; }
  .seed-ack-btn {
    display: none; margin: 8px auto; padding: 8px 20px;
    background: #2e7d32; color: #fff; border: none; border-radius: 6px;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .seed-ack-btn.visible { display: block; }
  .seed-ack-btn:hover { background: #388e3c; }
  .seed-ack-btn:active { transform: scale(0.96); }
</style>
</head>
<body>
  <div class="header">
    <div class="dot"></div>
    <h1>Emulator</h1>
  </div>
  <div class="display-area" id="displayArea">
    <div class="oled">
      <canvas id="oledCanvas" width="256" height="64"></canvas>
      <div class="oled-content" id="oled">
        <div class="idle-text">KeepKey Emulator Ready</div>
      </div>
    </div>
  </div>
  <div class="seed-section" id="seedSection">
    <div class="seed-title">Recovery Phrase</div>
    <div class="seed-grid" id="seedGrid"></div>
  </div>
  <button class="seed-ack-btn" id="seedAckBtn">I've recorded my words</button>
  <div class="buttons" id="buttons">
    <button class="btn btn-confirm" id="confirmBtn">Confirm</button>
    <button class="btn btn-reject" id="rejectBtn">Reject</button>
  </div>

<script>
(function() {
  var BRIDGE = 'http://localhost:${bridgePort}';
  var oled = document.getElementById('oled');
  var buttons = document.getElementById('buttons');
  var confirmBtn = document.getElementById('confirmBtn');
  var rejectBtn = document.getElementById('rejectBtn');
  var displayArea = document.getElementById('displayArea');
  var seedSection = document.getElementById('seedSection');
  var seedGrid = document.getElementById('seedGrid');
  var seedAckBtn = document.getElementById('seedAckBtn');
  var oledCanvas = document.getElementById('oledCanvas');
  var oledCtx = oledCanvas.getContext('2d');
  var hasRealDisplay = false;
  var currentConfirmId = null;

  // ── Receive messages from bun (via executeJavascript) ──

  window.handlePacket = function(packet) {
    if (packet.type === 'message') {
      if (packet.id === 'display-update') { onDisplayUpdate(packet.payload); return; }
      if (packet.id === 'display-lost') { onDisplayLost(); return; }
      console.log('[emu-ui] Received:', packet.id);
      if (packet.id === 'confirm-request') onConfirmRequest(packet.payload);
      if (packet.id === 'confirm-dismiss') onConfirmDismiss();
      if (packet.id === 'seed-display') onSeedDisplay(packet.payload);
      if (packet.id === 'seed-dismiss') onSeedDismiss();
    }
  };

  // ── OLED framebuffer rendering ──

  function onDisplayUpdate(data) {
    var raw = atob(data.fb);
    var w = data.w;
    var h = data.h;
    if (oledCanvas.width !== w) oledCanvas.width = w;
    if (oledCanvas.height !== h) oledCanvas.height = h;
    var imgData = oledCtx.createImageData(w, h);
    var px = imgData.data;
    // SSD1306 page format: 8 pages x 256 cols, each byte = 8 vertical pixels
    var pages = h >> 3;
    for (var page = 0; page < pages; page++) {
      for (var x = 0; x < w; x++) {
        var b = raw.charCodeAt(page * w + x);
        for (var bit = 0; bit < 8; bit++) {
          var y = page * 8 + bit;
          var on = (b >> bit) & 1;
          var idx = (y * w + x) << 2;
          px[idx] = on ? 255 : 0;
          px[idx + 1] = on ? 255 : 0;
          px[idx + 2] = on ? 255 : 0;
          px[idx + 3] = 255;
        }
      }
    }
    oledCtx.putImageData(imgData, 0, 0);
    if (!hasRealDisplay) {
      hasRealDisplay = true;
      oled.style.display = 'none';
    }
  }

  function onDisplayLost() {
    hasRealDisplay = false;
    oled.style.display = '';
  }

  // ── Send responses to bun (via fetch to bridge server) ──

  function postBridge(path, body) {
    fetch(BRIDGE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(function(err) {
      console.error('[emu-ui] Bridge POST failed:', err);
    });
  }

  // ── UI handlers ──

  function onConfirmRequest(details) {
    console.log('[emu-ui] Confirm request: op=' + details.operation + ' id=' + details.id);
    currentConfirmId = details.id;
    if (!hasRealDisplay) {
      var opName = details.operation
        .replace(/([A-Z])/g, ' $$1').replace(/^ /, '')
        .replace('Sign Tx', 'Sign Transaction')
        .replace('Get Address', 'Verify Address');
      var html = '<div class="op-label">' + esc(opName) + '</div>';
      if (details.chain) html += '<div class="detail">Chain: ' + esc(details.chain) + '</div>';
      if (details.to) {
        var addr = details.to;
        if (addr.length > 20) addr = addr.slice(0, 10) + '...' + addr.slice(-8);
        html += '<div class="addr">To: ' + esc(addr) + '</div>';
      }
      if (details.value) html += '<div class="detail">Amount: ' + esc(details.value) + '</div>';
      if (details.memo) html += '<div class="detail">Memo: ' + esc(details.memo) + '</div>';
      oled.innerHTML = html;
    }
    buttons.classList.add('visible');
  }

  function onConfirmDismiss() {
    currentConfirmId = null;
    if (!hasRealDisplay) {
      oled.innerHTML = '<div class="idle-text">KeepKey Emulator Ready</div>';
    }
    buttons.classList.remove('visible');
  }

  function onSeedDisplay(data) {
    var words = data.words || [];
    seedGrid.innerHTML = '';
    words.forEach(function(word, i) {
      var el = document.createElement('div');
      el.className = 'seed-word';
      el.innerHTML = '<span class="num">' + (i+1) + '</span> <span class="word">' + esc(word) + '</span>';
      seedGrid.appendChild(el);
    });
    displayArea.style.display = 'none';
    seedSection.classList.add('visible');
    seedAckBtn.classList.add('visible');
    buttons.classList.remove('visible');
  }

  function onSeedDismiss() {
    displayArea.style.display = '';
    seedSection.classList.remove('visible');
    seedAckBtn.classList.remove('visible');
    seedGrid.innerHTML = '';
    if (!hasRealDisplay) {
      oled.innerHTML = '<div class="idle-text">KeepKey Emulator Ready</div>';
    }
  }

  function esc(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ── Button clicks → bridge POST ──

  confirmBtn.addEventListener('click', function() {
    if (!currentConfirmId) return;
    console.log('[emu-ui] CONFIRM clicked');
    postBridge('/_emu/confirm', { id: currentConfirmId, approved: true });
    if (!hasRealDisplay) {
      oled.innerHTML = '<div class="idle-text" style="color:#4fc3f7">Processing...</div>';
    }
    buttons.classList.remove('visible');
  });

  rejectBtn.addEventListener('click', function() {
    if (!currentConfirmId) return;
    console.log('[emu-ui] REJECT clicked');
    postBridge('/_emu/confirm', { id: currentConfirmId, approved: false });
    if (!hasRealDisplay) {
      oled.innerHTML = '<div class="idle-text" style="color:#e57373">Rejected</div>';
      setTimeout(function() {
        oled.innerHTML = '<div class="idle-text">KeepKey Emulator Ready</div>';
      }, 1500);
    }
    buttons.classList.remove('visible');
  });

  seedAckBtn.addEventListener('click', function() {
    console.log('[emu-ui] Seed acknowledged');
    postBridge('/_emu/seed-ack', {});
    onSeedDismiss();
  });

  console.log('[emu-ui] Ready, bridge=' + BRIDGE);
  // Tell bun the WebView is ready to receive executeJavascript packets.
  // Without this, display-update polls fire before window.handlePacket is
  // defined and crash the WKWebView process (EXC_BREAKPOINT in WebKit).
  postBridge('/_emu/ready', {});
})();
</script>
</body>
</html>
`
}
