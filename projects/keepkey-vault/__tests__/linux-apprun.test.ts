import { afterAll, expect, test } from "bun:test"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
	writeFileSync(join(bin, "launcher"), '#!/bin/bash\necho "LAUNCHED $*"\necho "LAUNCHER_LD=$LD_LIBRARY_PATH"\n')
	if (lddOutput !== undefined) {
		// The stub also records the LD_LIBRARY_PATH it was invoked with, so tests
		// can assert the bundled usr/lib directory is on the search path.
		writeFileSync(
			join(stubs, "ldd"),
			`#!/bin/bash\necho "LDD_LD=$LD_LIBRARY_PATH" > "${join(dir, "ldd-env.txt")}"\ncat <<'EOF'\n${lddOutput}\nEOF\n`,
		)
		chmodSync(join(stubs, "ldd"), 0o755)
	}
	chmodSync(join(dir, "AppRun"), 0o755)
	chmodSync(join(bin, "launcher"), 0o755)
	return { dir, stubs }
}

function run(app: { dir: string; stubs: string }, args: string[] = [], env: Record<string, string> = {}) {
	const proc = Bun.spawnSync([join(app.dir, "AppRun"), ...args], {
		// No DISPLAY: any dialog tool present on the machine exits at once.
		env: { PATH: `${app.stubs}:/usr/bin:/bin`, ...env },
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

it("puts the bin dir (bundled tray libs) on the library path for the check and the app", () => {
	const app = appDir("libpath", [
		"\tlibayatana-appindicator3.so.1 => /usr/lib/libayatana-appindicator3.so.1 (0x00007f0000000000)",
	].join("\n"))
	const r = run(app)
	expect(r.code).toBe(0)
	// The tray stack is bundled next to libNativeWrapper.so in usr/bin/bin,
	// because the Electrobun launcher replaces the child's LD_LIBRARY_PATH
	// with exactly that directory. The ldd check must look there too.
	const bin = join(app.dir, "usr", "bin", "bin")
	const lddEnv = readFileSync(join(app.dir, "ldd-env.txt"), "utf8")
	expect(lddEnv).toContain(bin)
	expect(r.out).toContain(`LAUNCHER_LD=${bin}`)
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

it("suggests only the package that is actually missing", () => {
	// Fedora KDE ships without WebKitGTK; the tray stack is bundled, so the fix
	// line must name the webkit package and not tell the user to install a
	// tray package they do not need.
	const osRelease = join(root, "os-release-fedora")
	writeFileSync(osRelease, 'ID=fedora\nID_LIKE=""\n')
	const app = appDir("webkit-only", [
		"\tlibwebkit2gtk-4.1.so.0 => not found",
		"\tlibjavascriptcoregtk-4.1.so.0 => not found",
	].join("\n"))
	const r = run(app, [], { KK_APPRUN_OS_RELEASE: osRelease })
	expect(r.code).toBe(1)
	expect(r.err).toContain("sudo dnf install webkit2gtk4.1")
	expect(r.err).not.toContain("ayatana")
})

it("suggests both packages when both stacks are missing", () => {
	const osRelease = join(root, "os-release-debian")
	writeFileSync(osRelease, 'ID=debian\nID_LIKE=""\n')
	const app = appDir("both-missing", [
		"\tlibwebkit2gtk-4.1.so.0 => not found",
		"\tlibayatana-appindicator3.so.1 => not found",
	].join("\n"))
	const r = run(app, [], { KK_APPRUN_OS_RELEASE: osRelease })
	expect(r.code).toBe(1)
	expect(r.err).toContain("sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1")
})

it("falls back to a generic hint for unmapped libraries", () => {
	const osRelease = join(root, "os-release-arch")
	writeFileSync(osRelease, 'ID=arch\nID_LIKE=""\n')
	const app = appDir("unmapped", ["\tlibfancy.so.9 => not found"].join("\n"))
	const r = run(app, [], { KK_APPRUN_OS_RELEASE: osRelease })
	expect(r.code).toBe(1)
	expect(r.err).toContain("libfancy.so.9")
	expect(r.err).toContain("package manager")
})

it("starts the app when the libraries cannot be inspected", () => {
	// No ldd stub: either there is no ldd (macOS) or it cannot read the empty file.
	const r = run(appDir("no-ldd"))
	expect(r.code).toBe(0)
	expect(r.out).toContain("LAUNCHED")
})
