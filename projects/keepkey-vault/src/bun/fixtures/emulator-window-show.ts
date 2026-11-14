/** B4 driver: the EMU badge brings the emulator window to the front, or reopens
 * it with the screen and PIN instructions it had. Child process, like
 * emulator-window-lifecycle.ts, so the module mocks stay out of other suites. */
import { mock } from 'bun:test'
import { strict as assert } from 'node:assert'

const stateDir = process.env.KK_EMULATOR_WINDOW_TEST_DIR
if (!stateDir) throw new Error('A temporary emulator-window test directory is required')

class FakeWindow {
  static instances: FakeWindow[] = []
  handlers = new Map<string, () => void>()
  packets: string[] = []
  activations = 0
  minimized = false
  webview = {
    executeJavascript: (script: string) => { this.packets.push(script) },
    loadHTML: (html: string) => { this.options.html = html },
  }
  constructor(public options: any) { FakeWindow.instances.push(this) }
  on(event: string, callback: () => void) { this.handlers.set(event, callback) }
  getFrame() { return this.options.frame }
  close() {}
  activate() { this.activations++ }
  isMinimized() { return this.minimized }
  unminimize() { this.minimized = false }
  /** The user clicks the window's close button. */
  emitClose() { this.handlers.get('close')?.() }
}

const bridges: Array<{ fetch: (request: Request) => Response | Promise<Response> }> = []
const frames: Uint8Array[] = []
const originalServe = Bun.serve
Bun.serve = ((options: any) => {
  bridges.push({ fetch: options.fetch })
  return { port: 42000 + bridges.length, stop() {} }
}) as typeof Bun.serve

mock.module('electrobun/main', () => ({ BrowserWindow: FakeWindow, BrowserView: { defineRPC: () => ({}) } }))
mock.module('os', () => ({ homedir: () => stateDir }))
mock.module('../emulator', () => ({ getActiveFlashName: () => 'fixture-wallet', emuPopFrames: () => frames.splice(0) }))
mock.module('../test-review-tape', () => ({ recordReviewScreen() {}, reviewTapeRecording: () => false }))

const emulatorWindow = await import('../emulator-window')
const ready = (index: number) => {
  const loadId = /postBridge\('\/_emu\/ready', \{ loadId: '([^']+)' \}\)/.exec(FakeWindow.instances[index].options.html)?.[1]
  assert(loadId, 'the emulator HTML includes its ready-message load ID')
  return bridges[index].fetch(new Request('http://127.0.0.1/_emu/ready', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loadId }),
  }))
}
const pinGrid = new Uint8Array(2048).fill(0x5a)

try {
  emulatorWindow.openEmulatorWindow()
  const first = FakeWindow.instances[0]
  await ready(0)
  frames.push(pinGrid)
  emulatorWindow.displayPinPrompt('current')
  await Bun.sleep(150)
  assert(first.packets.some(p => p.includes('display-update')), 'the open window shows the PIN grid')

  // Open, maybe behind the main window or minimized: the badge brings it forward, no second window.
  first.minimized = true
  assert.equal(emulatorWindow.showEmulatorWindow(), 'focused')
  assert.equal(FakeWindow.instances.length, 1, 'no second window while one is open')
  assert.equal(first.activations, 1, 'the open window is activated')
  assert.equal(first.minimized, false, 'a minimized window is restored')

  // The user closed it while the device waits for the PIN: the badge reopens it.
  first.emitClose()
  assert.equal(emulatorWindow.isEmulatorWindowOpen(), false)
  assert.equal(emulatorWindow.showEmulatorWindow(), 'reopened')
  const reopened = FakeWindow.instances[1]
  assert(reopened, 'a new window opens')
  await ready(1)
  await Bun.sleep(150)
  // The firmware is idle on the PIN grid: it draws no new frame, so the window
  // must be given the last one, and the instructions for the open prompt.
  assert(reopened.packets.some(p => p.includes('display-update')), 'the reopened window shows the screen the device is on')
  assert(reopened.packets.some(p => p.includes('pin-request')), 'the reopened window shows the PIN instructions')

  // Once the prompt is answered, a reopen does not bring back stale instructions.
  emulatorWindow.clearPinPrompt()
  reopened.emitClose()
  emulatorWindow.showEmulatorWindow()
  const third = FakeWindow.instances[2]
  await ready(2)
  await Bun.sleep(150)
  assert(!third.packets.some(p => p.includes('pin-request')), 'an answered prompt is not shown again')

  // Stopping the emulator (a programmatic close) forgets its screen: the next emulator starts blank.
  emulatorWindow.closeEmulatorWindow()
  emulatorWindow.openEmulatorWindow()
  const fresh = FakeWindow.instances[3]
  await ready(3)
  await Bun.sleep(150)
  assert(!fresh.packets.some(p => p.includes('display-update')), 'a new emulator never shows the previous one\'s screen')
  console.log('emulator window show: focus, restore, reopen with screen and PIN prompt, and fresh start passed')
} finally {
  emulatorWindow.closeEmulatorWindow()
  emulatorWindow.stopDisplayPoll()
  Bun.serve = originalServe
}
