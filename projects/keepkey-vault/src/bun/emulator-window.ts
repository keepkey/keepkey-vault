/**
 * Emulator Window — a second BrowserWindow that shows a "fake KeepKey"
 * device screen and gates signing/address-display operations on user
 * confirmation.
 *
 * The window uses inline HTML (no separate Vite build) and communicates
 * with the Bun backend via Electrobun RPC.
 *
 * Architecture:
 *   [RPC handler] → emuInteractiveConfirm(fn, details)
 *     1. Pause poll, start operation (chunks queue in ring buffer)
 *     2. Poll N-1 times (consume all but last chunk)
 *     3. Send confirm-request to emulator window
 *     4. Wait for user Confirm/Reject click
 *     5. If approved: prewriteConfirmations → final poll → return result
 *     6. If rejected: throw error
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

// ── RPC Schema ──────────────────────────────────────────────────────────

export interface EmulatorConfirmDetails {
  operation: string
  chain?: string
  to?: string
  value?: string
  memo?: string
}

type EmulatorWindowRPC = {
  bun: RPCSchema<{
    requests: {
      emuConfirm: {
        params: { id: string; approved: boolean }
        response: { ok: boolean }
      }
      seedAcked: {
        params: {}
        response: { ok: boolean }
      }
    }
    messages: {}
  }>
  webview: RPCSchema<{
    requests: {}
    messages: {
      'confirm-request': {
        id: string
        operation: string
        chain?: string
        to?: string
        value?: string
        memo?: string
      }
      'confirm-dismiss': {}
      'emu-state': { state: 'idle' | 'confirming' | 'processing' | 'seed-display' }
      'seed-display': { words: string[] }
      'seed-dismiss': {}
    }
  }>
}

// ── State ───────────────────────────────────────────────────────────────

let emuWindow: BrowserWindow<typeof emuRpc> | null = null
let pendingConfirm: {
  id: string
  resolve: (approved: boolean) => void
} | null = null
let pendingSeedAck: {
  resolve: () => void
} | null = null


// ── RPC handlers ────────────────────────────────────────────────────────

const emuRpc = BrowserView.defineRPC<EmulatorWindowRPC>({
  maxRequestTime: 600_000, // 10 min — user may take time to review
  handlers: {
    requests: {
      emuConfirm: ({ id, approved }) => {
        if (pendingConfirm && pendingConfirm.id === id) {
          pendingConfirm.resolve(approved)
          pendingConfirm = null
          return { ok: true }
        }
        console.warn(`${TAG} emuConfirm for unknown/stale id=${id}`)
        return { ok: false }
      },
      seedAcked: () => {
        if (pendingSeedAck) {
          pendingSeedAck.resolve()
          pendingSeedAck = null
        }
        return { ok: true }
      },
    },
    messages: {},
  },
})

// ── Window lifecycle ────────────────────────────────────────────────────

export function openEmulatorWindow(): void {
  if (emuWindow) return

  const saved = loadWindowState()
  console.log(`${TAG} Opening emulator window at (${saved.x}, ${saved.y}) ${saved.width}x${saved.height}`)

  emuWindow = new BrowserWindow({
    title: 'KeepKey Emulator',
    html: EMULATOR_HTML,
    rpc: emuRpc,
    frame: { width: saved.width, height: saved.height, x: saved.x, y: saved.y },
  })

  emuWindow.on('close', () => {
    // Persist window position/size for next session
    try {
      const frame = emuWindow?.getFrame?.()
      if (frame) saveWindowState(frame)
    } catch {}

    console.log(`${TAG} Emulator window closed`)
    if (pendingConfirm) {
      pendingConfirm.resolve(false)
      pendingConfirm = null
    }
    if (pendingSeedAck) {
      pendingSeedAck.resolve()
      pendingSeedAck = null
    }
    emuWindow = null
  })
}

export function closeEmulatorWindow(): void {
  if (!emuWindow) return
  // Persist position before closing
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
}

export function isEmulatorWindowOpen(): boolean {
  return emuWindow !== null
}

// ── Seed word display ───────────────────────────────────────────────────

/**
 * Show seed words on the emulator window and wait for user acknowledgement.
 * Words are ONLY displayed on the emulator "device screen", never sent to the main UI.
 */
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
      ;(emuWindow.webview.rpc as any)?.send?.['seed-display']({ words })
      ;(emuWindow.webview.rpc as any)?.send?.['emu-state']({ state: 'seed-display' })
    } catch (err) {
      console.error(`${TAG} Failed to send seed-display:`, err)
      pendingSeedAck = null
      resolve()
    }
  })
}

export function dismissSeedDisplay(): void {
  try {
    ;(emuWindow?.webview.rpc as any)?.send?.['seed-dismiss']({})
    ;(emuWindow?.webview.rpc as any)?.send?.['emu-state']({ state: 'idle' })
  } catch {}
}

// ── Interactive confirm ─────────────────────────────────────────────────

/**
 * Request user confirmation via the emulator window.
 * Returns a promise that resolves to true (approved) or false (rejected).
 */
function requestUserConfirm(details: EmulatorConfirmDetails & { id: string }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!emuWindow) {
      console.warn(`${TAG} No emulator window — auto-approving`)
      resolve(true)
      return
    }

    // Reject any stale pending confirm
    if (pendingConfirm) {
      pendingConfirm.resolve(false)
    }

    pendingConfirm = { id: details.id, resolve }

    // Send confirm details to the webview
    try {
      ;(emuWindow.webview.rpc as any)?.send?.['confirm-request'](details)
      ;(emuWindow.webview.rpc as any)?.send?.['emu-state']({ state: 'confirming' })
    } catch (err) {
      console.error(`${TAG} Failed to send confirm-request:`, err)
      pendingConfirm = null
      resolve(true) // fall back to auto-approve
    }
  })
}

function sendDismiss(): void {
  try {
    ;(emuWindow?.webview.rpc as any)?.send?.['confirm-dismiss']({})
    ;(emuWindow?.webview.rpc as any)?.send?.['emu-state']({ state: 'idle' })
  } catch {}
}

/**
 * Interactive confirm wrapper for emulator signing/address operations.
 *
 * Same as emuConfirmOp but waits for user to click Confirm/Reject in the
 * emulator window before pre-writing ButtonAck + DebugLinkDecision.
 */
export async function emuInteractiveConfirm(
  fn: () => Promise<any>,
  details: EmulatorConfirmDetails,
  engineDelegate?: { chunkCount: number } | null,
): Promise<any> {
  const { pausePoll, resumePoll, saveEmulatorState, emuPollOnce } = await import('./emulator')
  const { prewriteConfirmations } = await import('./emulator-transport')

  const id = crypto.randomUUID()
  if (engineDelegate) engineDelegate.chunkCount = 0

  pausePoll()

  try {
    // Start operation — transport writes chunks to ring buffer
    const promise = fn()
    await new Promise(r => setTimeout(r, 30))

    const numChunks = engineDelegate?.chunkCount || 1
    console.log(`${TAG} ${numChunks} chunks written, polling ${numChunks - 1} pre-polls`)

    // Consume all chunks except the last
    for (let i = 0; i < numChunks - 1; i++) {
      emuPollOnce()
    }

    // Ask user for confirmation
    const approved = await requestUserConfirm({ id, ...details })

    if (!approved) {
      throw new Error('Transaction rejected by user on emulator')
    }

    // User approved — pre-write BA+DLD and execute
    prewriteConfirmations(1)
    emuPollOnce()

    const result = await promise
    saveEmulatorState()
    return result
  } finally {
    resumePoll()
    sendDismiss()
  }
}

// ── Inline HTML ─────────────────────────────────────────────────────────

const EMULATOR_HTML = `<!DOCTYPE html>
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
    height: 100px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 8px 12px;
    overflow: hidden;
  }
  .oled-content {
    color: #fff;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.4;
    text-align: center;
    word-break: break-all;
  }
  .oled-content .op-label {
    color: #4fc3f7;
    font-weight: bold;
    font-size: 12px;
    margin-bottom: 4px;
  }
  .oled-content .detail {
    color: #ccc;
    font-size: 10px;
  }
  .oled-content .addr {
    color: #81c784;
    font-size: 10px;
    font-family: 'Courier New', monospace;
  }
  .idle-text {
    color: #666;
    font-size: 12px;
  }
  .buttons {
    display: none;
    padding: 10px 16px 14px;
    gap: 12px;
    justify-content: center;
  }
  .buttons.visible { display: flex; }
  .btn {
    padding: 8px 24px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:active { transform: scale(0.96); }
  .btn-confirm {
    background: #2e7d32;
    color: #fff;
  }
  .btn-confirm:hover { background: #388e3c; }
  .btn-reject {
    background: #c62828;
    color: #fff;
  }
  .btn-reject:hover { background: #d32f2f; }
  /* Seed word display */
  .seed-section { display: none; padding: 8px 12px; }
  .seed-section.visible { display: block; }
  .seed-title {
    font-size: 11px;
    font-weight: 700;
    color: #e67e22;
    text-transform: uppercase;
    letter-spacing: 1px;
    text-align: center;
    margin-bottom: 6px;
  }
  .seed-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: center;
  }
  .seed-word {
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 10px;
    font-family: 'Courier New', monospace;
    min-width: 70px;
    text-align: center;
  }
  .seed-word .num { color: #666; font-size: 9px; }
  .seed-word .word { color: #81c784; font-weight: 600; }
  .seed-ack-btn {
    display: none;
    margin: 8px auto;
    padding: 8px 20px;
    background: #2e7d32;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
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
      <div class="oled-content" id="oled">
        <div class="idle-text">KeepKey Emulator Ready</div>
      </div>
    </div>
  </div>
  <div class="seed-section" id="seedSection">
    <div class="seed-title">Recovery Phrase — Write These Down</div>
    <div class="seed-grid" id="seedGrid"></div>
  </div>
  <button class="seed-ack-btn" id="seedAckBtn">I've recorded my words</button>
  <div class="buttons" id="buttons">
    <button class="btn btn-confirm" id="confirmBtn">Confirm</button>
    <button class="btn btn-reject" id="rejectBtn">Reject</button>
  </div>

<script>
(function() {
  const oled = document.getElementById('oled');
  const buttons = document.getElementById('buttons');
  const confirmBtn = document.getElementById('confirmBtn');
  const rejectBtn = document.getElementById('rejectBtn');
  const displayArea = document.getElementById('displayArea');
  const seedSection = document.getElementById('seedSection');
  const seedGrid = document.getElementById('seedGrid');
  const seedAckBtn = document.getElementById('seedAckBtn');

  let currentConfirmId = null;
  let sendPacket = null;
  let nextReqId = 0;

  // ── Minimal RPC client (same WebSocket protocol as Electrobun) ──

  function initRpc() {
    const w = window;
    const port = w.__electrobunRpcSocketPort;
    const webviewId = w.__electrobunWebviewId;

    if (!port || !webviewId) {
      console.warn('[emu-ui] Electrobun globals not injected');
      return;
    }

    const socket = new WebSocket('ws://localhost:' + port + '/socket?webviewId=' + webviewId);

    socket.addEventListener('message', async function(event) {
      try {
        const data = typeof event.data === 'string' ? event.data : await event.data.text();
        const parsed = JSON.parse(data);
        let packet = parsed;
        if (parsed.encryptedData && w.__electrobun_decrypt) {
          const decrypted = await w.__electrobun_decrypt(parsed.encryptedData, parsed.iv, parsed.tag);
          packet = JSON.parse(decrypted);
        }
        handlePacket(packet);
      } catch (err) {
        console.error('[emu-ui] Parse error:', err);
      }
    });

    socket.addEventListener('open', function() {
      console.log('[emu-ui] RPC connected');
    });

    sendPacket = async function(pkt) {
      if (socket.readyState !== WebSocket.OPEN) return;
      const json = JSON.stringify(pkt);
      if (w.__electrobun_encrypt) {
        try {
          const enc = await w.__electrobun_encrypt(json);
          socket.send(JSON.stringify(enc));
          return;
        } catch {}
      }
      socket.send(json);
    };
  }

  function handlePacket(packet) {
    if (packet.type === 'message') {
      if (packet.id === 'confirm-request') onConfirmRequest(packet.payload);
      if (packet.id === 'confirm-dismiss') onConfirmDismiss();
      if (packet.id === 'emu-state') onStateChange(packet.payload);
      if (packet.id === 'seed-display') onSeedDisplay(packet.payload);
      if (packet.id === 'seed-dismiss') onSeedDismiss();
    }
  }

  function rpcRequest(method, params) {
    if (!sendPacket) return;
    const id = ++nextReqId;
    sendPacket({ type: 'request', id: id, method: method, params: params });
  }

  // ── UI handlers ──

  function onConfirmRequest(details) {
    currentConfirmId = details.id;

    // Format operation name
    var opName = details.operation
      .replace(/([A-Z])/g, ' $1')
      .replace(/^\\s/, '')
      .replace('Sign Tx', 'Sign Transaction')
      .replace('Get Address', 'Verify Address');

    var html = '<div class="op-label">' + escHtml(opName) + '</div>';
    if (details.chain) {
      html += '<div class="detail">Chain: ' + escHtml(details.chain) + '</div>';
    }
    if (details.to) {
      var addr = details.to;
      if (addr.length > 20) addr = addr.slice(0, 10) + '...' + addr.slice(-8);
      html += '<div class="addr">To: ' + escHtml(addr) + '</div>';
    }
    if (details.value) {
      html += '<div class="detail">Amount: ' + escHtml(details.value) + '</div>';
    }
    if (details.memo) {
      html += '<div class="detail">Memo: ' + escHtml(details.memo) + '</div>';
    }

    oled.innerHTML = html;
    buttons.classList.add('visible');
  }

  function onConfirmDismiss() {
    currentConfirmId = null;
    oled.innerHTML = '<div class="idle-text">KeepKey Emulator Ready</div>';
    buttons.classList.remove('visible');
  }

  function onSeedDisplay(data) {
    var words = data.words || [];
    seedGrid.innerHTML = '';
    words.forEach(function(word, i) {
      var el = document.createElement('div');
      el.className = 'seed-word';
      el.innerHTML = '<span class="num">' + (i + 1) + '</span> <span class="word">' + escHtml(word) + '</span>';
      seedGrid.appendChild(el);
    });
    // Hide OLED area, show seed section
    displayArea.style.display = 'none';
    seedSection.classList.add('visible');
    seedAckBtn.classList.add('visible');
    buttons.classList.remove('visible');
    oled.innerHTML = '<div class="idle-text" style="color:#e67e22">Seed words shown below</div>';
  }

  function onSeedDismiss() {
    displayArea.style.display = '';
    seedSection.classList.remove('visible');
    seedAckBtn.classList.remove('visible');
    seedGrid.innerHTML = '';
    oled.innerHTML = '<div class="idle-text">KeepKey Emulator Ready</div>';
  }

  function onStateChange(data) {
    // Could add visual state indicators later
  }

  function escHtml(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ── Button clicks ──

  confirmBtn.addEventListener('click', function() {
    if (!currentConfirmId) return;
    rpcRequest('emuConfirm', { id: currentConfirmId, approved: true });
    oled.innerHTML = '<div class="idle-text" style="color:#4fc3f7">Processing...</div>';
    buttons.classList.remove('visible');
  });

  rejectBtn.addEventListener('click', function() {
    if (!currentConfirmId) return;
    rpcRequest('emuConfirm', { id: currentConfirmId, approved: false });
    oled.innerHTML = '<div class="idle-text" style="color:#e57373">Rejected</div>';
    buttons.classList.remove('visible');
    setTimeout(function() {
      oled.innerHTML = '<div class="idle-text">KeepKey Emulator Ready</div>';
    }, 1500);
  });

  seedAckBtn.addEventListener('click', function() {
    rpcRequest('seedAcked', {});
    onSeedDismiss();
  });

  // ── Init ──
  initRpc();
})();
</script>
</body>
</html>
`
