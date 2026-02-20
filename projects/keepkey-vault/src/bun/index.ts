import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun"
import { EngineController } from "./engine-controller"
import { startRestApi } from "./rest-api"
import type { VaultRPCSchema } from "../shared/rpc-schema"

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`
const REST_API_PORT = 1646

// ── Engine Controller ─────────────────────────────────────────────────
const engine = new EngineController()

// ── REST API Server (port 1646 — kkapi:// protocol) ───────────────────
const restServer = startRestApi(engine, REST_API_PORT)

// ── RPC Bridge (Electrobun UI ↔ Bun) ─────────────────────────────────
const rpc = BrowserView.defineRPC<VaultRPCSchema>({
	maxRequestTime: 600000, // device-interactive ops (recovery, create) can take 5-10 minutes
	handlers: {
		requests: {
			getDeviceState: async () => engine.getDeviceState(),
			startBootloaderUpdate: async () => { await engine.startBootloaderUpdate() },
			startFirmwareUpdate: async () => { await engine.startFirmwareUpdate() },
			flashFirmware: async () => { await engine.flashFirmware() },
			resetDevice: async (params) => { await engine.resetDevice(params) },
			recoverDevice: async (params) => { await engine.recoverDevice(params) },
			applySettings: async (params) => { await engine.applySettings(params) },
			sendPin: async (params) => { await engine.sendPin(params.pin) },
			sendPassphrase: async (params) => { await engine.sendPassphrase(params.passphrase) },
			sendCharacter: async (params) => { await engine.sendCharacter(params.character) },
			sendCharacterDelete: async () => { await engine.sendCharacterDelete() },
			sendCharacterDone: async () => { await engine.sendCharacterDone() },
		},
		messages: {},
	},
})

// Push engine events to WebView
engine.on('state-change', (state) => {
	try { rpc.send['device-state'](state) } catch { /* webview not ready yet */ }
})
engine.on('firmware-progress', (progress) => {
	try { rpc.send['firmware-progress'](progress) } catch { /* webview not ready yet */ }
})
engine.on('pin-request', (req) => {
	try { rpc.send['pin-request'](req) } catch { /* webview not ready yet */ }
})
engine.on('character-request', (req) => {
	try { rpc.send['character-request'](req) } catch { /* webview not ready yet */ }
})
engine.on('recovery-error', (err) => {
	try { rpc.send['recovery-error'](err) } catch { /* webview not ready yet */ }
})

// ── Window Setup ──────────────────────────────────────────────────────
async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel()
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" })
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`)
			return DEV_SERVER_URL
		} catch {
			console.log("Vite dev server not running. Run 'bun run dev:hmr' for HMR support.")
		}
	}
	return "views://mainview/index.html"
}

const url = await getMainViewUrl()

const mainWindow = new BrowserWindow({
	title: "KeepKey Vault",
	url,
	rpc,
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
})

// Start engine (USB event listeners + initial device sync)
await engine.start()

// Quit the app when the main window is closed
mainWindow.on("close", () => {
	engine.stop()
	restServer.stop()
	Utils.quit()
})

console.log("KeepKey Vault started!")
