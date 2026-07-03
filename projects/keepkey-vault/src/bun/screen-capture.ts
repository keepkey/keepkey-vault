/**
 * Native one-shot screen capture for QR scanning ("scan screen" in the QR overlay).
 *
 * Why native and not getDisplayMedia in the webview: WKWebView only honors
 * getDisplayMedia when the app implements NO media-capture delegate — Electrobun
 * implements one for getUserMedia (camera), so display-capture requests are
 * auto-denied unless a private WebKit delegate is added. Capturing with the OS
 * screenshot tool from the Bun side works on every platform and keeps the
 * decode path (jsQR in the webview) identical to the camera/file flows.
 *
 * macOS permission model (Screen Recording, pure TCC — no entitlement exists):
 * - CGPreflightScreenCaptureAccess() checks; CGRequestScreenCaptureAccess()
 *   registers the app in System Settings → Privacy & Security → Screen Recording
 *   and shows the system prompt (first call only).
 * - The grant is keyed to the RESPONSIBLE process: the .app bundle in prod,
 *   but the terminal/IDE that launched `bun dev` in dev builds — in dev you
 *   grant Screen Recording to Terminal/iTerm/WebStorm, not KeepKey Vault.
 * - After granting, macOS requires the app to relaunch before the in-process
 *   preflight reports true. Unauthorized `screencapture` fails loudly
 *   ("could not create image from display", exit 1) — verified on macOS 26 —
 *   so a permission gap can never masquerade as "no QR found".
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { ScreenCaptureResult } from "../shared/types"

// ── macOS TCC preflight/request via CoreGraphics ──────────────────────────
let cgSymbols: { preflight: () => boolean; request: () => boolean } | null = null
function loadCoreGraphics() {
	if (cgSymbols) return cgSymbols
	const { dlopen, FFIType } = require("bun:ffi")
	const lib = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
		CGPreflightScreenCaptureAccess: { args: [], returns: FFIType.bool },
		CGRequestScreenCaptureAccess: { args: [], returns: FFIType.bool },
	})
	cgSymbols = {
		preflight: () => lib.symbols.CGPreflightScreenCaptureAccess(),
		request: () => lib.symbols.CGRequestScreenCaptureAccess(),
	}
	return cgSymbols
}

/**
 * Check (and on first refusal, request) screen-capture permission.
 * Returns null when capture may proceed, or a permission error result.
 * Only macOS gates screen capture; Windows/Linux have no equivalent TCC.
 */
export function ensureScreenPermission(): ScreenCaptureResult | null {
	if (process.platform !== "darwin") return null
	try {
		const cg = loadCoreGraphics()
		if (cg.preflight()) return null
		// Registers the app in the Screen Recording list + shows the system
		// prompt the first time. Returns true if the user already granted
		// (e.g. mid-session grant picked up without the prompt).
		if (cg.request()) return null
		// Open the exact Settings pane — the system prompt only appears once.
		try {
			Bun.spawn(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"], { stdio: ["ignore", "ignore", "ignore"] })
		} catch {}
		return {
			ok: false,
			reason: "permission",
			message:
				"Screen Recording permission is required. In System Settings → Privacy & Security → Screen Recording, enable KeepKey Vault, then quit and reopen the app.",
		}
	} catch (e: any) {
		return { ok: false, reason: "failed", message: `Permission check failed: ${e?.message || e}` }
	}
}

function readAsBase64AndClean(dir: string, files: string[]): string[] {
	const images: string[] = []
	for (const f of files) {
		if (existsSync(f)) images.push(readFileSync(f).toString("base64"))
	}
	rmSync(dir, { recursive: true, force: true })
	return images
}

/** Capture every display to PNG. Caller is responsible for the permission check. */
export async function captureScreens(): Promise<ScreenCaptureResult> {
	const dir = mkdtempSync(join(tmpdir(), "kk-scan-"))
	// ponytail: 4 displays max — screencapture writes one file per attached display
	const files = [0, 1, 2, 3].map((i) => join(dir, `screen-${i}.png`))
	try {
		if (process.platform === "darwin") {
			const proc = Bun.spawn(["/usr/sbin/screencapture", "-x", "-t", "png", ...files], { stdio: ["ignore", "ignore", "ignore"] })
			await proc.exited
		} else if (process.platform === "win32") {
			// No OS permission gate on Windows. ponytail: CopyFromScreen is not
			// per-monitor-DPI aware — a scaled capture still decodes fine for QR.
			const ps = [
				"Add-Type -AssemblyName System.Windows.Forms;",
				"Add-Type -AssemblyName System.Drawing;",
				"$i=0;",
				"foreach($s in [System.Windows.Forms.Screen]::AllScreens){",
				"$b=$s.Bounds;",
				"$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
				"$g=[System.Drawing.Graphics]::FromImage($bmp);",
				"$g.CopyFromScreen($b.X,$b.Y,0,0,$b.Size);",
				`$bmp.Save((Join-Path '${dir.replace(/'/g, "''")}' (\"screen-$i.png\")),[System.Drawing.Imaging.ImageFormat]::Png);`,
				"$g.Dispose(); $bmp.Dispose(); $i++ }",
			].join(" ")
			const proc = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { stdio: ["ignore", "ignore", "ignore"] })
			await proc.exited
		} else {
			// Linux: first available tool wins (grim = Wayland, import = X11).
			// Wayland compositors may show their own one-time consent dialog.
			const out = files[0]
			const candidates: string[][] = [
				["grim", out],
				["gnome-screenshot", "-f", out],
				["spectacle", "-b", "-n", "-o", out],
				["import", "-window", "root", out],
			]
			const tool = candidates.find((c) => Bun.which(c[0]))
			if (!tool) {
				rmSync(dir, { recursive: true, force: true })
				return { ok: false, reason: "unsupported", message: "No screenshot tool found (install grim, gnome-screenshot, spectacle, or imagemagick)." }
			}
			const proc = Bun.spawn(tool, { stdio: ["ignore", "ignore", "ignore"] })
			await proc.exited
		}
		const images = readAsBase64AndClean(dir, files)
		if (images.length === 0) return { ok: false, reason: "failed", message: "Screen capture produced no image." }
		return { ok: true, images }
	} catch (e: any) {
		rmSync(dir, { recursive: true, force: true })
		return { ok: false, reason: "failed", message: `Screen capture failed: ${e?.message || e}` }
	}
}
