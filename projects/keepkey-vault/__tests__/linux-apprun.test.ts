import { afterAll, expect, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Runs the real AppRun script against a fake AppDir. `ldd` is stubbed on PATH so
// the missing-library path is exercised on macOS as well as Linux.
const it = test.skipIf(process.platform === "win32")
const root = mkdtempSync(join(tmpdir(), "kk-apprun-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function appDir(name: string, lddOutput?: string) {
	const dir = join(root, name)
	const bin = join(dir, "usr", "bin", "bin")
	const stubs = join(dir, "stubs")
	mkdirSync(bin, { recursive: true })
	mkdirSync(stubs)
	copyFileSync(join(import.meta.dir, "..", "scripts", "linux-apprun.sh"), join(dir, "AppRun"))
	writeFileSync(join(bin, "libNativeWrapper.so"), "")
	writeFileSync(join(bin, "launcher"), '#!/bin/bash\necho "LAUNCHED $*"\n')
	if (lddOutput !== undefined) {
		writeFileSync(join(stubs, "ldd"), `#!/bin/bash\ncat <<'EOF'\n${lddOutput}\nEOF\n`)
		chmodSync(join(stubs, "ldd"), 0o755)
	}
	chmodSync(join(dir, "AppRun"), 0o755)
	chmodSync(join(bin, "launcher"), 0o755)
	return { dir, stubs }
}

function run(app: { dir: string; stubs: string }, args: string[] = []) {
	const proc = Bun.spawnSync([join(app.dir, "AppRun"), ...args], {
		// No DISPLAY: any dialog tool present on the machine exits at once.
		env: { PATH: `${app.stubs}:/usr/bin:/bin` },
		stdout: "pipe",
		stderr: "pipe",
	})
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

it("starts the app when every library resolves", () => {
	const app = appDir("ok", [
		"\tlibgtk-3.so.0 => /lib/x86_64-linux-gnu/libgtk-3.so.0 (0x00007f0000000000)",
		"\tlibwebkit2gtk-4.1.so.0 => /lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 (0x00007f0000000000)",
	].join("\n"))
	const r = run(app, ["--flag", "value"])
	expect(r.code).toBe(0)
	expect(r.out).toContain("LAUNCHED --flag value")
})

it("names the missing libraries and does not start the app", () => {
	const app = appDir("missing", [
		"\tlibgtk-3.so.0 => /lib/x86_64-linux-gnu/libgtk-3.so.0 (0x00007f0000000000)",
		"\tlibwebkit2gtk-4.1.so.0 => not found",
		"\tlibayatana-appindicator3.so.1 => not found",
	].join("\n"))
	const r = run(app)
	expect(r.code).toBe(1)
	expect(r.out).not.toContain("LAUNCHED")
	expect(r.err).toContain("libwebkit2gtk-4.1.so.0")
	expect(r.err).toContain("libayatana-appindicator3.so.1")
	expect(r.err).not.toContain("libgtk-3.so.0")
	expect(r.err.toLowerCase()).toContain("install")
})

it("starts the app when the libraries cannot be inspected", () => {
	// No ldd stub: either there is no ldd (macOS) or it cannot read the empty file.
	const r = run(appDir("no-ldd"))
	expect(r.code).toBe(0)
	expect(r.out).toContain("LAUNCHED")
})
