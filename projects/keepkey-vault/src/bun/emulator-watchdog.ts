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
let watchdogProc: ReturnType<typeof Bun.spawn> | null = null
let started = false

export function startEmulatorWatchdog(): void {
  if (started) return
  if (process.platform === 'win32') {
    console.log('[EmuWatchdog] Skipped on Windows (kkemu is POSIX-only)')
    return
  }

  // Spawn the killer subprocess FIRST. If this throws, we bail before
  // arming the heartbeat — otherwise a failed spawn leaves an orphaned
  // setInterval writing to a file with no killer watching it.
  try {
    // 60s deadline. The 7.15 firmware adds Zcash Orchard + BIP-85 derivation
    // paths that, on first call, can take 5-15s in the dylib (no daemon poll
    // thread; the caller is the only thing driving kkemu_poll while a deep
    // derivation runs in the firmware). 15s wasn't enough headroom and
    // turned slow-but-working flows into kill-the-app crashes. Keep the
    // watchdog as a backstop against genuine freezes (confirm_helper-style
    // busy loops), just give legit work room to finish.
    watchdogProc = Bun.spawn(['bash', '-c', `
      while true; do
        sleep 5
        if [ ! -f "${HEARTBEAT_FILE}" ]; then exit 0; fi
        last=$(cat "${HEARTBEAT_FILE}" 2>/dev/null || echo 0)
        now=$(date +%s)
        age=$(( now - last / 1000 ))
        if [ "$age" -gt 60 ]; then
          kill -9 ${process.pid} 2>/dev/null
          rm -f "${HEARTBEAT_FILE}"
          exit 0
        fi
      done
    `], { stdout: 'ignore', stderr: 'ignore' })
    watchdogProc.unref()
  } catch (err: any) {
    console.warn(`[EmuWatchdog] Spawn failed (continuing without it): ${err?.message || err}`)
    watchdogProc = null
    return
  }

  // Arm the heartbeat. If the initial write fails, tear down the
  // subprocess we just spawned so we don't strand it.
  try {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()))
    heartbeatTimer = setInterval(() => {
      try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())) } catch {}
    }, 5000)
  } catch (err: any) {
    console.warn(`[EmuWatchdog] Heartbeat arm failed: ${err?.message || err}`)
    try { watchdogProc.kill('SIGKILL') } catch {}
    watchdogProc = null
    return
  }

  started = true
  console.log('[EmuWatchdog] Started — will SIGKILL if emulator FFI freezes event loop >60s')
}

export function stopEmulatorWatchdog(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }

  // Kill the subprocess BEFORE unlinking the heartbeat file. Otherwise, in
  // a rapid stop→start cycle, the old bash could wake from `sleep 5` after
  // the new start has already recreated HEARTBEAT_FILE — two watchdogs
  // racing on the same file. SIGKILL ensures the old one is gone before
  // any new file exists.
  if (watchdogProc) {
    try { watchdogProc.kill('SIGKILL') } catch {}
    watchdogProc = null
  }

  try { fs.unlinkSync(HEARTBEAT_FILE) } catch {}
  started = false
}
