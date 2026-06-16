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

const DEFAULT_STATE: WindowState = { x: 50, y: 50, width: 400, height: 380 }
const MIN_WIDTH = 320
const MIN_HEIGHT = 360 // header + OLED + confirm meta + buttons

function loadWindowState(): WindowState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
      if (data.x != null && data.y != null && data.width > 0 && data.height > 0) {
        return {
          x: data.x,
          y: data.y,
          width: Math.max(MIN_WIDTH, data.width),
          height: Math.max(MIN_HEIGHT, data.height),
        }
      }
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
  /** Network fee, pre-formatted by the sign handler (shown before approval). */
  fee?: string
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

/**
 * Pending seed ack — resolved on explicit "I've recorded my words" click,
 * rejected if the user closes the window without acking. Without the
 * reject path, the OS close button looks identical to an ack and the
 * wizard advances even though the user never confirmed they wrote down
 * the recovery phrase.
 */
let pendingSeedAck: {
  resolve: () => void
  reject: (err: Error) => void
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
      // Closing the window mid-seed-display is NOT an ack — caller must
      // see this as failure so it can roll back the saved mnemonic and
      // not advance the wizard with an unbacked-up wallet.
      pendingSeedAck.reject(new Error('Emulator window closed before seed words were acknowledged'))
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
  if (pendingSeedAck) {
    pendingSeedAck.reject(new Error('Emulator window closed before seed words were acknowledged'))
    pendingSeedAck = null
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

/**
 * Push a message into the webview via executeJavascript.
 *
 * Returns true if the call was issued (window present + viewReady + no
 * thrown error), false otherwise. Callers that install a pending promise
 * keyed off this delivery (e.g. displaySeedWords + pendingSeedAck) MUST
 * check the return value — if delivery failed silently and the caller
 * still installs the pending state, it can hang forever waiting for a
 * webview interaction that the webview never received the request for.
 */
function sendToWindow(messageName: string, payload: any): boolean {
  if (!emuWindow || !viewReady) return false
  const packet = JSON.stringify({ type: 'message', id: messageName, payload })
  try {
    emuWindow.webview.executeJavascript(`window.handlePacket(${packet})`)
    return true
  } catch (err: any) {
    console.warn(`${TAG} sendToWindow ${messageName} failed:`, err?.message)
    return false
  }
}

// ── Seed word display ───────────────────────────────────────────────────

export async function displaySeedWords(mnemonic: string): Promise<void> {
  const words = mnemonic.trim().split(/\s+/)

  if (!emuWindow) {
    console.warn(`${TAG} No emulator window — opening for seed display`)
    openEmulatorWindow()
  }

  // Wait for the bridge handshake before installing the pending ack —
  // otherwise sendToWindow silently no-ops and the awaiter blocks forever.
  // Throw on failure so callers (e.g. emulatorCreateWallet) don't tell the
  // user "seed displayed" when the words were never actually shown — that
  // would lead to backing up a seed the device doesn't hold.
  if (!viewReady) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !viewReady && emuWindow) {
      await new Promise(r => setTimeout(r, 50))
    }
    if (!emuWindow || !viewReady) {
      throw new Error(
        `Emulator window not ready (emuWindow=${!!emuWindow} viewReady=${viewReady}) — cannot display seed`
      )
    }
  }

  try { emuWindow!.focus() } catch {}

  return new Promise<void>((resolve, reject) => {
    pendingSeedAck = { resolve, reject }

    // sendToWindow returns false on delivery failure (window gone, view
    // not ready, executeJavascript threw). Without this check, the pending
    // ack stays installed and the RPC hangs forever waiting for an "I've
    // recorded my words" click on a webview that never got the request.
    const delivered = sendToWindow('seed-display', { words }) && sendToWindow('emu-state', { state: 'seed-display' })
    if (!delivered) {
      pendingSeedAck = null
      reject(new Error('Failed to deliver seed display to emulator webview'))
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
  }

  // Wait for the bridge handshake regardless of whether we just opened the
  // window or it was already up. A window can exist with viewReady=false
  // immediately after open (HTML hasn't loaded yet) — sendToWindow would
  // silently no-op and the user would never see the prompt.
  if (!viewReady) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !viewReady && emuWindow) {
      await new Promise(r => setTimeout(r, 50))
    }
    if (!emuWindow || !viewReady) {
      console.error(`${TAG} Emulator window not ready (emuWindow=${!!emuWindow} viewReady=${viewReady}) — rejecting`)
      return false
    }
  }

  // Bring the emu window to front so the user actually sees the prompt.
  // Without this, a user focused on the dashboard never realizes a sign
  // is waiting on a click in another window.
  try { emuWindow!.focus() } catch (e: any) {
    console.warn(`${TAG} focus() failed:`, e?.message)
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
//
// Strategy: the dylib's libkkemu_capture_frame() callback fires from inside
// every display_refresh() — including the ones inside confirm_helper's busy
// loop within a single synchronous kkemu_poll() call. Those frames would
// otherwise be invisible to JS (the canvas has reverted to home by the time
// kkemu_poll returns).
//
// Each poll tick: drain the C-side capture ring into our local playback
// queue, then emit one frame to the webview. This gives the user a visible
// playback of intermediate screens (confirm, cipher, recovery) at ~15fps.
// The C-side ring dedupes adjacent identical frames so an idle firmware
// doesn't fill the queue.

let displayPollTimer: ReturnType<typeof setInterval> | null = null
let cachedPopFrames: (() => Uint8Array[]) | null = null
const playbackQueue: Uint8Array[] = []
const PLAYBACK_QUEUE_CAP = 90 // ~6s at 15fps; older frames dropped
const PLAYBACK_TICK_MS = 66 // ~15fps normal/idle cadence
const PLAYBACK_TICK_SLOW_MS = 350 // post-approval: linger so confirm screens are readable
let slowPlaybackUntil = 0 // epoch ms; emit at the slow cadence until then (F4)

export function startDisplayPoll(): void {
  if (displayPollTimer) return
  import('./emulator').then(mod => {
    cachedPopFrames = mod.emuPopFrames
    // Self-rescheduling timer so the cadence can change per tick: normal
    // ~15fps, but slower right after an approval so the burst of confirm
    // screens (rendered in one synchronous kkemu_poll) is readable (F4).
    const tick = () => {
      if (!emuWindow || !cachedPopFrames) { displayPollTimer = setTimeout(tick, PLAYBACK_TICK_MS); return }

      // Always drain the C ring so the dylib doesn't overflow during the
      // bridge handshake. Frames captured before viewReady are held in the
      // playback queue (capped, oldest dropped) and start emitting as soon
      // as the webview is up — without this hold, setup-period OLED frames
      // (boot, wipe, recovery cipher prompts) were silently lost.
      const fresh = cachedPopFrames()
      if (fresh.length > 0) {
        playbackQueue.push(...fresh)
        while (playbackQueue.length > PLAYBACK_QUEUE_CAP) playbackQueue.shift()
      }

      // sendToWindow is a no-op until viewReady. Don't shift off the queue
      // until then — emitted frames would be discarded mid-flight.
      if (viewReady && playbackQueue.length > 0) {
        const fb = playbackQueue.shift()!
        const b64 = Buffer.from(fb).toString('base64')
        sendToWindow('display-update', { fb: b64, w: 256, h: 64 })
      }
      // No queued frame: leave the last frame on screen. (Don't emit
      // display-lost; the device hasn't gone away, it's just idle.)

      const delay = Date.now() < slowPlaybackUntil ? PLAYBACK_TICK_SLOW_MS : PLAYBACK_TICK_MS
      displayPollTimer = setTimeout(tick, delay)
    }
    displayPollTimer = setTimeout(tick, PLAYBACK_TICK_MS)
  })
}

export function stopDisplayPoll(): void {
  if (displayPollTimer) { clearTimeout(displayPollTimer); displayPollTimer = null }
  cachedPopFrames = null
  playbackQueue.length = 0
}

/** Transport delegate fields the confirm gate needs (a subset of EmulatorTransportDelegate). */
type ConfirmDelegate = { onButtonRequest: (() => void) | null }

/**
 * Run a wallet op on the emulator with screen-first confirm gating.
 *
 * Thread-driven model (Approach B): the dylib poll thread keeps the firmware
 * running, so confirm_helper renders the REAL OLED frame and then blocks in C
 * waiting for a button decision — without freezing the Bun event loop. The
 * frame streams to the emulator window via the capture ring + display poll, so
 * the user sees and reviews exactly what the device drew, HELD, before
 * deciding — like a physical KeepKey.
 *
 * We hook the transport (delegate.onButtonRequest, fired from readChunk when
 * the firmware emits a ButtonRequest) to gate the decision:
 *   - interactive: show Confirm/Reject over the held frame, wait for the click,
 *     then deliver the DebugLinkDecision. One ButtonRequest = one screen = one
 *     click, so multi-screen signs (BTC per-output, ETH data+fee) advance
 *     press-by-press.
 *   - auto: deliver an approve immediately (setup ops: wipe / load / settings).
 *
 * hdwallet auto-sends the ButtonAck (which sets button_request_acked); we only
 * supply the DebugLinkDecision (the simulated press). A reject writes
 * yes_no=false → confirm_helper returns false → the firmware aborts with a
 * Failure, which rejects fn().
 */
export async function emuGatedConfirm(
  fn: () => Promise<any>,
  delegate: ConfirmDelegate | null,
  opts: { interactive: true; details: EmulatorConfirmDetails } | { interactive: false },
): Promise<any> {
  const { saveEmulatorState, flushRingBuffers } = await import('./emulator')
  const { writeDecision } = await import('./emulator-transport')

  let rejected = false
  const prevHandler = delegate ? delegate.onButtonRequest : null

  if (delegate) {
    delegate.onButtonRequest = () => {
      if (!opts.interactive) {
        // Setup op — auto-press through each confirm screen.
        writeDecision(true)
        return
      }
      // Interactive sign — the real frame is already on screen (display poll).
      // Hold it and gate on the user's click. Fire-and-forget: hdwallet still
      // gets its ButtonRequest back and sends the ButtonAck; the DLD we write
      // on click is what releases confirm_helper.
      requestUserConfirm({ id: crypto.randomUUID(), ...opts.details })
        .then((approved) => {
          if (!approved) rejected = true
          writeDecision(approved)
        })
        .catch((e: any) => {
          // A failed prompt must not strand confirm_helper waiting forever —
          // reject so the firmware aborts cleanly.
          console.warn(`${TAG} confirm prompt failed — rejecting:`, e?.message)
          rejected = true
          writeDecision(false)
        })
    }
  }

  // Open the window up front (interactive) so the confirm frame is visible the
  // moment confirm_helper renders it, not after the first click.
  if (opts.interactive && !emuWindow) openEmulatorWindow()

  try {
    const result = await fn()
    await saveEmulatorState()
    return result
  } catch (e) {
    // If the user rejected, surface a clean message rather than the raw
    // firmware Failure that bubbled up through hdwallet.
    if (rejected) throw new Error('Transaction rejected by user on emulator')
    throw e
  } finally {
    if (delegate) delegate.onButtonRequest = prevHandler
    flushRingBuffers() // drain any late output so the next op reads clean
    sendDismiss()
  }
}

/**
 * Interactive (user-gated) confirm wrapper for emulator signing/address ops.
 */
export async function emuInteractiveConfirm(
  fn: () => Promise<any>,
  details: EmulatorConfirmDetails,
  engineDelegate?: ConfirmDelegate | null,
): Promise<any> {
  return emuGatedConfirm(fn, engineDelegate ?? null, { interactive: true, details })
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
  .idle-text { color: #666; font-size: 12px; }
  .confirm-meta {
    display: none;
    padding: 8px 14px 4px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.5;
    color: #ddd;
    text-align: center;
  }
  .confirm-meta.visible { display: block; }
  .confirm-meta .op-label { color: #4fc3f7; font-weight: bold; font-size: 13px; margin-bottom: 4px; }
  .confirm-meta .detail { color: #ccc; font-size: 11px; }
  .confirm-meta .addr { color: #81c784; font-size: 11px; word-break: break-all; }
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
  <div class="confirm-meta" id="confirmMeta"></div>
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
  var confirmMeta = document.getElementById('confirmMeta');
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
    var opName = details.operation
      .replace(/([A-Z])/g, ' $$1').replace(/^ /, '')
      .replace('Sign Tx', 'Sign Transaction')
      .replace('Get Address', 'Verify Address');
    var html = '<div class="op-label">' + esc(opName) + '</div>';
    if (details.chain) html += '<div class="detail">Chain: ' + esc(details.chain) + '</div>';
    if (details.to) {
      var addr = details.to;
      if (addr.length > 24) addr = addr.slice(0, 12) + '...' + addr.slice(-10);
      html += '<div class="addr">To: ' + esc(addr) + '</div>';
    }
    if (details.value) html += '<div class="detail">Amount: ' + esc(details.value) + '</div>';
    if (details.fee) html += '<div class="detail">Fee: ' + esc(details.fee) + '</div>';
    if (details.memo) html += '<div class="detail">Memo: ' + esc(details.memo) + '</div>';
    confirmMeta.innerHTML = html;
    confirmMeta.classList.add('visible');
    buttons.classList.add('visible');
  }

  function onConfirmDismiss() {
    currentConfirmId = null;
    confirmMeta.innerHTML = '';
    confirmMeta.classList.remove('visible');
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
    confirmMeta.innerHTML = '<div class="op-label" style="color:#4fc3f7">Processing…</div>';
    buttons.classList.remove('visible');
  });

  rejectBtn.addEventListener('click', function() {
    if (!currentConfirmId) return;
    console.log('[emu-ui] REJECT clicked');
    postBridge('/_emu/confirm', { id: currentConfirmId, approved: false });
    confirmMeta.innerHTML = '<div class="op-label" style="color:#e57373">Rejected</div>';
    buttons.classList.remove('visible');
    setTimeout(function() {
      confirmMeta.innerHTML = '';
      confirmMeta.classList.remove('visible');
    }, 1200);
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
