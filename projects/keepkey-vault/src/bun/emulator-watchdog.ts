// Emulator FFI liveness watchdog.
//
// Scope: ONLY the emulator path. When kkemu_poll() enters confirm_helper, the
// firmware C code busy-loops waiting for ButtonAck, freezing the Bun event
// loop. No setTimeout, no signal handler, no cleanup runs. This watchdog is
// a subprocess that SIGKILLs the parent if the heartbeat goes stale, so the
// user sees a clean crash + relaunch instead of an indefinitely hung UI.
//
// NOT active for physical-device operations. Real HID reads can block too
// (node-hid readSync), but that's a recoverable operation failure — the engine
// surfaces it as an error, the app stays alive, the user retries. Killing the
// whole process for a slow button press on a 2020 bootloader was wrong.
//
// PLATFORM: POSIX only. Uses bash/sleep/cat/date/kill -9. On Windows: no-op.
// kkemu is POSIX-only anyway (dylib builds only on macOS/Linux), so the
// watchdog is never needed on win32.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const HEARTBEAT_FILE = path.join(os.tmpdir(), `keepkey-vault-emu-heartbeat-${process.pid}`)
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let started = false

export function startEmulatorWatchdog(): void {
  if (started) return
  if (process.platform === 'win32') {
    console.log('[EmuWatchdog] Skipped on Windows (kkemu is POSIX-only)')
    return
  }

  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()))
    heartbeatTimer = setInterval(() => {
      try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())) } catch {}
    }, 5000)

    const watchdog = Bun.spawn(['bash', '-c', `
      while true; do
        sleep 5
        if [ ! -f "${HEARTBEAT_FILE}" ]; then exit 0; fi
        last=$(cat "${HEARTBEAT_FILE}" 2>/dev/null || echo 0)
        now=$(date +%s)
        age=$(( now - last / 1000 ))
        if [ "$age" -gt 15 ]; then
          kill -9 ${process.pid} 2>/dev/null
          rm -f "${HEARTBEAT_FILE}"
          exit 0
        fi
      done
    `], { stdout: 'ignore', stderr: 'ignore' })
    watchdog.unref()
    started = true
    console.log('[EmuWatchdog] Started — will SIGKILL if emulator FFI freezes event loop >15s')
  } catch (err: any) {
    console.warn(`[EmuWatchdog] Spawn failed (continuing without it): ${err?.message || err}`)
  }
}

export function stopEmulatorWatchdog(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  try { fs.unlinkSync(HEARTBEAT_FILE) } catch {}
  started = false
}
